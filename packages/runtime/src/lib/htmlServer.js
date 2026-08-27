// src/lib/htmlServer.js — sirve el HTML de un box desde R2, inyecta SDK.
//
// Cabeceras (§10):
//   - X-HTMLBox-Version: {n}
//   - Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; … (conservador)
//   - Cross-Origin-Opener-Policy: same-origin
//   - Cross-Origin-Embedder-Policy: require-corp (opcional; conservador por defecto)
//   - X-Content-Type-Options: nosniff
//   - Referrer-Policy: no-referrer
//   - Cache-Control: no-store (siempre fresco — el agente puede pushear en vivo)

import { boxVersionKey, SDK_URL } from '@htmlbox/shared'

export function securityHeaders(visibility) {
  const csp = [
    "default-src 'self'",
    // CDNs populares que el HTML de usuario suele usar.
    // Mantener lista corta y curada — añadir solo CDNs confiables bajo review.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')

  return {
    'Content-Security-Policy': csp,
    'Cross-Origin-Opener-Policy': visibility === 'public' ? 'same-origin' : 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'X-HTMLBox-Powered-By': 'HTMLBox',
  }
}

// Lee la versión activa de un box (debe haber sido resuelta antes por
// resolver.js). Devuelve { html, version } o null si no hay versión activa.
export async function readActiveHtml(bucket, tenantSlug, boxId, version) {
  if (!version || version < 1) return null
  const key = boxVersionKey(tenantSlug, boxId, version)
  const obj = await bucket.get(key)
  if (!obj) return null
  const html = await obj.text()
  return { html, version, key }
}

// Inyecta el SDK antes del </body>. Conservador: no rompe HTML malformado
// porque solo busca el cierre estándar.
export function injectSdk(html, boxId, visibility) {
  const tag = `<script src="${SDK_URL}?boxId=${encodeURIComponent(boxId)}&v=${visibility === 'public' ? 'public' : 'private'}"></script>`
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${tag}</body>`)
  }
  // Si no hay </body>, lo pegamos al final.
  return html + '\n' + tag
}

export async function serveBoxHtml({ boxId, version, html, visibility }) {
  if (!html || !version) {
    return new Response('Box sin versión publicada todavía.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  const finalHtml = injectSdk(html, boxId, visibility)
  const headers = new Headers(securityHeaders(visibility))
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('X-HTMLBox-Version', String(version))
  return new Response(finalHtml, { status: 200, headers })
}