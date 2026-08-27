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
