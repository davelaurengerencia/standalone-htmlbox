# HTMLBox — Spec: Auth centralizado en `auth.<dominio>` + flow-engine

> Spec de implementación. Cubre **Fase auth-centralizado** (nuevo Worker `htmlbox-auth`) **+ migración de la lógica de auth a flows del flow-engine**. La parte del 5° Worker es la respuesta estructural al bug de auth-error de esta sesión; la parte del flow-engine es la decisión de implementación para que esa lógica viva en flows declarativos (consistente con la decisión ya tomada para emails en §7 de `AGENTS.md`).

## 0. Por qué el parche de esta sesión no alcanza — el diagnóstico real

Cada bug de esta sesión (link con host de prod, redirect a prod, magic link filtrado en preview en prod-fallback, etc.) tuvo la MISMA causa raíz de fondo: **`control-plane` recibía el request de auth a través de OTRO worker** (`portal`, vía service binding o proxy HTTP) — y en cualquiera de esos dos caminos, la información real de "en qué host está el browser" se puede degradar en el viaje (service binding resuelve contra el script deployado, no contra la sesión `--remote` local; el header `X-Forwarded-Host` no siempre sobrevive el túnel `--remote`). Cada capa que agregamos (headers, env vars, hasta `window.location` en la página intermedia) fue un parche sobre ESE síntoma, no sobre la causa.

La causa de fondo: **el worker que decide el host nunca es el que recibe el request directamente del browser.**

La solución estructural es esa, no otro parche: que el servicio que arma/verifica/consume el magic link sea SIEMPRE el primero en tocar el request — nunca algo que le llega reenviado por otro worker. Un subdominio de auth dedicado logra exactamente eso, y de paso resuelve el pedido de producto de David (login centralizado, ruteo por rol).

## 1. Arquitectura nueva

Un 5° worker: `htmlbox-auth`.

| Worker | Dominio prod | Dev | Bindings |
|---|---|---|---|
| `htmlbox-auth` (nuevo) | `auth.sivocloud.dev` | `auth.localhost:8785` | DB, EMAIL |
| `htmlbox-control-plane` | `controlplane.sivocloud.dev` | `controlplane.localhost:8781` | DB, BUCKET, CACHE, EMAIL |
| `htmlbox-portal` | `studio.sivocloud.dev` | `studio.localhost:8782` | CONTROL_PLANE (binding) |
| `htmlbox-runtime` | `*.sivocloud.dev` (boxes) | `runtime.localhost:8783` | DB, BUCKET, KV |
| `htmlbox-landing` | `sivocloud.dev` | `sivocloud.localhost:8784` | RUNTIME (binding) |

`auth` declara su **propio** binding D1 apuntando al mismo `database_id` que control-plane (`htmlbox-control-plane`). Cloudflare permite múltiples Workers con bindings al mismo D1 — esto evita service bindings (que ya probamos que rompen en `--remote`, ver `AGENTS.md` §2). Misma lógica para `EMAIL`: cada Worker declara su propio `send_email` apuntando al mismo dominio onboarded.

`auth` es liviano: solo `htmlbox_users`, `htmlbox_sessions`, `htmlbox_magic_links`, `htmlbox_login_tickets` (la tabla nueva de §6). No toca `htmlbox_boxes`/Turso/WFP.

## 2. Cada endpoint de auth es un flow del flow-engine

Toda la lógica de auth vive en **5 flows declarativos** en `packages/auth/src/flows/`. El Worker `auth` es solo una cáscara HTTP que enruta `/api/auth/<op>` al flow correspondiente (ver §3).

### 2.1 `auth-request.flow.json` — `POST /auth-request`

