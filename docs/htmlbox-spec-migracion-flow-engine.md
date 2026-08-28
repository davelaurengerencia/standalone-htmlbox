# HTMLBox — Spec: migración del backend a `_flow-engine`

## 0. Antes de nada — lo que hay que saber de las dos piezas

**HTMLBox hoy**: ~4000 líneas de handlers repartidos en `control-plane` (`boxes.js`, `uploads.js`, `ai.js`, `tenantAppUsers.js`, `internal.js`, `auth.js`, `tenants.js`) y `runtime` (`resolver.js`, `htmlServer.js`, `dataApi.js`, `appAuth.js`, `appAuthRoutes.js`, `appDataApi.js`, `tenantAppAuth.js`, `csv.js`, `debugPanel.js`). Buena parte es lógica security-sensitive ya auditada y con fixes verificados por mí en esta misma conversación: cookies con `Path`/`Domain` scoped correctamente, validación de rol antes de cada mutación admin, cruce de `tenant_id` dentro de la función de chequeo (no solo en el caller), slugs validados contra regex antes de interpolar en SQL, escape de XSS real en las páginas de verificación de magic link, anti-enumeración en signup.

**`_flow-engine` hoy** (revisado recién, `arquitectura.md` + código): es un runtime de flujos tipo Node-RED, agnóstico de negocio, con nodos `http-in`/`http-request`/`http-response`/`turso`/`flexdb`(tablas)/`function`/`switch`/`change`/etc. **Pero corre hoy sobre Node.js, no sobre Cloudflare Workers** — el `wrangler.jsonc` que tiene es un placeholder explícitamente marcado "no se usa aún", y "mover `server.js`/`app.js` a un Worker real" figura como pendiente sin resolver en su propio documento de arquitectura. El contexto de flujo/global vive en memoria del proceso Node (se pierde al reiniciar; en Workers necesitaría Durable Objects/KV, todavía sin diseñar). El nodo `function` (código JS libre) corre con `new Function` **sin sandbox real** — el propio doc dice textual: "antes de exponerlo a cualquier tenant externo" queda pendiente.

**Conclusión de esto**: no es una migración de "cambiar dónde vive el código", es depender de una pieza que todavía no corre en el mismo entorno de producción que HTMLBox (Cloudflare Workers) y que no tiene sandboxing de código ni persistencia durable resueltos. Migrar TODO el backend de un saque cambiaría la base de un sistema ya endurecido por una etiquetada por su propio equipo como "casi producción". Por eso esta spec es fasada, no un big-bang, y dejo la capa de auth/sesión/cookies para el final, condicionada a que flow-engine tenga su port a Workers real.

## 1. Prerrequisito de infraestructura (bloqueante para cualquier fase que sirva tráfico real)

Antes de mover una sola ruta de HTMLBox: `_flow-engine` necesita correr en Cloudflare Workers de verdad, no en Node. Esto es trabajo de flow-engine, no de HTMLBox, pero HTMLBox no puede empezar sin esto:

1. Puerto de `app.js`/`engine/runtime.js`/`nodes/*` a un Worker (`worker/index.js`) — el propio doc dice que `engine/` y `nodes/` deberían poder reusarse "sin cambios" porque ya usan `@tursodatabase/serverless` (el driver fetch-only, compatible con Workers desde el día 1 — confirmado en los comentarios de `turso.js`).
2. Contexto flow/global: reemplazar el Map en memoria por Durable Objects (uno por instancia de flow-engine, ej. uno por box) o KV, según si el patrón de uso necesita fuerte consistencia (DO) o alcanza con eventual (KV). Recomiendo Durable Objects — el contexto de un flujo por box es exactamente el caso de uso de un DO (estado por-entidad, aislado, con fuerte consistencia).
3. Nada de esto lo escribe HTMLBox — es la condición de entrada. Si flow-engine no tiene su Worker real, esta spec no avanza más allá de la Fase 1 (que corre igual sobre Node, ver abajo).

## 2. Fases

### Fase 1 — piloto de bajo riesgo: la data API de un box nuevo, sin auth (Node, sin esperar el Worker)

Objetivo: validar el patrón "un flow reemplaza un handler" con la pieza de MENOR riesgo — `handleDataApi` (la data API genérica de un box, `packages/runtime/src/lib/dataApi.js`, la que consume `HTMLBox.table(slug).rows()` del SDK) — antes de tocar nada con sesión/cookie/tenant. Esto se puede prototipar HOY mismo sobre Node (`app.js`/`server.js` locales), sin esperar el Worker de flow-engine, justo para validar el patrón sin comprometer producción.

- 1 flow por operación: `GET /api/data/{boxId}/tables/{slug}/rows` → `http-in` (GET) → nodo `turso` (operación `select`, Conexión = la base Turso del box) → `http-response`.
- El nodo `flexdb`/tables encaja mejor todavía si el objetivo final es que un tenant pueda declarar sus propias tablas sin migración — que es justo el motivo por el que existe ese nodo.
- **Qué NO entra en esta fase**: nada de `owner_user_id`/sesión de customer — la spec de app-customers depende de eso, y mezclar sesión con este piloto contamina la validación. Esta fase es solo lectura/escritura de tablas de negocio del box, sin filtro por usuario.

### Fase 2 — CRUD del box + IA (control-plane, sirviendo desde el Worker real de flow-engine)

