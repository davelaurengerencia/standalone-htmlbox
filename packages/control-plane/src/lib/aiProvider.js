// src/lib/aiProvider.js — integración con Gemini 2.0 Flash para generar
// propuestas de schema a partir del HTML subido por el usuario.
//
// Endpoint: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
// Auth: header X-goog-api-key.
//
// analyzeHtml(html, env, opts?) → { model, tokensUsed, tables }
// buildPrompt(html)            → prompt completo (system + user)
// validateProposal(tables)     → sanea/valida la propuesta del modelo

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
      "sdk_example": "await HTMLBox.table('slug').rows({ limit: 50 })"
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
- Be conservative — 1-2 tables is fine; don't invent complexity.`

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

function buildPrompt(html) {
  return `${SYSTEM_PROMPT}\n\n${USER_PROMPT_TMPL(escapeBackticks(html))}`
}

export function validateProposal(tables) {
  if (!Array.isArray(tables)) return []
  return tables.filter((t) => {
    return t
      && typeof t.slug === 'string'
      && /^[a-z][a-z0-9_]{0,40}$/.test(t.slug)
      && typeof t.name === 'string'
      && Array.isArray(t.columns)
  }).map((t) => ({
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
  }))
}

export async function analyzeHtml(html, env, opts = {}) {
  const { model = 'gemini-flash-latest', maxOutputTokens = 4096 } = opts
  const apiKey = env?.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured')

  const capped = (typeof html === 'string' ? html : '').length > 100_000
    ? html.slice(0, 100_000) + '\n<!--TRUNCATED-->'
    : html
  const prompt = buildPrompt(capped)

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
      tables: validateProposal(parsed.tables || []),
    }
  }
  throw lastErr
}

export { buildPrompt, escapeBackticks, SYSTEM_PROMPT }