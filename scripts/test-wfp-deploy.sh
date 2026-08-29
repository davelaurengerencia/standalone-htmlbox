#!/usr/bin/env bash
# scripts/test-wfp-deploy.sh — smoke test end-to-end de sivostudio.
#
# Uso:
#   1. Generar WFP_DEPLOY_TOKEN con ./scripts/setup-wfp-experiments.sh
#   2. Asegurarse de que dev:studio está corriendo (npm run dev:studio)
#   3. Correr este script:
#      bash scripts/test-wfp-deploy.sh
#
# Qué hace:
#   1. POST /api/studio/create-box
#   2. Si OK: imprime el boxId y la URL del box.
#   3. Si OK: GET /box/{boxId}/health-style (HEAD /editor/frontend) para
#      confirmar que el box worker responde.
#   4. Cleanup: NO borra el box — eso lo hace el cron trigger (Fase 6).
#      Si querés limpiar manualmente, usá `wrangler dispatch-namespace
#      scripts delete sivostudio-experiments box-{boxId}` (o esperá 30 días).
#
# Exit codes:
#   0 = OK
#   1 = create-box falló
#   2 = box worker no responde

set -euo pipefail

STUDIO_URL="${HTMLBOX_STUDIO_URL:-http://127.0.0.1:8786}"

echo "→ POST $STUDIO_URL/api/studio/create-box"
CREATE_RESPONSE=$(curl -s -X POST "$STUDIO_URL/api/studio/create-box")
echo "$CREATE_RESPONSE"
echo ""

# Parsear boxId del JSON. Usamos node porque jq puede no estar instalado.
BOX_ID=$(node -e "try { process.stdout.write(JSON.parse(process.argv[1]).boxId || '') } catch { process.stderr.write('ERROR: respuesta no es JSON válido o no tiene boxId\n'); process.exit(1) }" "$CREATE_RESPONSE")

if [ -z "$BOX_ID" ]; then
  echo "✗ create-box falló — revisá que WFP_DEPLOY_TOKEN esté configurado:"
  echo "    cd packages/sivostudio && wrangler secret list"
  echo "    y que wrangler.jsonc tenga el binding STUDIO_R2."
  exit 1
fi

echo "✓ Box creado: $BOX_ID"
echo "  URL app: $STUDIO_URL/box/$BOX_ID/editor/frontend"
echo "  URL app publicada: $STUDIO_URL/box/$BOX_ID/"
echo ""

echo "→ GET $STUDIO_URL/box/$BOX_ID/editor/frontend (debería servir App Studio)"
HTTP_CODE=$(curl -s -o /tmp/sivostudio-appstudio.html -w "%{http_code}" "$STUDIO_URL/box/$BOX_ID/editor/frontend")
echo "  status=$HTTP_CODE"
echo "  size=$(wc -c < /tmp/sivostudio-appstudio.html) bytes"
if [ "$HTTP_CODE" != "200" ]; then
  echo "✗ Box worker no responde 200 — el deploy al namespace pudo haber fallado."
  exit 2
fi

echo ""
echo "→ GET $STUDIO_URL/box/$BOX_ID/ (debería servir el placeholder)"
HTTP_CODE=$(curl -s -o /tmp/sivostudio-app.html -w "%{http_code}" "$STUDIO_URL/box/$BOX_ID/")
echo "  status=$HTTP_CODE"
echo "  size=$(wc -c < /tmp/sivostudio-app.html) bytes"

echo ""
echo "→ GET $STUDIO_URL/api/studio/list (debería incluir el box)"
curl -s "$STUDIO_URL/api/studio/list" | node -e "
const d = JSON.parse(require('fs').readFileSync(0, 'utf8'))
console.log('  boxes activos:', d.boxes?.length || 0)
for (const b of d.boxes || []) {
  console.log('    -', b.box_id, '·', b.name, '·', b.last_seen)
}
"

echo ""
echo "✅ Smoke test OK. El box está vivo en /box/$BOX_ID/"
echo ""
echo "Próximos pasos manuales:"
echo "  1. Abrí $STUDIO_URL/box/$BOX_ID/editor/frontend en el browser"
echo "  2. Diseñá algo en App Studio → click 'Exportar HTML' → debería disparar"
echo "     POST /editor/api/frontend que guarda en R2"
echo "  3. Abrí $STUDIO_URL/box/$BOX_ID/editor/backend para el Flow Editor"
echo "  4. Cuando termines, abrí $STUDIO_URL/box/$BOX_ID/ (la app real)"
echo ""
echo "Si /editor/backend falla con 'configNodes debe ser un array':"
echo "  El box worker está sirviendo un bundle viejo. Re-desplegar con:"
echo "  curl -X POST $STUDIO_URL/api/studio/redeploy-box/$BOX_ID"