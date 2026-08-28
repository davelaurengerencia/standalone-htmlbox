# HTMLBox — Orden de implementación y verificación: tablas reales, provisioning y IA

4 specs con dependencias reales entre sí — este documento es el mapa de en qué orden implementar y verificar cada una, para no bloquearse a mitad de camino. Los archivos se renombraron con prefijo numérico para que el orden sea obvio en el listado de la carpeta.

## Orden

**1. `01-htmlbox-spec-tablas-reales.md`** — fundacional. Columnas SQL reales en vez de `data_json`, `PRAGMA table_info` como fuente de verdad, `ensureTableReal`. Todo lo demás depende de esto. Se puede implementar y verificar 100% aislado de la IA — es un cambio de la capa de datos (`dataApi.js`/`boxSchema.js`) que se prueba con tests directos contra Turso real (crear tabla, ALTER ADD COLUMN, UNIQUE rechaza duplicado, FK rechaza referencia inexistente), sin tocar Gemini para nada.

**2. `02-htmlbox-spec-provisioning-lazy.md`** — depende de #1 (`ensureTableReal` es uno de los puntos donde se dispara el aprovisionamiento). Independiente de la IA — los triggers principales (upload manual/CSV) ya existen hoy sin tocar nada de Gemini. Verificable con tests de control-plane puros (crear box → sin Turso; primer write → aprovisiona). Importante hacerlo ANTES de tocar el loop de IA (#4): si el loop de tools llama `create_table` contra un box sin Turso todavía, necesita que este mecanismo ya exista y funcione, si no cada tool call de creación tiene que reinventar su propio manejo de "no hay DB todavía".

**3. `03-htmlbox-spec-ai-analyze-robusto.md`** — depende de #1 (necesita `ensureTableReal`/columnas reales para que `unique`/`references` signifiquen algo). Independiente de #2 y #4 en el sentido de que el PROMPT y la clasificación de `app_type` se pueden diseñar y probar con fixtures de HTML sin loop de tools (analyzeHtml en modo actual de una sola pasada, solo con el prompt mejorado) — verificar acá que la clasificación y el prompt extendido funcionan bien ANTES de meterle la complejidad del loop de tools encima.

**4. `04-htmlbox-spec-ai-tool-loop.md`** — la más compleja y la última, porque depende de las 3 anteriores funcionando: necesita #1 (los tools `create_table`/`alter_table_add_column` ejecutan contra columnas reales), #2 (el tool `create_table` debe disparar el aprovisionamiento diferido si hace falta, no asumir que la Turso ya existe), y #3 (el `SYSTEM_PROMPT`/clasificación de `app_type` que el loop usa como contexto). Verificar esta al final, con las otras 3 ya estables — así cualquier bug que aparezca en el loop es del loop en sí, no de una pieza de abajo que todavía no se probó sola.

## Regla general para verificar cada una

En cada spec, antes de pasar a la siguiente: correr sus tests propios contra Turso REAL (no mock) para las partes que tocan SQL — mismo criterio que ya se usó en las specs de WFP y de app-users (verificado personalmente en esta conversación, no solo "los tests unitarios pasan"). Las partes que tocan Gemini (#3, #4) sí pueden mockear la llamada HTTP a la API de IA en la mayoría de los tests, pero necesitan al menos un smoke test manual contra la API real antes de darlas por cerradas (mismo patrón que `scripts/smoke-wfp.mjs` ya usó para WFP).
