# HTMLBox

> Plataforma runtime/publicador para dashboards y apps HTML generados con IA (ChatGPT, Claude, Gemini) sobre Cloudflare.

Documento de diseño: [`./arquitectura.md`](./arquitectura.md).

Estado: **fases 1 (Fundación) + 2 (Boxes con versionado de las últimas 5 versiones)**. Fase 3+ (datos, automatización, MCP) están documentadas pero no implementadas.

Demo standalone previa (LocalStorage, sin backend): [`./mvp.html`](./mvp.html).

---

## Topología

```
htmlbox/
├── packages/
│   ├── shared/         constantes, validadores, schema SQL por box
│   ├── control-plane/  Worker htmlbox-control-plane  — registry, auth, Turso provisioning
│   ├── portal/         Worker htmlbox-portal         — SPA Alpine.js del tenant
│   └── runtime/        Worker htmlbox-runtime        — sirve HTML de boxes, expone SDK
└── scripts/            dev.sh, migrate-*.sh
```

| Worker | Host | Rol |
|---|---|---|
| `htmlbox-control-plane` | `controlplane.htmlbox.app` | Auth (magic-link), tenants/workspaces/boxes, **provisiona la Turso DB por box**, panel admin |
| `htmlbox-portal` | `portal.htmlbox.app` | SPA Alpine del tenant (crear/subir boxes, versionar HTML, gestionar) |
| `htmlbox-runtime` | `*.htmlbox.app` | Sirve HTML de boxes desde R2 + inyecta SDK |

---

## Recursos Cloudflare

- **D1 `htmlbox-control-plane`** — metadatos (tenants, workspaces, users, memberships, boxes, versions, api_tokens).
- **Turso `htmlbox-box-{boxId}`** — una DB por box (datos del box; en fase 1 no se usa, pero ya se aprovisiona al crear).
- **R2 `htmlbox-content`** — layout estricto:
  ```
  tenants/{tenantSlug}/boxes/{boxId}/versions/v{1..5}.html
  tenants/{tenantSlug}/boxes/{boxId}/uploads/{fileId}/{filename}
  tenants/{tenantSlug}/boxes/{boxId}/assets/{path}
  tenants/{tenantSlug}/_exports/{runId}/{filename}
  ```
- **KV `htmlbox-cache`** — caché opcional de snapshots y resolución boxSlug → boxId.

---

## Setup local

### Prerrequisitos
- Node >= 18
- `wrangler` >= 3 (`npx wrangler --version`)
- `turso` CLI (`brew install turso` o `curl -sSfL https://get.turso.io/install.sh | bash`)

### 1. Instalar dependencias
```bash
npm install
```

### 2. Configurar secrets (cada worker)
```bash
cp packages/control-plane/.dev.vars.example packages/control-plane/.dev.vars
cp packages/portal/.dev.vars.example          packages/portal/.dev.vars
cp packages/runtime/.dev.vars.example         packages/runtime/.dev.vars
```
Edítalos y rellena los secretos (ver archivos `.example`).

### 3. Iniciar sqld local (Turso dev)
```bash
turso dev --port 8080
```

### 4. Aplicar migrations D1 a local
```bash
npm run migrate:local
```

### 5. Arrancar los 3 Workers
```bash
npm run dev
```

Esto lanza en paralelo:
- control-plane en `http://localhost:8781`
- portal en `http://localhost:8782`
- runtime en `http://localhost:8783`

### 6. Crear el primer tenant
Visita `http://localhost:8782`, solicita el magic-link del primer usuario. En dev el email se loguea en consola del control-plane (no se envía realmente).

### 7. Probar el ciclo de versionado
1. Crear HTML Box desde el portal.
2. Subir un archivo `.html` (drag&drop o "Subir HTML de IA").
3. Reemplazarlo 5+ veces para verificar purga de la versión más antigua.
4. Acceder al box: `http://acme.localhost:8783/cartera` (cabecera `Host: acme.localhost:8783`).
5. Rollback a una versión anterior desde el tab Editor.

---

## Convenciones

- **Prefijo `htmlbox-`** en TODO (Workers, D1, R2, KV, Turso DB, secrets, flows, dominios).
- Reglas de nombres detalladas en `arquitectura.md` §2.
- `tenant_id` SIEMPRE server-side desde la sesión.
- Subidas: presigned R2, key SIEMPRE prefijada por `tenants/{slug}/` (jamás composición por el cliente — contención de `../` en `namespacedKey`).

## Tests

```bash
npm test
```

## Producción

- Reemplazar `*.localhost` por `*.htmlbox.app` en DNS / Workers routes.
- Cookies con `Domain=.htmlbox.app` para compartirlas entre los 3 Workers.
- `wrangler secret put HTMLBOX_SESSION_SECRET`, `HTMLBOX_TURSO_PLATFORM_TOKEN`, `HTMLBOX_R2_ACCESS_KEY_ID`, `HTMLBOX_R2_SECRET_ACCESS_KEY`.
- Aplicar migrations a remoto: `npm run migrate:remote`.

## Roadmap

| Fase | Estado |
|---|---|
| 1. Fundación | ✅ este repo |
| 2. Boxes + versionado | ✅ este repo |
| 3. Datos (SDK, tab Datos, manual CSV/XLSX) | ⏸ |
| 4. flow-engine + nodos htmlbox-* | ⏸ |
| 5. Colaboración (roles, invitaciones) | ⏸ |
| 6. MCP + canales | ⏸ |