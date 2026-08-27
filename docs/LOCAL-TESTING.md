# HTMLBox — Guía de desarrollo local

Esta guía describe cómo correr el ciclo E2E completo de HTMLBox contra el D1
remoto de Cloudflare, sin necesidad de desplegar nada. El código corre local
(workerd) pero los bindings D1/R2/KV pegan contra la API real de Cloudflare
(`wrangler dev --remote`), así que dev = prod en datos.

---

## Lo que necesitas instalado

| Herramienta | Uso | Comando de instalación |
|---|---|---|
| Node ≥ 18 | runtime | `brew install node` |
| wrangler ≥ 4 | CLI de Cloudflare | viene con el repo (`npm install`) |
| Autenticación CF | hablar con tu cuenta | `wrangler login` o `export CLOUDFLARE_API_TOKEN=…` |

> En macOS los subdominios `*.localhost` resuelven solos a `127.0.0.1`. En Linux
> agregá a `/etc/hosts`:
> ```
> 127.0.0.1   controlplane.localhost portal.localhost runtime.localhost
> ```

---

## 1) Setup único

```bash
cd _standalone/htmlbox
npm install

# Copiar dev.vars a cada worker
for p in control-plane portal runtime; do
  cp "packages/$p/.dev.vars.example" "packages/$p/.dev.vars"
done
```

Los archivos `.dev.vars.example` traen placeholders seguros — no hace falta editarlos
para dev. Lo único que SÍ querés cambiar antes de producción es
`HTMLBOX_SESSION_SECRET` (clave HMAC para firmar cookies).

Verificá que estés autenticado:

```bash
npx wrangler whoami
```

---

## 2) Levantar los 3 Workers (D1 remoto)

### Opción A — script todo-en-uno

```bash
npm run dev
```

Esto ejecuta `scripts/dev.sh`, que:
1. Mata workerd/wrangler zombi de runs previos en los puertos 8781-8783 / 9229-9231.
2. Verifica que estés autenticado en Cloudflare.
3. Aplica las migrations D1 a la base remota (`wrangler d1 migrations apply --remote`).
4. Levanta los 3 wrangler dev con `--remote` en paralelo:
   - `http://controlplane.localhost:8781` — control-plane (API + UI admin)
   - `http://portal.localhost:8782` — portal (UI Alpine del tenant)
   - `http://runtime.localhost:8783` — runtime (sirve los boxes publicados)

### Opción B — paso por paso

```bash
# Terminal 1: migraciones D1 a remoto
npm run migrate:remote

# Terminal 2: control-plane
cd packages/control-plane
npx wrangler dev --remote --persist-to ./.wrangler

# Terminal 3: portal
cd packages/portal
npx wrangler dev --remote --persist-to ./.wrangler

# Terminal 4: runtime
cd packages/runtime
npx wrangler dev --remote --persist-to ./.wrangler
```

---

## 3) Smoke test en el browser

### 3.1 UI Admin (control-plane)

1. Abrí `http://controlplane.localhost:8781/admin/` en el browser.
2. En "Email", ingresá `david@ejemplo.com` y enviá el magic link.
3. En la consola del control-plane (`npm run dev`), mirá el link de preview:
   ```
   [auth][dev] Magic link NO enviado. Pegá esto en el browser:
     → http://controlplane.localhost:8781/api/auth/verify?token=abcd…
   ```
4. Abrilo en el browser — el HTML auto-POSTea al consume y te deja logueado.
5. Creá un tenant (slug `acme`).

### 3.2 Portal (UI Alpine)

1. Abrí `http://portal.localhost:8782/`.
2. Iniciá sesión con el mismo email (`david@ejemplo.com`) — el portal habla con
   el control-plane en `http://controlplane.localhost:8781` (configurado vía
   `window.HTMLBOX_API_ORIGIN`).
3. Seleccioná el tenant "acme" en el sidebar.
4. Click **"Nuevo HTML Box"** → nombre "Mi Dashboard" → plantilla "Dashboard de Cartera".
5. En el tab **Editor HTML** vas a ver el seed. Click **"Guardar"** → confirma con
   un summary → vas al tab **Vista Previa**.

### 3.3 Runtime (servir boxes)

En el tab **Vista Previa** el iframe muestra el HTML servido. Para acceder al box
desde fuera (URL "real"), abrí (con curl o browser):

- **Privado**: `http://acme.localhost:8783/mi-dashboard` — requiere cookie de sesión del portal.
- **Público**: la URL del share está en el modal "Compartir" — formato `https://htmlbox.dev/s/<shareId>`.
  En dev se sirve igual por el runtime si lo abrís directo.

---

## 4) Probar el versionado "5 últimas"

Desde el portal, repetí **"Guardar"** con distintos HTMLs. Tras la sexta versión,
verás en el tab **Editor** que la columna `version` pasa de `1` a `6` pero el
historial `htmlbox_versions` tiene solo 5 filas (la v1 fue purgada).

Para validar con curl:

```bash
# 1) login (repetí el flujo del magic link en el browser; copiá la cookie 'sid')

# 2) listar boxes de tu workspace
curl -s "http://controlplane.localhost:8781/api/boxes?workspace=<WS_ID>" \
  -H "Cookie: sid=<SID>" | jq

# 3) ver historial de versiones
curl -s "http://controlplane.localhost:8781/api/boxes/<BOX_ID>/versions" \
  -H "Cookie: sid=<SID>" | jq

# 4) rollback a v3
curl -s -X POST "http://controlplane.localhost:8781/api/boxes/<BOX_ID>/rollback/3" \
  -H "Cookie: sid=<SID>" | jq
# → {version: 7, ...}  (nunca destruye el historial)
```

