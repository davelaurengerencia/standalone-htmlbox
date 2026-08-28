# HTMLBox — Spec: detectar HTML que lee archivos locales, subirlos a R2, sin tocar el HTML

Extiende `htmlbox-spec-ai-analyze-robusto.md` (mismo paso de análisis) y completa un placeholder existente: `postUpload()` (`dataApi.js`) hoy registra el upload en `htmlbox_files` con `r2_key: 'pending://upload/${fileId}'` — un valor que nunca se resuelve, el archivo original no se guarda en ningún lado, solo las filas parseadas van a Turso. Esta spec cierra ese hueco Y agrega la detección nueva.

## 1. Decisión de alcance (confirmada con David)

El form de subida vive en el modal "Analizar con IA" del portal, lo hace el DUEÑO del box UNA VEZ al aplicar el análisis — no un `<input type="file">` nuevo dentro del HTML final de la app. El HTML de la app queda intacto en su lógica (si ya tenía su propio parser de CSV/Excel, se respeta tal cual); lo único que cambia es que el `fetch()`/lectura local ahora apunta a la copia que ya vive en R2, en vez de a un archivo que nunca iba a estar ahí en producción.

## 2. Detección (extiende `dataExtractor.js`, mismo archivo que ya extrae candidatos de arrays)

Nueva función `extractLocalFileCandidates(html)`, sin `eval` ni ejecutar nada del tenant (mismo criterio de seguridad que ya rige todo `dataExtractor.js`):

- **Patrón A — fetch a ruta relativa con extensión de datos**: regex sobre `fetch(['"]([^'"]+\.(csv|json|xlsx|tsv))['"]` — cualquier URL que NO empiece con `http`/`https`/`/` (o sea, relativa al propio HTML) y termine en una extensión de datos común.
- **Patrón B — `<input type="file">` + `FileReader`**: si hay un `<input type="file">` en el HTML Y el JS usa `FileReader`/`.readAsText()`/`.readAsArrayBuffer()` — señal de que el propio HTML espera que un humano seleccione el archivo cada vez que se abre (distinto del patrón A, que asume un archivo fijo ya provisto).

Cada candidato devuelve `{ kind: 'local_file', pattern: 'fetch'|'file_input', detectedPath: './ventas.csv' | null, varOrElementHint: '...' }`.

## 3. Qué hace la IA con esto

En el prompt (`htmlbox-spec-ai-analyze-robusto.md` ya extendido con `app_type`), estos candidatos se pasan igual que los de arrays — la IA los puede usar para proponer una tabla (si conviene estructurar los datos) O simplemente señalar "este archivo necesita subirse, no requiere tabla" (cuando el HTML ya hace su propio parseo y no hace falta que HTMLBox entienda la forma de los datos). La IA NO decide subir nada — solo identifica y describe; subir es una acción del dueño en el modal.

## 4. El modal — un form por archivo detectado

Por cada candidato `local_file`, el modal de "Analizar con IA" muestra:

```
📄 Esta app espera leer "ventas.csv" — subilo para que funcione en la nube.
[ Elegir archivo ]  (usa el nombre detectado como label; si no se pudo
                      detectar un nombre — patrón B sin filename fijo —
                      usa un label genérico "Subí el archivo que la app espera")
```

Al subir: `POST /api/data/{boxId}/files/{slug}` (nuevo endpoint o extensión de `postUpload`) — guarda el archivo TAL CUAL en R2 (`r2_key` real, no el placeholder actual — esto de paso arregla el bug existente), sin parsearlo a filas (a menos que la IA haya propuesto explícitamente una tabla para ese candidato, en cuyo caso además corre el import a Turso vía `postUpload` como ya existe).

## 5. Reescritura del HTML — solo cambia la URL, no la lógica

Para el patrón A (`fetch('./ventas.csv')`): reemplazo de string simple, mismo mecanismo de splice-por-posición que ya usa `applyAnalysis` para arrays — cambia `'./ventas.csv'` por `'/api/files/{boxId}/ventas.csv'` (endpoint de lectura, sirve el byte tal cual desde R2 con el `Content-Type` correcto). El resto del `fetch().then(r => r.text()).then(parseCSV...)` del HTML original queda exactamente igual — nunca se toca el parser propio de la app.

Para el patrón B (`<input type="file">`): más delicado — significa que la app ORIGINALMENTE dejaba elegir el archivo a quien la abre, no un archivo fijo del dueño. Acá no hay una única respuesta correcta automática; el modal debe aclarar esto al dueño ("esta app deja que cada visitante suba su propio archivo — ¿querés fijar uno para todos, o dejar que el input siga funcionando como está, sin persistir nada?"), y solo reescribir el HTML si el dueño elige "fijar uno para todos" (convierte el `<input type="file">` + `FileReader` en un fetch al archivo ya subido, mismo tratamiento que el patrón A desde ese punto).

## 6. `GET /api/files/{boxId}/{filename}` — nuevo endpoint de lectura

Sirve el byte crudo desde R2 con el `Content-Type` correcto (`text/csv`, `application/json`, etc.), mismo criterio de auth que ya aplica a boxes privados/públicos (`serveBoxHtml`/`resolver.js` — un archivo de un box privado requiere la misma sesión que el HTML del box). Namespacing de la key en R2: mismo prefijo por-tenant/por-box que ya usa `namespacedKey` en `packages/shared` — nunca un path que un tenant pueda usar para leer el archivo de otro box.

## 7. Fuera de alcance

- No se resuelve el caso "el dueño quiere reemplazar el archivo después" en esta pasada más allá de lo que ya permite re-analizar/re-aplicar — no hay un botón dedicado "actualizar este archivo" fuera del flujo de análisis.
- No se agrega parseo de Excel real (`.xlsx`) en el servidor — si el patrón detectado es `.xlsx`, se sube y sirve igual (R2 passthrough), pero la IA no intenta convertirlo a filas de Turso (el parser CSV ya existe en `csv.js`; XLSX no).
- El patrón B con "dejar como está" (no fijar archivo) simplemente no reescribe nada — la app sigue funcionando exactamente igual que antes de pasar por el análisis, con su comportamiento original de selección local.

## 8. Checklist

1. `extractLocalFileCandidates()` en `dataExtractor.js` (patrones A y B, sin eval).
2. Extender el prompt/response de `aiProvider.js` para incluir candidatos `local_file` (mismo tratamiento que `source_var`, sin inventar paths que no estén en los candidatos).
3. Endpoint de subida (arreglar el placeholder `r2_key` de `postUpload`, o uno nuevo `POST /api/data/{boxId}/files/{slug}`) que persiste el archivo real en R2.
4. Endpoint `GET /api/files/{boxId}/{filename}` — lectura con auth y namespacing correctos.
5. UI del modal: un form de subida por candidato `local_file`, con el nombre detectado como label.
6. Rewrite del HTML: patrón A automático (solo cambia la URL), patrón B con confirmación explícita del dueño antes de tocar el `<input type="file">`.
7. Tests: detección de ambos patrones sobre HTML de fixture, subida real a R2 (no mock) y lectura de vuelta byte-a-byte idéntica, namespacing rechaza leer el archivo de otro box, patrón B sin confirmación no reescribe nada.