```
http-in (POST /auth-request)
  → function (validateEmail: regex + lowercase + trim; si falla → response 200 con GENERIC_RESPONSE)
  → cloudflare-d1-sql (rate limit: SELECT COUNT(*) FROM htmlbox_magic_links
       WHERE email=? AND created_at > datetime('now','-60 seconds');
       si n>=3 → response 200 con GENERIC_RESPONSE — anti-enumeración)
  → function (randomToken() vía crypto.getRandomValues;
       armar magicLink = `${requestUrl.origin}/api/auth/verify?token=${id}`
       usando el host del request directo, NUNCA heurísticas)
  → cloudflare-d1-sql (INSERT INTO htmlbox_magic_links (id, email, expires_at) VALUES (?, ?, ?))
  → function (renderMagicLinkEmail: arma subject/text/html con el magicLink)
  → cloudflare-email (envía el email vía ctx.platformBindings.EMAIL
       — el gate HTMLBOX_EMAIL_MODE vive en el flow-engine, ver §10)
  → function (gate Fix 3: si HTMLBOX_ENV !== 'production' → payload._dev_preview=magicLink;
       sino → payload = GENERIC_RESPONSE)
  → http-response (statusCode: 200, Content-Type: application/json)
```

### 2.2 `auth-verify.flow.json` — `GET /auth-verify`

```
http-in (GET /auth-verify)
  → function (extraer token del query string)
  → cloudflare-d1-sql (peek: SELECT id, email, used_at, expires_at
       FROM htmlbox_magic_links WHERE id=?;
       si used_at OR expired → response HTML loginErrorHtml)
  → template (arma loginConfirmHtml con un <script> que postea a
       /api/auth/consume y luego hace window.location.href = data.destUrl)
  → http-response (Content-Type: text/html)
```

**Aclaración**: NO hay `window.location` override en el HTML. El destino del redirect lo calcula el flow `auth-consume` (que sí tiene el request directo) y se pasa como `destUrl` en la respuesta JSON de `/api/auth/consume`. El HTML servido por `auth-verify` es solo un trampolín que postea el token y recibe `destUrl` del backend.

### 2.3 `auth-consume.flow.json` — `POST /auth-consume`

```
http-in (POST /auth-consume)
  → function (parsear JSON body, extraer token)
  → cloudflare-d1-sql (consume: UPDATE htmlbox_magic_links SET used_at=datetime('now')
       WHERE id=? AND used_at IS NULL AND datetime(expires_at) > datetime('now');
       si changes=0 → 400 invalid_or_expired_token)
  → cloudflare-d1-sql (findUser: SELECT id, is_platform_owner
       FROM htmlbox_users WHERE email=?)
  → switch (rama "no existe" vs "existe")
    rama "no existe":
      → cloudflare-d1-sql (countUsers: SELECT count(*) AS n FROM htmlbox_users)
      → function (decidir is_platform_owner = (count===0))
      → cloudflare-d1-sql (insertUser: INSERT INTO htmlbox_users (id, email, is_platform_owner) VALUES (?, ?, ?))
    rama "existe":
      → (no hace nada, sigue)
  → cloudflare-d1-sql (createSession: INSERT INTO htmlbox_sessions (id, user_id, expires_at) VALUES (?, ?, ?))
  → function (buildSessionCookie + randomToken() para loginTicket + armar Set-Cookie)
  → cloudflare-d1-sql (insertTicket: INSERT INTO htmlbox_login_tickets (id, session_id, expires_at) VALUES (?, ?, ?))
  → function (decidir destOrigin según is_platform_owner:
       controlplane.<host> si platform_owner, sino studio.<host>;
       destUrl = `${destOrigin}/auth/exchange?st=${ticket}`)
  → function (armar { payload: { ok, user, destUrl }, headers: { 'Set-Cookie': sid } })
  → http-response (payload: { ok, user, destUrl }; headers: Set-Cookie + Content-Type)
```

**Importante**: la respuesta de este flow lleva `destUrl` calculado server-side, con el host del request que `auth` recibió directamente. La página "Verificando…" (servida por `auth-verify`) lee `data.destUrl` y hace `window.location.href = destUrl` — sin parche de browser, sin heurística, sin `window.location` override.

### 2.4 `auth-logout.flow.json` — `POST /auth-logout`

```
http-in (POST /auth-logout)
  → function (extraer sid de la cookie 'sid' del request)
  → cloudflare-d1-sql (DELETE FROM htmlbox_sessions WHERE id=?)
  → function (buildClearCookie; set msg.headers = { 'Set-Cookie': clearCookie })
  → http-response (payload: { ok: true })
```

### 2.5 `auth-exchange.flow.json` — `POST /auth-exchange`

