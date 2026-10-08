"""fxapis quickstart -- MetaTrader 5 (MT5) from Python in one file.

Connects an MT5 account, brings it online, reads it, and (only if you opt in)
places and closes a 0.01-lot market order.

    pip install fxapis
    export FXAPIS_API_KEY=fx_test_...
    export MT5_LOGIN=... MT5_SERVER=... MT5_PASSWORD=...   # or FXAPIS_ACCOUNT_ID=<already connected>
    export FXAPIS_EXAMPLES_TRADE=1                         # to actually trade (DEMO account!)
    python quickstart.py

Test keys reach real brokers. Use a broker DEMO account.
"""

from __future__ import annotations

import os
import sys

from fxapis import (
    AccountExistsError,
    AccountNeedsAttentionError,
    Fxapis,
    OrderRejectedError,
    OrderUnresolvedError,
)


def connect_or_reuse(client: Fxapis) -> str:
    """Returns the fxapis id of the account to use, connecting it if needed."""
    existing = os.environ.get("FXAPIS_ACCOUNT_ID")
    if existing:
        return existing

    login, server, password = (os.environ.get(k) for k in ("MT5_LOGIN", "MT5_SERVER", "MT5_PASSWORD"))
    if not (login and server and password):
        sys.exit("Set FXAPIS_ACCOUNT_ID, or MT5_LOGIN, MT5_SERVER and MT5_PASSWORD.")

    try:
        account = client.accounts.connect(
            login=login,
            server=server,  # exactly as MetaTrader shows it, e.g. "VantageMarkets-Demo"
            password=password,  # the TRADING password, not the investor password
            mode="warm_on_demand",  # online when needed; offline after 15 idle minutes
            label="fxapis quickstart",
        )
        print(f"connected {login}@{server} as {account['id']} (state: {account['state']})")
        return account["id"]
    except AccountExistsError:
        # Connected before: find it rather than connecting twice.
        for account in client.accounts.list():
            if account["login"] == login and account["server"] == server:
                print(f"reusing {account['id']}")
                return account["id"]
        raise


def main() -> None:
    client = Fxapis()  # reads FXAPIS_API_KEY

    workspace = client.workspace.get()
    print(f"workspace {workspace['name']} on plan {workspace['planName']}")

    account_id = connect_or_reuse(client)

    # Bring the account online: 202 at once, then poll. Typically about 10 seconds.
    client.accounts.warm(account_id)
    try:
        status = client.accounts.wait_until_ready(account_id, timeout=120)
    except AccountNeedsAttentionError as err:
        # Wrong password, 2FA, certificate, or a read-only login. Retrying will not help.
        sys.exit(f"The account needs attention: {err.state} -- {err.detail}")
    print(f"online: {status['state']}")

    account = client.accounts.get(account_id)
    print(f"{account['brokerName']} | {account['currency']} | leverage 1:{account['leverage']}")

    margin = client.calculate.margin(account_id, symbol="EURUSD", side="buy", volume="0.01", price="1.10000")
    print(f"margin for 0.01 EURUSD at 1.10000: {margin['value']} {account['currency']}")

    for position in client.positions.list(account_id):
        print(f"open: {position['symbol']} {position['side']} {position['volume']} profit {position['profit']}")

    if os.environ.get("FXAPIS_EXAMPLES_TRADE") != "1":
        print("Read-only run. Set FXAPIS_EXAMPLES_TRADE=1 to place and close a 0.01-lot trade (demo account!).")
        return

    try:
        # An Idempotency-Key is generated and sent for you; a retry reuses it.
        order = client.orders.market(
            account_id, symbol="EURUSD", side="buy", volume="0.01", comment="fxapis quickstart"
        )
    except OrderRejectedError as err:
        sys.exit(f"The broker refused the order: {err.message}")
    except OrderUnresolvedError as err:
        # Never resend: the order may be live. Wait for fxapis to confirm it with the broker.
        order = client.orders.wait_until_resolved(err.order_id or "")
    print(f"order {order['id']}: {order['state']} at {order['filledPrice']} (retcode {order['retcode']})")

    # The position the order opened carries the order's own ticket (brokerOrderId). Positions
    # refresh by themselves about every 15 s; reconcile refreshes them now.
    client.accounts.reconcile(account_id)
    ticket = next(
        (p["brokerPositionId"] for p in client.positions.list(account_id)
         if p["brokerPositionId"] == order.get("brokerOrderId")),
        None,
    )
    if ticket:
        closed = client.positions.close(account_id, ticket)
        print(f"closed position {ticket}: {closed['state']} at {closed['filledPrice']}")

    for deal in client.orders.deals(order["id"]):
        print(f"deal {deal['brokerDealId']}: {deal['dealType']} {deal['volume']} @ {deal['price']}")

    usage = client.usage.get()
    print(f"orders this month: {usage['usage']['orders']}")


if __name__ == "__main__":
    main()
