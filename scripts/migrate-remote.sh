#!/usr/bin/env bash
# Aplica migrations D1 a las DBs remotas (producción).
#
# Idempotente: si una DB no existe todavía (ej: sivostudio, que se crea
# la primera vez con `./scripts/setup-wfp-experiments.sh`), skipea con
# warning en vez de tirar el script entero.

set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ control-plane D1 (remote)"
cd "$HERE/packages/control-plane"
npx wrangler d1 migrations apply htmlbox-control-plane --remote

echo
echo "→ sivostudio D1 (remote — opcional)"
cd "$HERE/packages/sivostudio"
# Si wrangler.jsonc todavía tiene el placeholder de database_id, skip.
if grep -q "REEMPLAZAR_CON_DATABASE_ID_REAL" wrangler.jsonc; then
  echo "  ⚠ database_id placeholder en wrangler.jsonc — skip."
  echo "    Para habilitarlo: crear la D1 con 'wrangler d1 create htmlbox-sivostudio'"
  echo "    y actualizar database_id en wrangler.jsonc. Ver scripts/setup-wfp-experiments.sh."
else
  npx wrangler d1 migrations apply htmlbox-sivostudio --remote
fi

echo
echo "✓ migrations aplicadas a remoto."
