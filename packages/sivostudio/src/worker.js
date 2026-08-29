// src/worker.js — SivoStudio Worker (launcher + front-worker consolidados).
//
// Ver comentario al inicio de wrangler.jsonc sobre por qué un solo Worker.
//
// Rutas:
//   GET  /                            → launcher UI (botón "Crear box")
//   POST /api/studio/create-box       → aprovisiona box + redirige (Fase 2)
//   GET  /api/studio/list             → lista boxes activos (debug, Fase 6)
//   *    /box/{boxId}/*               → despacha al box via WFP
//   GET  /health                      → health check
//
// Esta fase es SOLO la estructura + placeholders. La lógica real de cada
// endpoint llega en Fases 2 (launcher + D1), 3 (wfpDeployer), 4 (box worker
// con flow-engine), 5 (deploy buttons), 6 (limpieza).

const LAUNCHER_HTML = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SivoStudio — launcher</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #f1f5f9;
    }
    main { max-width: 480px; padding: 2rem; text-align: center; }
    .badge {
      display: inline-block; padding: 0.4rem 0.8rem;
      background: rgba(99,102,241,0.1); border: 1px solid rgba(99,102,241,0.3);
      border-radius: 999px; font-size: 0.75rem; color: #a5b4fc; margin-bottom: 1.5rem;
    }
    h1 { font-size: 2.25rem; margin-bottom: 0.75rem;
         background: linear-gradient(90deg, #6366f1, #ec4899);
         -webkit-background-clip: text; -webkit-text-fill-color: transparent;
         background-clip: text; }
    p { color: #cbd5e1; margin-bottom: 2rem; line-height: 1.5; }
    button {
      font: inherit; cursor: pointer; padding: 0.75rem 2rem;
      background: #6366f1; color: white; border: 0; border-radius: 8px;
      font-weight: 600; font-size: 1rem;
      transition: background 0.15s;
    }
    button:hover:not(:disabled) { background: #4f46e5; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    #status { margin-top: 1.5rem; font-size: 0.875rem; color: #94a3b8; min-height: 1.25rem; }
    #status.error { color: #f87171; }
  </style>
</head>
<body>
  <main x-data="{ creating: false, msg: '' }">
    <span class="badge">Experimento aislado</span>
    <h1>SivoStudio</h1>
    <p>Cada box arranca como un Worker real en WFP. Lo editás en su propia URL.</p>
    <button
      :disabled="creating"
      @click="creating = true; msg = 'Aprovisionando…';
              fetch('/api/studio/create-box', { method: 'POST' })
                .then(r => r.json())
                .then(d => {
                  if (d.url) { window.location.href = d.url; }
                  else { creating = false; msg = d.error || 'Error'; $refs.status.classList.add('error'); }
                })
                .catch(e => { creating = false; msg = e.message; $refs.status.classList.add('error'); })">
      <span x-show="!creating">Crear box</span>
      <span x-show="creating">Creando…</span>
    </button>
    <div id="status" x-ref="status" x-text="msg"></div>
  </main>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js"></script>
</body>
</html>`

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function notImplemented(what) {
  return jsonResponse({ error: 'not_implemented', detail: what }, 501)
}

// === RUTAS ===

// GET / — launcher UI.
function handleLauncher() {
  return htmlResponse(LAUNCHER_HTML)
}

// POST /api/studio/create-box — Fase 2: aprovisiona box + redirige.
async function handleCreateBox(request, env) {
  // TODO Fase 2:
  //   1. Generar boxId ([a-z0-9]{16}).
  //   2. INSERT INTO htmlbox_studio_boxes (box_id, name, script_name, created_at)
  //      usando env.STUDIO_D1.
  //   3. Construir el bundle del box (build.mjs output → string).
  //   4. deployStudioBoxWorker(env, ..., boxId, bundleSource).
  //   5. Responder { url: \`https://\${url.hostname}/box/\${boxId}/editor/frontend\` }.
  return notImplemented('create-box (Fase 2)')
}

// GET /api/studio/list — debug, Fase 6 (limpieza).
async function handleListBoxes(env) {
  // TODO Fase 6: SELECT box_id, name, script_name, created_at, last_seen
  //              FROM htmlbox_studio_boxes WHERE deleted = 0 ORDER BY created_at DESC.
  return notImplemented('list (Fase 6)')
}

// /box/:boxId/* → front-worker: despacha al box via WFP.
async function handleBoxDispatch(request, env, boxId, subpath) {
  // 1) Chequear que el box existe y no está borrado.
  //    TODO Fase 2: SELECT 1 FROM htmlbox_studio_boxes WHERE box_id = ? AND deleted = 0.
  //    Por ahora dejamos que pase cualquier boxId (placeholder).

  // 2) Update last_seen.
  //    TODO Fase 2: UPDATE htmlbox_studio_boxes SET last_seen = datetime('now') WHERE box_id = ?.

  // 3) Despachar al namespace. El script name es `box-{boxId}`.
  if (!env.STUDIO_DISPATCH) {
    return jsonResponse({ error: 'no_dispatch_binding' }, 500)
  }
  const scriptName = `box-${boxId}`
  let worker
  try {
    worker = env.STUDIO_DISPATCH.get(scriptName)
  } catch (e) {
    return jsonResponse({ error: 'dispatch_get_failed', detail: String(e) }, 500)
  }

  // Reescribir URL para preservar /box/:boxId/* — el box worker sabe
  // parsearlo (ver box-template/worker.js#dispatchZone). Esto es coherente
  // con el patrón actual de runtime-core/src/boxDispatch.js, que también
  // pasa la URL completa y agrega headers via BOX_ID_HEADER.
  const dispatched = await worker.fetch(request)
  return dispatched
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // Health check.
    if (url.pathname === '/health') {
      return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }

    // Launcher UI.
    if (url.pathname === '/' || url.pathname === '') {
      return handleLauncher()
    }

    // API del launcher.
    if (url.pathname === '/api/studio/create-box' && request.method === 'POST') {
      return await handleCreateBox(request, env)
    }
    if (url.pathname === '/api/studio/list' && request.method === 'GET') {
      return await handleListBoxes(env)
    }

    // Front-worker: /box/:boxId/* → despachar al box via WFP.
    const boxMatch = url.pathname.match(/^\/box\/([a-z0-9]{16})(\/.*)?$/)
    if (boxMatch) {
      const [, boxId, subpath] = boxMatch
      return await handleBoxDispatch(request, env, boxId, subpath || '/')
    }

    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
  },

  // Cron trigger para Fase 6: limpieza de boxes abandonados.
  // Por ahora no declaramos ningún schedule — se agrega cuando Fase 6 esté lista.
  // async scheduled(event, env, ctx) { ... }
}
