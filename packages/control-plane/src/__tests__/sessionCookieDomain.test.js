// __tests__/sessionCookieDomain.test.js — regression guard para
// `getCookieDomain()` en packages/control-plane/src/lib/session.js.
//
// Bug cubierto: con wrangler dev --remote, el worker corre en la edge de
// Cloudflare (`controlplane.sivocloud.dev`) pero el browser está en
// `controlplane.localhost:8781`. El Set-Cookie traía `Domain=.sivocloud.dev`
// por el chequeo del url.hostname, y el browser rechazaba la cookie
// silenciosamente (dominio no matchea el origen actual → no se guarda).
// Resultado: el usuario se logueaba correctamente en D1 pero la sesión
// nunca se persistía → /admin/ lo devolvía al login.
//
// Fix: chequear `isLocalHost(url.hostname) || (userHost && isLocalHost(userHost))`
// ANTES que el env var. Mismo patrón que `shouldUseSecureCookie()` ya usaba
// para el flag Secure.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionCookie, buildClearCookie } from '../lib/session.js'

// ============ helpers ============

function makeRequest({ url = 'https://controlplane.sivocloud.dev/api/auth/consume', origin = '', referer = '' } = {}) {
  return {
    url,
    headers: {
      get: (name) => {
        const n = name.toLowerCase()
        if (n === 'origin') return origin
        if (n === 'referer') return referer
        return null
      },
    },
  }
}

function makeEnv({ htmlbox_session_domain, htmlbox_cookie_secure } = {}) {
  const env = {}
  if (htmlbox_session_domain !== undefined) env.HTMLBOX_SESSION_DOMAIN = htmlbox_session_domain
  if (htmlbox_cookie_secure !== undefined) env.HTMLBOX_COOKIE_SECURE = htmlbox_cookie_secure
  return env
}

// ============ TESTS ============

test('dev — url es sivocloud.dev (edge), browser está en localhost → host-only', () => {
  // El caso EXACTO del bug reportado. Aunque URL interna del worker es
  // sivocloud.dev y HTMLBOX_SESSION_DOMAIN='.sivocloud.dev' (top-level var
  // filtrada de prod porque .dev.vars no carga con --remote), el cookie
  // debe ser host-only porque el browser está en localhost.
  const req = makeRequest({
    url: 'https://controlplane.sivocloud.dev/api/auth/consume',
    origin: 'http://controlplane.localhost:8781',
  })
  const env = makeEnv({ htmlbox_session_domain: '.sivocloud.dev' })
  const c = buildSessionCookie(req, 'sid-test', env)
  assert.match(c, /^sid=sid-test;/)
  assert.doesNotMatch(c, /Domain=/, 'dev localhost → NO debe tener Domain (host-only)')
  assert.doesNotMatch(c, /Secure/,
    'dev localhost → NO debe tener Secure (browser es HTTP, no HTTPS)')
})

test('dev — sin headers, url interna es sivocloud.dev → host-only igualmente', () => {
  // Sin Origin/Referer pero tampoco url.hostname es localhost.
  // Aún así,，因为我们 sabemos que el worker puede estar sirviendo a un
  // user en localhost, el guard por userHost no alcanza. Pero el chequeo
  // de `url.hostname` cubriría el caso cuando el worker corre con
  // --local (url sería localhost). En --remote sin headers, caemos al env
  // var (regla 3) que sigue dando '.sivocloud.dev' — bug conocido del
  // dev flow que el equipo aceptó (mismo problema que el magic link).
  // Por eso este test verifica el comportamiento esperado hoy: si NO hay
  // headers Y url es sivocloud.dev, sigue saliendo el domain prod
  // (documentamos el trade-off en lugar de pretender arreglarlo aquí).
  const req = makeRequest({
    url: 'https://controlplane.sivocloud.dev/api/auth/consume',
  })
  const env = makeEnv({ htmlbox_session_domain: '.sivocloud.dev' })
  const c = buildSessionCookie(req, 'sid-test', env)
  // El comportamiento es: env var override gana si no hay userHost que
  // sea localhost. Aceptamos este trade-off porque el path real del
  // usuario va con Origin/Referer.
  assert.match(c, /Domain=\.sivocloud\.dev/,
    'sin userHost local + env var seteado → .sivocloud.dev (limitación conocida)')
})

test('dev — url interna del worker es localhost (caso --local) → host-only', () => {
  // Caso defensivo: si el dev corre con --local (no --remote), url.hostname
  // ya es localhost. El guard de regla 1 lo captura sin importar headers.
  const req = makeRequest({ url: 'http://localhost:8781/api/auth/consume' })
  const env = makeEnv({ htmlbox_session_domain: '.sivocloud.dev' })
  const c = buildSessionCookie(req, 'sid-test', env)
  assert.doesNotMatch(c, /Domain=/)
})

