# HTMLBox — Spec: consolidar la arquitectura hacia el potencial real de Workers for Platforms

David: la decisión original ("el script del box se crea una vez, nunca se redeploya al publicar HTML") venía de pensar el script del box como un simple *proxy* — su único trabajo era reenviar la identidad y dejar que control-plane resolviera todo. Esa premisa ya no aplica: con WFP cada box tiene su propio isolate real, con su propio set de bindings (secrets, vars, R2, D1 si hiciera falta) fijado en el momento del deploy. Esta spec redefine el script del box como una unidad de cómputo real, no un túnel, y consolida todo lo que hoy pasa por control-plane en cada request hacia bindings directos del propio script — con redeploys como una operación normal y barata, no algo a evitar.

## 0. Qué cambia de fondo

Hoy: `deployBoxWorker()` se llama UNA vez, en `createBox()` (`routes/boxes.js`). El script queda fijo con 2 bindings (`BUCKET` sin usar, `HTMLBOX_CONTROL_PLANE_ORIGIN`) para siempre. Cada request de un box público hace un fetch completo a `control-plane/api/boxes/{id}/active-html` — el binding de R2 que ya tiene declarado nunca se toca.

Ahora: el script del box es la unidad que se actualiza cada vez que algo que le pertenece cambia — no solo al crearse. Redeploy deja de ser un evento raro y pasa a ser parte normal del ciclo de vida, con la misma lógica best-effort que ya existe hoy para el deploy inicial (`wfp_status`, fallback al path viejo si falla).

## 1. Qué SÍ conviene mover a bindings directos — y qué no

**Turso (secrets)** — sí, sin duda. `TURSO_DB_URL`/`TURSO_DB_TOKEN` como `secret_text` bindeados directo al script del box. Elimina el hop a `/api/internal/boxes/{id}/db` que hoy hace `resolveBoxDb()` en cada operación de datos. Redeploy se dispara cuando Turso se aprovisiona (conecta directo con `htmlbox-spec-provisioning-lazy.md` — `ensureBoxProvisioned()` pasa a terminar con un redeploy, no solo con un UPDATE en D1) o cuando se rota el token.

**Secrets/vars por app (lo que pediste — "sección de variables y secrets por app")** — sí, es la pieza nueva de esta spec. Ver §3.

**HTML del box** — acá NO recomiendo inline-en-el-bundle, y quiero ser explícito sobre por qué, porque es la parte donde "aprovechar WFP al máximo" podría llevar a un diseño peor:

- El binding `BUCKET` (R2) ya está declarado y sin usar. Activarlo — que el propio script del box lea su HTML de `env.BUCKET.get(key)` en vez de hacer `fetch()` a control-plane — ya elimina el round-trip actual, sin necesitar redeploy en cada publish. Es la mejora de más impacto y menor riesgo de toda esta spec.
- Meter el HTML DENTRO del bundle (como código/string embebido) sí sería más rápido todavía (cero I/O en el request), pero acopla "publicar contenido" con "redeployar un Worker" — cada guardado del usuario en el portal pasaría a depender de la API de deploy de Cloudflare (latencia real, rate limits documentados por Cloudflare para `workers/dispatch/namespaces/*/scripts`, y un fallo ahí ya no es "sirvo la versión vieja de R2" sino "el publish entero falló"). `MAX_HTML_BYTES` es 2 MB — entra cómodo en el límite de bundle (10 MB comprimido en plan pago), así que es *posible*, pero no es gratis.
- **Recomendación**: separar los dos ciclos. Publish de HTML = escribir a R2 + flip de puntero en D1 (como ya funciona hoy), el script del box lee ese R2 con su binding directo — sin redeploy. Redeploy = solo cuando cambian bindings (secrets, vars, Turso). Esto es "consolidar hacia el potencial de WFP" en la parte que importa (bindings reales, secrets reales, menos hops) sin heredar el costo operativo de redeployar en el hot path de guardar contenido.

Si igual preferís inline-en-bundle porque querés latencia mínima absoluta y aceptás el trade-off, decímelo explícito y lo diseñamos así — pero como recomendación técnica, separar publish de redeploy es lo que yo haría.

**D1** — igual que ya hablamos: no aplica a los datos del box (eso es Turso). Sí podría aplicarse a algo nuevo y chico que quieran materializar por-box (cache local de config, por ejemplo), pero no hay un caso concreto todavía — lo dejo fuera de esta spec hasta que haya uno.

## 2. `redeployBoxWorker()` — un solo punto de entrada para todos los triggers

Hoy `deployBoxWorker()` se llama solo desde `createBox()`. Nueva función que la envuelve, reusada desde cada trigger:

```js
// lib/wfpDeployer.js
export async function redeployBoxWorker(env, accountId, namespace, boxId, reason) {
  // reason: 'create' | 'secrets_updated' | 'turso_provisioned' | 'turso_rotated'
  // Mismo PUT que deployBoxWorker, pero SIEMPRE recalcula bindings desde
  // el estado actual en D1 (turso creds, secrets del box) — no reusa el
  // metadata del deploy anterior.
  const bindings = await buildBindingsForBox(env, boxId)   // nuevo — ver §3
  ...
  // Actualiza wfp_status/wfp_error igual que hoy, + wfp_last_deploy_reason
  // + wfp_last_deployed_at (nuevo, para debug/auditoría en el dashboard).
}
```

