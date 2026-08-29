// src/authExchange.js — handler compartido para el endpoint /auth/exchange.
//
// Usado por `packages/portal` y `packages/control-plane`. Recibe un ticket
// de un solo uso del Worker `auth`, lo canjea server-to-server contra
// `auth.*/api/auth/exchange`, y setea la cookie `sid` host-only en el dominio
// del Worker que llama (studio.* o controlplane.*).
//
// Esto es el patrón OAuth authorization_code: nunca depende de que el browser
// comparta cookies entre subdominios (que no funciona en *.localhost por la
// Public Suffix List). El ticket tiene TTL de 60s y es de un solo uso, así
// que filtrarlo en un log/Referer tiene ventana de abuso mínima.
//
// Ver docs/htmlbox-spec-auth-centralizado.md §6.

import { buildSessionCookie } from './sessionCookies.js'

/**
 * Handler del endpoint `GET /auth/exchange?st=...&return=...`.
 *
 * @param {Request} request — el request del browser (con ?st y opcionalmente ?return)
 * @param {object} env — bindings del Worker (HTMLBOX_AUTH_ORIGIN, HTMLBOX_INTERNAL_SECRET)
 * @returns {Response} — 302 redirect con Set-Cookie si OK, 400 si ticket inválido
 */
export async function handleAuthExchange(request, env) {
  const url = new URL(request.url)
  const ticket = url.searchParams.get('st')
  const returnTo = url.searchParams.get('return') || '/'
  if (!ticket) {
    return new Response(JSON.stringify({ error: 'missing_ticket' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const authOrigin = env.HTMLBOX_AUTH_ORIGIN
  if (!authOrigin) {
    return new Response(JSON.stringify({ error: 'auth_origin_not_configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Server-to-server: el Worker hace fetch a auth.*/api/auth/exchange con el
  // secret compartido. NO se reenvían headers del browser (el secret nunca
  // debe venir del cliente).
  let exchangeRes
  try {
    exchangeRes = await fetch(`${authOrigin}/api/auth/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-HTMLBox-Internal-Secret': env.HTMLBOX_INTERNAL_SECRET || '',
      },
      body: JSON.stringify({ ticket }),
    })
  } catch (err) {
    return new Response(JSON.stringify({
      error: 'auth_unreachable',
      detail: String(err?.message || err).slice(0, 200),
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!exchangeRes.ok) {
    return new Response(JSON.stringify({ error: 'invalid_or_expired_ticket' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { sessionId } = await exchangeRes.json()
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'auth_response_missing_session' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Seteamos cookie host-only en ESTE dominio (studio.* o controlplane.*).
  // La cookie NO tiene Domain (host-only) — el Worker `auth` ya intentó
  // setear su propia cookie pero es host-only de auth.* que no le sirve
  // al browser en studio.*/controlplane.*.
  const cookie = buildSessionCookie(request, sessionId, env)

  // Validación de `returnTo`: solo paths relativos del mismo origen (anti
  // open-redirect). Si empieza con `//` o tiene `://`, redirigir a `/`.
  const safeReturn = isSafeReturnPath(returnTo) ? returnTo : '/'

  return new Response(null, {
    status: 302,
    headers: {
      Location: safeReturn,
      'Set-Cookie': cookie,
    },
  })
}

// Open-redirect protection: solo aceptamos paths que empiezan con `/`
// y NO con `//` (que sería una URL absoluta sin esquema).
function isSafeReturnPath(p) {
  if (typeof p !== 'string') return false
  if (p.length === 0 || p.length > 2048) return false
  if (!p.startsWith('/')) return false
  if (p.startsWith('//')) return false
  if (p.includes('\\')) return false // algunos browsers interpretan \ como /
  return true
}
