// src/lib/resolver.js — resuelve un box a partir del request.
//
// Modos:
//   - Público:   https://htmlbox.dev/s/{shareId}            (sin auth)
//   - Privado:   https://{tenantSlug}.htmlbox.dev/{boxSlug}  (con sesión)
//   - Privado:   https://htmlbox.dev/t/{tenantSlug}/{boxSlug}  (path-based, sin wildcard DNS)
//
// Caching en KV: `box:{shareId}` → { boxId, tenantSlug, visibility }
//                `box:{tenant}:{boxSlug}` → { boxId, tenantSlug, visibility }
//                TTL 5 min; el control-plane invalida al crear/editar.

import { isValidBoxSlug, isValidTenantSlug } from '@htmlbox/shared'

const KV_TTL_SEC = 300

function k(parts) {
  return `box:${parts.join(':')}`
}

async function fetchControlPlane(env, path, request) {
  const origin = env.HTMLBOX_CONTROL_PLANE_ORIGIN
  if (!origin) throw new Error('resolver: HTMLBOX_CONTROL_PLANE_ORIGIN no configurado')
  const headers = new Headers()
  // Reenviamos la cookie de sesión para que el control-plane autorice.
  const cookie = request.headers.get('Cookie')
  if (cookie) headers.set('Cookie', cookie)
  const res = await fetch(`${origin}${path}`, { headers })
  return res
}

// Resuelve por shareId (público).
export async function resolveByShareId(env, shareId, request) {
  if (!shareId || !/^[a-z0-9]{6,20}$/.test(shareId)) return null
  if (env.CACHE) {
    const cached = await env.CACHE.get(k(['s', shareId]))
    if (cached) {
      try { return JSON.parse(cached) } catch { /* ignore */ }
    }
  }
  const res = await fetchControlPlane(
    env,
    `/api/internal/boxes-by-share/${encodeURIComponent(shareId)}`,
    request,
  )
  if (!res.ok) return null
  const data = await res.json()
  if (!data.box) return null
  const out = {
    boxId: data.box.id,
    tenantSlug: data.box.tenant_slug,
    boxSlug: data.box.slug,
    visibility: data.box.visibility,
  }
  if (env.CACHE) await env.CACHE.put(k(['s', shareId]), JSON.stringify(out), { expirationTtl: KV_TTL_SEC })
  return out
}

// Resuelve por tenantSlug + boxSlug (privado).
export async function resolveByTenantAndSlug(env, tenantSlug, boxSlug, request) {
  if (!isValidTenantSlug(tenantSlug)) return null
  if (!isValidBoxSlug(boxSlug)) return null
  if (env.CACHE) {
    const cached = await env.CACHE.get(k(['t', tenantSlug, boxSlug]))
    if (cached) {
      try { return JSON.parse(cached) } catch { /* ignore */ }
    }
  }
  const res = await fetchControlPlane(
    env,
    `/api/internal/boxes-by-slug/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(boxSlug)}`,
    request,
  )
  if (!res.ok) return null
  const data = await res.json()
  if (!data.box) return null
  const out = {
    boxId: data.box.id,
    tenantSlug: data.box.tenant_slug,
    boxSlug: data.box.slug,
    visibility: data.box.visibility,
  }
  if (env.CACHE) await env.CACHE.put(k(['t', tenantSlug, boxSlug]), JSON.stringify(out), { expirationTtl: KV_TTL_SEC })
  return out
}

export function parseRuntimePath(url) {
  // /s/{shareId}
  const s = url.pathname.match(/^\/s\/([a-z0-9]{6,20})\/?$/)
  if (s) return { mode: 'public', shareId: s[1] }

  // /t/{tenantSlug}/{boxSlug}  — path-based private (alternativa al subdomain
  // cuando el wildcard DNS *.htmlbox.dev no está disponible).
  const tp = url.pathname.match(/^\/t\/([a-z0-9][a-z0-9-]{0,38}[a-z0-9])\/([a-z][a-z0-9_-]{0,62}[a-z0-9])\/?$/)
  if (tp) return { mode: 'private', tenantSlug: tp[1], boxSlug: tp[2] }

  // /{boxSlug}  — en host con subdomain {tenant}.htmlbox.dev
  const p = url.pathname.match(/^\/([a-z][a-z0-9_-]{0,62}[a-z0-9])\/?$/)
  if (p) {
    const host = url.hostname
    let tenantSlug
    if (host.endsWith('.htmlbox.dev')) {
      tenantSlug = host.slice(0, -('.htmlbox.dev'.length))
    } else if (host.endsWith('.localhost')) {
      tenantSlug = host.slice(0, -('.localhost'.length))
    } else if (host === 'localhost') {
      tenantSlug = requestHeaderFromEnv()
    }
    if (tenantSlug) return { mode: 'private', tenantSlug, boxSlug: p[1] }
  }
  return null
}

function requestHeaderFromEnv() {
  return null
}