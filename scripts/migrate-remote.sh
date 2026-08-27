#!/usr/bin/env bash
# Aplica migrations D1 a las DBs remotas (producción).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ control-plane D1 (remote)"
cd "$HERE/packages/control-plane"
npx wrangler d1 migrations apply htmlbox-control-plane --remote

echo
echo "✓ migrations aplicadas a remoto."