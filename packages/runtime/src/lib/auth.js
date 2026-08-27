// src/lib/auth.js — helpers de auth compartidos entre dataApi.js y debugPanel.js.
// Extraído de dataApi.js sin cambios de comportamiento.

export function controlPlaneHeaders(env, request) {
  const headers = new Headers()
  const cookie = request.headers.get('Cookie')
  if (cookie) headers.set('Cookie', cookie)
  if (env.HTMLBOX_INTERNAL_SECRET) {
    headers.set('X-HTMLBox-Internal-Secret', env.HTMLBOX_INTERNAL_SECRET)
  }
  return headers
}

// Lee la sesión desde cookie de control-plane. Devuelve { userId, tenantId, isPlatformOwner, role } o null.
export async function readSession(env, request) {
  const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
  if (!origin) return null
  const headers = controlPlaneHeaders(env, request)
  const res = await fetch(`${origin}/api/internal/whoami`, { headers })
  if (!res.ok) return null
  return await res.json()
}

// Devuelve { ok, role: 'owner'|'editor'|'viewer'|null, error? }.
export async function checkMembership(env, request, boxId) {
  const sess = await readSession(env, request)
  if (!sess) return { ok: false, error: 'unauthenticated' }
  if (sess.isPlatformOwner) return { ok: true, role: 'owner', userId: sess.userId }

  const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
  const headers = controlPlaneHeaders(env, request)
  const res = await fetch(`${origin}/api/internal/boxes/${encodeURIComponent(boxId)}/membership`, { headers })
  if (!res.ok) return { ok: false, error: 'forbidden' }
  const data = await res.json()
  if (!data.membership) return { ok: false, error: 'forbidden' }
  return { ok: true, role: data.membership.role, userId: sess.userId }
}