```
http-in (POST /auth-exchange)
  → function (parsear JSON body, extraer ticket; validar header X-HTMLBox-Internal-Secret
       — server-to-server desde studio.*/controlplane.*, no desde browser)
  → cloudflare-d1-sql (consumeTicket: UPDATE htmlbox_login_tickets SET consumed_at=datetime('now')
       WHERE id=? AND consumed_at IS NULL AND datetime(expires_at) > datetime('now');
       si changes=0 → 400 invalid_or_expired_ticket)
  → cloudflare-d1-sql (getSession: SELECT session_id
       FROM htmlbox_login_tickets WHERE id=?)
  → http-response (payload: { sessionId }; Content-Type: application/json)
```

El destino (`studio.*` o `controlplane.*`) llama este endpoint server-to-server con el ticket que recibió en `?st=...`, recibe `{ sessionId }`, y setea cookie `sid` host-only en su propio dominio.

## 3. El Worker `auth.*` es cáscara HTTP delgada

~80 líneas. Solo enrutar HTTP y bootstrap del flow-engine (mismo patrón que `packages/control-plane/src/lib/flows.js`):

```js
// packages/auth/src/worker.js (esquema)
import { createFlowEngineApp } from 'flow-engine/app'
import { coreNodes as flowCoreNodes } from 'flow-engine/nodes'

import authRequest from './flows/auth-request.flow.json' with { type: 'json' }
import authVerify from './flows/auth-verify.flow.json' with { type: 'json' }
import authConsume from './flows/auth-consume.flow.json' with { type: 'json' }
import authLogout from './flows/auth-logout.flow.json' with { type: 'json' }
import authExchange from './flows/auth-exchange.flow.json' with { type: 'json' }

const FLOWS = {
  'auth-request': authRequest,
  'auth-verify': authVerify,
  'auth-consume': authConsume,
  'auth-logout': authLogout,
  'auth-exchange': authExchange,
}

const HTTP_NODE_ROOT = '/api/flows'

let cloudflareEmailPatched = false
function ensureCloudflareEmailPatched() { /* mismo monkey-patch que control-plane */ }

const APP_CACHE = new Map()
async function getFlowEngineApp(env) {
  ensureCloudflareEmailPatched()
  const sig = Object.keys(env || {}).sort().join('|')
  let app = APP_CACHE.get(sig)
  if (app) return app
  app = await createFlowEngineApp({
    runtime: 'worker',
    flows: FLOWS,
    configNodes: [],
    mountPath: HTTP_NODE_ROOT,
    httpNodeRoot: HTTP_NODE_ROOT,
    exposeErrorDetails: false,
  })
  APP_CACHE.set(sig, app)
  return app
}

function corsHeaders(request) { /* reflejo de Origin, default '*' */ }

function rewriteToFlowEngine(request, flowName) {
  const url = new URL(request.url)
  url.pathname = `${HTTP_NODE_ROOT}/${flowName}`
  return new Request(url, request)
}

function pageLoginHtml(env) {
  // Página estática con form que postea a /api/auth/request (mismo origen).
  // Sin JS framework. Sin CORS. Lee return de ?return=... para redirigir post-consume.
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) })
    }

    // 1. Login page estática
    if (path === '/' || path === '/login') {
      return new Response(pageLoginHtml(env), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    // 2. Health
    if (path === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
      })
    }

    // 3. Rutas /api/auth/* → reenviar al flow-engine (http-in).
    const pathToFlow = {
      '/api/auth/request': 'auth-request',
      '/api/auth/verify': 'auth-verify',
      '/api/auth/consume': 'auth-consume',
      '/api/auth/logout': 'auth-logout',
      '/api/auth/exchange': 'auth-exchange',
    }
    if (pathToFlow[path]) {
      const internalReq = rewriteToFlowEngine(request, pathToFlow[path])
      const app = await getFlowEngineApp(env)
      const res = await app.handleWorker(internalReq, env, ctx)
      return res || new Response('Not Found', { status: 404 })
    }

    return new Response('Not Found', { status: 404 })
  },
}
```

**Por qué la traducción `/api/auth/<op>` → `/api/flows/<flowName>`**: el flow-engine se monta en `httpNodeRoot: '/api/flows'` y matchea por path completo dentro de ese namespace. Los flows definen `path: '/auth-request'` etc. El Worker `auth` expone URLs "limpias" (`/api/auth/request`) y traduce internamente.

