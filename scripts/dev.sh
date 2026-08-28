#!/usr/bin/env bash
# Levanta los 4 Workers de SivoCloud contra el D1 REMOTO en subdominios *.localhost.
#
# Workers:
#   - control-plane (8781) — auth, registry, internal API
#   - portal/studio (8782) — tenant SPA
#   - runtime (8783) — sirve boxes (incluye dispatch WFP)
#   - landing (8784) — Coming Soon para sivocloud.localhost
#
# Requiere estar autenticado en Cloudflare (`wrangler login` o CLOUDFLARE_API_TOKEN).
# El código corre local (workerd) pero los bindings D1/R2/KV van a la API real.
#
# Subdominios esperados en /etc/hosts (los agregamos una sola vez):
#   127.0.0.1   controlplane.localhost studio.localhost runtime.localhost sivocloud.localhost
#
# En macOS `*.localhost` ya resuelve a 127.0.0.1 nativamente, así que no hace
# falta tocar /etc/hosts. En Linux hay que agregarlos manualmente.
#
# Salida:
#   - Durante el boot el stdout queda limpio (los wrangler loguean a archivos).
#   - Cuando los 4 workers están Ready, se imprime un banner con las URLs.
#   - Después sale el tail -F mergeado de los 4 logs, con colores por worker.
#   - Logs persistentes en .logs/dev/{control-plane,portal,runtime,landing}.log
#
# Cleanup:
#   - Al inicio, kill_zombies() se encarga de wrangler/workerd zombis de
#     runs previos. Si Ctrl+C mata el tail -F pero deja workers vivos, el
#     próximo `npm run dev` los limpia (mismo comportamiento que vite, CRA, etc).

set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HERE/.logs/dev"
mkdir -p "$LOG_DIR"

# Colores ANSI para los 4 workers en el tail en vivo.
COLOR_CP="\033[36m"   # cyan
COLOR_PO="\033[35m"   # magenta
COLOR_RT="\033[33m"   # yellow
COLOR_LD="\033[32m"   # green
RESET="\033[0m"

# 1) Limpia procesos de runs previos. Importante: matar wrangler CLI ANTES
#    que workerd, porque wrangler respawn-ea workerd cuando lo matás.
kill_zombies() {
  echo "→ limpiando procesos previos..."
  # Por patrón, solo este repo.
  pkill -9 -f "htmlbox.*wrangler" 2>/dev/null || true
  pkill -9 -f "htmlbox.*workerd"  2>/dev/null || true
  pkill -9 -f "htmlbox.*stdbuf"   2>/dev/null || true
  sleep 1
  # Backup por puerto — wrangler v4 pone workerd en su propio session group,
  # así que SIGINT no propaga. lsof + kill es lo único que llega.
  for p in 8781 8782 8783 8784 9229 9230 9231; do
    leftover="$(lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$leftover" ]; then
      echo "  ⚠ :$p aún ocupado (PIDs $leftover) — matando"
      kill -9 $leftover 2>/dev/null || true
    fi
  done
  sleep 2
  # Verificación final: si los puertos siguen ocupados, algo se rompió
  # (probablemente workerd re-spawn-eada por otro proceso). Avisamos y
  # seguimos igual — wrangler va a fallar con "Address already in use" y
  # el usuario va a ver el error claro.
  for p in 8781 8782 8783 8784; do
    if lsof -tiTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then
      echo "  ✗ puerto :$p sigue ocupado. Inspección: lsof -iTCP:$p"
    fi
  done
}

kill_zombies

# 2) wrangler disponible.
if ! command -v wrangler >/dev/null 2>&1; then
  if [ -x "$HERE/node_modules/.bin/wrangler" ]; then
    export PATH="$HERE/node_modules/.bin:$PATH"
  else
    echo "⚠  wrangler no encontrado. Corré 'npm install' primero."
    exit 1
  fi
fi

# 3) Autenticado en Cloudflare.
if ! wrangler whoami >/dev/null 2>&1; then
  echo "✗ no estás autenticado en Cloudflare."
  echo "  Corré: wrangler login"
  echo "  O exportá CLOUDFLARE_API_TOKEN=<token con permisos D1/R2/KV/Workers>"
  exit 1
fi

# 4) Migrations D1 REMOTAS. Como control-plane corre --remote, usa la DB
# real en Cloudflare — las tablas tienen que estar aplicadas ahí.
echo
echo "→ aplicando migrations D1 REMOTAS"
# 4) Migrations D1 REMOTAS. Como control-plane corre --remote, usa la
# DB real en Cloudflare — las tablas tienen que estar aplicadas ahí.
echo
echo "→ aplicando migrations D1 REMOTAS"
bash "$HERE/scripts/migrate-remote.sh"

