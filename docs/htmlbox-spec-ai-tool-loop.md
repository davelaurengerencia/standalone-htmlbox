# HTMLBox — Spec: la IA analiza con tools (loop agentic), no en una sola pasada

Depende de `htmlbox-spec-tablas-reales.md` (columnas SQL reales, `PRAGMA table_info` como fuente de verdad) y reemplaza el flujo de una sola pasada de `htmlbox-spec-ai-analyze-robusto.md` §2 por un loop de tool-calling. El resto de esa spec (clasificación de `app_type`, `created_by`, UI del modal) no cambia.

## 1. El problema con el flujo actual

`analyzeHtml()` hoy es una sola llamada: prompt → JSON → listo. Si Gemini se equivoca (relación mal inferida, tipo incorrecto, `unique` que en realidad no lo es), no hay corrección — hay que re-analizar todo de cero, y "aplicar" ejecuta la propuesta tal cual sin que nadie (ni la IA) verifique el resultado real. Con tools, la IA puede: mirar qué hay antes de proponer, crear, verificar con otro PRAGMA que quedó como esperaba, corregir si no — un loop real de "revisar, actuar, comprobar", no una apuesta de un solo tiro.

## 2. Tools expuestos (formato OpenAI-compatible, no atado a Gemini)

David preguntó si esto se puede extender a OpenRouter — sí, y por eso los tools se definen en el formato de function-calling estilo OpenAI (`{ name, description, parameters: {JSON Schema} }`), que es el que OpenRouter normaliza para CUALQUIER modelo detrás suyo (GPT, Claude, Gemini, Llama, etc.) vía su endpoint `/chat/completions` con `tools`. Gemini también soporta este mismo shape casi 1:1 en su API nativa (`functionDeclarations`). Diseñar los tools una sola vez, en este formato, y tener un adaptador delgado por proveedor (Gemini nativo hoy, OpenRouter como alternativa después) es lo que evita reescribir todo si mañana cambian de proveedor o quieren dejar que el usuario elija modelo.

Tools (ejecutan contra la Turso del box vía `getBoxClient`, reusando lo de `htmlbox-spec-tablas-reales.md`):

```json
[
  {
    "name": "get_schema",
    "description": "Devuelve las tablas existentes en la base de este box y sus columnas reales (via PRAGMA table_info). Si la app es nueva, devuelve una lista vacía — eso NO es un error, significa que no hay nada creado todavía y sos libre de diseñar desde cero.",
    "parameters": { "type": "object", "properties": {} }
  },
  {
    "name": "create_table",
    "description": "Crea una tabla nueva con columnas reales. Falla si la tabla ya existe (usar alter_table para modificar una existente).",
    "parameters": {
      "type": "object",
      "properties": {
        "slug": { "type": "string" },
        "id_strategy": { "type": "string", "enum": ["autoincrement", "uuid"] },
        "columns": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": { "type": "string" },
              "type": { "type": "string", "enum": ["string", "number", "boolean", "date"] },
              "unique": { "type": "boolean" },
              "nullable": { "type": "boolean" },
              "references": { "type": "string", "description": "'{tabla}.{columna}', solo si referencia otra tabla de esta misma app" }
            },
            "required": ["name", "type"]
          }
        }
      },
      "required": ["slug", "columns"]
    }
  },
  {
    "name": "alter_table_add_column",
    "description": "Agrega una columna a una tabla existente (ALTER TABLE ADD COLUMN). No soporta agregar UNIQUE/REFERENCES a una tabla ya creada — si hace falta, hay que recrear la tabla (avisar al usuario, no intentarlo).",
    "parameters": { "type": "object", "properties": { "slug": {"type":"string"}, "column": {"type":"object"} }, "required": ["slug","column"] }
  },
  {
    "name": "insert_rows",
    "description": "Inserta filas de ejemplo/reales en una tabla ya creada. Usar DESPUÉS de create_table, nunca antes.",
    "parameters": { "type": "object", "properties": { "slug": {"type":"string"}, "rows": {"type":"array"} }, "required": ["slug","rows"] }
  },
  {
    "name": "list_tables",
    "description": "Lista los slugs de todas las tablas del box (sin detalle de columnas — para chequeos rápidos de existencia).",
    "parameters": { "type": "object", "properties": {} }
  }
]
```

## 3. El loop

En vez de una llamada única, `analyzeAndApply(html, env, boxId)` (nueva función que reemplaza el flujo separado analyze→apply cuando se usa el modo tools) corre un loop de mensajes:

