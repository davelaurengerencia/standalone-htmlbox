// src/lib/csv.js — parser CSV liviano para Workers.
//
// Reglas (v1):
//   - Separador: coma (,) — el RFC también tolera tab pero v1 solo coma.
//   - Comillas: " para envolver campos con coma/comilla/salto de línea.
//   - Escape de comilla: "" dentro de un campo.
//   - Primera fila = headers (nombres de columna).
//   - Salto de línea: \n o \r\n.
//
// Devuelve:
//   { headers: string[], rows: Array<Record<string, string>>, rowCount: n }
//   o { error: string } si el CSV está mal armado.

export function parseCsv(input) {
  if (typeof input !== 'string') {
    return { error: 'csv input must be a string' }
  }
  if (input.length === 0) return { headers: [], rows: [], rowCount: 0 }

  const records = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < input.length; i++) {
    const c = input[i]

    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++ // skip escaped quote
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }

    if (c === '"') {
      inQuotes = true
      continue
    }
    if (c === ',') {
      row.push(field)
      field = ''
      continue
    }
    if (c === '\n' || c === '\r') {
      // commit field + row
      row.push(field)
      field = ''
      if (row.length > 1 || row[0] !== '') records.push(row)
      row = []
      // \r\n → skip extra \n
      if (c === '\r' && input[i + 1] === '\n') i++
      continue
    }
    field += c
  }
  // último field/row
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') records.push(row)
  }

  if (records.length === 0) return { headers: [], rows: [], rowCount: 0 }

  const headers = records[0].map((h) => String(h).trim())
  const rows = []
  for (let i = 1; i < records.length; i++) {
    const r = records[i]
    const obj = {}
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = r[j] !== undefined ? String(r[j]) : ''
    }
    rows.push(obj)
  }
  return { headers, rows, rowCount: rows.length }
}