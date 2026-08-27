// src/lib/dataExtractor.js — extractor determinístico de candidatos de
// arrays de datos embebidos en HTML.
//
// htmlbox-spec-ai-apply-schema.md §2.
//
// Reglas críticas:
//   - NUNCA eval(), new Function(), ni nada que ejecute código del tenant.
//     El único parser que toca el JS del tenant es JSON.parse() sobre el
//     texto exacto de un array literal — si no es JSON válido, no es
//     candidato. Misma garantía de seguridad que el resto del proyecto.
//   - Trabaja SOLO si hay exactamente un <script> inline (sin src) — mismo
//     límite que htmlbox-spec-editor-split-view.md §1 (v1). Si hay 0 o 2+,
//     no hay candidatos.
//   - Las posiciones (declStart/declEnd) se devuelven ABSOLUTAS dentro del
//     HTML completo, listas para hacer splice directo sobre el string
//     original. Se calculan usando match.indices (flag `d` de la regex),
//     no a mano — ver htmlbox-spec-editor-split-view.md §2 (mismo patrón).

// Devuelve info del único <script> inline (sin src) o null si hay 0 o 2+.
//   { attrs, content, contentStart, fullMatch, start, end }
//     - contentStart: posición ABSOLUTA dentro de html donde arranca el
//       contenido (entre > de apertura y </script>)
//     - start: posición del '<' de apertura del tag
//     - end: posición del '>' de cierre del </script>
export function findSingleInlineScript(html) {
  if (typeof html !== 'string') return null
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gd
  const matches = []
  let m
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1])) continue // <script src="..."> — externo, no cuenta
    matches.push({
      attrs: m[1],
      content: m[2],
      contentStart: m.indices[2][0],
      contentEnd: m.indices[2][1],
      fullMatch: m[0],
      start: m.indices[0][0],
      end: m.indices[0][1],
    })
  }
  return matches.length === 1 ? matches[0] : null
}

// Reemplaza findSingleInlineScript en operaciones que NO requieren el
// offset exacto — solo saber si hay un único script inline y obtener su
// contenido + tag de apertura. Útil para el "agregar type=module" del §4.
export function getSingleInlineScriptOpenTag(html) {
  const s = findSingleInlineScript(html)
  if (!s) return null
  return { attrs: s.attrs, fullMatch: s.fullMatch, start: s.start, end: s.end }
}

// Devuelve [{ varName, declStart, declEnd, arrayText, rows, rowCount }]
// para cada `const X = [...]` / `let X = [...]` dentro del ÚNICO <script>
// inline del HTML, cuyo array sea JSON-válido y array de objetos no vacío.
//
//   - declStart/declEnd: posiciones ABSOLUTAS dentro de `html` (no del
//     script), listas para hacer splice sobre el html original.
//   - Si el candidato se descarta (no es JSON, no es array de objetos,
//     etc.) se omite silenciosamente — el extractor no rompe nada, solo
//     no devuelve ese candidato.
export function extractArrayCandidates(html) {
  const script = findSingleInlineScript(html)
  if (!script) return []

  // flag `d` para tener m.indices — igual a findSingleInlineScript.
  const re = /\b(?:const|let)\s+([a-zA-Z_$][\w$]*)\s*=\s*(\[[\s\S]*?\])\s*;?/gd
  const candidates = []
  let m
  while ((m = re.exec(script.content)) !== null) {
    const varName = m[1]
    const arrayText = m[2]
    let rows
    try {
      rows = JSON.parse(arrayText)
    } catch {
      // No es JSON válido (comillas simples, trailing comma, código, etc.) — se descarta.
      continue
    }
    if (!Array.isArray(rows) || rows.length === 0) continue
    if (!rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) continue

    const [declStartInContent, declEndInContent] = m.indices[0]
    const declStart = script.contentStart + declStartInContent
    const declEnd = script.contentStart + declEndInContent

    candidates.push({
      varName,
      declStart,
      declEnd,
      arrayText,
      rows,
      rowCount: rows.length,
    })
  }
  return candidates
}

// Construye el reemplazo para un candidato — la línea que se inserta en
// lugar de `const X = [...]`. Usa `await HTMLBox.table('slug').rows(...)`
// (mismo SDK que ya usa el resto del portal, ver htmlbox-spec-ai-apply-schema.md §1).
export function buildReplacementForCandidate(candidate, slug) {
  return `const ${candidate.varName} = await HTMLBox.table('${slug}').rows({ limit: 1000 })`
}