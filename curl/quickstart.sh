#!/usr/bin/env bash
# fxapis quickstart with curl — MetaTrader 5 (MT5) REST API.
#
#   export FXAPIS_API_KEY=fx_test_...
#   export MT5_LOGIN=... MT5_SERVER=... MT5_PASSWORD=...   # or FXAPIS_ACCOUNT_ID=<already connected>
#   export FXAPIS_EXAMPLES_TRADE=1                         # to place and close a 0.01-lot trade (DEMO account!)
#   ./quickstart.sh
#
# Needs curl and jq. Test keys reach real brokers: use a broker DEMO account.
set -euo pipefail

API="${FXAPIS_API:-https://api.fxapis.com}"
: "${FXAPIS_API_KEY:?Set FXAPIS_API_KEY}"
AUTH=(-H "Authorization: Bearer $FXAPIS_API_KEY")
JSON=(-H "Content-Type: application/json")
uuid() {
  if command -v uuidgen >/dev/null; then uuidgen | tr '[:upper:]' '[:lower:]'; else cat /proc/sys/kernel/random/uuid; fi
}

curl -sS "$API/v1/workspace" "${AUTH[@]}" | jq '.data | {name, plan, tradingDisabled}'

# 1. Connect an MT5 account (once). The TRADING password, not the investor password.
ACCOUNT_ID="${FXAPIS_ACCOUNT_ID:-}"
if [ -z "$ACCOUNT_ID" ]; then
  : "${MT5_LOGIN:?Set MT5_LOGIN}" "${MT5_SERVER:?Set MT5_SERVER}" "${MT5_PASSWORD:?Set MT5_PASSWORD}"
  ACCOUNT_ID=$(jq -n --arg login "$MT5_LOGIN" --arg server "$MT5_SERVER" --arg password "$MT5_PASSWORD" \
      '{login: $login, server: $server, password: $password, mode: "warm_on_demand", label: "curl quickstart"}' |
    curl -sS -X POST "$API/v1/accounts" "${AUTH[@]}" "${JSON[@]}" -d @- | jq -er '.data.id')
  echo "connected: $ACCOUNT_ID"
fi

# 2. Bring it online (202 at once) and poll until ready — typically about 10 seconds.
curl -sS -X POST "$API/v1/accounts/$ACCOUNT_ID/warm" "${AUTH[@]}" | jq -c '.data'
for _ in $(seq 1 60); do
  STATE=$(curl -sS "$API/v1/accounts/$ACCOUNT_ID/status" "${AUTH[@]}" | jq -r '.data.state')
  echo "state: $STATE"
  case "$STATE" in
    ready | executing) break ;;
    invalid_credentials | needs_2fa | needs_certificate | trading_disabled)
      echo "The account needs attention ($STATE). Retrying will not help." >&2; exit 1 ;;
  esac
  sleep 2
done

curl -sS "$API/v1/accounts/$ACCOUNT_ID" "${AUTH[@]}" | jq '.data | {brokerName, currency, leverage, state}'

# Margin for 0.01 lots, computed by the account's own terminal. Opens nothing.
curl -sS -X POST "$API/v1/accounts/$ACCOUNT_ID/calculate" "${AUTH[@]}" "${JSON[@]}" \
  -d '{"kind": "margin", "symbol": "EURUSD", "side": "buy", "volume": "0.01", "price": "1.10000"}' | jq -c '.data'

curl -sS "$API/v1/accounts/$ACCOUNT_ID/positions" "${AUTH[@]}" | jq -c '.data[] | {symbol, side, volume, profit, observedAt}'

if [ "${FXAPIS_EXAMPLES_TRADE:-0}" != "1" ]; then
  echo "Read-only run. Set FXAPIS_EXAMPLES_TRADE=1 to place and close a 0.01-lot trade (demo account!)."
  exit 0
fi

# 3. A market order. Volumes and prices are strings. Keep the key: a retry with it never places a second order.
KEY=$(uuid)
ORDER=$(curl -sS -X POST "$API/v1/accounts/$ACCOUNT_ID/orders/market" "${AUTH[@]}" "${JSON[@]}" \
  -H "Idempotency-Key: $KEY" \
  -d '{"symbol": "EURUSD", "side": "buy", "volume": "0.01", "comment": "curl quickstart"}')
echo "$ORDER" | jq '.data // .error'
# On .error.code == "ORDER_UNRESOLVED": do NOT resend. Poll GET /v1/orders/{id} until it leaves "unknown".
# On "SEND_FAILED" / "ACCOUNT_NOT_READY": resend with the SAME Idempotency-Key.

# 4. Close the position it opened — with its own key. That position carries the order's own
#    ticket (brokerOrderId). Positions refresh by themselves about every 15 s; reconcile does it now.
curl -sS -X POST "$API/v1/accounts/$ACCOUNT_ID/reconcile" "${AUTH[@]}" > /dev/null
OPENED=$(echo "$ORDER" | jq -r '.data.brokerOrderId // empty')
TICKET=$(curl -sS "$API/v1/accounts/$ACCOUNT_ID/positions" "${AUTH[@]}" \
  | jq -r --arg t "$OPENED" '.data[] | select(.brokerPositionId == $t) | .brokerPositionId')
if [ -n "$TICKET" ]; then
  curl -sS -X POST "$API/v1/accounts/$ACCOUNT_ID/positions/$TICKET/close" "${AUTH[@]}" "${JSON[@]}" \
    -H "Idempotency-Key: close_$TICKET" -d '{}' | jq -c '.data // .error'
fi
