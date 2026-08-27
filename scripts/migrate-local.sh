#!/usr/bin/env bash
# Aplica migrations D1 a las DBs locales de los 3 Workers.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ control-plane D1 (local)"
cd "$HERE/packages/control-plane"
npx wrangler d1 migrations apply htmlbox-control-plane --local --persist-to "$HERE/packages/control-plane/.wrangler"

echo
echo "✓ migrations aplicadas. Si la DB no existe, wrangler la crea automáticamente."

echo
echo "⚠  Los workers portal y runtime no tienen D1 propia en fase 1; comparten lectura"
echo "   con control-plane via API."