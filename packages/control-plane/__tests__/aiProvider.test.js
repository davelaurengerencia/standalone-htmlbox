// __tests__/aiProvider.test.js — tests unitarios del provider AI (Gemini 2.0 Flash).
//
// Mockeamos globalThis.fetch para no depender del network real. Los tests
// verifican:
//   1. Forma del request a Gemini (URL, headers, body)
//   2. Validación de respuesta (candidates vacíos → error)
//   3. Parseo del JSON devuelto por Gemini
//   4. validateProposal rechaza slugs inválidos
//   5. validateProposal coerce tipos inválidos
//   6. Retry con backoff exponencial ante 429
//   7. Falla definitiva tras 3 intentos
//   8. Cap de HTML en 100KB

import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { analyzeHtml, validateProposal, buildPrompt } from '../src/lib/aiProvider.js'

const OK_BODY = {
  candidates: [{
    content: { parts: [{ text: JSON.stringify({
      tables: [{
        slug: 'productos',
        name: 'Productos',
        description: 'Catálogo',
        columns: [
          { name: 'id', type: 'number', example: '1' },
          { name: 'nombre', type: 'string', example: 'Camiseta' },
        ],
        sample_rows: [{ id: 1, nombre: 'Camiseta' }],
        sdk_example: "await HTMLBox.table('productos').rows({ limit: 50 })",
      }],
    }) }], role: 'model' },
    finishReason: 'STOP',
  }],
  usageMetadata: { totalTokenCount: 1234 },
}

function mockFetch(responder) {
  const calls = []
  const orig = globalThis.fetch
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init })
    return responder(url, init, calls.length)
  })
  return {
    calls,
    restore: () => { globalThis.fetch = orig },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

test('1) analyzeHtml sends correct request shape to Gemini', async () => {
  const mock = mockFetch(() => new Response(JSON.stringify(OK_BODY), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }))
  try {
    const result = await analyzeHtml('<html>x</html>', { GEMINI_API_KEY: 'k' })
    expect(result.tables).toHaveLength(1)
    expect(result.tokensUsed).toBe(1234)

    expect(mock.calls).toHaveLength(1)
    const { url, init } = mock.calls[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers['X-goog-api-key']).toBe('k')

    const body = JSON.parse(init.body)
    expect(body.contents).toHaveLength(1)
    expect(body.contents[0].role).toBe('user')
    expect(typeof body.contents[0].parts[0].text).toBe('string')
    expect(body.generationConfig.temperature).toBe(0.2)
    expect(body.generationConfig.maxOutputTokens).toBe(4096)
    expect(body.generationConfig.responseMimeType).toBe('application/json')
  } finally {
    mock.restore()
  }
})

test('2) analyzeHtml validates response shape (missing candidates → error)', async () => {
  vi.useRealTimers()
  const mock = mockFetch(() => new Response(JSON.stringify({ candidates: [] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }))
  try {
    await expect(analyzeHtml('<html/>', { GEMINI_API_KEY: 'k' })).rejects.toThrow(/empty response/)
  } finally {
    mock.restore()
  }
})

test('3) analyzeHtml parses JSON from response', async () => {
  const mock = mockFetch(() => new Response(JSON.stringify(OK_BODY), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }))
  try {
    const result = await analyzeHtml('<html/>', { GEMINI_API_KEY: 'k' })
    expect(result.tables[0].slug).toBe('productos')
    expect(result.tables[0].columns).toHaveLength(2)
    expect(result.tables[0].columns[0]).toMatchObject({ name: 'id', type: 'number' })
  } finally {
    mock.restore()
  }
})

test('4) validateProposal rejects invalid slugs', () => {
  const out = validateProposal([
    { slug: 'Bad-Slug', name: 'X', columns: [] },
    { slug: '1bad', name: 'X', columns: [] },
    { slug: 'a'.repeat(60), name: 'X', columns: [] },
    { slug: 'ok_slug', name: 'OK', columns: [{ name: 'a', type: 'string' }] },
    { name: 'NoSlug', columns: [] },
  ])
  expect(out).toHaveLength(1)
  expect(out[0].slug).toBe('ok_slug')
})

test('5) validateProposal filters columns with invalid types', () => {
  const out = validateProposal([{
    slug: 'cosas',
    name: 'Cosas',
    columns: [
      { name: 'good', type: 'number' },
      { name: 'bad', type: 'blob' },
      { name: 'noType', example: 'x' },
      { name: 'alsoGood', type: 'string' },
    ],
  }])
  expect(out[0].columns).toHaveLength(2)
  expect(out[0].columns[0]).toMatchObject({ name: 'good', type: 'number' })
  expect(out[0].columns[1]).toMatchObject({ name: 'alsoGood', type: 'string' })
})

test('6) analyzeHtml retries on 429 with backoff', async () => {
  const mock = mockFetch((url, init, n) => {
    if (n < 3) return new Response('rate limited', { status: 429 })
    return new Response(JSON.stringify(OK_BODY), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  })
  try {
    const promise = analyzeHtml('<html/>', { GEMINI_API_KEY: 'k' })
    // 1st retry after 1s, 2nd retry after 2s
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    const result = await promise
    expect(result.tables).toHaveLength(1)
    expect(mock.calls.length).toBe(3)
    expect(mock.calls[0].init.headers['X-goog-api-key']).toBe('k')
  } finally {
    mock.restore()
  }
})

test('7) analyzeHtml throws after 3 failed attempts', async () => {
  const mock = mockFetch(() => new Response('boom', { status: 500 }))
  try {
    const promise = analyzeHtml('<html/>', { GEMINI_API_KEY: 'k' })
    promise.catch(() => {})
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(4000)
    await expect(promise).rejects.toThrow(/gemini 500/)
    expect(mock.calls).toHaveLength(3)
  } finally {
    mock.restore()
  }
})

test('8) analyzeHtml caps HTML at 100KB', async () => {
  let capturedSize = -1
  const mock = mockFetch((url, init) => {
    const body = JSON.parse(init.body)
    const text = body.contents[0].parts[0].text
    capturedSize = text.length
    return new Response(JSON.stringify(OK_BODY), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  })
  try {
    const big = 'x'.repeat(150_000)
    const result = await analyzeHtml(big, { GEMINI_API_KEY: 'k' })
    expect(result.tables).toHaveLength(1)
    // el prompt es el sistema + el html truncado a 100KB + delimitadores
    expect(capturedSize).toBeLessThan(150_000)
    expect(capturedSize).toBeGreaterThan(100_000)
    // verificamos que el cap es ≤ ~100KB + pequeño overhead por prompt
    expect(capturedSize).toBeLessThan(105_000)
  } finally {
    mock.restore()
  }
})

test('9) GEMINI_API_KEY missing throws', async () => {
  await expect(analyzeHtml('<html/>', {})).rejects.toThrow(/GEMINI_API_KEY not configured/)
})

test('10) buildPrompt escapes backticks', () => {
  const p = buildPrompt('hello `world`')
  expect(p).not.toContain('hello `world`')
  expect(p).toContain('hello \\`world\\`')
})