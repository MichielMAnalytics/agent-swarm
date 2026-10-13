#!/usr/bin/env bash
# Smoke-test the native script sandbox in a built API image.
#
# Usage: bash scripts/smoke-api-sandbox.sh <image>
#
# Boots the image with Docker's default capabilities (the Docker/Dokploy
# deploy shape), then asserts:
#   - /health reports scriptSandbox "hardened"
#   - the data directory is mode 700
#   - an inline native script runs as a non-root uid, cannot read the
#     database or /proc/1/environ, and gets EPERM on spawn
set -euo pipefail

IMAGE="${1:?usage: smoke-api-sandbox.sh <image>}"
NAME="api-sandbox-smoke-$$"
API_KEY="$(cat /proc/sys/kernel/random/uuid)"
AGENT_ID="$(cat /proc/sys/kernel/random/uuid)"
DB_PATH=/app/data/agent-swarm-db.sqlite

cleanup() {
  if [[ "${KEEP:-0}" != "1" ]]; then docker rm -f "$NAME" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  docker logs "$NAME" 2>&1 | tail -40 >&2 || true
  exit 1
}

docker run -d --name "$NAME" -p 127.0.0.1::3013 \
  -e AGENT_SWARM_API_KEY="$API_KEY" \
  -e DESPLEGA_TELEMETRY_ENV=test \
  -e ANONYMIZED_TELEMETRY=false \
  "$IMAGE" >/dev/null
BASE_URL="http://$(docker port "$NAME" 3013/tcp | head -1)"

SANDBOX=""
for _ in $(seq 1 120); do
  SANDBOX="$(curl -fsS "$BASE_URL/health" 2>/dev/null | jq -r '.scriptSandbox // empty' || true)"
  if [[ -n "$SANDBOX" && "$SANDBOX" != "pending" ]]; then break; fi
  sleep 0.5
done
echo "scriptSandbox: ${SANDBOX:-<none>}"
[[ "$SANDBOX" == "hardened" ]] || fail "/health scriptSandbox is '${SANDBOX:-<none>}', expected 'hardened'"

# Positive controls: both files exist and root can read them.
docker exec "$NAME" test -r "$DB_PATH" || fail "control: $DB_PATH missing in the container"
docker exec "$NAME" test -r /proc/1/environ || fail "control: root cannot read /proc/1/environ"
MODE="$(docker exec "$NAME" stat -c %a "$(dirname "$DB_PATH")")"
[[ "$MODE" == "700" ]] || fail "data dir mode is $MODE, expected 700"

curl -fsS -X POST "$BASE_URL/api/agents" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Agent-ID: $AGENT_ID" \
  -H "Content-Type: application/json" \
  -d '{"name":"Sandbox Smoke Agent","isLead":false}' >/dev/null

SOURCE=$(cat <<EOF
export default async () => {
  const canRead = async (path: string) => {
    try {
      await Bun.file(path).bytes();
      return true;
    } catch {
      return false;
    }
  };
  let spawnExit: string;
  try {
    spawnExit = String(await Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" }).exited);
  } catch (error) {
    spawnExit = String((error as { code?: string }).code ?? error);
  }
  return {
    uid: process.getuid(),
    canReadDb: await canRead("$DB_PATH"),
    canReadInitEnviron: await canRead("/proc/1/environ"),
    spawnExit,
  };
};
EOF
)

RESPONSE="$(jq -n --arg source "$SOURCE" '{source: $source, args: {}, intent: "api image sandbox smoke"}' |
  curl -fsS -X POST "$BASE_URL/api/scripts/run" \
    -H "Authorization: Bearer $API_KEY" \
    -H "X-Agent-ID: $AGENT_ID" \
    -H "Content-Type: application/json" \
    -d @-)" || fail "script run request failed"

RESULT="$(printf '%s' "$RESPONSE" | jq -c '[.. | objects | select(has("canReadDb"))][0] // empty')"
echo "script result: ${RESULT:-<none>}"
[[ -n "$RESULT" ]] || fail "no sandbox result in response: $(printf '%s' "$RESPONSE" | head -c 1000)"

printf '%s' "$RESULT" | jq -e '.uid != 0' >/dev/null || fail "script ran as uid 0"
printf '%s' "$RESULT" | jq -e '.canReadDb == false' >/dev/null || fail "script can read the database"
printf '%s' "$RESULT" | jq -e '.canReadInitEnviron == false' >/dev/null || fail "script can read /proc/1/environ"
printf '%s' "$RESULT" | jq -e '.spawnExit == "EPERM"' >/dev/null || fail "spawn was not denied"

echo "API sandbox smoke passed"
