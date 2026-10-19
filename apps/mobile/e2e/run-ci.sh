#!/usr/bin/env bash
# Playwright end to end (SDD §19.1), as CI runs it: a fresh embedded-Postgres E2E
# database, the E2E API (frozen clock) on :8080, the Expo web app on :8081, then the
# whole suite. Run from the repo root: `bash apps/mobile/e2e/run-ci.sh [playwright args]`.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LOGS="${E2E_LOG_DIR:-$ROOT/apps/mobile/test-results/e2e-logs}"
mkdir -p "$LOGS"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
}
trap cleanup EXIT

wait_for() { # <description> <seconds> <command...>
  local what="$1" secs="$2"
  shift 2
  for _ in $(seq 1 "$secs"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "Timed out waiting for $what" >&2
  return 1
}

cd "$ROOT/apps/api"
rm -rf .e2e-pgdata .e2e-media
pnpm e2e:db >"$LOGS/e2e-db.log" 2>&1 &
PIDS+=($!)
wait_for "the E2E database" 180 grep -q "E2E database ready" "$LOGS/e2e-db.log" || {
  cat "$LOGS/e2e-db.log"
  exit 1
}

pnpm e2e:server >"$LOGS/e2e-server.log" 2>&1 &
PIDS+=($!)
wait_for "the E2E API" 120 curl -sf http://localhost:8080/health || {
  cat "$LOGS/e2e-server.log"
  exit 1
}

cd "$ROOT/apps/mobile"
EXPO_PUBLIC_API_URL='http://localhost:8080' \
  EXPO_PUBLIC_WEB_URL='http://localhost:8081' \
  EXPO_PUBLIC_DEV_LOGIN_ENABLED='true' \
  CI=1 npx expo start --web --port 8081 >"$LOGS/e2e-web.log" 2>&1 &
PIDS+=($!)
wait_for "the web app" 300 curl -sf -o /dev/null http://localhost:8081/ || {
  cat "$LOGS/e2e-web.log"
  exit 1
}
# Warm the dev bundle once so the first test doesn't spend its timeout compiling it.
BUNDLE=$(curl -s http://localhost:8081/home | grep -o 'src="[^"]*bundle[^"]*"' | head -1 |
  sed 's/src="//; s/"$//; s/&amp;/\&/g')
[ -n "$BUNDLE" ] && curl -s "http://localhost:8081$BUNDLE" --max-time 600 -o /dev/null

npx playwright test --config=e2e/playwright.config.ts --workers=1 "$@"
