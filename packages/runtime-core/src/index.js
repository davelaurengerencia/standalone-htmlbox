// src/index.js — entry point de @htmlbox/runtime-core.
//
// Paquete compartido entre:
//   - el runtime dispatcher (packages/runtime/src/worker.js) — resuelve y sirve boxes
//   - el script per-box de WFP (Phase 2) — recibe args y sirve el HTML aislado
//
// Contiene piezas PURAS del runtime que no tienen dependencias de auth/data-api —
// solo dependencias mínimas (HTML/R2/KV/Control-plane HTTP). Toda la auth
// security-sensitive (sessions, cookies, role checks) vive en
// packages/runtime/src/lib/{appAuth,appAuthRoutes,appDataApi,tenantAppAuth}.js
// y no se mueve a runtime-core (mantiene el blast radius acotado).

export {
  controlPlaneHeaders,
  readSession,
  checkMembership,
} from './auth.js'

export {
  securityHeaders,
  readActiveHtml,
  injectSdk,
  injectDebugPanel,
  serveBoxHtml,
} from './htmlServer.js'

export {
  resolveByShareId,
  resolveByTenantAndSlug,
  parseRuntimePath,
} from './resolver.js'

export { shouldShowDebugPanel } from './debugPanel.js'

// Constantes compartidas dispatcher ↔ per-box script (Phase 2).
// BOX_ID_HEADER: canal de identidad (dispatcher → script).
// BOX_ID_PATTERN: regex del boxId, mismo que ya usaba cookiePathForBox.
// isWorkerNotFoundError: predicado para detectar "script no existe en
// el namespace" y caer al path viejo sin propagar el error.
export { BOX_ID_HEADER, BOX_ID_PATTERN, isWorkerNotFoundError } from './boxDispatch.js'
