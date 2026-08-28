# HTMLBox — Spec: aprovisionar Turso al primer uso real, no al crear el box

Depende de `01-htmlbox-spec-tablas-reales.md` (`ensureTableReal` es uno de los puntos donde se dispara el aprovisionamiento diferido). La clasificación `app_type` de `03-htmlbox-spec-ai-analyze-robusto.md` decide el default de algunas plantillas (ver §4). Ver `htmlbox-spec-orden-implementacion.md` para dónde encaja esto en la secuencia general.

## 1. Por qué diferir

Hoy `createBox()` (`control-plane/routes/boxes.js`) aprovisiona Turso SIEMPRE, en el mismo request de creación — `createBoxDatabase()` + `ensureBoxSchema()`, best-effort (si falla, `turso_status='failed'`/`'schema_failed'`, la box queda creada igual). Esto es correcto para plataformas donde todo proyecto por definición necesita su base (el criterio que ya usa SIVOCLOUD para sus proyectos de ecommerce/POS). HTMLBox es distinto: con la clasificación de `app_type` ya diseñada (`data_backed` | `read_only_dashboard` | `external_integration`), sabemos de antemano que una fracción real de boxes NUNCA va a necesitar una base — dashboards puros, apps que solo hablan con Shopify/APIs de terceros. Aprovisionar Turso para esos es gastar una base (cuenta con límite/costo por cantidad de bases) que nunca se usa.

## 2. Diseño

`createBox()` deja de llamar a `createBoxDatabase()`/`ensureBoxSchema()`. La fila en `htmlbox_boxes` se crea con `turso_status = 'not_provisioned'` (nuevo valor del enum, distinto de `'pending'` que hoy es un estado transitorio de un provisioning en curso — `'not_provisioned'` es un estado ESTABLE, puede durar para siempre si el box nunca necesita datos).

Punto único de aprovisionamiento on-demand — nueva función en control-plane:

```js
// control-plane/src/lib/tursoProvisioner.js (o donde viva createBoxDatabase hoy)
export async function ensureBoxProvisioned(env, boxId) {
  const box = await env.DB.prepare(`SELECT turso_status, turso_db_url, turso_db_token FROM htmlbox_boxes WHERE id = ?1`).bind(boxId).first()
  if (!box) throw new Error('box not found')
  if (box.turso_status === 'ready') return { url: box.turso_db_url, token: box.turso_db_token }
  if (box.turso_status === 'ready_provisioning') {
    // otra request ya está aprovisionando — ver §3 (carrera)
    throw new Error('provisioning_in_progress')
  }
  await env.DB.prepare(`UPDATE htmlbox_boxes SET turso_status = 'ready_provisioning' WHERE id = ?1`).bind(boxId).run()
  try {
    const { url, token } = await createBoxDatabase(env, boxId)
    await ensureBoxSchema(env, url, token)
    await env.DB.prepare(`UPDATE htmlbox_boxes SET turso_db_url=?1, turso_db_token=?2, turso_status='ready' WHERE id=?3`).bind(url, token, boxId).run()
    return { url, token }
  } catch (err) {
    await env.DB.prepare(`UPDATE htmlbox_boxes SET turso_status = 'schema_failed' WHERE id = ?1`).bind(boxId).run()
    throw err
  }
}
```

**Dónde se llama** (todos los puntos donde hoy se asume que la Turso ya existe y hoy fallarían con `box_not_found` si `turso_status` no es `'ready'`):

1. `internal.js` — `GET /api/internal/boxes/:id/db` (el endpoint que `resolveBoxDb` del runtime consulta): si `turso_status === 'not_provisioned'`, llama `ensureBoxProvisioned` ANTES de responder, en vez de devolver credenciales vacías. Esto cubre automáticamente `dataApi.js#requireBox` en runtime — no hace falta tocar runtime para nada, el aprovisionamiento queda oculto detrás del mismo endpoint interno que ya consulta.
2. `routes/ai.js#applyAnalysis` — antes de `ensureTableReal`, llama `ensureBoxProvisioned`.
3. El tool `create_table` del loop de `04-htmlbox-spec-ai-tool-loop.md` — mismo punto, antes de ejecutar contra Turso.
4. El editor manual de tablas en el portal (cuando el usuario arma una tabla a mano, sin IA) — mismo punto.

