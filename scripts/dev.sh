#!/usr/bin/env bash
# Arranca sqld local + los 3 Workers de HTMLBox en paralelo.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() {
  echo "→ cerrando procesos hijos..."
  jobs -p | xargs -r kill 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

if ! command -v turso >/dev/null 2>&1; then
  echo "⚠  'turso' CLI no está instalado. La DB local de boxes no funcionará."
  echo "   Instálala: brew install turso  (o)  curl -sSfL https://get.turso.io/install.sh | bash"
fi

if command -v turso >/dev/null 2>&1; then
  echo "→ levantando sqld local en :8080 (turso dev)"
  turso dev --port 8080 >"$HERE/.turso-dev.log" 2>&1 &
  sleep 1
fi

echo
echo "→ aplicando migrations D1 locales"
bash "$HERE/scripts/migrate-local.sh"

echo
echo "→ lanzando los 3 workers en paralelo:"
echo "   - control-plane : http://localhost:8781"
echo "   - portal        : http://localhost:8782"
echo "   - runtime       : http://localhost:8783"
echo
( cd "$HERE/packages/control-plane" && npx wrangler dev --port 8781 --persist-to "$HERE/packages/control-plane/.wrangler" ) &
( cd "$HERE/packages/portal"       && npx wrangler dev --port 8782 --persist-to "$HERE/packages/portal/.wrangler"       ) &
( cd "$HERE/packages/runtime"      && npx wrangler dev --port 8783 --persist-to "$HERE/packages/runtime/.wrangler"      --local ) &

echo
echo "Ctrl+C para detener todo."
wait