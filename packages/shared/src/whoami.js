// src/whoami.js — helper compartido para validar sesión de plataforma.
//
// Lee la cookie `sid` del request, busca la sesión en htmlbox_sessions
// (compartida entre control-plane y auth via el mismo D1), y devuelve los
// datos del user logueado o null.
//
// Usado por:
//   - `routes/internal.js::whoami` (runtime → control-plane, server-to-server)
//   - endpoint público `GET /api/auth/me` en control-plane (browser)
//
// El endpoint /api/auth/me se re-introdujo después de migrar auth.js al
// paquete `auth` — la UI admin y portal lo necesitan para saber si hay
// sesión activa sin tener que pegarle al Worker `auth` (que está pensado
// para browser, no para APIs internas).

export async function whoamiFromCookie(env, request) {
  const sid = readCookie(request, 'sid')
  if (!sid) return null
  const sess = await env.DB.prepare(
    `SELECT u.id AS user_id, u.email, u.tenant_id, u.is_platform_owner
       FROM htmlbox_sessions s
       JOIN htmlbox_users u ON u.id = s.user_id
      WHERE s.id = ?1 AND datetime(s.expires_at) > datetime('now')`
  ).bind(sid).first()
  if (!sess) return null
  return {
    userId: sess.user_id,
    email: sess.email,
    tenantId: sess.tenant_id,
    isPlatformOwner: !!sess.is_platform_owner,
  }
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || request.headers.get('cookie') || ''
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}