1. System prompt (mismo `SYSTEM_PROMPT` de hoy + instrucciones de uso de tools + la aclaración explícita: *"Si `get_schema` devuelve una lista vacía, la app es nueva — proponé el mejor schema posible desde cero, no es un error ni falta de datos."*).
2. User message: el HTML + los candidatos deterministicos (`extractArrayCandidates`, igual que hoy).
3. La IA responde con tool calls (`get_schema` primero, casi siempre) → control-plane ejecuta contra Turso, devuelve el resultado como tool response.
4. La IA sigue: si hay tablas existentes, decide si reusar/extender (via `alter_table_add_column`) o crear nuevas; si no hay nada, diseña desde cero y llama `create_table` + `insert_rows`.
5. Después de cada `create_table`/`alter_table_add_column`, control-plane inyecta automáticamente un `get_schema` de verificación (no lo pide la IA, lo hacemos nosotros) y se lo devuelve como contexto — así la IA ve el resultado real, no asume que su tool call salió como esperaba.
6. Loop termina cuando la IA responde con texto plano (sin más tool calls) — un resumen de lo que hizo, que se guarda en `analyses.result_summary` y se muestra en el portal.
7. **Límite duro de 12 tool calls por análisis** (evitar loops descontrolados/costos inesperados) — si se alcanza, se corta y se devuelve lo hecho hasta ahí con un flag `truncated: true`.

## 4. Adaptador por proveedor

```
lib/aiProvider.js
  runToolLoop(html, env, opts)   — orquesta el loop, agnóstico de proveedor
  providers/gemini.js             — traduce tools/mensajes al formato nativo de Gemini (functionDeclarations, function_call/function_response)
  providers/openrouter.js         — traduce al formato OpenAI (tools/tool_calls), pega a openrouter.ai/api/v1/chat/completions
```

`env.AI_PROVIDER` (`'gemini'|'openrouter'`, default `'gemini'`) decide cuál adaptador usar — mismo tool schema, mismo loop, dos wire formats. Esto responde directo a tu pregunta: sí, los tools se pueden usar con OpenRouter sin rediseñarlos, porque ya nacen en el formato que OpenRouter espera.

## 5. Seguridad de los tools (esto no es opcional)

Los tools ejecutan SQL real contra la Turso del box — mismas reglas que ya existen en `dataApi.js`/`boxSchema.js`, no relajadas por venir de una IA:
- `slug` validado contra `/^[a-z][a-z0-9_]{0,40}$/` antes de cualquier interpolación (igual que siempre en este código).
- Los tools SOLO pueden actuar sobre la Turso DEL BOX que se está analizando — el `boxId` viene del contexto de la request autenticada (`requireUser`+`requireRole('editor')`, igual que hoy en `ai.js`), nunca de un parámetro que la IA controle.
- `create_table`/`alter_table_add_column` respetan el límite de columnas/tablas ya existente en el código (`postBulkCreate` ya limita a 20 tablas, 50 columnas — mismo límite acá).
- Los tool calls y sus resultados se loguean en `htmlbox_schema_log` (tabla que YA existe en el schema base, hoy subutilizada) — auditoría de qué hizo la IA y cuándo, no solo el resultado final.

## 6. UI

El modal de "Analizar con IA" pasa de mostrar un resultado final de una vez a mostrar el loop en progreso — una lista tipo "consola" de pasos (`Revisando schema actual...` / `Tabla vacía, diseñando desde cero...` / `Creando tabla productos...` / `Verificando...` / `Listo`), reusando el patrón visual que ya existe para "IA trabajando en segundo plano..." (`aiAutoAnalyzePending`, `main-panel.html.txt`).

## 7. Fuera de alcance

- No se le da a la IA un tool de `drop_table`/`delete_rows` en v1 — demasiado riesgoso para un loop autónomo; borrar sigue siendo una acción manual del usuario en el portal.
- No se implementa todavía el adaptador de OpenRouter en código — la spec deja la arquitectura lista (mismo tool schema, interfaz `providers/*.js`) pero la primera implementación real sigue siendo Gemini; OpenRouter se agrega cuando haga falta elegir modelo, sin tener que rediseñar nada de esto.
- No se resuelve recrear una tabla para agregarle UNIQUE/FK después de creada (mismo punto que ya quedó fuera de alcance en `htmlbox-spec-tablas-reales.md` §5).

## 8. Checklist

1. Definir los 5 tools en JSON Schema (formato OpenAI-compatible) en un archivo compartido (`lib/aiTools.js`), reusado por ambos adaptadores.
2. Implementar `providers/gemini.js` (loop de `functionDeclarations`/`function_call`/`function_response`) sobre la API ya usada hoy.
3. Implementar los handlers reales de cada tool (`get_schema`→PRAGMA, `create_table`/`alter_table_add_column`→`ensureTableReal` de la spec de tablas reales, `insert_rows`→INSERT con columnas nombradas, `list_tables`→PRAGMA simplificado).
4. `runToolLoop` con el límite de 12 llamadas, inyección automática de `get_schema` de verificación tras cada create/alter, logging a `htmlbox_schema_log`.
5. Actualizar el `SYSTEM_PROMPT` con la aclaración de "schema vacío = app nueva, no error".
6. UI del modal: vista tipo consola del progreso del loop.
7. (Fuera de esta pasada, dejar el archivo listo con el placeholder) `providers/openrouter.js` — implementar cuando se decida usar OpenRouter de verdad.
8. Tests: loop completo contra Turso real de test — app nueva (schema vacío → crea desde cero), app con 1 tabla existente (extiende con `alter_table_add_column` en vez de recrear), límite de 12 tool calls se respeta, tool `create_table` con slug inválido rechazado antes de tocar SQL, verificación post-create detecta y reporta si el `CREATE TABLE` no generó lo esperado.
