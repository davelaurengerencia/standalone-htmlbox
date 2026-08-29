#!/usr/bin/env bash
# scripts/setup-wfp-experiments.sh — prepara el namespace WFP para sivostudio.
#
# Gemelo de scripts/setup-wfp.sh, pero apuntando al namespace
# `sivostudio-experiments` (separado del de prod `htmlbox-boxes`).
#
# Misma mecánica:
#   1. Crear el dispatch namespace (idempotente).
#   2. Guiar al usuario para generar un Scoped API Token.
#   3. Guardar el token como secret en el worker de sivostudio.
#
# Diferencia con setup-wfp.sh: el token se guarda en el worker de sivostudio
# (no en control-plane), porque sivostudio deploya sus propios scripts y
# tiene su propia cadena de deploy aislada.
#
# Uso: ./scripts/setup-wfp-experiments.sh

set -euo pipefail

ACCOUNT_ID="${HTMLBOX_CLOUDFLARE_ACCOUNT_ID:-bbd6bb71e68887eb0fa9cc8e872ed588}"
NAMESPACE="${HTMLBOX_STUDIO_NAMESPACE:-sivostudio-experiments}"

color() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
header() { color "1;34" "▸ $1"; }
ok() { color "32" "✓ $1"; }
warn() { color "33" "⚠ $1"; }

header "SivoStudio WFP setup (experimentos)"
echo
echo "Account ID:  $ACCOUNT_ID"
echo "Namespace:   $NAMESPACE"
echo
echo "Este namespace es SEPARADO del de prod (htmlbox-boxes)."
echo "Sirve para que el experimento de sivostudio corra aislado."
echo

# ─────────────────────────────────────────────────────────────────────────────
# 1. Crear el dispatch namespace (idempotente)
# ─────────────────────────────────────────────────────────────────────────────
header "1/4 Crear dispatch namespace"

if npx wrangler dispatch-namespace list 2>&1 | grep -q "$NAMESPACE"; then
  ok "Namespace '$NAMESPACE' ya existe"
else
  echo "  Creando..."
  if npx wrangler dispatch-namespace create "$NAMESPACE" 2>&1 | tail -3; then
    ok "Namespace '$NAMESPACE' creado"
  else
    warn "Error creando namespace. Verifica que Workers for Platforms esté habilitado en tu cuenta."
    warn "Dashboard: https://dash.cloudflare.com/?to=/:account/workers-for-platforms"
    exit 1
  fi
fi
echo

# ─────────────────────────────────────────────────────────────────────────────
# 2. Instrucciones para generar el Scoped API Token
# ─────────────────────────────────────────────────────────────────────────────
header "2/4 Generar Scoped API Token (manual — dashboard)"

cat <<EOF
1. Andá a https://dash.cloudflare.com/?to=/:account/api-tokens
2. Click "Create Token" → "Create Custom Token"
3. Permissions:
     Account → Workers Scripts: Edit
     Account → Workers Scripts: Read
4. Account Resources:
     Include → Specific namespace → "$NAMESPACE"
     (ESTO limita el token: si se filtra, el peor escenario es deploy
      en este namespace específico. NO toca el namespace de prod.)
5. Click "Continue to summary" → "Create Token"
6. COPIÁ EL TOKEN (Cloudflare solo lo muestra una vez).

EOF
echo

# ─────────────────────────────────────────────────────────────────────────────
# 3. Guardar el token como secret
# ─────────────────────────────────────────────────────────────────────────────
header "3/4 Guardar el token en el worker de sivostudio"

cat <<EOF
Pegá el token como secret en htmlbox-sivostudio:

  cd packages/sivostudio
  npx wrangler secret put WFP_DEPLOY_TOKEN

(Cloudflare te pide el valor — pegalo. Después podés verificar con
 'npx wrangler secret list' que aparezca.)
EOF
echo

# ─────────────────────────────────────────────────────────────────────────────
# 4. Verificar
# ─────────────────────────────────────────────────────────────────────────────
header "4/4 Verificar"

echo "Lista de dispatch namespaces:"
npx wrangler dispatch-namespace list 2>&1 | head -20
echo
echo "Para testear que tu token funciona (opcional):"
cat <<EOF

  # Reemplazá <TOKEN> por el token que copiaste en el paso 2:
  curl -sS -X GET \\
    -H "Authorization: Bearer <TOKEN>" \\
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/dispatch/namespaces/$NAMESPACE/scripts" \\
    | python3 -m json.tool

  # Debería responder { "result": [], "success": true, ... } si el namespace
  # está vacío. Si responde 403 → el token no tiene scope al namespace.

EOF
echo

header "Próximos pasos"
echo "  1. ✓ Dispatch namespace '$NAMESPACE' creado (este script)"
echo "  2. → Generar Scoped API Token en dashboard (paso 2 arriba)"
echo "  3. → wrangler secret put WFP_DEPLOY_TOKEN en packages/sivostudio (paso 3)"
echo "  4. → Reemplazar database_id en packages/sivostudio/wrangler.jsonc"
echo "         (D1 de sivostudio: wrangler d1 create htmlbox-sivostudio)"
echo "  5. → npm run migrate:remote -w @htmlbox/sivostudio"
echo "         (aplica migrations de packages/sivostudio/migrations/)"
echo "  6. → npm run build -w @htmlbox/sivostudio"
echo "         (genera box-template/editors/app-studio.html.txt desde Chats/.../repl-svelte/"
echo "          + bundlea dist/box-worker.mjs)"
echo "  7. → npm run dev -w @htmlbox/sivostudio"
echo "         (arranca en :8786)"
echo
ok "Setup WFP de sivostudio completo"
