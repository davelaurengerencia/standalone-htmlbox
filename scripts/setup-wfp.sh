#!/usr/bin/env bash
# scripts/setup-wfp.sh — prepara Workers for Platforms en HTMLBox.
#
# Crea el dispatch namespace 'htmlbox-boxes' (idempotente — no hace nada
# si ya existe) y guía al usuario para generar el Scoped API Token.
#
# El token NO se puede generar por CLI (requiere dashboard) — el script
# imprime las instrucciones exactas y un comando curl de prueba para
# verificar que el token funciona.
#
# Uso: ./scripts/setup-wfp.sh

set -euo pipefail

ACCOUNT_ID="${HTMLBOX_CLOUDFLARE_ACCOUNT_ID:-bbd6bb71e68887eb0fa9cc8e872ed588}"
NAMESPACE="htmlbox-boxes"

color() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
header() { color "1;34" "▸ $1"; }
ok() { color "32" "✓ $1"; }
warn() { color "33" "⚠ $1"; }

header "HTMLBox WFP setup"
echo
echo "Account ID:  $ACCOUNT_ID"
echo "Namespace:   $NAMESPACE"
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
     (ESTO es lo que limita el token a no poder tocar otros Workers
      de la cuenta — incluso si se filtra, el peor escenario es deploy
      en este namespace específico)
5. Click "Continue to summary" → "Create Token"
6. COPIÁ EL TOKEN (Cloudflare solo lo muestra una vez).

EOF
echo

# ─────────────────────────────────────────────────────────────────────────────
# 3. Guardar el token como secret
# ─────────────────────────────────────────────────────────────────────────────
header "3/4 Guardar el token en control-plane"

cat <<EOF
Pegá el token como secret en control-plane:

  cd packages/control-plane
  npx wrangler secret put WFP_DEPLOY_TOKEN

(Cloudflare te pide el valor — pegalo. Después podés verificar con
 'npx wrangler secret list' que aparezca.)

EOF
echo

# ─────────────────────────────────────────────────────────────────────────────
# 4. Verificar el namespace + (opcional) test del token
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
echo "  3. → wrangler secret put WFP_DEPLOY_TOKEN en control-plane (paso 3)"
echo "  4. → Verificar que wrangler deploy --dry-run de control-plane liste"
echo "         env.WFP_DEPLOY_TOKEN (oculto) en los bindings"
echo "  5. → wrangler deploy de control-plane y runtime"
echo "  6. → (Opcional) ./scripts/wipe-demo.sh para limpiar los boxes de demo"
echo "  7. → Crear un box desde el portal y verificar que:"
echo "         - htmlbox_boxes.wfp_status = 'ready'"
echo "         - El script 'box-<boxId>' aparece en el namespace"
echo "         - El box se sirve via per-box script (no via path viejo)"
echo
ok "Setup WFP completo"