---

## 5) Modo R2 local-fake (sin Cloudflare R2)

Por defecto `wrangler dev --remote` usa el bucket R2 real. Si querés trabajar
offline (sin pegar contra Cloudflare para uploads), el repo expone
`HTMLBOX_R2_MODE=local-fake` en el `.dev.vars` del control-plane. En ese modo:

- `POST /api/boxes/:id/upload-url` devuelve una URL que apunta al propio
  control-plane (`POST /api/_local/upload?key=...`).
- El cliente hace PUT a esa URL y el server escribe a `env.BUCKET` directamente
  (con la API local del binding R2 simulado por workerd).
- El endpoint `/api/_local/upload` solo está activo si
  `HTMLBOX_R2_MODE === 'local-fake'`. En producción, este var se setea a
  `"production"` (o se omite) y se usa el flujo real con `createPresignedUrl()`.

Para verificar:

```bash
curl -i "http://controlplane.localhost:8781/api/_local/upload?key=tenants/acme/boxes/x/versions/v1.html" \
  -X PUT -H "Content-Type: text/html" --data-binary '<html>test</html>'
# → 200 OK con body JSON { ok: true, key, size }
```

---

## 6) Tests automatizados

```bash
# Solo los tests rápidos (sin levantar workers)
npm run test:node --workspaces --if-present

# Suite E2E completa (levanta el worker del control-plane en miniflare)
cd packages/control-plane
npm run test:e2e

# Todo junto
cd ../..
npm test
```

Resultado esperado:

```
@htmlbox/control-plane  → 3 (node) + 8 (e2e) = 11 tests
@htmlbox/runtime        → 12 tests
@htmlbox/shared         → 31 tests
TOTAL                   → 54 tests, 0 fallos
```

Los tests E2E cubren:
1. Auth flow completo (request → consume → me → logout).
2. Tenant + workspace creation.
3. Box creation (turso_status).
4. Versionado: 6 pushes → quedan 5 versiones, v1 purgada del bucket.
5. Rollback crea nueva versión con el contenido anterior.
6. Aislamiento entre tenants (403 cross-tenant).
7. /api/_local/upload: 403 si modo incorrecto, 400 key inválida, 200 key válida.
8. Active-html: 401 sin sesión, 404 sin versión activa.

---

## 7) Limitaciones del modo dev

| Funcionalidad | Estado en dev |
|---|---|
| Magic link por email | No envía. Loguea + devuelve link en `_dev_preview`. |
| `createPresignedUrl` (R2) | Activo contra el bucket real (`--remote`). |
| Cookies cross-host (`Domain=localhost`) | OK en dev — los 3 subdominios `*.localhost` comparten parent domain. |
| D1 | Real (remoto). Los datos de dev conviven con prod en la misma DB; usá tenant/workspace distintos. |
| Turso Platform API (boxes DB) | Habla con Turso real vía `--remote`. |
| HTTPS | Solo HTTP. La cookie sid no lleva flag `Secure`. |
| Cron trigger | No se dispara solo en `wrangler dev`. |

---

## 8) Troubleshooting comunes

**"no such table: htmlbox_magic_links"**
Migrations no aplicadas. Corré `npm run migrate:remote` o reiniciá `npm run dev` (las aplica automáticamente al inicio).

**"Address already in use: 127.0.0.1:9229"**
Workerd huérfano. El script `dev.sh` ya los mata al arrancar; si lo levantás a mano, hacé `lsof -iTCP:9229` y `kill -9 <PID>`.

**El portal no carga boxes (queda en blanco)**
Probable CORS — el portal habla con `controlplane.localhost:8781`. Verificá que `.dev.vars` del portal tenga `HTMLBOX_CONTROL_PLANE_ORIGIN: http://controlplane.localhost:8781` y que el control-plane devuelva headers `Access-Control-Allow-Credentials: true` (ya está).

**El magic link no abre**
El dev mode imprime el link por consola. Buscá la línea:
```
[email][dev] Magic link NO enviado. Pegá esto en el browser:
  → http://controlplane.localhost:8781/api/auth/verify?token=…
```

**El runtime devuelve "Box sin versión publicada"**
El box no tiene `htmlbox_version` aún. Subí un HTML desde el portal primero.

---

## 9) Producción (deploy a Cloudflare)

1. Reemplazá los IDs placeholder en `wrangler.jsonc` (`database_id`, `kv namespace id`).
2. Configurá secrets:
   ```bash
   wrangler secret put HTMLBOX_SESSION_SECRET
   wrangler secret put HTMLBOX_TURSO_PLATFORM_TOKEN   # solo si HTMLBOX_TURSO_MODE=cloud
   wrangler secret put HTMLBOX_R2_ACCESS_KEY_ID      # opcional — wrangler firma con binding
   wrangler secret put HTMLBOX_R2_SECRET_ACCESS_KEY
   ```
3. Seteá `HTMLBOX_R2_MODE=production` (o quitalo — el default es el flujo real).
4. Aplicá migrations a remoto: `npm run migrate:remote`.
5. Deploy cada worker: `npm run deploy --workspaces --if-present`.

---

## 10) Workflow recomendado

```bash
# desarrollo cotidiano
npm run dev                                          # sqld + 3 workers
# editás código en packages/*/src/**
# wrangler dev recarga solo

# antes de commit
npm test                                             # todos los tests

# deploy
npm run migrate:remote
npm run deploy --workspaces --if-present
```