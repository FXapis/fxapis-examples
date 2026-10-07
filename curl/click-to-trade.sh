#!/usr/bin/env bash
# Click-to-trade with curl: prepare on view, then one order per approval keyed by signal + member.
#
#   export FXAPIS_API_KEY=fx_test_... ACCOUNT_ID=<member's fxapis account id>
#   ./click-to-trade.sh
#
# Full guide: https://docs.fxapis.com/signals — test with a broker DEMO account.
set -euo pipefail

API="${FXAPIS_API:-https://api.fxapis.com}"
: "${FXAPIS_API_KEY:?Set FXAPIS_API_KEY}" "${ACCOUNT_ID:?Set ACCOUNT_ID}"
AUTH=(-H "Authorization: Bearer $FXAPIS_API_KEY")
JSON=(-H "Content-Type: application/json")
SIGNAL_ID="${SIGNAL_ID:-9931}"
MEMBER_ID="${MEMBER_ID:-4821}"

# The member OPENS the signal: bring their account online now (202 at once; up to 200 ids per call).
curl -sS -X POST "$API/v1/accounts/prepare" "${AUTH[@]}" "${JSON[@]}" \
  -d "{\"accountIds\": [\"$ACCOUNT_ID\"]}" | jq -c '.data'

# The member approves: the key is signal + member, so a double tap returns the first answer.
place() {
  curl -sS -X POST "$API/v1/accounts/$ACCOUNT_ID/orders/market" "${AUTH[@]}" "${JSON[@]}" \
    -H "Idempotency-Key: signal_${SIGNAL_ID}:member_${MEMBER_ID}" \
    -d "{\"symbol\": \"EURUSD\", \"side\": \"buy\", \"volume\": \"0.01\", \"stopLoss\": \"1.00000\",
         \"takeProfit\": \"1.30000\", \"clientOrderId\": \"signal_${SIGNAL_ID}\"}"
}

RESPONSE=$(place)
CODE=$(echo "$RESPONSE" | jq -r '.error.code // empty')
case "$CODE" in
  "") echo "$RESPONSE" | jq '.data | {id, state, filledPrice, brokerPositionId}' ;;
  SEND_FAILED | ACCOUNT_NOT_READY | NO_RUNTIME | IDEMPOTENCY_IN_FLIGHT)
    echo "nothing was sent ($CODE); retrying with the same key"; sleep 3; place | jq '.data // .error' ;;
  ORDER_UNRESOLVED)
    ORDER_ID=$(echo "$RESPONSE" | jq -r '.error.details[0].orderId')
    echo "unresolved: NOT resending; polling order $ORDER_ID"
    for _ in $(seq 1 30); do
      STATE=$(curl -sS "$API/v1/orders/$ORDER_ID" "${AUTH[@]}" | jq -r '.data.state')
      [ "$STATE" != "unknown" ] && { echo "resolved: $STATE"; break; }
      sleep 2
    done ;;
  *) echo "$RESPONSE" | jq '.error' ;;
esac

# A second tap with the same key replays the first answer (response header idempotent-replay: true).
place | jq -c '.data | {id, state}'
