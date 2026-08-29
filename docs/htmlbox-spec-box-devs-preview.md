# HTMLBox — Spec: Box Devs y preview descartable en el navegador

Extiende `htmlbox-spec-wfp-consolidacion.md`. Define una categoría nueva de app — "Box Dev": código real de servidor (`worker.js`), escrito por un dev técnico, no HTML/JS generado por IA ni subido por un tenant — y el ciclo de vida completo desde que se edita en el navegador hasta que un tenant la instala. La pieza central que David confirmó: el preview en navegador no simula nada — es un deploy REAL a WFP, con un script descartable, reusando `deployBoxWorker()` tal cual existe hoy.

## 0. Qué es un Box Dev vs. un box normal

Box normal: HTML/JS estático, generado por IA o pegado por el tenant, sin lógica de servidor propia — corre bajo `wrapper.mjs` genérico.

Box Dev: código real (`worker.js` con su propio `fetch()`), escrito por alguien técnico (del equipo, o eventualmente un dev externo), empaquetado como plantilla instalable. Vive primero como fuente en el repo (`packages/apps/{nombre}/` — `worker.js`, `_partials/*.html`, `package.json`, `README.md`, `wrangler.jsonc` de solo-dev-local), y después como plantilla en control-plane, lista para que un tenant la instale en su box.

## 1. Editor en el portal — "Box Dev Studio"

Sección nueva del portal, distinta del editor de HTML de un box normal (reusa el mismo componente CodeMirror 6 ya migrado, pero editando `worker.js`/partials en vez de un único HTML). Acceso restringido — ver §5.

## 2. Preview — deploy real, descartable

Flujo, disparado por un botón "Probar" en el Studio:

1. El portal manda el código fuente (`worker.js` + partials) a `POST /api/box-devs/preview` (control-plane).
2. Control-plane bundlea server-side con esbuild — mismo mecanismo que ya usa `runtime-box-worker/scripts/build.mjs` para `wrapper.mjs`, corrido on-demand en vez de en build-time del repo.
3. Deploy real vía `deployBoxWorker()` (ya existe, sin cambios) contra el namespace WFP, con `scriptName: preview-{devUserId}` — **fijo por usuario, no por intento**: cada "Probar" nuevo pisa el script anterior del mismo dev (mismo PUT, mismo nombre) en vez de acumular scripts. Evita que cada tecla + guardado genere un script nuevo y further evita rate-limit de la API de Cloudflare.
4. Bindings del preview: **nunca las credenciales reales de un tenant**. Un set de bindings "sandbox" — Turso de test (una DB fija de desarrollo, compartida entre previews, con datos descartables) + placeholders para cualquier secret que el Box Dev declare necesitar (ver `manifest.json`, §3) con valores dummy marcados como tal (`SANDBOX_...`) para que el propio código del Box Dev pueda detectar que está en modo preview si le importa.
5. Respuesta: la URL del preview (ver §4 — cómo se sirve) + el resultado del deploy (éxito/error, igual que ya reporta `deployBoxWorker`).
6. Botón "Descartar preview" → `deleteBoxWorker()` (ya existe). Si el dev no lo descarta a mano, TTL automático: un cron/scheduled task (ya tienen el mecanismo de scheduled tasks en la plataforma) barre `preview-*` sin actividad reciente y los borra — nunca deben quedar acumulándose en el namespace.

## 3. `manifest.json` — qué bindings necesita el Box Dev

Junto a `worker.js`, un archivo chico que declara la forma, no los valores:

```json
{
  "name": "fichas-tecnicas",
  "vars": ["STORE_NAME"],
  "secrets": ["SHOPIFY_API_KEY"],
  "needs_turso": true
}
```

Se usa en dos momentos: (a) preview — control-plane rellena esas keys con valores sandbox/dummy automáticamente, sin pedirle nada al dev; (b) instalación real por un tenant — el portal arma el formulario de "Variables y Secrets" (`htmlbox-spec-wfp-consolidacion.md` §3) pre-poblado con exactamente esas keys, en vez de que el tenant tenga que adivinar qué cargar.

## 4. Cómo se sirve el preview

