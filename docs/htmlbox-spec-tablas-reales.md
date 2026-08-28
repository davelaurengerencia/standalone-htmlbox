# HTMLBox — Spec: tablas de verdad (columnas SQL reales, no `data_json`)

Decisión de David: reemplazar el modelo actual de blob JSON por columnas SQL reales en TODA la capa de datos de un box (no solo lo que crea la IA) — manual, CSV upload, bulk-create y el análisis con IA comparten el mismo storage hoy (`packages/runtime/src/lib/dataApi.js`), así que el cambio es transversal. Esta spec **reemplaza** la sección §3 ("promover columnas") de `htmlbox-spec-ai-analyze-robusto.md` — esa spec pasa a apoyarse en esta.

## 1. Por qué el diseño actual ya no se sostiene

Grounding real en `dataApi.js`: `ensureTable()`, `postUpsert()`, `postUpload()`, `postBulkCreate()` y `getRows()` guardan y leen SIEMPRE contra `data_json` (un blob por fila) — las "columnas" declaradas en `htmlbox_tables.columns_json` son metadata descriptiva, nunca se materializan en la tabla física. Encontramos ya un síntoma concreto: `buildSelectSql()` filtra con `data_json LIKE ?` — substring match sobre texto, sin índice, sin garantía de exactitud (`LIKE '%5%'` matchea "15" o "50"), sin poder comparar numéricamente.

Los argumentos que suelen justificar este patrón (evitar migraciones que rompan otros tenants en una tabla compartida) no aplican acá: cada box tiene su propia Turso DB aislada — un `ALTER TABLE` en un box nunca toca a otro box. Y la premisa de "flexibilidad sin migraciones" ya no es necesaria: SQLite (y libSQL/Turso, que lo hereda) soporta `ALTER TABLE ... ADD COLUMN`, `ALTER TABLE ... DROP COLUMN` (desde SQLite 3.35) y `ALTER TABLE ... RENAME COLUMN` (desde 3.25) de forma nativa — "agregar/quitar/renombrar un campo desde la UI" se traduce a un ALTER real, no a tocar un JSON de metadata.

## 2. Diseño nuevo

**Tabla física** — columnas reales declaradas, con un `extra_json` chico como escape hatch para lo verdaderamente no anticipado (no como storage principal):

```sql
CREATE TABLE htmlbox_{slug} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,  -- o TEXT PRIMARY KEY si id_strategy='uuid'
  {columna1} {TIPO_SQL} [UNIQUE] [NOT NULL] [REFERENCES htmlbox_{otra}(id)],
  {columna2} {TIPO_SQL} ...,
  extra_json TEXT NOT NULL DEFAULT '{}',   -- campos no declarados, ad-hoc
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
```

Mapeo de tipos declarados (`string|number|boolean|date`) a SQL: `string`→`TEXT`, `number`→`REAL` (SQLite no distingue int/float estrictamente, pero se puede afinar a `INTEGER` cuando el `id_strategy`/ejemplo es claramente entero), `boolean`→`INTEGER` (0/1, convención SQLite estándar), `date`→`TEXT` (ISO 8601, igual que `created_at`/`updated_at` ya lo hacen).

**`htmlbox_tables.columns_json` deja de ser la fuente de verdad** — pasa a ser cache/historial (para mostrar "qué se declaró" sin pegarle a Turso). La fuente de verdad real es `PRAGMA table_info(htmlbox_{slug})`, consultado en runtime — mismo patrón que ya usan `dbMigrations.js#ensureColumnD1` (D1) y `checkInstall()` (apps instalables, PRAGMA contra Turso real) en este mismo código base. `getColumns()` (`dataApi.js`) pasa a hacer `PRAGMA table_info` en vez de leer `columns_json`, con `columns_json` quedando solo como campo informativo adicional en la respuesta (para ver qué propuso la IA originalmente vs. qué hay hoy de verdad, útil para detectar drift).

## 3. Evolución de schema (agregar/quitar/renombrar columnas)

`ensureTable()` cambia de "crear con columnas fijas de una vez" a un diff contra `PRAGMA table_info` real:

```js
async function ensureTableReal(client, slug, declaredColumns, opts = {}) {
  const exists = await tableExists(client, slug)
  if (!exists) {
    await client.execute(buildCreateTableSql(slug, declaredColumns, opts))
  } else {
    const current = await client.execute(`PRAGMA table_info(htmlbox_${slug})`)
    const currentNames = new Set(current.rows.map(r => r.name))
    for (const col of declaredColumns) {
      if (!currentNames.has(col.name)) {
        await client.execute(`ALTER TABLE htmlbox_${slug} ADD COLUMN ${sanitizeColName(col.name)} ${sqlTypeFor(col.type)}`)
        // UNIQUE/REFERENCES no se pueden agregar vía ALTER ADD COLUMN en SQLite —
        // si una columna existente necesita pasar a UNIQUE, requiere recrear la
        // tabla (patrón estándar SQLite: crear tabla nueva, copiar datos, swap).
        // v1: solo columnas simples se agregan on-the-fly; UNIQUE/FK solo se
        // declaran en la CREATE inicial. Ver §5.
      }
    }
  }
  await ensureTableScopeColumn(client) // sin cambios — sigue siendo necesaria
  await upsertTablesMetadataCache(client, slug, declaredColumns, opts) // columns_json como cache, no fuente de verdad
}
```

