#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://localhost:3000/webhook}"
CALL_ID="demo-auth-lock"

# The server reads WEBHOOK_TOKEN from .env, so a shell without it would get 401 on
# every step and look like a broken gate. Fall back to the same .env the server
# read. A shell value still wins, which is how the public URL gets tested.
TOKEN="${WEBHOOK_TOKEN:-}"
ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.env"
if [[ -z "$TOKEN" && -f "$ENV_FILE" ]]; then
  TOKEN="$(sed -n 's/^[[:space:]]*WEBHOOK_TOKEN[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" | head -n1 | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
fi

AUTH_HEADER=()
if [[ -n "$TOKEN" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${TOKEN}")
  echo "using bearer token from $([[ -n "${WEBHOOK_TOKEN:-}" ]] && echo "the shell" || echo ".env"); target $BASE"
  echo
else
  echo "no WEBHOOK_TOKEN found; target $BASE is expected to be open"
  echo
fi

call_tool() {
  local id="$1" name="$2" args="$3"
  curl -sS -X POST "$BASE" -H 'content-type: application/json' "${AUTH_HEADER[@]}" \
    -d "{\"message\":{\"type\":\"tool-calls\",\"call\":{\"id\":\"$CALL_ID\"},\"toolCallList\":[{\"id\":\"$id\",\"name\":\"$name\",\"arguments\":$args}]}}"
  printf '\n'
}

echo "1. Pre-auth lookup must be denied"
call_tool t1 get_account_details '{}'

echo "1b. Pre-auth payment action must be denied"
call_tool t1b send_payment_link '{"channel":"SMS"}'

echo "2. Verify customer"
call_tool t2 verify_customer '{"verification_type":"DOB_FULL","verification_value":"15-06-1995"}'

echo "3. Same call ID can now fetch account details"
call_tool t3 get_account_details '{}'

echo "4. Repeating t3 returns the cached result"
call_tool t3 get_account_details '{}'

echo "5. A different call ID remains locked"
CALL_ID="different-call"
call_tool t4 get_account_details '{}'
