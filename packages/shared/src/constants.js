// src/constants.js — constantes globales del producto.
//
// Regla fija de arquitectura §2: todo recurso lleva el prefijo `htmlbox-`.

export const PREFIX = 'htmlbox'

export const D1_NAME_CONTROL_PLANE = `${PREFIX}-control-plane`
export const R2_BUCKET_CONTENT = `${PREFIX}-content`
export const KV_NAMESPACE_CACHE = `${PREFIX}-cache`

export const TURSO_GROUP = `${PREFIX}`                // todas las DBs nacen en este group
export const TURSO_DB_NAME_PREFIX = `${PREFIX}-box-`  // htmlbox-box-{boxId}
export const TURSO_DB_NAME_REGEX = new RegExp(`^${TURSO_DB_NAME_PREFIX}[a-z0-9_-]{4,}$`, 'i')

export const MAX_BOX_VERSIONS = 5                  // regla §11.2 — siempre 5 últimas
export const MAX_HTML_BYTES = 2 * 1024 * 1024       // 2 MB
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024     // 25 MB
export const ALLOWED_HTML_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
]

// Roles §3
export const ROLE_OWNER = 'owner'
export const ROLE_EDITOR = 'editor'
export const ROLE_VIEWER = 'viewer'
export const VALID_ROLES = [ROLE_OWNER, ROLE_EDITOR, ROLE_VIEWER]

// Visibilidad §10
export const VISIBILITY_PUBLIC = 'public'
export const VISIBILITY_PRIVATE = 'private'

// Sources de versiones §11.2
export const VERSION_SOURCE_PORTAL = 'portal'
export const VERSION_SOURCE_AGENT = 'agent'
export const VERSION_SOURCE_API = 'api'
export const VERSION_SOURCE_ROLLBACK = 'rollback'

// Cookie de sesión
export const SESSION_COOKIE_NAME = 'sid'
export const SESSION_COOKIE_DOMAIN = '.htmlbox.app'   // en dev se sobreescribe por var

// Límite de rate-limit del magic-link §3 (port de sivocloud)
export const AUTH_REQUEST_WINDOW_SEC = 60
export const AUTH_REQUEST_MAX_PER_EMAIL = 3
export const AUTH_MAGICLINK_TTL_SEC = 15 * 60
export const AUTH_SESSION_TTL_DAYS = 30

// Versión SDK expuesta en runtime
export const SDK_VERSION = '0.1.0'
export const SDK_URL = '/_sdk/htmlbox.js'