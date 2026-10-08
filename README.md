<div align="center">

<img src="https://fxapis.com/logo.png" alt="" width="72" height="72">

# fxapis examples

**Runnable MetaTrader 5 (MT5) REST API examples — Python, Node.js/TypeScript and curl**

[Website](https://fxapis.com) · [Docs](https://docs.fxapis.com) · [API Reference](https://docs.fxapis.com/api-reference) · [Status](https://status.fxapis.com) · [Support](mailto:support@fxapis.com)

[![License: MIT](https://img.shields.io/badge/license-MIT-22D3D6?style=flat-square)](LICENSE)
[![check](https://img.shields.io/github/actions/workflow/status/FXapis/fxapis-examples/check.yml?branch=main&style=flat-square&label=check)](https://github.com/FXapis/fxapis-examples/actions/workflows/check.yml)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522.18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.10-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org)
[![fxapis status](https://status.fxapis.com/badge.svg)](https://status.fxapis.com)

</div>

---

Runnable examples for **[fxapis](https://fxapis.com)**, the hosted **MetaTrader 5 REST API**. Connect an MT5 account once, then trade it over plain HTTPS: market and pending orders, closing and modifying positions, positions and deal history, and one trade placed on many accounts at once.

You run **no MetaTrader terminal, no Windows VPS and no EA**. fxapis runs the MT5 terminals in its own cloud (EU, Amsterdam); your code talks to a REST API. That makes **MT5 from Python** or Node.js work on Linux, macOS and serverless, and makes **copy trading** and **click-to-trade** signal apps a few API calls.

> [!WARNING]
> **Test keys reach real brokers.** An `fx_test_` key is a label for your configuration, not a sandbox. Run these examples against a **broker demo account**. They only read unless you set `FXAPIS_EXAMPLES_TRADE=1`, and then trade 0.01 lots.

## Table of contents

- [What's here](#whats-here)
- [Setup](#setup)
- [Quickstart](#quickstart)
- [Click-to-trade](#click-to-trade-for-signal-providers)
- [Copy trader](#copy-trader)
- [The rules that keep money safe](#the-rules-that-keep-money-safe)
- [Related fxapis repositories](#related-fxapis-repositories)
- [Getting help](#getting-help)
- [Contributing](#contributing)
- [License](#license)

## What's here

| | Python | Node.js / TypeScript | curl |
|---|---|---|---|
| **Quickstart** — connect, bring online, read, trade, close | [`python/quickstart.py`](python/quickstart.py) | [`node/quickstart.ts`](node/quickstart.ts) | [`curl/quickstart.sh`](curl/quickstart.sh) |
| **Click-to-trade** — signal provider: prepare on view, one-click order keyed by signal + member | [`python/click_to_trade.py`](python/click_to_trade.py) | [`node/click-to-trade.ts`](node/click-to-trade.ts) | [`curl/click-to-trade.sh`](curl/click-to-trade.sh) |
| **Copy trader** — poll a master's deals, mirror them to followers with one multi-account order | [`python/copy_trader.py`](python/copy_trader.py) | [`node/copy-trader.ts`](node/copy-trader.ts) | [`curl/multi-account-order.sh`](curl/multi-account-order.sh) |
| **History** — orders and deals, cursor-paginated | in the SDK: `client.orders.iter()` | `getOrders({ query })` | [`curl/history.sh`](curl/history.sh) |

Looking for the **Postman collection**, **TradingView alert payloads** or **n8n templates**? Those moved to [`fxapis-integrations`](https://github.com/FXapis/fxapis-integrations).

## Setup

1. Create an API key in the console at [fxapis.com](https://fxapis.com).
2. Open a demo MT5 account with any broker and note its **login**, **trading password** and **server name** (exactly as MetaTrader shows it, e.g. `VantageMarkets-Demo`).
3. Copy [`.env.example`](.env.example) to `.env`, fill it in, and export it (`set -a; . ./.env; set +a`).

### Python

```bash
cd python
pip install -r requirements.txt        # the fxapis SDK (httpx is its only dependency)
python quickstart.py
```

### Node.js / TypeScript

```bash
cd node
npm install                            # the fxapis SDK (no runtime dependencies)
node quickstart.ts                     # Node 22.18+ runs TypeScript directly
npm run check                          # type-check
```

### curl

```bash
cd curl
./quickstart.sh                        # needs curl and jq
```

> [!NOTE]
> The SDKs come from [npm](https://www.npmjs.com/package/fxapis) (`npm install fxapis`) and [PyPI](https://pypi.org/project/fxapis/) (`pip install fxapis`) — `npm install` and `pip install -r requirements.txt` above install them.

## Quickstart

Connect an account with `"mode": "warm_on_demand"` (online when needed, offline after 15 idle minutes), bring it online with `POST /v1/accounts/{id}/warm` and poll `GET /v1/accounts/{id}/status` until `ready` (about 10 seconds for a typical broker), read the account and a margin calculation, then place a market order and close the position it opened.

## Click-to-trade for signal providers

For apps where each member approves a signal with a click, on their own MT5 account:

1. **Connect** the member's account once, and check the credentials straight away with `warm` + `status` so a wrong password is caught on the connect screen, not on the first trade.
2. **Prepare on view** — when the member *opens* the signal, `POST /v1/accounts/prepare` brings their account online (up to 200 accounts per call). By the time they tap approve, the order goes straight through.
3. **Order with a signal + member key** — `Idempotency-Key: signal_<id>:member_<id>` means a double tap, a flaky connection or a retry returns the first answer and never opens a second position.
4. **Handle every outcome** — filled; `ORDER_REJECTED` (show the reason); `ORDER_UNRESOLVED` (**never resend** — poll the order); `ACCOUNT_NOT_READY` / `SEND_FAILED` (nothing was sent — retry with the same key).
5. Show positions with their `observedAt`, close with a key, and `disconnect` when a member leaves (the stored password is erased at once).

The full walkthrough is in the [signals guide](https://docs.fxapis.com/signals).

## Copy trader

Watches a master MT5 account and mirrors its trades onto follower accounts. There are no event webhooks yet, so it polls: `reconcile` the master, read new deals, and for each opening deal send **one multi-account order** (`POST /v1/execution-waves`) to every follower, with the master deal id as the idempotency key so a restart never copies a deal twice. When the master closes, the followers' copies are closed. Per-account volumes (`weights`), a release time (`executeAt`) and barrier policies (`release-ready`, `all-or-nothing`, `wait`) are available on the same endpoint.

Kept deliberately small: buys and sells only, full closes only, no stop copying. A starting point, not a product.

## The rules that keep money safe

- **Always send an `Idempotency-Key` on orders and closes.** Keys are honoured for 24 hours: the same key with the same body returns the first answer. The SDKs generate one for you (Python) or give you `newIdempotencyKey()` (Node).
- **Never resend `ORDER_UNRESOLVED`.** The order may be live at the broker. fxapis confirms the outcome with the broker; poll `GET /v1/orders/{id}` until it leaves `unknown`.
- **`SEND_FAILED`, `ACCOUNT_NOT_READY` and `NO_RUNTIME` mean nothing was sent** — retry with the same key.
- **Volumes and prices are strings** — `"0.01"`, not `0.01`. Stops are absolute prices, not pips.
- **Keep the API key on your backend.** Scoped keys can be read-only or reduce-only (close but never open).

## FAQ

**Can I run this against a live account?** Yes, but don't start there. Every fxapis key, test keys included, reaches a real broker — there is no simulated market. Validate behaviour on a demo account first.

**Why poll instead of a webhook?** fxapis has no event webhooks yet. The copy trader example shows the poll-and-reconcile pattern that works today; it is replaced by a webhook subscription without changing anything else once that ships.

**MT4?** Not supported. MT5 only.

## Related fxapis repositories

| Repository | What it is |
|---|---|
| [`fxapis-typescript`](https://github.com/FXapis/fxapis-typescript) | The official TypeScript/Node.js SDK these Node examples use |
| [`fxapis-python`](https://github.com/FXapis/fxapis-python) | The official Python SDK these Python examples use |
| [`fxapis-mcp-examples`](https://github.com/FXapis/fxapis-mcp-examples) | Connect Claude, Cursor, VS Code and other AI agents over MCP |
| [`fxapis-nextjs-starter`](https://github.com/FXapis/fxapis-nextjs-starter) | A small working Next.js app: connect, view positions, place a trade |
| [`fxapis-integrations`](https://github.com/FXapis/fxapis-integrations) | Postman collection, TradingView alert payloads, automation templates |

## Getting help

- **Docs:** [docs.fxapis.com](https://docs.fxapis.com)
- **Status:** [status.fxapis.com](https://status.fxapis.com) — live status and uptime history
- **Email:** [support@fxapis.com](mailto:support@fxapis.com)
- **Found a bug in an example?** [Open an issue](https://github.com/FXapis/fxapis-examples/issues) or send a pull request.

## Contributing

Pull requests that fix a bug, clarify a comment, or add a small, focused example in the existing style are welcome. Please keep examples runnable against a demo account with no extra dependencies beyond what is already listed, and keep the "only trades with `FXAPIS_EXAMPLES_TRADE=1`" safety behaviour intact.

## License

[MIT](LICENSE) © 2026 El Wizard