# 5) Limpia logs viejos para arrancar de cero.
rm -f "$LOG_DIR"/*.log "$LOG_DIR"/*.pid

echo
echo "→ levantando 4 workers contra D1 remoto (logs: .logs/dev/*.log)…"
echo

# 6) Lanza cada worker en background. Su stdout/stderr va a su propio log
#    con prefijo "[name] " por línea (sin color, para que grep siga limpio).
launch_worker() {
  local pkg=$1 name=$2 mode=${3:--remote}
  (
    cd "$HERE/packages/$pkg"
    # stdbuf -o L fuerza line-buffering (BSD stdbuf usa sintaxis corta).
    stdbuf -o L -e L npx wrangler dev "$mode" \
      --persist-to "$HERE/packages/$pkg/.wrangler" 2>&1
  ) | awk -v p="[$name] " '{ printf "%s%s\n", p, $0; fflush() }' \
    > "$LOG_DIR/$name.log" 2>&1 &
  printf '%s' "$!" > "$LOG_DIR/$name.pid"
}

# Todos los workers corren --remote. La DB D1 es la real en Cloudflare
# (mismas tablas que prod). Cada worker levanta un preview en el edge
# de Cloudflare y la proxy local (8781-8784) forwardea al edge.
#
# Inter-worker calls usan service bindings (no HTTP fetch público):
#   portal    → control-plane  via env.CONTROL_PLANE.fetch()
#   landing   → runtime        via env.RUNTIME.fetch()
#
# Razón: wrangler 4.127+ tiene un bug donde los fetches worker-to-worker
# via custom domain en la misma zona hanguean 20s (522). Service binding
# es interno, zero-latency, y no tiene ese problema.
launch_worker control-plane "control-plane" "--remote"
launch_worker portal        "portal"       "--remote"
launch_worker runtime       "runtime"      "--remote"
launch_worker landing       "landing"      "--remote"

# 7) Espera Ready en los 4 logs (timeout 90s c/u).
echo "→ esperando Ready on los 4 workers (timeout 90s)…"
wait_ready() {
  local name=$1
  local deadline=$(( $(date +%s) + 90 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if grep -q "\[wrangler:info\] Ready on" "$LOG_DIR/$name.log" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

ok=true
wait_ready control-plane || { echo "  ✗ control-plane: timeout"; ok=false; }
wait_ready portal        || { echo "  ✗ portal:        timeout"; ok=false; }
wait_ready runtime       || { echo "  ✗ runtime:       timeout"; ok=false; }
wait_ready landing       || { echo "  ✗ landing:       timeout"; ok=false; }

# 8) Banner grande con las URLs lindas.
echo
if $ok; then
  cat <<'BANNER'
═══════════════════════════════════════════════════════════════
  ✅  SivoCloud dev ready
═══════════════════════════════════════════════════════════════

    control-plane → http://controlplane.localhost:8781
    studio        → http://studio.localhost:8782
    runtime       → http://runtime.localhost:8783
    landing       → http://sivocloud.localhost:8784

  Logs en vivo (Ctrl+C para detener el tail; los workers quedan vivos
  y se limpian en el próximo `npm run dev`):
BANNER
else
  cat <<'BANNER'
═══════════════════════════════════════════════════════════════
  ⚠  Uno o más workers NO llegaron a Ready. Revisá:
    tail -f .logs/dev/control-plane.log
    tail -f .logs/dev/portal.log
    tail -f .logs/dev/runtime.log
    tail -f .logs/dev/landing.log
═══════════════════════════════════════════════════════════════
BANNER
fi
echo "═══════════════════════════════════════════════════════════════"
echo

# 9) Live tail de los 4 logs, con color ANSI por worker.
#    tail -F antepone "==> filename <==" cuando rota entre archivos; awk
#    parsea esos headers para saber qué worker está emitiendo (porque en un
#    pipe FILENAME queda vacío).
tail -F \
  "$LOG_DIR/control-plane.log" \
  "$LOG_DIR/portal.log" \
  "$LOG_DIR/runtime.log" \
  "$LOG_DIR/landing.log" 2>/dev/null \
| awk -v cp="$COLOR_CP" -v po="$COLOR_PO" -v rt="$COLOR_RT" -v ld="$COLOR_LD" -v rst="$RESET" '
    /^==> .*control-plane/ { current = cp; print current $0 rst; fflush(); next }
    /^==> .*portal/        { current = po; print current $0 rst; fflush(); next }
    /^==> .*runtime/       { current = rt; print current $0 rst; fflush(); next }
    /^==> .*landing/       { current = ld; print current $0 rst; fflush(); next }
    /^==>/                 { current = rt; print current $0 rst; fflush(); next }
    {
      # Línea normal — usa el color del último "==>" que vimos, o rt como
      # fallback (antes del primer header).
      print (current ? current : rt) $0 rst
      fflush()
    }
  '
