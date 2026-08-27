// src/boxDispatch.js — constantes y predicados compartidos entre el
// dispatcher (packages/runtime) y el per-box script (Phase 2).
//
// El header X-HTMLBox-Box-Id es el canal por el que el dispatcher pasa
// la identidad del box al per-box script. Ambos lados importan este
// módulo para evitar drift — si alguien renombra el header en un solo
// lado, el spec test del runtime-core no detecta el cambio (es string
// puro), pero al menos el contrato vive en un lugar único y un grep
// `BOX_ID_HEADER` encuentra las referencias.

// El header es deliberadamente NO estándar (prefijo X-) porque no
// debería tener semántica de proxy — solo entre dispatcher y per-box
// script corriendo en el mismo isolate WFP de Cloudflare.
export const BOX_ID_HEADER = 'X-HTMLBox-Box-Id'

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