**Bindings necesarios en `wrangler.jsonc` del Worker `auth`**:

```jsonc
{
  "name": "htmlbox-auth",
  "main": "src/worker.js",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "rules": [
    { "type": "Text", "globs": ["src/flows/*.flow.json"], "fallthrough": true }
  ],
  "dev": { "ip": "::", "port": 8785, "inspector_port": 9235, "inspector_ip": "127.0.0.1" },
  "routes": [
    { "pattern": "auth.sivocloud.dev/*", "zone_name": "sivocloud.dev" }
  ],
  "vars": {
    "HTMLBOX_ENV": "production",
    "HTMLBOX_TURSO_MODE": "cloud",
    "HTMLBOX_SESSION_DOMAIN": ".sivocloud.dev",
    "HTMLBOX_EMAIL_MODE": "prod",
    "HTMLBOX_EMAIL_FROM_ADDRESS": "no-reply@sivocloud.dev",
    "HTMLBOX_EMAIL_FROM_NAME": "SivoCloud",
    "HTMLBOX_INTERNAL_SECRET": "<mismo-que-control-plane-y-runtime>",
    "HTMLBOX_PORTAL_ORIGIN": "https://studio.sivocloud.dev",
    "HTMLBOX_PUBLIC_ORIGIN": "https://controlplane.sivocloud.dev"
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "htmlbox-control-plane",
    "database_id": "7ac72bf3-63ae-4789-9679-ab869419fa2a",
    "migrations_dir": "migrations"
  }],
  "send_email": [{ "name": "EMAIL" }],
  "observability": { "enabled": true }
}
```

El `database_id` es **el mismo** que control-plane — ambos Workers comparten el D1.

## 4. Flujo de login completo

1. Cualquier punto de entrada (portal, admin, link externo) hace un **redirect 302** a `https://auth.<dominio>/login?return=<path-donde-queda-el-usuario>`. **No** un fetch cross-origin — un redirect puro.
2. `auth` sirve la página de login estática (`packages/auth/src/ui/login.html.txt`) — un `<form>` simple que postea a `/api/auth/request` (mismo origen). Sin CORS, sin JS framework.
3. Usuario envía email → flow `auth-request` (en el mismo Worker `auth`) → genera magic link → email sale vía flow-engine → cookie `previewLink` agregada al response si estamos en dev.
4. Usuario clickea el link (o toca "Entrar" en el panel dev que ahora viene de `auth.*` directo).
5. Flow `auth-verify` sirve la página "Verificando…" → su `<script>` lee el token de la URL, postea a `/api/auth/consume` (mismo origen).
6. Flow `auth-consume`: consume el token, crea sesión, arma cookie `sid` (host-only en `auth.*` por ahora — irrelevante para el flujo final, ver §6), arma ticket, **responde `{ ok, user, destUrl }`**. La página "Verificando…" recibe `destUrl` y hace `window.location.href = destUrl`.
7. `destUrl` = `${controlplane/studio}.${requestUrl.host}/auth/exchange?st=<ticket>`. **El host acá es el que `auth` recibió directo** — no hay heurística, no hay env var.
8. Browser llega a `studio.*` o `controlplane.*` con `?st=...`. Cada uno tiene un endpoint chico `GET /auth/exchange` que llama server-to-server a `auth.*/api/auth/exchange` con el ticket (header `X-HTMLBox-Internal-Secret`), recibe `{ sessionId }`, setea cookie `sid` host-only en su propio dominio, redirige al path original (`return`).
9. **Listo** — el usuario está autenticado en el destino.

## 5. Destino post-login — por rol, no por "de dónde vino"

Regla nueva (lo que pidió David): el destino post-login se decide por **quién es el usuario**, no por dónde se inició el login.

