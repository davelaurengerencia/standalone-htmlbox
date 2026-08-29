# HTMLBox — Spec: Box Devs vía ZIP (crear local, subir, queda online)

Complementa `htmlbox-spec-box-devs-preview.md` — este es el v0: en vez de un editor en el navegador, el dev arma el proyecto en su máquina con sus herramientas de siempre, lo zippea, lo sube, y sale deployado. Reusa toda la infraestructura de deploy que ya existe (`deployBoxWorker()`) — lo nuevo acá es solo la entrada: de "código escrito en el navegador" a "ZIP subido".

## 1. Estructura del proyecto local

Misma convención que ya definimos (`htmlbox-spec-box-devs-preview.md` §0), pensada para zippear tal cual:

```
fichas-tecnicas/
├── worker.js              # obligatorio — entry point del Worker
├── manifest.json          # obligatorio — nombre, vars/secrets que necesita, needs_turso
├── _partials/
│   ├── index.html
│   └── admin.html
├── local.sqlite           # opcional — DB de desarrollo, si needs_turso=true
├── package.json           # opcional, informativo
├── README.md              # opcional, informativo
└── wrangler.jsonc         # opcional, solo para `wrangler dev` local — se ignora en el upload
```

El dev desarrolla y prueba localmente con `wrangler dev` contra su `wrangler.jsonc` (mismo patrón dev que ya usan los 4 Workers actuales), usando `local.sqlite` como su base de datos de prueba — sin depender de red ni de una Turso real mientras itera.

## 2. Endpoint de subida

`POST /api/box-devs/upload-zip` (multipart, un solo campo `file`), + parámetro `target`: `boxId` de un box propio (deploya ahí directo) o `'template'` (publica como plantilla instalable, no deploya a ningún tenant — mismo flujo que `htmlbox-spec-box-devs-preview.md` §6).

Validaciones antes de tocar el ZIP:
- Tamaño máximo del archivo subido (ej. 20 MB comprimido — generoso para código+partials, insuficiente para colar algo grande sin querer).
- Content-Type `application/zip`.
- Rol: mismo gate que Box Dev Studio (`is_platform_owner` o `platform_developer`, v1).

Al descomprimir (server-side, control-plane):
- **Zip-slip**: cada entry del ZIP se valida contra path traversal (`../`, paths absolutos, symlinks) antes de escribir a disco temporal — nunca confiar en los nombres de archivo de un ZIP subido por un usuario. Rechazar el ZIP entero si una sola entry es sospechosa.
- Límite de entries (ej. 200 archivos) y de tamaño descomprimido total (ej. 100 MB) — protege contra zip bombs.
- Whitelist de extensiones permitidas dentro del ZIP: `.js`, `.html`, `.json`, `.md`, `.sqlite`, `.txt` — cualquier otra extensión hace rechazar el ZIP completo (nada de binarios arbitrarios, nada de `node_modules/` con paquetes nativos).
- `worker.js` y `manifest.json` en la raíz son obligatorios — si falta cualquiera, 400 con el motivo claro.

## 3. Build

Mismo paso que ya define `htmlbox-spec-box-devs-preview.md` §2.2 — esbuild server-side, `worker.js` + `_partials/*.html` inlineados como texto (mismo mecanismo `Text`/`fallthrough` que ya usan `control-plane`/`portal`). Si el build falla (sintaxis inválida, import de un paquete no permitido), la respuesta incluye el error de esbuild tal cual, para que el dev lo vea y corrija localmente — no se intenta arreglar nada del lado del servidor.

Paquetes npm: v1 **no** soporta `import` de dependencias externas dentro de `worker.js` — solo lo que ya provee `nodejs_compat` + módulos propios del Box Dev (`_partials` importados como texto). Si el dev necesita una librería externa, queda fuera de alcance por ahora (ver §7) — evita tener que resolver un `npm install` seguro contra código subido por el usuario.

## 4. `.sqlite` → Turso real

Si `manifest.json` declara `needs_turso: true` Y el ZIP incluye `local.sqlite`:

1. Validar que el archivo es un SQLite real antes de tocarlo — magic bytes (`SQLite format 3\0`, primeros 16 bytes), tamaño máximo (ej. 50 MB — una DB de desarrollo no debería ser más grande que eso).
2. Provisionar (o reusar, si `target` es un box existente) la Turso del box.
3. Importar el contenido de `local.sqlite` como base de esa Turso — el schema real (`CREATE TABLE` con columnas reales, si el dev ya siguió `htmlbox-spec-tablas-reales.md` en su desarrollo local) y los datos de prueba quedan tal cual en producción.

