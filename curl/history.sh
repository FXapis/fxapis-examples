#!/usr/bin/env bash
# Orders and deal history, cursor-paginated, with curl.
#
#   export FXAPIS_API_KEY=fx_test_... ACCOUNT_ID=<fxapis account id>
#   ./history.sh
set -euo pipefail

API="${FXAPIS_API:-https://api.fxapis.com}"
: "${FXAPIS_API_KEY:?Set FXAPIS_API_KEY}" "${ACCOUNT_ID:?Set ACCOUNT_ID}"
AUTH=(-H "Authorization: Bearer $FXAPIS_API_KEY")

# Orders still being confirmed with the broker (state=unknown) — the ones that need attention.
curl -sS "$API/v1/orders?state=unknown" "${AUTH[@]}" | jq -c '.data[] | {id, accountId, symbol, createdAt}'

# Every order on one account, newest first, following nextCursor page by page.
CURSOR=""
while :; do
  PAGE=$(curl -sS -G "$API/v1/orders" "${AUTH[@]}" --data-urlencode "accountId=$ACCOUNT_ID" \
    --data-urlencode "limit=200" ${CURSOR:+--data-urlencode "cursor=$CURSOR"})
  echo "$PAGE" | jq -c '.data[] | {id, symbol, side, state, filledPrice, createdAt}'
  [ "$(echo "$PAGE" | jq -r '.page.hasMore')" = "true" ] || break
  CURSOR=$(echo "$PAGE" | jq -r '.page.nextCursor')
done

# The broker's deal history — including stop-loss fills, swaps and trades placed from the MetaTrader desktop.
curl -sS -G "$API/v1/accounts/$ACCOUNT_ID/deals" "${AUTH[@]}" --data-urlencode "limit=50" |
  jq -c '.data[] | {brokerDealId, symbol, dealType, entry, volume, price, profit, dealtAt}'
