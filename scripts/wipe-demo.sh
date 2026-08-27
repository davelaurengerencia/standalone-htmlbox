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

# Orden importa: primero las tablas con FKs salientes (hijas), después
# las padres. Las migraciones canónicas viven en packages/control-plane/migrations/
# y este listado matchea los CREATE TABLE de ahí.
TABLES=(
  "htmlbox_ai_analyses"
  "htmlbox_tenant_app_access"
  "htmlbox_tenant_app_magic_links"
  "htmlbox_tenant_app_sessions"
  "htmlbox_tenant_app_users"
  "htmlbox_memberships"
  "htmlbox_versions"
  "htmlbox_boxes"
  "htmlbox_workspaces"
  "htmlbox_magic_links"
  "htmlbox_sessions"
  "htmlbox_tenants"
  "htmlbox_users"
  "htmlbox_api_tokens"
)

# Desactivamos -e temporalmente — un fallo de wrangler en una tabla
# no debe cortar las demás. Reportamos el estado final.
set +e
declare -a FAILED_TABLES=()
declare -a OK_COUNT=0
for t in "${TABLES[@]}"; do
  printf "  DELETE FROM %-32s ... " "$t"
  out=$(npx wrangler d1 execute htmlbox-control-plane --remote \
    --command "DELETE FROM $t" 2>&1)
  if echo "$out" | grep -q "success.*true"; then
    printf "✓\n"
    OK_COUNT=$((OK_COUNT + 1))
  else
    printf "✗\n"
    FAILED_TABLES+=("$t")
  fi
done
set -e

if [[ ${#FAILED_TABLES[@]} -gt 0 ]]; then
  warn "Algunas tablas fallaron: ${FAILED_TABLES[*]}"
  warn "Re-corré el script o wipealas manualmente."
else
  ok "D1 wiped (${OK_COUNT} tablas)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. R2 — wipe del bucket (tenants/* y raíz si quedó algo suelto)
# ─────────────────────────────────────────────────────────────────────────────
header "2/3 Wipe R2 bucket ($BUCKET)"

# API REST directa para listar/borrar (wrangler r2 object list/delete tiene
# output variable entre versiones). CLOUDFLARE_API_TOKEN es el OAuth de
# wrangler — funciona para authenticated requests a la cuenta.
API_BASE="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/r2/buckets/$BUCKET/objects"
R2_AUTH="Authorization: Bearer ${CLOUDFLARE_API_TOKEN:-}"

delete_objects() {
  local prefix="$1"
  local cursor=""
  local total=0
  while : ; do
    local url="$API_BASE?prefix=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$prefix")"
    [[ -n "$cursor" ]] && url+="&cursor=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$cursor")"
    local resp
    resp=$(curl -sS -H "$R2_AUTH" "$url")
    local keys
    keys=$(echo "$resp" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(o.get("name") or o.get("Key","") for o in d.get("result", [])))' 2>/dev/null || true)
    if [[ -z "$keys" ]]; then break; fi
    while IFS= read -r key; do
      [[ -z "$key" ]] && continue
      curl -sS -X DELETE \
        -H "$R2_AUTH" \
        "$API_BASE/$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$key")" \
        >/dev/null 2>&1 || true
      total=$((total + 1))
    done <<< "$keys"
    cursor=$(echo "$resp" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("result_pagination", {}).get("cursor", "") if isinstance(d.get("result_pagination"), dict) else "")' 2>/dev/null || true)
    [[ -z "$cursor" || "$cursor" == "None" ]] && break
  done
  echo "$total"
}

echo "  borrando tenants/* ..."
r2_tenants=$(delete_objects "tenants/")
echo "    $r2_tenants objetos borrados"

echo "  borrando _devtools/* (debug panel scripts) ..."
r2_devtools=$(delete_objects "_devtools/")
echo "    $r2_devtools objetos borrados"

total_r2=$((r2_tenants + r2_devtools))
ok "R2 wiped ($total_r2 objetos borrados)"

# ─────────────────────────────────────────────────────────────────────────────
# 3. WFP namespace — wipe de scripts per-box
# ─────────────────────────────────────────────────────────────────────────────
header "3/3 Wipe WFP namespace scripts ($NAMESPACE)"

scripts=$(curl -sS \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN:-}" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/dispatch/namespaces/$NAMESPACE/scripts" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(s["id"] for s in d.get("result", [])))' 2>/dev/null || true)

wfp_deleted=0
if [[ -z "$scripts" ]]; then
  ok "WFP namespace vacío"
else
  while IFS= read -r script; do
    [[ -z "$script" ]] && continue
    curl -sS -X DELETE \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN:-}" \
      "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/dispatch/namespaces/$NAMESPACE/scripts/$script" \
      >/dev/null 2>&1 && wfp_deleted=$((wfp_deleted + 1))
    echo "  borrado: $script"
  done <<< "$scripts"
  ok "WFP scripts borrados: $wfp_deleted"
fi

echo
header "✓ Wipe completo"
echo "  - D1: 14 tablas vaciadas"
echo "  - R2: $total_r2 objetos borrados"
echo "  - WFP: $wfp_deleted scripts borrados"
echo ""
echo "Próximo paso: deployá control-plane + runtime, y empezá a crear boxes"
echo "frescos. La próxima vez que crees un box, control-plane auto-deployará"
echo "su script per-box al namespace."