El dispatcher (`runtime/src/worker.js`) ya sabe resolver `box-{boxId}` contra el namespace WFP. Para preview, mismo mecanismo con un patrón de nombre distinto: `preview-{devUserId}` no es un `boxId` real (no existe fila en `htmlbox_boxes`), así que necesita una ruta dedicada — `preview.sivocloud.dev/{devUserId}` (o `studio.sivocloud.dev/_preview/{devUserId}` para no gastar un subdominio nuevo) que el dispatcher reconoce por patrón y despacha directo a `preview-{devUserId}` en el namespace, sin pasar por la tabla `htmlbox_boxes` en absoluto — solo valida que `devUserId` sea el usuario autenticado actual (nadie puede ver el preview de otro dev con solo adivinar la URL).

## 5. Quién puede usar esto

Box Dev Studio no es para cualquier tenant — es una herramienta técnica. v1: solo `is_platform_owner` o un rol nuevo `platform_developer` (no confundir con el rol `owner`/`editor` de un workspace, que es sobre boxes normales). Si en el futuro se abre a devs externos (terceros construyendo Box Devs para vender en un catálogo), es una decisión de producto aparte — no se resuelve acá.

## 6. Publicar como plantilla instalable

Cuando el Box Dev está listo (no es un preview más, es la versión que otros tenants van a poder instalar): `POST /api/box-devs/publish` — toma el mismo bundle que ya se generó y probó en preview, lo guarda en `htmlbox_box_dev_templates` (bundle + `manifest.json` + versión), y queda disponible en el catálogo de apps instalables. Instalar una plantilla en un box de un tenant real es un `redeployBoxWorker()` normal (`htmlbox-spec-wfp-consolidacion.md`), con los bindings reales de ese tenant — no con los de sandbox.

## 7. Fuera de alcance (v1)

- Runtime de Workers corriendo dentro del navegador (la opción "cara" que se descartó a favor de esta). Sigue siendo válida como optimización futura si el preview real-deploy resulta muy lento en la práctica, pero no se construye ahora.
- Catálogo público de Box Devs de terceros — v1 asume que los Box Devs los escribe el equipo.
- Versionado/rollback de plantillas publicadas más allá de "la última versión gana" — mismo tratamiento simple que boxes normales tienen hoy en versión 1 de HTMLBox, se puede sofisticar después.
- Hot-reload dentro del preview (cada "Probar" es un deploy nuevo, no un reload en caliente) — aceptable para v1, un deploy a WFP toma segundos, no minutos.

## 8. Checklist

1. `packages/apps/` — convención de carpeta para Box Devs fuente (`worker.js`, `_partials/`, `manifest.json`, `wrangler.jsonc` dev-only, `package.json`, `README.md`).
2. `POST /api/box-devs/preview` — bundlea server-side (esbuild) + `deployBoxWorker()` con `scriptName: preview-{devUserId}` + bindings sandbox armados desde `manifest.json`.
3. `DELETE /api/box-devs/preview` — `deleteBoxWorker()` explícito.
4. Scheduled task de limpieza — barre `preview-*` sin actividad reciente (definir TTL, ej. 2 horas).
5. Ruta del dispatcher para `preview.sivocloud.dev/{devUserId}` (o `studio.sivocloud.dev/_preview/{devUserId}`) — valida sesión del dev dueño antes de despachar.
6. Rol `platform_developer` (o gate por `is_platform_owner` en v1) para acceso al Box Dev Studio.
7. `htmlbox_box_dev_templates` — tabla nueva (bundle, manifest, versión, nombre) + `POST /api/box-devs/publish`.
8. UI: Box Dev Studio en el portal (editor CodeMirror 6 reusado, botón Probar/Descartar, link al preview en vivo).
9. Tests: preview deploy real contra WFP de test (no mock) confirma que la URL responde con el código del dev; `scriptName` fijo por usuario no acumula scripts en deploys sucesivos; bindings de preview nunca incluyen credenciales de un tenant real (test explícito, no solo por inspección); un dev no puede ver el preview de otro devUserId; TTL de limpieza borra previews viejos sin tocar boxes reales (`box-*`).
