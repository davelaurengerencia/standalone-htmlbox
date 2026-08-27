// src/sdk/htmlbox-sdk.js — SDK inyectado en cada box servido.
//
// Uso:
//   <script src="/_sdk/htmlbox.js"></script>
//
// Expone window.HTMLBox con la API mínima documentada en §5.
// En fase 1/2 solo expone la firma y respuestas stub para que el HTML de
// usuario funcione y los autores sepan la API que tendrán disponible.
//
// Firma (fase 3+ implementará las llamadas reales contra el runtime):
//   await HTMLBox.table('ventas').rows({ limit, offset, where })
//   await HTMLBox.table('ventas').columns()
//   await HTMLBox.table('ventas').upsert(rows)
//   HTMLBox.table('ventas').onChange(cb)
//   await HTMLBox.flow('refresh-ventas').run()
//
// La inyección la hace htmlServer.js#injectSdk — recibe ?boxId=…&v=public|private.

;(function () {
  const URL_PARAMS = new URLSearchParams(location.search)
  const BOX_ID = URL_PARAMS.get('boxId') || ''
  const VISIBILITY = URL_PARAMS.get('v') || 'public'

  // URL del runtime para hablar con /api/data/* — fase 3+.
  const RUNTIME_ORIGIN = location.origin

  function notImplemented(method, op) {
    return Promise.reject(new Error(
      `[HTMLBox] ${method}.${op} no está disponible todavía (fase 3). ` +
      `Box: ${BOX_ID}, visibilidad: ${VISIBILITY}.`,
    ))
  }

  function table(slug) {
    if (!slug || typeof slug !== 'string') {
      throw new Error('HTMLBox.table(slug): slug requerido')
    }
    const api = {
      rows() { return notImplemented('table', 'rows') },
      columns() { return notImplemented('table', 'columns') },
      upsert() { return notImplemented('table', 'upsert') },
      onChange() {
        console.info(`[HTMLBox] table(${slug}).onChange — el polling suave se habilita en fase 3.`)
      },
    }
    return api
  }

  function flow(flowId) {
    if (!flowId || typeof flowId !== 'string') {
      throw new Error('HTMLBox.flow(flowId): flowId requerido')
    }
    return {
      run() { return notImplemented('flow', 'run') },
    }
  }

  const htmlbox = {
    boxId: BOX_ID,
    visibility: VISIBILITY,
    runtimeOrigin: RUNTIME_ORIGIN,
    sdkVersion: '0.1.0',
    table,
    flow,
  }

  window.HTMLBox = htmlbox
  console.log(`[HTMLBox] SDK v${htmlbox.sdkVersion} listo (box=${BOX_ID}, visibility=${VISIBILITY})`)
})()