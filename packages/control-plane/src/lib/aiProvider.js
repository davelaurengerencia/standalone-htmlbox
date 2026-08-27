// src/lib/aiProvider.js — integración con Gemini 2.0 Flash para generar
// propuestas de schema a partir del HTML subido por el usuario.
//
// Endpoint: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
// Auth: header X-goog-api-key.
//
// analyzeHtml(html, env, opts?)       → { model, tokensUsed, tables, candidates }
// buildPrompt(html, candidates)        → prompt completo (system + user) con candidatos
// validateProposal(tables, candidates) → sanea/valida la propuesta, asegurando que
//                                        source_var (si no es null) existe en candidates
//
// Cambios en esta versión (htmlbox-spec-ai-apply-schema.md §3):
//   - buildPrompt ahora recibe los candidatos extraídos y le dice a Gemini
//     que el campo source_var de cada tabla DEBE ser uno de los varName
//     dados o null.
//   - validateProposal ahora valida que source_var (si no es null) esté
//     en la lista real de candidatos — defensivo contra IAs que ignoran
//     instrucciones.

const SYSTEM_PROMPT = `You are a database architect for HTMLBox. Given a user-uploaded HTML app, propose a Turso/SQLite schema that captures its data.

Return ONLY valid JSON matching this exact shape:
{
  "tables": [
    {
      "slug": "string_snake_case",
      "name": "Human Readable Name",
      "description": "one sentence in Spanish",
      "columns": [
        { "name": "column_name", "type": "string|number|boolean|date", "example": "example value" }
      ],
      "sample_rows": [ { "col1": "val1", "col2": "val2" } ],
      "sdk_example": "await HTMLBox.table('slug').rows({ limit: 50 })",
      "source_var": "string_or_null"
    }
  ]
}

Rules:
- Slugs MUST match /^[a-z][a-z0-9_]{0,40}$/ (lowercase, snake_case, no hyphens, max 40).
- Types allowed: "string", "number", "boolean", "date".
- Infer columns from: fetch() URLs/query params, mock data arrays, <input> name attrs, <td> cell content, JSON.parse of literal arrays in JS.
- Sample rows: 2-3 realistic rows per table, synthesize from context.
- DO NOT propose columns that don't appear in the HTML.
- Skip decorative data (text content of <h1>, copy text). Focus on STRUCTURED data the app shows/uses.
- If you see an array of objects literal (e.g. const productos = [...), propose a table for it.
- Be conservative — 1-2 tables is fine; don't invent complexity.

CRITICAL — "source_var" field:
- The user-provided HTML may already contain candidate data arrays (extracted deterministically by regex, NOT by you).
- For each table you propose, set "source_var" to ONE of those varName EXACTLY (string match, case-sensitive) if the table's data is already in one of those arrays.
- If the table is for data that is NOT in any of those arrays (e.g. data from an external fetch() or computed at runtime), set "source_var" to null.
- NEVER invent a varName that is not in the candidates list.`

const USER_PROMPT_TMPL = (safeHtml) => `Analiza este HTML y propone el schema óptimo.

HTML:
\`\`\`html
${safeHtml}
\`\`\``

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function escapeBackticks(s) {
  return String(s).replace(/`/g, '\\`')
}

export function buildPrompt(html, candidates = []) {
  const userPrompt = USER_PROMPT_TMPL(escapeBackticks(html))
  if (!candidates.length) return `${SYSTEM_PROMPT}\n\n${userPrompt}`

  const candidatesSummary = candidates.map((c) =>
    `- varName: "${c.varName}", rowCount: ${c.rowCount}, primera fila: ${JSON.stringify(c.rows[0] || {})}`,
  ).join('\n')
  return `${SYSTEM_PROMPT}\n\n${userPrompt}\n\nCandidatos de datos ya detectados en el HTML (deterministicamente, por regex):\n${candidatesSummary}\n\nPara cada tabla que propongas, el campo "source_var" DEBE ser exactamente uno de esos varName, o null si la tabla no corresponde a ningún candidato (ej. si proponés una tabla para datos que en realidad NO están en un array literal, sino que vienen de un fetch() o se computan en runtime).`
}

export function validateProposal(tables, candidates = []) {
  if (!Array.isArray(tables)) return []
  const validVarNames = new Set(candidates.map((c) => c.varName))
  return tables.filter((t) => {
    return t
      && typeof t.slug === 'string'
      && /^[a-z][a-z0-9_]{0,40}$/.test(t.slug)
      && typeof t.name === 'string'
      && Array.isArray(t.columns)
  }).map((t) => {
    // source_var: si la IA inventó un varName que no está en candidates,
    // forzamos null (defensivo — no se aplica igual).
    const rawSourceVar = typeof t.source_var === 'string' ? t.source_var : null
    const sourceVar = rawSourceVar && validVarNames.has(rawSourceVar)
      ? rawSourceVar
      : null
    return {
      slug: t.slug,
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      columns: (t.columns || [])
        .filter((c) => c && typeof c.name === 'string'
          && ['string', 'number', 'boolean', 'date'].includes(c.type))
        .map((c) => ({
          name: c.name,
          type: c.type,
          example: typeof c.example === 'string' ? c.example : '',
        })),
      sample_rows: Array.isArray(t.sample_rows) ? t.sample_rows.slice(0, 5) : [],
      sdk_example: typeof t.sdk_example === 'string'
        ? t.sdk_example
        : `await HTMLBox.table('${t.slug}').rows({ limit: 50 })`,
      source_var: sourceVar,
    }
  })
}

export async function analyzeHtml(html, env, opts = {}) {
  const { model = 'gemini-flash-latest', maxOutputTokens = 4096, candidates = [] } = opts
  const apiKey = env?.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured')

  const capped = (typeof html === 'string' ? html : '').length > 100_000
    ? html.slice(0, 100_000) + '\n<!--TRUNCATED-->'
    : html
  const prompt = buildPrompt(capped, candidates)

  let attempt = 0
  let lastErr
  while (attempt < 3) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens,
            responseMimeType: 'application/json',
          },
        }),
      },
    )
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`gemini ${res.status}`)
        await sleep(1000 * Math.pow(2, attempt))
        attempt++
        continue
      }
      throw new Error(`gemini ${res.status}: ${await res.text()}`)
    }
    const data = await res.json()
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error('gemini: empty response')

    let parsed
    try { parsed = JSON.parse(text) }
    catch { throw new Error('gemini: response is not valid JSON') }

    return {
      model,
      tokensUsed: data?.usageMetadata?.totalTokenCount || 0,
      tables: validateProposal(parsed.tables || [], candidates),
      // Devolvemos candidates también para que el caller (routes/ai.js) los
      // guarde en la fila D1 si quiere, o el caller los puede regenerar del html.
    }
  }
  throw lastErr
}

export { SYSTEM_PROMPT }