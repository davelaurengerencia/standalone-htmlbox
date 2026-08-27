// src/boxDispatch.js — constantes y predicados compartidos entre el
// dispatcher (packages/runtime) y el per-box script (Phase 2).
//
// Estos headers son el canal por el que el dispatcher pasa el contexto
// del box al per-box script. Ambos lados importan este módulo para
// evitar drift — si alguien renombra un header en un solo lado, los
// tests de runtime-core no detectan el cambio (son strings puros), pero
// el spec test del wrapper sí (busca nombres literales en dist/).
//
// Headers (todos prefijados X-HTMLBox- para evitar colisión con headers
// de proxy estándar — solo entre dispatcher y per-box script en el mismo
// isolate WFP de Cloudflare):

export const BOX_ID_HEADER = 'X-HTMLBox-Box-Id'        // 16 chars [a-z0-9]
export const TENANT_HEADER = 'X-HTMLBox-Tenant-Slug'   // slug del tenant
export const SLUG_HEADER = 'X-HTMLBox-Box-Slug'        // slug del box
export const VIS_HEADER = 'X-HTMLBox-Visibility'       // 'public' | 'private'

// boxId siempre matchea este regex. Reusar la misma regex en:
//   - dispatcher: validar antes de armar el script name "box-{boxId}"
//   - per-box script: defense-in-depth al leer el header
//   - cookiePathForBox (security fix H2): ya validaba con este mismo regex
// Es un patrón que el repo ya tiene como invariante.
export const BOX_ID_PATTERN = /^[a-z0-9]{16}$/

// Mensaje de error que lanza Cloudflare cuando .get(name) no encuentra
// el script en el dispatch namespace. Cobertura:
//   - "Worker not found."              (raw message del ejemplo oficial)
//   - "Error: Worker not found."       (algunos wranglers wrappean con prefijo)
//   - "Worker 'box-abc123' not found." (variante con nombre entre medio,
//                                        más robusta a cambios de wrangler)
//
// Usamos `Worker[\s\S]*not found` (cualquier texto entre medio) en vez
// de `Worker not found` literal porque el mensaje exacto varía entre
// versiones de wrangler. El [\s\S]* cubre nombres con guión bajo, guiones
// y espacios que Cloudflare podría intercalar en versiones futuras.
export function isWorkerNotFoundError(e) {
  if (!(e instanceof Error)) return false
  return /Worker[\s\S]*not found/i.test(e.message)
}