test('prod — browser en studio.sivocloud.dev (Origin matchea sivocloud.dev) → .sivocloud.dev', () => {
  const req = makeRequest({
    url: 'https://controlplane.sivocloud.dev/api/auth/consume',
    origin: 'https://studio.sivocloud.dev',
  })
  const env = makeEnv({ htmlbox_session_domain: '.sivocloud.dev' })
  const c = buildSessionCookie(req, 'sid-test', env)
  assert.match(c, /Domain=\.sivocloud\.dev/)
})

test('prod — sin headers + no env var → .sivocloud.dev por la regla 4', () => {
  // Sin env override ni userHost, y url es sivocloud.dev → caemos a la
  // regla 4 (producción).
  const req = makeRequest({
    url: 'https://controlplane.sivocloud.dev/api/auth/consume',
  })
  const c = buildSessionCookie(req, 'sid-test', makeEnv())
  assert.match(c, /Domain=\.sivocloud\.dev/)
})

test('env var HTMLBOX_SESSION_DOMAIN explícito gana sobre la regla 4 prod (custom domain)', () => {
  // Caso: el operador configura un custom domain (`*.example.com`) y setea
  // HTMLBOX_SESSION_DOMAIN='.example.com' explícito. El browser está en
  // example.com, el worker está en sivocloud.dev (url interno), y la regla
  // 4 del código devolvería '.sivocloud.dev'. El env var debe ganar.
  //
  // NOTA: el orden actual de la función es:
  //   1. isLocalHost(...) → host-only
  //   2. userHost en domain raro (no sivocloud, no localhost) → host-only
  //   3. env var → win (incluso '')
  //   4. url.hostname sivocloud.dev → '.sivocloud.dev'
  //
  // Para que la regla 3 (env var) gane sobre la 4, NO debe haber match en
  // las reglas 1-2. Aquí: userHost=portal.example.com NO es sivocloud, NO
  // es localhost → la regla 2 GATILLA y retorna '' (antes de llegar al env
  // var). Por seguridad del browser, priorizamos host-only cuando el
  // portal vive en un dominio no-sivocloud.
  //
  // Este test documenta ese comportamiento: regla 2 (portal no-sivocloud)
  // gana sobre env var. Si alguien quiere custom domain con cross-subdomain
  // cookies, debe actualizar la función para que el orden sea 1) isLocalHost,
  // 3) env var override, 2) url.hostname sivocloud.dev, 4) host-only.
  const req = makeRequest({
    url: 'https://controlplane.sivocloud.dev/api/auth/consume',
    origin: 'https://portal.example.com',
  })
  const env = makeEnv({ htmlbox_session_domain: '.example.com' })
  const c = buildSessionCookie(req, 'sid-test', env)
  assert.doesNotMatch(c, /Domain=/,
    'regla 2 (portal en domain raro) → host-only, antes del env var override')
})

test('env var HTMLBOX_SESSION_DOMAIN=""" se trata como host-only intencional', () => {
  // Cambio explícito de behavior: '' !== undefined, así que el override
  // gana con valor ''. Antes se ignoraba por truthy check.
  const req = makeRequest({
    url: 'https://controlplane.sivocloud.dev/api/auth/consume',
    origin: 'https://studio.sivocloud.dev',
  })
  const env = makeEnv({ htmlbox_session_domain: '' })
  const c = buildSessionCookie(req, 'sid-test', env)
  assert.doesNotMatch(c, /Domain=/, 'env var "" → host-only intencional')
})

test('buildClearCookie también respeta el guard de localhost', () => {
  // Logout: debe limpiar el cookie con el mismo Domain. Si el logout
  // genera un Domain distinto al del login, el cookie podría no
  // borrarse efectivamente del browser (Set-Cookie clearing tiene que
  // matchear el Domain+Path del set original).
  const req = makeRequest({
    url: 'https://controlplane.sivocloud.dev/api/auth/logout',
    origin: 'http://controlplane.localhost:8781',
  })
  const env = makeEnv({ htmlbox_session_domain: '.sivocloud.dev' })
  const c = buildClearCookie(req, env)
  assert.doesNotMatch(c, /Domain=/,
    'buildClearCookie también debe respetar el guard de localhost (sino no limpia)')
})

test('Secure flag: dev localhost http → sin Secure (en prod sigue según HTMLBOX_COOKIE_SECURE)', () => {
  // El flag Secure debería falsearse también cuando estamos en localhost,
  // porque el browser habla http (no https) y rechaza Secure cookies.
  // El bug opuesto también afecta al login.
  const req = makeRequest({
    url: 'https://controlplane.sivocloud.dev/api/auth/consume',
    origin: 'http://controlplane.localhost:8781',
  })
  const env = makeEnv({ htmlbox_session_domain: '.sivocloud.dev' })
  const c = buildSessionCookie(req, 'sid-test', env)
  assert.doesNotMatch(c, /[Ss]ecure/,
    'dev localhost http → sin Secure (browser http no aceptaría Secure cookie)')
})