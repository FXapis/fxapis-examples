#!/usr/bin/env bash
# One trade on many MT5 accounts at once (copy trading / signal fan-out) with curl.
#
#   export FXAPIS_API_KEY=fx_test_... ACCOUNT_IDS=<id>,<id>,...
#   ./multi-account-order.sh
#
# Test with broker DEMO accounts.
set -euo pipefail

API="${FXAPIS_API:-https://api.fxapis.com}"
: "${FXAPIS_API_KEY:?Set FXAPIS_API_KEY}" "${ACCOUNT_IDS:?Set ACCOUNT_IDS (comma separated)}"
AUTH=(-H "Authorization: Bearer $FXAPIS_API_KEY")
KEY="wave-$(date +%s)"

WAVE_ID=$(jq -n --arg ids "$ACCOUNT_IDS" --arg key "$KEY" '{
    accountIds: ($ids | split(",")),
    symbol: "EURUSD", side: "buy", volume: "0.01",
    barrierPolicy: "release-ready",
    clientWaveId: $key,
    label: "curl example"
  }' |
  curl -sS -X POST "$API/v1/execution-waves" "${AUTH[@]}" -H "Content-Type: application/json" \
    -H "Idempotency-Key: $KEY" -d @- | jq -er '.data.id')
echo "multi-account order: $WAVE_ID"

# planned -> preparing -> armed -> releasing -> settled (or cancelled / abandoned: nothing was sent)
for _ in $(seq 1 120); do
  WAVE=$(curl -sS "$API/v1/execution-waves/$WAVE_ID" "${AUTH[@]}")
  STATE=$(echo "$WAVE" | jq -r '.data.state')
  echo "state: $STATE"
  case "$STATE" in settled | cancelled | abandoned) break ;; esac
  sleep 1
done
echo "$WAVE" | jq '.data | {state, summary, dispatchSpreadMs, legs: [.legs[] | {accountId, state, orderId}]}'
