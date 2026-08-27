// src/lib/partials.js — ensambla el shell de la SPA con sus partials usando
// HTMLRewriter (nativo de Workers/Miniflare, no requiere build step).
//
// Los partials acá son estáticos: se bundlean como texto en build-time
// (misma técnica que ya usa el proyecto para portal.html.txt / htmlbox-sdk.txt,
// vía la regla `Text` de wrangler.jsonc) y se resuelven en memoria, sin R2/D1.
// Esto es DISTINTO al spec de "partials de plataforma" para los boxes de
// usuario (htmlbox-spec-partials-htmlrewriter.md) — ese sí involucra R2/D1
// porque el contenido lo publica el platform owner en runtime. Acá el shell
// y sus partials son parte del propio código fuente del portal/admin.
//
// Convención en el shell: <htmlbox-partial name="slug"></htmlbox-partial>
// Cada nombre debe existir como key en el mapa `partials` pasado a renderShell().

class PartialInjector {
  constructor(partials) {
    this.partials = partials
  }
  element(el) {
    const name = el.getAttribute('name')
    if (!name) {
      el.remove()
      return
    }
    const html = this.partials[name]
    if (html) {
      el.replace(html, { html: true })
    } else {
      // Un partial faltante nunca debe tumbar toda la página — se loguea y
      // se deja vacío, igual que la estrategia de fallback en el spec de
      // partials de boxes.
      console.error(`[partials] falta el partial "${name}"`)
      el.remove()
    }
  }
}

class HeadAppender {
  constructor(html) {
    this.html = html
  }
  element(el) {
    el.append(this.html, { html: true })
  }
}

// Ensambla `shellHtml` reemplazando cada <htmlbox-partial name="..."> por su
// contenido. `headAppend`, si se pasa, se inyecta al final del <head> (ej.
// el <script>window.HTMLBOX_RUNTIME_ORIGIN=...</script> que hoy se mete con
// un regex sobre el string — acá se hace con el mismo HTMLRewriter, sin
// depender de que el HTML tenga literalmente la substring "<head>").
export function renderShell(shellHtml, partials, headAppend) {
  const base = new Response(shellHtml, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
  let rewriter = new HTMLRewriter().on('htmlbox-partial', new PartialInjector(partials))
  if (headAppend) {
    rewriter = rewriter.on('head', new HeadAppender(headAppend))
  }
  return rewriter.transform(base)
}