```js
function chooseDestination(user, host) {
  if (user.is_platform_owner) {
    return `https://controlplane.${host}/auth/exchange`
  }
  return `https://studio.${host}/auth/exchange`
}
```

Esto reemplaza la lógica actual de `origin` ('admin'/'portal', guardado en el magic link al pedirlo) — que respondía a "desde qué pantalla lo pediste", no a quién sos. Con la regla nueva, un platform owner siempre cae en control-plane sin importar desde dónde pidió el link; un tenant normal siempre cae en studio.

**Edge case: platform owner que también es tenant owner** — un user con `is_platform_owner=1` Y `tenant_id != NULL` siempre cae en control-plane. Si quiere entrar a studio como tenant, usa el menú "Entrar como tenant" desde control-plane (link secundario, fuera de scope de esta spec).

## 6. Sesión cross-subdomain (ticket OAuth-style)

**Decisión**: ticket de un solo uso, 60s TTL, en vez de cookie compartida via `Domain`.

**Razón**: en dev (`*.localhost`) `Domain=.localhost` es rechazado por browsers (Public Suffix List). En prod `Domain=.sivocloud.dev` SÍ funcionaría, pero tener UN solo mecanismo para los dos ambientes es mejor que dos (menos superficie de bug, mismo código de destino). El ticket es de un solo uso + 60s TTL → si se filtra en un log o Referer, ventana de abuso mínima.

**Tabla nueva** (migration `0009_htmlbox_login_tickets.sql` en `packages/control-plane/migrations/`):

```sql
CREATE TABLE htmlbox_login_tickets (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (session_id) REFERENCES htmlbox_sessions(id) ON DELETE CASCADE
);
CREATE INDEX idx_login_tickets_expires ON htmlbox_login_tickets(expires_at);
```

**Ciclo de vida**:

1. `auth-consume` flow crea el ticket (60s TTL), persiste, lo mete en `destUrl`.
2. Browser redirige a `destUrl?st=<ticket>`.
3. Destino (`studio.*` o `controlplane.*`) llama `POST auth.*/api/auth/exchange` con `{ ticket }` (server-to-server, header `X-HTMLBox-Internal-Secret`).
4. `auth-exchange` flow marca el ticket consumido, devuelve `{ sessionId }`.
5. Destino setea cookie `sid` host-only en su dominio, redirige a `return`.
6. **Reintento del mismo `?st=...`**: el flow devuelve 400 (`invalid_ticket`) porque `consumed_at IS NOT NULL`.

**Endpoints nuevos en portal y control-plane** (`GET /auth/exchange?st=...`):

```js
// packages/portal/src/routes/authExchange.js (esquema)
// Y el equivalente en packages/control-plane/src/routes/authExchange.js.
// Comparten lógica — vale extraer a @htmlbox/shared/src/authExchange.js si
// la duplicación pesa.

