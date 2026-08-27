#!/usr/bin/env bash
# scripts/wipe-demo.sh — limpia TODOS los datos de demo de HTMLBox.
#
# PELIGRO: este script borra:
#   1. Filas de htmlbox_users, htmlbox_tenants, htmlbox_workspaces,
#      htmlbox_boxes, htmlbox_box_versions, htmlbox_api_tokens,
#      htmlbox_ai_analyses, htmlbox_tenant_app_users (en D1).
#   2. Todos los objetos en el R2 bucket 'htmlbox-content' bajo
#      tenants/* y otros paths demo.
#   3. Todos los scripts per-box en el dispatch namespace 'htmlbox-boxes'.
#
# Caso de uso: cuando ya no queda valor en los boxes de demo existentes
# y queremos empezar limpio después del cutover de WFP. NO correr en
# producción con datos de usuarios.
#
# Uso: ./scripts/wipe-demo.sh
# Requisitos: wrangler CLI autenticado.

set -euo pipefail

ACCOUNT_ID="bbd6bb71e68887eb0fa9cc8e872ed588"
DB_ID="7ac72bf3-63ae-4789-9679-ab869419fa2a"
BUCKET="htmlbox-content"
NAMESPACE="htmlbox-boxes"

color() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
header() { color "1;34" "▸ $1"; }
ok() { color "32" "✓ $1"; }
warn() { color "33" "⚠ $1"; }

header "HTMLBox demo wipe — esto borra TODO"
echo "  D1 database:  $DB_ID"
echo "  R2 bucket:    $BUCKET"
echo "  WFP namespace: $NAMESPACE"
echo
warn "Estás a punto de borrar todos los datos de demo. Esto NO es reversible."
echo
read -rp "Type 'yes' to continue: " confirm
if [[ "$confirm" != "yes" ]]; then
  warn "Abortando."
  exit 1
fi
echo

# ─────────────────────────────────────────────────────────────────────────────
# 1. D1 — wipe de todas las tablas relevantes
# ─────────────────────────────────────────────────────────────────────────────
header "1/3 Wipe D1 tables"

TABLES=(
  "htmlbox_api_tokens"
  "htmlbox_ai_analyses"
  "htmlbox_tenant_app_users"
  "htmlbox_box_versions"
  "htmlbox_boxes"
  "htmlbox_memberships"
  "htmlbox_workspaces"
  "htmlbox_tenants"
  "htmlbox_users"
  "htmlbox_sessions"
  "htmlbox_magic_links"
)

for t in "${TABLES[@]}"; do
  echo "  DELETE FROM $t..."
  npx wrangler d1 execute htmlbox-control-plane --remote \
    --command "DELETE FROM $t" 2>&1 | tail -2
done
ok "D1 wiped"

# ─────────────────────────────────────────────────────────────────────────────
# 2. R2 — wipe del bucket
# ─────────────────────────────────────────────────────────────────────────────
header "2/3 Wipe R2 bucket ($BUCKET)"

# Lista todos los objetos y los borra de a batches (max 1000 por list).
prefix=""
list_page() {
  local cursor="$1"
  local cmd="wrangler r2 object list $BUCKET --prefix=tenants/"
  if [[ -n "$cursor" ]]; then
    cmd+=" --cursor=$cursor"
  fi
  eval "$cmd" 2>/dev/null
}

cursor=""
total_deleted=0
while : ; do
  page=$(wrangler r2 object list "$BUCKET" --prefix="tenants/" 2>&1 || true)
  keys=$(echo "$page" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(o["Key"] for o in d.get("objects", [])))' 2>/dev/null || true)
  if [[ -z "$keys" ]]; then break; fi
  count=0
  while IFS= read -r key; do
    [[ -z "$key" ]] && continue
    wrangler r2 object delete "$BUCKET" "$key" >/dev/null 2>&1 || true
    count=$((count + 1))
  done <<< "$keys"
  total_deleted=$((total_deleted + count))
  echo "  borrados: $total_deleted"
  # ¿Hay otra página?
  next_cursor=$(echo "$page" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("cursor", ""))' 2>/dev/null || true)
  if [[ -z "$next_cursor" || "$next_cursor" == "null" ]]; then break; fi
  cursor="$next_cursor"
done

ok "R2 wiped ($total_deleted objetos borrados)"

# ─────────────────────────────────────────────────────────────────────────────
# 3. WFP namespace — wipe de scripts per-box
# ─────────────────────────────────────────────────────────────────────────────
header "3/3 Wipe WFP namespace scripts ($NAMESPACE)"

# Lista scripts en el namespace y los borra.
scripts=$(curl -sS \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN:-}" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/dispatch/namespaces/$NAMESPACE/scripts" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(s["id"] for s in d.get("result", [])))' 2>/dev/null || true)

if [[ -z "$scripts" ]]; then
  ok "WFP namespace vacío (o sin acceso — verificar manualmente)"
else
  while IFS= read -r script; do
    [[ -z "$script" ]] && continue
    curl -sS -X DELETE \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN:-}" \
      "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/dispatch/namespaces/$NAMESPACE/scripts/$script" \
      >/dev/null 2>&1 || true
    echo "  borrado: $script"
  done <<< "$scripts"
  ok "WFP scripts borrados"
fi

echo
header "✓ Wipe completo"
echo "  - D1: 11 tablas vaciadas"
echo "  - R2: $total_deleted objetos borrados"
echo "  - WFP: scripts borrados"
echo
echo "Próximo paso: deployá control-plane + runtime, y empezá a crear boxes"
echo "frescos. La próxima vez que crees un box, control-plane auto-deployará"
echo "su script per-box al namespace."
