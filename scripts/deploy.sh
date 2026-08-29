#!/usr/bin/env bash
# Deploya los Workers de SivoCloud a producción.
#
# Por defecto deploya los 5 en orden de dependencia:
#   1. control-plane  — registry, auth plataforma, AI, internal API (D1)
#   2. portal         — Studio SPA (consume control-plane via service binding)
#   3. runtime        — sirve boxes (consume control-plane via service binding)
#   4. landing        — Coming Soon para sivocloud.dev
#   5. auth           — magic links, sesión cross-subdomain
#
# Antes de deployar:
#   - Aplica migrations D1 remotas al control-plane (`migrate-remote.sh`).
#   - Buildea `@htmlbox/runtime-box-worker` (el bundle ESM que el control-plane
#     deploya por WFP a `htmlbox-boxes` — si cambió, hay que regenerarlo).
#
# Subset:
#   ./scripts/deploy.sh                    # los 5
#   ./scripts/deploy.sh control-plane      # uno solo
#   ./scripts/deploy.sh control-plane portal
#   ./scripts/deploy.sh --skip-migrate     # skip D1 migrations
#   ./scripts/deploy.sh --skip-build       # skip runtime-box-worker bundle
#
# Requiere estar autenticado en Cloudflare (`wrangler login` o CLOUDFLARE_API_TOKEN).
# Deploy es a prod (`wrangler deploy`, sin `--remote`/sin `--local`) — modifica
# el worker deployado de verdad en la cuenta.

set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"

ALL_WORKERS=(control-plane portal runtime landing auth)

# Flags opcionales
SKIP_MIGRATE=0
SKIP_BUILD=0
SELECTED=()

for arg in "$@"; do
  case "$arg" in
    --skip-migrate) SKIP_MIGRATE=1 ;;
    --skip-build)   SKIP_BUILD=1 ;;
    --help|-h)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    -*)
      echo "✗ flag desconocido: $arg"
      echo "  Flags: --skip-migrate --skip-build"
      exit 1
      ;;
    *)
      SELECTED+=("$arg")
      ;;
  esac
done

if [ ${#SELECTED[@]} -eq 0 ]; then
  SELECTED=("${ALL_WORKERS[@]}")
fi

# Validar subset
for w in "${SELECTED[@]}"; do
  if [ ! -d "$HERE/packages/$w" ]; then
    echo "✗ package desconocido: $w"
    echo "  Disponibles: ${ALL_WORKERS[*]}"
    exit 1
  fi
  if [ ! -f "$HERE/packages/$w/wrangler.jsonc" ]; then
    echo "✗ $w no tiene wrangler.jsonc — no es deployable"
    exit 1
  fi
done

# wrangler disponible.
if ! command -v wrangler >/dev/null 2>&1; then
  if [ -x "$HERE/node_modules/.bin/wrangler" ]; then
    export PATH="$HERE/node_modules/.bin:$PATH"
  else
    echo "⚠  wrangler no encontrado. Corré 'npm install' primero."
    exit 1
  fi
fi

# Autenticado en Cloudflare.
if ! wrangler whoami >/dev/null 2>&1; then
  echo "✗ no estás autenticado en Cloudflare."
  echo "  Corré: wrangler login"
  echo "  O exportá CLOUDFLARE_API_TOKEN=<token con permisos Workers/D1/R2/KV>"
  exit 1
fi

# Migrations D1 — solo si hay un control-plane en el subset (control-plane es
# el único con D1 binding, pero por seguridad chequeamos el archivo).
if [ $SKIP_MIGRATE -eq 0 ]; then
  has_cp=0
  for w in "${SELECTED[@]}"; do
    [ "$w" = "control-plane" ] && has_cp=1
  done
  if [ $has_cp -eq 1 ]; then
    echo
    echo "→ aplicando migrations D1 REMOTAS (control-plane)"
    bash "$HERE/scripts/migrate-remote.sh"
  fi
fi

# Bundle runtime-box-worker — el control-plane deploya este ESM por WFP a
# cada box nuevo. Si cambió el source, hay que regenerarlo antes de
# deployar control-plane.
if [ $SKIP_BUILD -eq 0 ]; then
  if [ -d "$HERE/packages/runtime-box-worker" ]; then
    echo
    echo "→ buildeando @htmlbox/runtime-box-worker"
    npm run build -w @htmlbox/runtime-box-worker
  fi
fi

echo
echo "→ deployando ${#SELECTED[@]} worker(s): ${SELECTED[*]}"
echo

deploy_one() {
  local pkg=$1
  local started_at
  started_at=$(date +%s)
  echo
  echo "═══════════════════════════════════════════════════════════════"
  echo "  [$pkg] deployando..."
  echo "═══════════════════════════════════════════════════════════════"
  (
    cd "$HERE/packages/$pkg"
    npx wrangler deploy 2>&1
  ) | awk -v p="[$pkg] " '{ printf "%s%s\n", p, $0; fflush() }'
  local rc=${PIPESTATUS[0]}
  local elapsed=$(( $(date +%s) - started_at ))
  if [ $rc -ne 0 ]; then
    echo
    echo "═══════════════════════════════════════════════════════════════"
    echo "  ✗ [$pkg] deploy FALLÓ (rc=$rc, ${elapsed}s)"
    echo "═══════════════════════════════════════════════════════════════"
    return $rc
  fi
  echo
  echo "═══════════════════════════════════════════════════════════════"
  echo "  ✓ [$pkg] deploy OK (${elapsed}s)"
  echo "═══════════════════════════════════════════════════════════════"
}

started_total=$(date +%s)
ok=true
for w in "${SELECTED[@]}"; do
  if ! deploy_one "$w"; then
    ok=false
    break
  fi
done

elapsed_total=$(( $(date +%s) - started_total ))

echo
echo "═══════════════════════════════════════════════════════════════"
if $ok; then
  cat <<BANNER
  ✅  Deploy completo (${elapsed_total}s)

  Workers deployados:
BANNER
  for w in "${SELECTED[@]}"; do
    echo "    - $w"
  done
else
  cat <<BANNER
  ✗  Deploy interrumpido por error.

  El worker que falló NO quedó deployado (o quedó en estado parcial según
  Cloudflare). Revisá el output arriba y reintentá:

    ./scripts/deploy.sh <package-falló>

  Para retomar desde el principio:
    ./scripts/deploy.sh ${SELECTED[*]}
BANNER
fi
echo "═══════════════════════════════════════════════════════════════"
$ok