Con (1) cubriendo el endpoint interno de forma centralizada, en la práctica (2)(3)(4) heredan el comportamiento gratis la primera vez que llaman a `resolveBoxDb`/`getBoxClient` — no hace falta duplicar la llamada a `ensureBoxProvisioned` en cada handler si todos pasan por el mismo endpoint interno. Confirmar esto en la implementación real antes de asumir que no hace falta tocar los call sites de runtime.

## 3. Carrera (dos requests concurrentes disparan el primer provisioning)

`turso_status = 'ready_provisioning'` como estado intermedio explícito (distinto de `'pending'`, que ya no se usa para esto). Si una segunda request ve `'ready_provisioning'`, no reintenta provisionar — espera con backoff corto (2-3 reintentos, 300ms/600ms/1200ms) reconsultando `turso_status`, y si sigue sin resolverse devuelve 503 `provisioning_in_progress` (el cliente/SDK reintenta la request completa, no hace falta lógica especial en el box). Caso raro en la práctica (requiere dos escrituras simultáneas al primer segundo de vida del box) pero hay que cerrarlo explícitamente, no dejarlo como condición de carrera silenciosa.

## 4. Qué boxes siguen aprovisionando eager (opcional, a discutir con el equipo)

Para no cambiar la experiencia de los templates que YA vienen con datos de ejemplo (CRM, inventario — los templates no-vacíos que hoy arrancan con `sample_rows` precargadas), tiene sentido seguir aprovisionando en la creación SOLO para esos templates específicos (se sabe de antemano que van a escribir datos en el mismo flujo de creación). El template `'empty'` y cualquier box creado sin plantilla de datos quedan en `not_provisioned` hasta el primer uso real. Esto es una optimización de UX (evitar el primer-request-lento en el caso común de "sé que va a usar datos ya"), no una necesidad funcional — se puede implementar después si el diferido genera fricción perceptible.

## 5. Fuera de alcance

- No se migra el estado de boxes ya existentes (todos ya tienen `turso_status='ready'` o similar — esto aplica solo a boxes creados desde que se implemente).
- No se resuelve qué pasa si el usuario intenta "despedir"/liberar la Turso de un box que ya la tiene pero dejó de usarla (des-provisionar) — fuera de alcance, es la operación inversa y tiene sus propios riesgos (perder datos).
- No se cambia el aprovisionamiento del script WFP (Phase 2) — sigue siendo eager en la creación, es un costo distinto (no son bases de datos, es un Worker script, sin el mismo problema de límite de cantidad).

## 6. Checklist

1. Nuevo valor de enum `turso_status = 'not_provisioned'` + `'ready_provisioning'`; `createBox()` deja de llamar a `createBoxDatabase`/`ensureBoxSchema`.
2. `ensureBoxProvisioned(env, boxId)` en control-plane, con el manejo de carrera de §3.
3. `internal.js#GET /api/internal/boxes/:id/db` llama a `ensureBoxProvisioned` cuando `turso_status === 'not_provisioned'`.
4. Confirmar que `applyAnalysis`, el tool `create_table`, y el editor manual de tablas heredan el comportamiento vía el endpoint interno (no requieren cambio propio) — o agregar la llamada explícita si el flujo real no pasa por ahí.
5. (Opcional, §4) mantener eager para templates con `sample_rows` precargadas.
6. Tests: crear box → `turso_status='not_provisioned'`, sin llamada a Turso; primer `create_table`/upload dispara el aprovisionamiento y deja `turso_status='ready'`; dos requests concurrentes no crean dos bases (mock de `createBoxDatabase` contando llamadas); box que nunca usa datos nunca aprovisiona (verificar contando llamadas a lo largo de un test de creación + servir HTML + nunca tocar datos).