Triggers que lo llaman:
1. `createBox()` — igual que hoy (`reason: 'create'`), pero ahora con `buildBindingsForBox()` en vez de `buildBindings()` fijo (aunque al crear, probablemente no haya secrets/Turso todavía — bindings mínimos).
2. `ensureBoxProvisioned()` (spec 02) — al terminar de aprovisionar Turso, redeploy con las creds ya como secret binding (`reason: 'turso_provisioned'`).
3. Nuevo endpoint de secrets/vars (§3) — al guardar cualquier cambio (`reason: 'secrets_updated'`).
4. Rotación de token Turso (si/cuando se implemente) — `reason: 'turso_rotated'`.

Todos best-effort, mismo criterio que ya existe: si el redeploy falla, el box sigue funcionando con los bindings viejos (o cae al fallback del dispatcher si el script no existe todavía) — nunca bloquea la operación que lo disparó (guardar un secret no debería fallar porque Cloudflare tuvo un 500 transitorio en el deploy).

## 3. Variables y Secrets por app — la pieza de producto nueva

Nueva tabla D1, `htmlbox_box_env`:

```sql
CREATE TABLE htmlbox_box_env (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  box_id TEXT NOT NULL REFERENCES htmlbox_boxes(id),
  key TEXT NOT NULL,                    -- validado /^[A-Z][A-Z0-9_]{0,63}$/ (convención de env var)
  kind TEXT NOT NULL,                   -- 'var' | 'secret'
  value_encrypted TEXT,                 -- NULL si kind='var' (esas van en plano, ver abajo)
  value_plain TEXT,                     -- NULL si kind='secret'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(box_id, key)
);
```

- **`var`**: valor visible, se guarda en plano (`value_plain`), se refleja en la UI del portal siempre. Va al script como `plain_text` binding.
- **`secret`**: valor NUNCA se vuelve a mostrar después de guardado (mismo patrón UX que cualquier secret manager — Vercel, Cloudflare dashboard, GitHub Actions). Se cifra en reposo con AES-GCM usando una clave derivada de `HTMLBOX_SECRETS_KEK` (nueva var/secret de control-plane, distinta de `HTMLBOX_SESSION_SECRET` — no reusar secrets entre dominios de uso distintos). Va al script como `secret_text` binding — Cloudflare también cifra esto en su lado, pero el valor no debe quedar legible en D1 de control-plane tampoco (defense in depth: si D1 se filtra, los secrets de los tenants no salen en texto plano).

`buildBindingsForBox(env, boxId)`:
```js
async function buildBindingsForBox(env, boxId) {
  const bindings = [
    { type: 'r2_bucket', name: 'BUCKET', bucket_name: ... },
    { type: 'plain_text', name: 'HTMLBOX_CONTROL_PLANE_ORIGIN', text: ... },
  ]
  const box = await getBoxRow(env, boxId)   // incluye turso_db_url/token si ya provisionado
  if (box.turso_db_url && box.turso_db_token) {
    bindings.push({ type: 'secret_text', name: 'TURSO_DB_URL', text: box.turso_db_url })
    bindings.push({ type: 'secret_text', name: 'TURSO_DB_TOKEN', text: box.turso_db_token })
  }
  const envRows = await env.DB.prepare(`SELECT key, kind, value_encrypted, value_plain FROM htmlbox_box_env WHERE box_id = ?1`).bind(boxId).all()
  for (const row of envRows.results) {
    if (row.kind === 'secret') {
      bindings.push({ type: 'secret_text', name: row.key, text: await decrypt(env, row.value_encrypted) })
    } else {
      bindings.push({ type: 'plain_text', name: row.key, text: row.value_plain })
    }
  }
  return bindings
}
```

Límite: Cloudflare permite hasta 5000 bindings por script en teoría, pero un límite práctico razonable acá es ~50 vars+secrets por box (mismo orden de magnitud que ya usan `postBulkCreate` para tablas/columnas) — evita que alguien use esto como un KV store improvisado.

### UI en el portal

Nueva sección "Variables y Secrets" en la vista de cada box (junto a donde hoy está el editor y el modal de IA). Tabla simple: `key | kind (var/secret) | valor (mostrado si var, "•••• (guardado)" si secret) | Eliminar`. Botón "Agregar variable" → modal con `key`, toggle var/secret, `value`. Guardar dispara `POST /api/boxes/{id}/env` → escribe en `htmlbox_box_env` → llama `redeployBoxWorker(reason: 'secrets_updated')`.

Conecta directo con la detección de `external_integration` de `htmlbox-spec-ai-analyze-robusto.md`: cuando el análisis detecta que la app llama a una API externa (Shopify, Stripe, etc.), el modal de "Analizar con IA" puede sugerir "esta app parece necesitar una API key de {dominio detectado} — ¿querés agregarla en Variables y Secrets?" con un atajo directo a esta sección, en vez de que el dueño tenga que pegar la key directo en el HTML (que hoy sería la única opción, y expondría la key en el cliente).