`postUpsert`/`postUpload`/`postBulkCreate` insertan ahora con columnas nombradas (`INSERT INTO htmlbox_{slug} (col1, col2, ...) VALUES (?, ?, ...)`) en vez de `INSERT ... (data_json) VALUES (?)`. Cualquier campo del row que NO esté en las columnas declaradas va a `extra_json` (no se descarta, pero tampoco se le pide a la IA/usuario que lo anticipe todo perfecto desde el día uno).

`getRows()` deja de hacer `JSON.parse(r.data_json)` — arma el objeto de respuesta a partir de las columnas reales devueltas por el `SELECT *`, más lo que haya en `extra_json` si no está vacío (merge, con las columnas reales ganando si hay colisión de nombre).

`buildSelectSql()` deja de usar `data_json LIKE` — el `where` ahora arma condiciones reales por columna: `WHERE {col} = ?` (o `LIKE` explícitamente solo si el tipo es `string` y se pide match parcial), con tipos correctos, index-friendly.

## 4. Índices e integridad

- `UNIQUE` en la columna SQL (no solo documentado) — falla real en el `INSERT`, no un chequeo aplicativo que se puede saltear.
- `FOREIGN KEY` real con `PRAGMA foreign_keys = ON` (Turso/libSQL requiere activarlo explícitamente por conexión — no viene prendido por default en SQLite). Confirmar que `getBoxClient`/`connectToBox` lo activa al conectar.
- Índice explícito en cualquier columna marcada `unique` o usada en `references` (además de la constraint, un `CREATE INDEX` para que los `WHERE`/joins no hagan table scan).

## 5. Qué NO resuelve esta spec (v1)

- **Cambiar una columna existente a UNIQUE/FK después de creada**: SQLite no soporta `ALTER TABLE ... ADD CONSTRAINT`. El patrón estándar es recrear la tabla (crear `_new`, copiar datos validando la constraint, `DROP` + `RENAME`) — es mecánico pero no trivial de hacer bien (hay que preservar índices, FKs entrantes de otras tablas, y hacerlo transaccional). Se deja para una spec aparte si hace falta en la práctica; v1 solo soporta declarar `unique`/`references` en la creación inicial de la tabla.
- **Migración retroactiva de tablas ya creadas con el modelo `data_json` viejo** — no se tocan boxes existentes. Esto aplica a tablas nuevas desde que se implemente.
- **Backups / point-in-time recovery**: mencionado por David como conversación futura — Turso ya ofrece esto nativamente a nivel de base de datos (útil justo para el caso "un `ALTER TABLE`/migración salió mal"), pero es una decisión operativa aparte (qué retención, quién la dispara, si es automática por box o manual), no parte de esta spec.
- **Tipado estricto más allá de lo que declara la IA/usuario** — SQLite es de tipado dinámico incluso con columnas declaradas (`type affinity`, no enforcement estricto como Postgres); no se agrega una capa de validación de tipos en la aplicación en esta pasada.

## 6. Impacto en `htmlbox-spec-ai-analyze-robusto.md`

Esa spec queda simplificada: su §3 ("promover columnas unique/references, con duplicación en data_json") se reemplaza enteramente por "usar `ensureTableReal` de esta spec" — la IA declara columnas con `unique`/`references`/`id_strategy` y se crean tal cual, sin duplicación de datos entre columna real y blob. El resto de esa spec (clasificación de `app_type`, detección de fetch externo, `created_by`) no cambia.

## 7. Checklist

1. `buildCreateTableSql(slug, columns, opts)` — nueva función en `shared/boxSchema.js` (reemplaza `physicalTableSqlFor` de firma fija), con mapeo de tipos, `UNIQUE`, `REFERENCES`, `id_strategy`.
2. `ensureTableReal()` en `dataApi.js` — diff contra `PRAGMA table_info`, `ALTER TABLE ADD COLUMN` para columnas nuevas simples.
3. Confirmar `PRAGMA foreign_keys = ON` en la conexión de `getBoxClient`/`connectToBox`.
4. Migrar `postUpsert`/`postUpload`/`postBulkCreate` a INSERT con columnas nombradas + `extra_json` para lo no declarado.
5. Migrar `getRows`/`buildSelectSql` a columnas reales, `WHERE` tipado, sin `LIKE` sobre JSON.
6. `getColumns()` — leer de `PRAGMA table_info` como fuente de verdad, `columns_json` como campo informativo secundario.
7. Actualizar `applyAnalysis` (ai.js) para usar `ensureTableReal`/`buildCreateTableSql` en vez de `physicalTableSqlFor` genérico.
8. Tests: ALTER TABLE agrega columna sin romper filas existentes (NULL en las viejas), UNIQUE rechaza insert duplicado contra Turso real (no mock), FK rechaza insert con referencia inexistente, `getRows` devuelve columnas reales + merge de `extra_json`, `where` filtra por columna real con `=` exacto (no substring falso positivo).
