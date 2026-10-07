"""A minimal MT5 copy trader with the fxapis MetaTrader 5 API.

Watches a master account's deals and mirrors them onto follower accounts:

* a master deal that **opens** a position (``entry == "in"``) becomes one
  multi-account order on every follower (``POST /v1/execution-waves``);
* a deal that **closes** a master position (``entry == "out"``) closes the
  followers' copies of it.

There are no event webhooks yet, so this polls: every few seconds it asks
fxapis to refresh the master from the broker (``reconcile``) and reads the new
deals. Every copy carries an idempotency key made from the master deal, so a
restart or a retry never copies the same deal twice (keys are honoured for 24 hours;
the state file below covers longer gaps).

    export FXAPIS_API_KEY=fx_test_...
    export MASTER_ACCOUNT_ID=<id> FOLLOWER_ACCOUNT_IDS=<id>,<id>,...
    export VOLUME_MULTIPLIER=1.0      # follower lots = master lots x multiplier
    python copy_trader.py

Simplifications, on purpose: only buys and sells are copied; a partial close
of the master is logged, not mirrored; stops set on the master are not
copied. Use broker DEMO accounts while you try it.
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from decimal import ROUND_DOWN, Decimal
from pathlib import Path
from typing import Any

from fxapis import FeatureNotInPlanError, Fxapis, FxapisError, OrderUnresolvedError
from fxapis.types import Deal

POLL_SECONDS = float(os.environ.get("POLL_SECONDS", "3"))
STATE_FILE = Path(os.environ.get("COPY_STATE_FILE", "copy_trader_state.json"))

client = Fxapis()


def load_state() -> dict[str, Any]:
    if STATE_FILE.exists():
        state: dict[str, Any] = json.loads(STATE_FILE.read_text())
        return state
    # First run: copy only what happens from now on.
    return {"since": datetime.now(timezone.utc).isoformat(), "seen": [], "copies": {}}


def save_state(state: dict[str, Any]) -> None:
    state["seen"] = state["seen"][-5000:]
    STATE_FILE.write_text(json.dumps(state, indent=2))


def follower_volume(master_volume: str, multiplier: Decimal) -> str:
    lots = (Decimal(master_volume) * multiplier).quantize(Decimal("0.01"), rounding=ROUND_DOWN)
    return str(max(lots, Decimal("0.01")))


def keep_master_online(master_id: str) -> None:
    """The master must be online for its deals to be read. always_on if the plan has it, else warm it."""
    try:
        client.accounts.set_mode(master_id, "always_on")
        print("master set to always_on")
    except FeatureNotInPlanError:
        print("always_on is not in this plan; the master will be warmed whenever it is offline")
    client.accounts.warm(master_id)
    client.accounts.wait_until_ready(master_id)


def ensure_online(master_id: str) -> None:
    if client.accounts.status(master_id).get("state") not in ("ready", "executing"):
        client.accounts.warm(master_id)
        client.accounts.wait_until_ready(master_id)


def new_master_deals(master_id: str, state: dict[str, Any]) -> list[Deal]:
    client.accounts.reconcile(master_id)  # pulls the broker's latest deals and positions into fxapis
    seen = set(state["seen"])
    fresh = [d for d in client.deals.iter(master_id, since=state["since"]) if d["brokerDealId"] not in seen]
    fresh.sort(key=lambda d: d["dealtAt"])  # the API lists newest first; copy in the order they happened
    return fresh


def copy_open(deal: Deal, followers: list[str], multiplier: Decimal, state: dict[str, Any]) -> None:
    master_position = deal.get("brokerPositionId") or deal["brokerDealId"]
    key = f"copy-open:{deal['brokerDealId']}"
    wave = client.waves.create(
        account_ids=followers,
        symbol=deal["symbol"],
        side="buy" if deal["dealType"] == "buy" else "sell",
        volume=follower_volume(deal["volume"] or "0", multiplier),
        barrier_policy="release-ready",  # trade on the followers that are online in time
        client_wave_id=key,
        label=f"copy of master deal {deal['brokerDealId']}",
        idempotency_key=key,
    )
    wave = client.waves.wait_until_settled(wave["id"], timeout=180)
    print(
        f"copied {deal['dealType']} {deal['symbol']}: {wave['state']} {wave.get('summary')} "
        f"(sent to all within {wave.get('dispatchSpreadMs')} ms)"
    )

    # Remember which follower position copies which master position, so a close can follow.
    copies: dict[str, str] = {}
    for leg in wave.get("legs", []):
        order_id = leg.get("orderId")
        if order_id and leg.get("state") in ("filled", "unresolved"):
            order = client.orders.wait_until_resolved(order_id)  # returns at once when already settled
            ticket = order.get("brokerPositionId")
            if ticket:
                copies[leg["accountId"]] = ticket
    state["copies"][master_position] = copies


def copy_close(deal: Deal, state: dict[str, Any]) -> None:
    master_position = deal.get("brokerPositionId")
    copies: dict[str, str] = state["copies"].get(master_position or "", {})
    if not copies:
        return
    positions_left = [p for p in client.positions.list(deal["accountId"]) if p["brokerPositionId"] == master_position]
    if positions_left:
        print(f"master partially closed {master_position}; partial closes are not mirrored in this example")
        return
    for follower_id, ticket in copies.items():
        try:
            client.positions.close(
                follower_id, ticket, idempotency_key=f"copy-close:{deal['brokerDealId']}:{follower_id}"
            )
            print(f"closed copy {ticket} on {follower_id}")
        except OrderUnresolvedError as err:
            # Never resend. It will resolve; check it later.
            print(f"close of {ticket} on {follower_id} is being confirmed (order {err.order_id})")
        except FxapisError as err:
            print(f"could not close {ticket} on {follower_id}: {err}")
    state["copies"].pop(master_position, None)


def main() -> None:
    master_id = os.environ.get("MASTER_ACCOUNT_ID")
    followers = [f for f in os.environ.get("FOLLOWER_ACCOUNT_IDS", "").split(",") if f]
    if not master_id or not followers:
        sys.exit("Set MASTER_ACCOUNT_ID and FOLLOWER_ACCOUNT_IDS.")
    multiplier = Decimal(os.environ.get("VOLUME_MULTIPLIER", "1.0"))

    state = load_state()
    keep_master_online(master_id)
    # Followers come online for each copy by themselves; preparing them now makes the first copy fast.
    client.accounts.prepare(followers[:200])
    print(f"watching {master_id} -> {len(followers)} followers (every {POLL_SECONDS:g}s, Ctrl+C to stop)")

    while True:
        try:
            ensure_online(master_id)
            for deal in new_master_deals(master_id, state):
                if deal["dealType"] in ("buy", "sell"):
                    if deal.get("entry") == "in":
                        copy_open(deal, followers, multiplier, state)
                    elif deal.get("entry") in ("out", "out_by"):
                        copy_close(deal, state)
                state["seen"].append(deal["brokerDealId"])
                state["since"] = deal["dealtAt"]
                save_state(state)
        except FxapisError as err:
            print(f"poll failed, will retry: {err}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