## 4. Qué pasa con el HTML del box en runtime (con el binding R2 activado)

`wrapper.mjs` cambia de esto:
```js
const res = await fetch(`${origin}/api/boxes/${boxId}/active-html`, { headers })
```
a resolver directo contra `env.BUCKET` para boxes públicos, usando la misma key que ya usa `boxVersionKey(tenantSlug, boxId, version)` — pero necesita saber CUÁL es la versión activa sin preguntarle a control-plane. Dos opciones:

- **(a)** el dispatcher (`runtime/src/worker.js`) ya conoce `htmlbox_version` (lo tiene en D1) y lo pasa como header nuevo (`X-HTMLBox-Active-Version`) junto con los 4 que ya manda — el box-worker arma la key y lee directo de R2, cero fetch.
- **(b)** el box-worker cachea la versión activa en KV con TTL corto (unos segundos) para no depender de que el dispatcher se la pase.

Recomiendo (a) — es consistente con el patrón ya establecido de "el dispatcher es la fuente de verdad de identidad, el box-worker confía en sus headers pero los revalida con regex" (mismo criterio anti-spoofing que ya aplica a `boxId`/`tenantSlug`).

Para boxes **privados**: la validación de sesión (`Cookie` → `validateSession`) sigue necesitando ir a control-plane — eso no se resuelve con bindings (el session store es D1 de control-plane, no algo que tenga sentido replicar por-box). Esta spec no cambia esa parte: privados siguen pagando el round-trip de auth; públicos dejan de pagar cualquier round-trip.

## 5. Riesgos y qué NO se resuelve acá

- **Rate limits de la API de deploy de Cloudflare**: si `secrets_updated` se dispara en cada tecla de un formulario mal debounced, se puede pegar contra el límite de la API de scripts. El endpoint de guardar env vars debe ser explícito ("Guardar cambios", no autosave por campo) — mismo criterio que ya aplica al publish de HTML (`postPushHtml` es un submit explícito, no autosave por keystroke).
- **Redeploy en progreso vs. request concurrente**: mientras un redeploy está en vuelo, requests al box siguen sirviendo con el script/bindings viejos hasta que el PUT de Cloudflare confirma — no hay downtime, pero puede haber una ventana corta donde un secret recién guardado todavía no está disponible. Aceptable, mismo tipo de eventual consistency que ya existe en el flujo de creación de box.
- **Migración retroactiva**: boxes ya deployados con el `buildBindings()` viejo (2 bindings fijos) no se re-deployan solos con este cambio — necesitan un redeploy explícito (podría ser un script de mantenimiento uno-a-uno, o esperar al primer trigger natural — guardar un secret, aprovisionar Turso). No lo resuelvo acá, lo dejo como tarea de rollout.
- **No se resuelve** todavía cómo el box-worker validaría sesión de boxes privados SIN ir a control-plane (JWT firmado localmente, por ejemplo) — es una optimización real pero es un cambio de modelo de auth más grande, fuera de esta spec.

## 6. Checklist

1. `buildBindingsForBox(env, boxId)` en `wfpDeployer.js` — reemplaza `buildBindings()` fijo, arma bindings desde Turso creds (si existen) + `htmlbox_box_env`.
2. `redeployBoxWorker(env, accountId, namespace, boxId, reason)` — wrapper sobre `deployBoxWorker`, un solo punto de entrada, trackea `wfp_last_deploy_reason`/`wfp_last_deployed_at` (columnas nuevas en `htmlbox_boxes`).
3. Migración D1: tabla `htmlbox_box_env` + columnas nuevas en `htmlbox_boxes`.
4. Cifrado: `HTMLBOX_SECRETS_KEK` (secret nuevo de control-plane) + helpers `encrypt`/`decrypt` (AES-GCM) para `value_encrypted`.
5. `POST/GET/DELETE /api/boxes/:id/env` — CRUD de variables/secrets, dispara `redeployBoxWorker(reason: 'secrets_updated')` en cada cambio.
6. `ensureBoxProvisioned()` (spec 02) termina con `redeployBoxWorker(reason: 'turso_provisioned')` en vez de solo actualizar D1.
7. `wrapper.mjs`: leer HTML de `env.BUCKET` usando la versión que llega por header nuevo `X-HTMLBox-Active-Version` (agregado por el dispatcher), en vez de `fetch()` a control-plane — solo para boxes públicos; privados mantienen el fetch actual para la validación de sesión.
8. UI del portal: sección "Variables y Secrets" por box, con el atajo desde el modal de IA cuando detecta `external_integration`.
9. Tests: `buildBindingsForBox` arma el array correcto con/sin Turso/env vars, cifrado/descifrado roundtrip, redeploy no bloquea la operación que lo disparó si Cloudflare devuelve error, box público sirve HTML sin ningún fetch a control-plane (mock de R2 real, no solo mock de fetch), box privado sigue validando sesión igual que hoy, límite de ~50 env vars por box se respeta.