Ya requiere que el prerrequisito de §1 esté resuelto (Worker real). Mueve:
- `routes/boxes.js` (crear/listar/borrar box) — CRUD simple sobre D1, mapea 1:1 a flows con nodo `turso`/D1 equivalente (`_flow-engine` hoy solo tiene nodo `turso`, no `d1` — hace falta un nodo `d1` nuevo, o usar Turso también para la metadata de HTMLBox en vez de D1, decisión aparte).
- `routes/uploads.js` (publicar versión — el flujo `BUCKET.put` + `recordVersion` + `purgeIfOverLimit`) — necesita un nodo `r2` nuevo (no existe en el catálogo hoy).
- `routes/ai.js` (`applyAnalysis`) — se beneficia de flows porque ya es un pipeline (extraer candidatos → llamar IA → crear tablas → insertar filas → reescribir HTML) que hoy vive como una función larga; como flow sería más legible y más fácil de tocar sin re-leer 300 líneas.

**Nodos nuevos que hacen falta en `_flow-engine` antes de esta fase**: `d1` (o decisión de mover metadata a Turso), `r2` (get/put/delete/list), y un nodo o `function` con acceso a la IA (Gemini) — hoy no hay nodo de LLM en el catálogo.

### Fase 3 — auth/sesión/cookies (LA ÚLTIMA, la más riesgosa)

Todo lo de `appAuth.js`, `appAuthRoutes.js`, `appDataApi.js` (customers, `owner_user_id`), `tenantAppAuth.js` (usuarios centralizados fase 3), y `auth.js`/`tenants.js` de control-plane (sesión de plataforma). Esta es la capa que yo mismo audité y donde encontré 4 vulnerabilidades reales hace poco — cookies con `Path`/`Domain` mal scoped, falta de chequeo de rol, cruce de tenant faltante. Migrar esto a flows exige, como mínimo:

- Que el nodo `function` tenga sandbox real (pendiente explícito de flow-engine) — código que genera/valida cookies httpOnly, firma tokens, hace magic links, es exactamente el tipo de código que NO debería correr con `new Function` sin aislamiento.
- Reproducir en flows cada uno de los invariantes de seguridad ya verificados: Path de cookie determinístico por `boxId` (no por Referer), anti-enumeración en signup, cruce de `tenant_id` dentro del nodo de chequeo (no solo en el caller), XSS-escape en las páginas HTML de verificación.
- Una revisión de seguridad completa de esta fase antes de servir tráfico real — mismo nivel de rigor que el anexo que ya hice, no menos, porque el motor cambió.

**No arrancar esta fase hasta que Fase 2 esté en producción y estable.** Es deliberado: cada fase valida el patrón con menos riesgo antes de tocar lo más sensible.

## 3. Qué se gana (para que quede claro que no es solo cautela — hay valor real)

- Los flujos de `boxes.js`/`uploads.js`/`ai.js` HOY son funciones JS largas que solo se entienden leyendo el código. Como flow, David los ve completos de un vistazo — es literalmente lo que pidió ("me gusta ver todo, como lo tengo hecho").
- `flexdb`/tables ya resuelve gratis algo que HTMLBox no tiene: que un tenant declare sus propias tablas sin pedir una migración — encaja con la dirección de la feature de IA que ya se speció (`aiApply` crea tablas Turso a partir de HTML). Se podría rehacer `applyAnalysis` como un flow que usa el nodo `flexdb` en vez de SQL crudo (`physicalTableSqlFor`) — mismo resultado, menos código propio de HTMLBox que mantener.
- Nodos que ya existen (`turso`, `http-request`, `switch`, `template`) se reusan tal cual — no hay que reinventarlos.

## 4. Fuera de alcance de esta spec

- No se decide todavía si D1 (metadata de HTMLBox) se reemplaza por Turso o si se agrega soporte D1 al catálogo de nodos — es una decisión de Fase 2, no de esta spec.
- No se resuelve el sandboxing del nodo `function` — es trabajo de `_flow-engine`, prerrequisito de Fase 3, no algo que esta spec implemente.
- No se migra el editor del portal (Monaco) ni el flujo de publicación de HTML en sí (sigue siendo R2 + versión, con o sin flow-engine detrás).
- No se decide todavía si el EDITOR de flujos (con token único compartido, sin roles) queda expuesto a los tenants o solo al equipo interno de HTMLBox — dado que hoy es un token único sin usuarios/roles, por ahora asumo que el editor de flows queda como herramienta INTERNA del equipo de HTMLBox (igual que ya es para SIVOCLOUD), no algo que un tenant de HTMLBox toque directamente.

## 5. Checklist

1. Confirmar con el equipo de flow-engine el estado real de "Worker real" — si ya arrancó o sigue en el backlog, define cuándo puede empezar la Fase 2.
2. Fase 1: prototipar 2-3 flujos de `dataApi.js` sobre Node local, comparar contra el comportamiento actual (mismos tests, mismo resultado).
3. Agregar los nodos que faltan al catálogo (`d1` o decisión Turso-only, `r2`, LLM) antes de Fase 2.
4. Fase 2: migrar `boxes.js`/`uploads.js`/`ai.js`, con los tests actuales como criterio de aceptación (deben seguir pasando contra los flows, no solo contra el código viejo).
5. Fase 3: NO empezar hasta que Fase 2 esté estable en producción. Cuando arranque: sandboxing del nodo `function` resuelto primero, después migrar auth/cookies, y cerrar con una auditoría de seguridad completa antes de cortar tráfico real hacia los flows.
6. En cada fase: correr en paralelo (flow vs código actual) contra los mismos requests antes de cortar el tráfico real — no reemplazar de un salto sin comparación lado a lado.