export async function handleAuthExchange(request, env, ctx) {
  const url = new URL(request.url)
  const ticket = url.searchParams.get('st')
  const returnTo = url.searchParams.get('return') || '/'
  if (!ticket) return new Response('Missing ticket', { status: 400 })

  const authOrigin = env.HTMLBOX_AUTH_ORIGIN  // 'http://auth.localhost:8785' en dev
  const res = await fetch(`${authOrigin}/api/auth/exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-HTMLBox-Internal-Secret': env.HTMLBOX_INTERNAL_SECRET,
    },
    body: JSON.stringify({ ticket }),
  })
  if (!res.ok) return new Response('Invalid ticket', { status: 400 })
  const { sessionId } = await res.json()

  const cookie = buildSessionCookie(request, sessionId, env)  // host-only en este dominio
  return new Response(null, {
    status: 302,
    headers: {
      Location: returnTo,
      'Set-Cookie': cookie,
    },
  })
}
```

## 7. Zero Trust para control-plane/admin (fuera de alcance)

David mencionó proteger `controlplane.*` con Cloudflare Zero Trust además del login por email — tiene sentido como capa adicional (el admin panel es más sensible que un box de tenant), pero es ortogonal a esta spec: Zero Trust se configura a nivel de Cloudflare Access delante de `controlplane.sivocloud.dev`, no cambia nada del flujo de `auth` acá descripto. Se puede prender cuando quieran, independiente de cuándo se implemente esto.

## 8. Lo que se BORRA de control-plane/portal

Inventario explícito para que no queden cabos sueltos:

**`packages/control-plane/src/routes/auth.js`** — se borra el archivo entero.

**`packages/control-plane/src/lib/magic-link.js`** — se borra el archivo entero. Las funciones (`sendMagicLinkViaFlow`, `buildMagicLinkUrl`, `renderMagicLinkEmail`, `getBrowserHost`, `isHostLocalhost`, `resolveDevAwareOrigin`) ahora viven en los flows del nuevo paquete `auth`.

**`packages/control-plane/src/lib/session.js`** — se queda solo el bloque "Crypto + Cookies" (`randomToken`, `buildSessionCookie`, `buildClearCookie`, `getSessionIdFromRequest`, `getCookieDomain`, `shouldUseSecureCookie`, `extractHost`) — y se mueve a `packages/shared/src/sessionCookies.js` para que tanto control-plane como el nuevo paquete `auth` lo importen desde ahí.

Las funciones que tocan DB (`createMagicLink`, `peekMagicLink`, `consumeMagicLink`, `createSession`, `deleteSession`, `validateSession`, `isRateLimited`, etc.) **se reemplazan por nodos `cloudflare-d1-sql`** en los flows. `whoami` y `getMe` siguen leyendo de la tabla directamente en control-plane (para `/api/internal/whoami` que consume runtime), pero usan SQL inline — no necesitan helpers.

**`packages/control-plane/src/lib/flows.js`** — borrar entradas `'magic-link'` y `'app-magic-link'` del mapa `FLOWS`. Borrar archivos `magic-link.flow.json` y `app-magic-link.flow.json` de `packages/control-plane/src/flows/`. Borrar test `__tests__/magicLinkSend.test.js`.

**`packages/portal/src/ui-partials/login.html.txt`** — el `<form>` actual pasa a ser un link "Iniciar sesión" → redirect a `auth.*/login?return=<studio-host>/...`.

**`packages/portal/src/ui-partials/app-script.html.txt`** — eliminar `requestMagicLink()` (reemplazado por redirect). Eliminar `localizeDevPreviewLink()` (ya no aplica — el preview viene de `auth.*` directo). Simplificar `enterViaPreview()` para apuntar al link completo (consume relativo a `auth.*`).

**`packages/portal/src/worker.js`** — eliminar la rama `isLocalDev` del `proxyToControlPlane` (ya no se usa para auth — el portal no proxia `/api/auth/*` más). `injectForwardedHost` se queda (sigue útil para otros `/api/*` que sí van por binding). Agregar routing para `GET /auth/exchange`.

**`packages/control-plane/src/worker.js`** — eliminar el routing `/api/auth/*` (todo va al nuevo Worker `auth`). Agregar routing para `GET /auth/exchange`. Mantener `/api/me/*`, `/api/tenants`, `/api/internal/*` etc.

**Tests a borrar**:
- `packages/control-plane/src/__tests__/magicLinkSend.test.js` — reemplazado por tests de los flows (`packages/auth/src/__tests__/`).
- `packages/control-plane/src/__tests__/authPreviewGating.test.js` — el gate Fix 3 ahora vive en `auth-request` flow (test va al package `auth`).

## 9. Compat hacia atrás — CORTADA (decisión confirmada)

Se borra `/api/auth/verify` (y `/api/auth/request`, `/api/auth/consume`, `/api/auth/logout`) de control-plane **sin redirect**. Magic links viejos (≤15 min TTL) fallan — usuario pide uno nuevo. La ventana de molestia es <15 min para cualquier email que se mandó antes del deploy.

Justificación: si alguien tiene un link en el email justo cuando se hizo el deploy, pedir otro es trivial. Y mantener un redirect 30 días para "cubrir emails viejos" no vale el código extra — los flows son testeables al 100% con `wrangler dev --remote` y un deploy coordinado.

## 10. Riesgos / decisiones de implementación

**Cookie helpers compartidos** — `randomToken`, `buildSessionCookie`, `buildClearCookie`, `getCookieDomain`, `shouldUseSecureCookie` se mueven a `packages/shared/src/sessionCookies.js`. Ambos packages (`auth` y `control-plane`) los importan de ahí. Es ~80 líneas, sin dependencias de runtime, reusables.

**Bindings compartidos D1** — Cloudflare permite múltiples Workers con binding al mismo D1 (mismo `database_id`). `auth` declara `d1_databases: [{ binding: "DB", database_id: "<mismo-id-que-control-plane>", database_name: "htmlbox-control-plane" }]` — lee/escribe las mismas tablas. Sin service binding (ya sabemos que rompe en `--remote`).

**Bindings compartidos EMAIL** — `auth` declara su propio `send_email: [{ name: "EMAIL" }]` apuntando al mismo dominio onboarded. El flow `auth-request` lo usa via el nodo `cloudflare-email` (mismo monkey-patch de `ctx.tenantId` que `control-plane/src/lib/flows.js`).

**Login UX** — el portal deja de tener form de login propio. CTA único: "Iniciar sesión" → redirect a `auth.*/login?return=...`. La página `/login` de `auth` es server-side HTML estática (`packages/auth/src/ui/login.html.txt`) — sin Alpine, sin build step. El form postea a `/api/auth/request` (mismo origen, sin CORS).

**Auto-provisioning de users** — el flow `auth-consume` mantiene la lógica actual: si el email no tiene fila en `htmlbox_users`, lo crea. Si la tabla está vacía, ese user es `is_platform_owner=1`. El switch del flow maneja las dos ramas (existe vs no-existe).

**Edge case: usuario sin `htmlbox_users` row pero con magic link válido** — el flow `auth-consume` crea el row on-the-fly (auto-provisioning). Misma lógica que el `postConsume` actual. El first-user-becomes-platform-owner se decide en el flow (rama del `switch`).

**Mount path del flow-engine** — `httpNodeRoot: '/api/flows'`. Los flows tienen `path: '/auth-request'` etc. El Worker traduce `/api/auth/request` → `/api/flows/auth-request` (ver §3). Validar con `engine/runtime.js` que `app.handleWorker` matchea por path completo (no por subpath).

**DNS dev** — `auth.localhost` resuelve a `::1` en macOS sin tocar `/etc/hosts`. `wrangler dev --port 8785 --ip ::` en `scripts/dev.sh`.

**`app-magic-link` flow (tenant-app-users)** — se queda en `packages/control-plane/src/flows/app-magic-link.flow.json` y se sigue invocando desde `routes/internal.js::postTenantAppRequest`. No se mueve al paquete `auth` porque (1) lo invoca runtime via `/api/internal/send-app-magic-link`, no el browser; (2) ya tiene un patrón consolidado. No se toca.

## 11. Checklist

### 11.1 Setup del paquete `auth`

1. `packages/auth/` nuevo package: `package.json` (con `flow-engine` linkeado a `../../../../_flow-engine`), `wrangler.jsonc` (bindings DB+EMAIL, route `auth.sivocloud.dev/*`, dev port 8785), `.dev.vars.example`, `src/worker.js` (cáscara HTTP con routing a flows + bootstrap del flow-engine idéntico al patrón de control-plane).
2. `scripts/dev.sh`: agregar `auth.localhost:8785` al banner, `kill_zombies`, tabla de colores del log.
3. `AGENTS.md` §2: nueva fila en la tabla de workers, actualizar puertos y notas DNS.

### 11.2 Refactor de helpers compartidos

4. `packages/shared/src/sessionCookies.js`: helpers de cookie + `randomToken`. Migrar desde `packages/control-plane/src/lib/session.js`.
5. `packages/control-plane/src/lib/session.js`: borrar `createMagicLink`, `peekMagicLink`, `consumeMagicLink`, `createSession`, `deleteSession`, `validateSession`. Importar cookie helpers de `@htmlbox/shared`.

### 11.3 Flows del paquete `auth`

6. `packages/auth/src/flows/auth-request.flow.json` (estructura de §2.1).
7. `packages/auth/src/flows/auth-verify.flow.json` (estructura de §2.2).
8. `packages/auth/src/flows/auth-consume.flow.json` (estructura de §2.3, incluyendo auto-provisioning + creación de sesión + creación de ticket + decisión de destino por rol).
9. `packages/auth/src/flows/auth-logout.flow.json` (estructura de §2.4).
10. `packages/auth/src/flows/auth-exchange.flow.json` (estructura de §2.5).
11. `packages/auth/src/lib/bootstrap.js`: idéntico patrón a `packages/control-plane/src/lib/flows.js` (APP_CACHE + monkey-patch cloudflare-email).

### 11.4 Migración de control-plane

12. `packages/control-plane/src/lib/flows.js`: borrar entradas `'magic-link'` y `'app-magic-link'` del mapa `FLOWS`. Borrar archivos `magic-link.flow.json` y `app-magic-link.flow.json`. Borrar test `__tests__/magicLinkSend.test.js`.
13. `packages/control-plane/src/lib/magic-link.js`: **borrar el archivo**.
14. `packages/control-plane/src/routes/auth.js`: **borrar el archivo**.
15. `packages/control-plane/src/worker.js`: eliminar routing `/api/auth/*`. Agregar routing para `GET /auth/exchange` (handler compartido con portal — mover a `packages/shared/src/authExchange.js`).
16. `packages/control-plane/migrations/0009_htmlbox_login_tickets.sql`: tabla de §6.

### 11.5 Migración de portal

17. `packages/portal/src/ui-partials/login.html.txt`: reemplazar `<form>` por link "Iniciar sesión" con redirect a `auth.*/login?return=...`.
18. `packages/portal/src/ui-partials/app-script.html.txt`: borrar `requestMagicLink()`, `localizeDevPreviewLink()`. Simplificar `enterViaPreview()`.
19. `packages/portal/src/worker.js`: borrar rama `isLocalDev` del proxy. Agregar routing para `GET /auth/exchange`.
20. `packages/portal/src/ui-partials/dev-preview-overlay.html.txt`: ajustar copy para reflejar que el preview viene de `auth.*` directo.

### 11.6 Tests

21. `packages/auth/src/__tests__/authRequestFlow.test.js`: POST `/api/auth/request` con email válido → genera magic link + email sale (mock EMAIL.send). Rate limit funciona. Email inválido → GENERIC_RESPONSE sin leak. `_dev_preview` en dev, NO en prod (Fix 3).
22. `packages/auth/src/__tests__/authVerifyFlow.test.js`: GET `/api/auth/verify?token=X` con token válido → sirve HTML con script. Token usado/expirado → HTML de error.
23. `packages/auth/src/__tests__/authConsumeFlow.test.js`: POST `/api/auth/consume` con token válido → crea sesión + arma ticket + devuelve `destUrl` correcto (controlplane si platform_owner, sino studio). Auto-provisioning funciona. First-user-becomes-platform-owner funciona.
24. `packages/auth/src/__tests__/authExchangeFlow.test.js`: POST `/api/auth/exchange` con ticket válido + secret correcto → devuelve `sessionId`. Ticket ya consumido → 400. Secret incorrecto → 403.
25. `packages/auth/src/__tests__/authLogoutFlow.test.js`: POST `/api/auth/logout` con sid válido → limpia sesión + cookie.
26. `packages/auth/src/__tests__/sessionCookies.test.js`: helpers de cookie funcionan en localhost (host-only) y prod (.sivocloud.dev).

### 11.7 Smoke e2e manual (post-deploy local)

27. Login desde `studio.localhost` → redirect a `auth.localhost/login?return=...`.
28. Email llega al inbox (dev mode `prod` → email real a `gomezdavid1121@gmail.com`) o aparece en dev panel de `auth.localhost`.
29. Click → `auth.localhost/verify` → consume → redirige a `studio.localhost/auth/exchange?st=...` → canjea ticket → setea cookie en `studio.localhost` → redirige a `return`.
30. Plataforma owner (`davelauren.gerencia@...` o `gomezdavid1121@gmail.com` si se le da is_platform_owner=1) hace lo mismo pero termina en `controlplane.localhost` (no studio).
31. Ticket doble canje → segundo 400.
32. Magic link viejo (`controlplane.localhost/api/auth/verify?token=...`) → 404 (compat cortada, esperado).
33. Cookie NO se comparte entre `*.localhost` después del exchange (cada dominio tiene la suya) — verificable en DevTools.
34. Logout desde studio → cookie sid se limpia en studio (no en controlplane — son host-only independientes).

### 11.8 Cierre

35. `AGENTS.md` §7: nota que `magic-link` y `app-magic-link` flows se BORRARON de control-plane; la lógica vive ahora en `packages/auth/src/flows/` (para magic-link plataforma) y `packages/control-plane/src/flows/app-magic-link.flow.json` (sin cambios, lo sigue llamando runtime).
36. `AGENTS.md` §2: actualizar tabla de workers y rutas dev con `auth.localhost:8785`.