**Punto a confirmar antes de implementar**: el mecanismo exacto que expone la API de Turso para importar un `.sqlite` existente (no solo el CLI `turso db create --from-file`, sino el equivalente programático que control-plane pueda llamar desde un Worker) — no lo tengo verificado contra la documentación actual de Turso en esta sesión. Antes de escribir código, alguien del equipo debe confirmar: (a) si existe un endpoint de su API REST para esto, (b) límites de tamaño del import, (c) si el import es sincrónico o hay que pollear un estado. Si no hay forma programática directa, la alternativa es: parsear el `.sqlite` localmente en el Worker (hay librerías WASM de SQLite que corren en Workers) y reproducir el schema + datos con `CREATE TABLE`/`INSERT` reales contra la Turso ya provisionada — más trabajo, pero no depende de una feature específica de la API de Turso.

Si `needs_turso: true` pero NO se sube `.sqlite`: cae al comportamiento normal de `htmlbox-spec-provisioning-lazy.md` — Turso vacía, se llena con el primer uso real.

## 5. Deploy

- `target: boxId` → `redeployBoxWorker(env, ..., boxId, reason: 'box_dev_upload')` — mismo mecanismo de `htmlbox-spec-wfp-consolidacion.md`, bindings reales del tenant dueño de ese box (incluida la Turso recién poblada si aplica §4).
- `target: 'template'` → se guarda en `htmlbox_box_dev_templates` (`htmlbox-spec-box-devs-preview.md` §6) sin deployar a ningún tenant — queda disponible para instalar después. El `.sqlite`, si viene, se guarda como "datos de ejemplo" de la plantilla (se usa para poblar la Turso de CADA tenant que la instale, no una Turso compartida).

Respuesta: éxito/error del deploy (igual que ya reporta `deployBoxWorker`) + la URL final si aplica.

## 6. Seguridad — resumen de lo que ya se mencionó, en un solo lugar

- Gate de rol (§2) — no es una feature para tenants normales en v1.
- Zip-slip + límites de tamaño/entries (§2) — el ZIP es contenido no confiable hasta que se valida.
- Sin `npm install` de dependencias externas (§3) — superficie de ataque enorme si se permite instalar paquetes arbitrarios server-side a partir de un ZIP subido.
- `.sqlite` validado por magic bytes antes de cualquier import (§4) — no confiar en la extensión del archivo.
- Igual que preview (`htmlbox-spec-box-devs-preview.md` §2): si `target` es `'template'`, nunca se usan credenciales de un tenant real durante el proceso — el `.sqlite` de ejemplo se queda como archivo/plantilla, no se importa a ninguna Turso de producción hasta que un tenant instala.

## 7. Fuera de alcance (v1)

- Dependencias npm externas dentro de `worker.js` (§3).
- Editor en el navegador (`htmlbox-spec-box-devs-preview.md`) — sigue siendo un camino aparte, no reemplazado por este, para ediciones rápidas sin volver a zippear.
- Versionado de uploads (subir un ZIP nuevo pisa el deploy anterior, sin historial tipo el de boxes normales — se puede sumar después con el mismo mecanismo de `htmlbox_versions` si hace falta).
- Convertir el `.sqlite` si NO sigue el modelo de columnas reales (si el dev igual usó su propio formato ad-hoc dentro del SQLite) — se importa tal cual, HTMLBox no valida que el schema del `.sqlite` subido siga ninguna convención particular.

## 8. Checklist

1. `POST /api/box-devs/upload-zip` — recepción multipart, validaciones de tamaño/Content-Type/rol.
2. Descompresión segura (protección zip-slip, límite de entries/tamaño descomprimido, whitelist de extensiones).
3. Build server-side (esbuild) reusando el mismo mecanismo de `htmlbox-spec-box-devs-preview.md`.
4. Validación de `.sqlite` (magic bytes, tamaño) + investigación/implementación del import real a Turso (bloqueado hasta confirmar la API de Turso — ver §4).
5. Deploy: `target: boxId` vs `target: 'template'`, reusando `redeployBoxWorker()`/`htmlbox_box_dev_templates`.
6. Tests: ZIP con path traversal se rechaza sin escribir nada a disco; ZIP con extensión no permitida se rechaza; `.sqlite` inválido (bytes random con extensión `.sqlite`) se rechaza antes de intentar importar; build con `import` de paquete externo falla con mensaje claro; deploy a `target: boxId` de otro tenant se rechaza (verificación de ownership, no solo de rol); import de un `.sqlite` real con columnas reales resulta en una Turso con el mismo `PRAGMA table_info` que el archivo original.
