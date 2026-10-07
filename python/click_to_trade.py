"""Click-to-trade for signal providers, with the fxapis MetaTrader 5 API.

A signal goes out; each member decides with one click whether to take it on
their own MT5 account. The pieces, as backend handlers:

    member connects MT5 account  -> on_member_connects()   POST /v1/accounts (+ warm, to check credentials)
    member OPENS the signal      -> on_signal_viewed()     POST /v1/accounts/prepare
    member approves              -> on_member_approves()   POST /v1/accounts/{id}/orders/market
    member views their trades    -> on_trades_viewed()     GET  /v1/accounts/{id}/positions
    member closes                -> on_member_closes()     POST /v1/accounts/{id}/positions/{ticket}/close
    member leaves                -> on_member_leaves()     POST /v1/accounts/{id}/disconnect

Two ideas carry the design:

* **Prepare on view.** Bring a member's account online when *they* open the
  signal, not when it is published. By the time they tap approve their account
  is logged in, and only members who look at the signal use capacity.
* **Signal + member idempotency key.** ``signal_<id>:member_<id>`` makes a
  double tap, a flaky phone connection or your own retry return the first
  answer instead of opening a second position.

Run a scripted demo against one member account (a broker DEMO account):

    export FXAPIS_API_KEY=fx_test_... FXAPIS_ACCOUNT_ID=<connected account id>
    export FXAPIS_EXAMPLES_TRADE=1   # otherwise it stops before the order
    python click_to_trade.py

Full guide: https://docs.fxapis.com/signals
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass

from fxapis import (
    AccountExistsError,
    AccountNeedsAttentionError,
    AccountNotReadyError,
    Fxapis,
    FxapisError,
    IdempotencyInFlightError,
    NoRuntimeError,
    OrderRejectedError,
    OrderUnresolvedError,
    QuotaExceededError,
    SendFailedError,
    WaitTimeoutError,
)
from fxapis.types import Order, Position, Side


@dataclass
class Signal:
    id: str
    symbol: str
    side: Side
    stop_loss: str
    take_profit: str


@dataclass
class Member:
    id: str
    fxapis_account_id: str
    lot_size: str = "0.01"


# What to tell a member when their account cannot log in. Retrying will not help any of these.
NEEDS_MEMBER = {
    "invalid_credentials": "The login, password or server is wrong. Use the TRADING password and exact server.",
    "trading_disabled": "Your broker has disabled trading for this login -- ask them to enable it.",
    "needs_2fa": "Your account requires two-factor sign-in. Turn it off for this account.",
    "needs_certificate": "Your broker requires a certificate. Contact support.",
}

client = Fxapis()  # one client for the whole app; reads FXAPIS_API_KEY


def on_member_connects(member_id: str, login: str, server: str, password: str) -> tuple[str | None, str]:
    """Connects a member's account and checks the credentials while they are still on the screen.

    Returns ``(account_id, message)``. Store the account id against the member.
    Never store or log the password: fxapis encrypts it and never returns it.
    """
    try:
        account = client.accounts.connect(
            login=login, server=server, password=password, mode="warm_on_demand", label=f"member_{member_id}"
        )
    except AccountExistsError:
        return None, "This MT5 account is already connected."

    client.accounts.warm(account["id"])  # 202 at once
    try:
        client.accounts.wait_until_ready(account["id"], timeout=90)
    except AccountNeedsAttentionError as err:
        return account["id"], NEEDS_MEMBER.get(err.state, err.detail or err.state)
    except WaitTimeoutError:
        return account["id"], "Your broker is slow to answer. We will keep trying in the background."
    # It goes offline again by itself after 15 idle minutes; nothing else to do.
    return account["id"], "Connected. You're ready to take signals."


def on_signal_viewed(member: Member) -> None:
    """The member opened the signal: bring their account online now, without making them wait."""
    try:
        for result in client.accounts.prepare([member.fxapis_account_id]):
            if result["result"] == "needs_operator":
                print(f"member {member.id} must fix their account: {result.get('message')}")
    except FxapisError as err:
        # Preparing is an optimisation. If it fails, the order still brings the account online itself.
        print(f"prepare failed ({err}); the order will warm the account instead")


def prepare_many(account_ids: list[str]) -> None:
    """For a group (e.g. everyone viewing a signal): prepare accepts up to 200 accounts per call."""
    for start in range(0, len(account_ids), 200):
        client.accounts.prepare(account_ids[start : start + 200])


def on_member_approves(signal: Signal, member: Member) -> tuple[Order | None, str]:
    """The click. Returns ``(order, message for the member)``."""
    key = f"signal_{signal.id}:member_{member.id}"
    try:
        order = client.orders.market(
            member.fxapis_account_id,
            symbol=signal.symbol,  # as the member's broker names it (some add suffixes, e.g. EURUSD.a)
            side=signal.side,
            volume=member.lot_size,  # a string: "0.05", not 0.05
            stop_loss=signal.stop_loss,  # absolute prices, not pips
            take_profit=signal.take_profit,
            client_order_id=f"signal_{signal.id}",
            idempotency_key=key,
        )
        return order, f"Filled at {order['filledPrice']}."
    except OrderRejectedError as err:
        # Nothing opened. A retry needs a NEW key -- this one now answers with the rejection.
        return None, f"Your broker refused the trade: {err.message}"
    except OrderUnresolvedError as err:
        # We do not know yet whether it reached the broker. NEVER resend. Show "confirming..." and poll.
        try:
            order = client.orders.wait_until_resolved(err.order_id or "", timeout=60)
        except WaitTimeoutError:
            return None, "Confirming your trade with the broker..."
        return order, f"Confirmed: {order['state']}."
    except (AccountNotReadyError, NoRuntimeError, SendFailedError, IdempotencyInFlightError):
        # Nothing was sent. The SDK already retried with the same key; the member can tap again safely --
        # the same key means at most one position.
        return None, "Your account is still coming online. Tap again in a few seconds."
    except QuotaExceededError:
        return None, "This trade can't be placed right now. Please contact support."


def on_trades_viewed(member: Member) -> list[Position]:
    """Positions as last seen. ``observedAt`` says how fresh each is; show it.

    Positions refresh while the account is online. Preparing the account when
    the member opens this screen gives them a live view within seconds.
    """
    positions = client.positions.list(member.fxapis_account_id)
    for p in positions:
        print(f"  {p['symbol']} {p['side']} {p['volume']} @ {p['openPrice']}", end="")
        print(f" -> P/L {p['profit']} (as of {p['observedAt']})")
    return positions


def on_member_closes(member: Member, ticket: str, volume: str | None = None) -> str:
    """Closes a position (its ``brokerPositionId``). Always with a key: a repeated close could open the opposite way."""
    try:
        order = client.positions.close(
            member.fxapis_account_id, ticket, volume=volume, idempotency_key=f"close_{ticket}_{volume or 'all'}"
        )
        return f"Closed at {order['filledPrice']}."
    except OrderUnresolvedError as err:
        order = client.orders.wait_until_resolved(err.order_id or "", timeout=60)
        return f"Close confirmed: {order['state']}."


def on_member_leaves(member: Member) -> None:
    """Erases the stored password at once. Their history stays."""
    client.accounts.disconnect(member.fxapis_account_id)


def main() -> None:
    account_id = os.environ.get("FXAPIS_ACCOUNT_ID")
    if not account_id:
        sys.exit("Set FXAPIS_ACCOUNT_ID to a connected DEMO account (see quickstart.py).")

    member = Member(id="4821", fxapis_account_id=account_id)
    signal = Signal(id="9931", symbol="EURUSD", side="buy", stop_loss="1.00000", take_profit="1.30000")

    print("member opens signal 9931 -> prepare")
    on_signal_viewed(member)

    if os.environ.get("FXAPIS_EXAMPLES_TRADE") != "1":
        print("Stopping before the order. Set FXAPIS_EXAMPLES_TRADE=1 to continue (demo account!).")
        return

    print("member taps approve -> market order")
    order, message = on_member_approves(signal, member)
    print(f"  {message}")

    print("member taps approve again (double tap) -> same key, same answer, no second position")
    again, _ = on_member_approves(signal, member)
    if order and again:
        assert again["id"] == order["id"]

    print("member views their trades")
    on_trades_viewed(member)

    ticket = order.get("brokerPositionId") if order else None
    if ticket:
        print("member closes")
        print(f"  {on_member_closes(member, ticket)}")


if __name__ == "__main__":
    main()
