// fxapis quickstart — MetaTrader 5 (MT5) from Node.js / TypeScript.
//
// Connects an MT5 account, brings it online, reads it, and (only if you opt in)
// places and closes a 0.01-lot market order.
//
//   npm install
//   export FXAPIS_API_KEY=fx_test_...
//   export MT5_LOGIN=... MT5_SERVER=... MT5_PASSWORD=...   # or FXAPIS_ACCOUNT_ID=<already connected>
//   export FXAPIS_EXAMPLES_TRADE=1                         # to actually trade (DEMO account!)
//   node quickstart.ts                                      # Node 22.18+ runs TypeScript directly
//
// Test keys reach real brokers. Use a broker DEMO account.
import { Fxapis, FxapisError, newIdempotencyKey } from "fxapis";
import { env, orderIdOf, waitUntilReady, waitUntilResolved, withSafeRetry } from "./helpers.ts";

const fx = new Fxapis(env("FXAPIS_API_KEY"));

async function connectOrReuse(): Promise<string> {
  if (process.env.FXAPIS_ACCOUNT_ID) return process.env.FXAPIS_ACCOUNT_ID;

  const login = env("MT5_LOGIN");
  const server = env("MT5_SERVER");
  try {
    const account = await fx.postAccounts({
      login,
      server, // exactly as MetaTrader shows it, e.g. "VantageMarkets-Demo"
      password: env("MT5_PASSWORD"), // the TRADING password, not the investor password
      mode: "warm_on_demand", // online when needed; offline after 15 idle minutes
      label: "fxapis quickstart",
    });
    console.log(`connected ${login}@${server} as ${account.id} (state: ${account.state})`);
    return account.id;
  } catch (err) {
    if (err instanceof FxapisError && err.code === "ACCOUNT_EXISTS") {
      const accounts: { id: string; login: string; server: string }[] = await fx.getAccounts();
      const existing = accounts.find((a) => a.login === login && a.server === server);
      if (existing) return existing.id;
    }
    throw err;
  }
}

const workspace = await fx.getWorkspace();
console.log(`workspace ${workspace.name} on plan ${workspace.planName}`);

const accountId = await connectOrReuse();

// Bring the account online: 202 at once, then poll. Typically about 10 seconds.
await fx.postAccountsByIdWarm(accountId);
await waitUntilReady(fx, accountId);

const account = await fx.getAccountsById(accountId);
console.log(`${account.brokerName} | ${account.currency} | leverage 1:${account.leverage}`);

const margin = await fx.postAccountsByIdCalculate(accountId, {
  kind: "margin",
  symbol: "EURUSD",
  side: "buy",
  volume: "0.01",
  price: "1.10000",
});
console.log(`margin for 0.01 EURUSD at 1.10000: ${margin.value} ${account.currency}`);

for (const p of await fx.getAccountsByIdPositions(accountId)) {
  console.log(`open: ${p.symbol} ${p.side} ${p.volume} profit ${p.profit} (as of ${p.observedAt})`);
}

if (process.env.FXAPIS_EXAMPLES_TRADE !== "1") {
  console.log("Read-only run. Set FXAPIS_EXAMPLES_TRADE=1 to place and close a 0.01-lot trade (demo account!).");
  process.exit(0);
}

// One key per order, kept across retries: a retry with it returns the first answer, never a second order.
const key = newIdempotencyKey();
let order;
try {
  order = await withSafeRetry(() =>
    fx.postAccountsByIdOrdersMarket(
      accountId,
      { symbol: "EURUSD", side: "buy", volume: "0.01", comment: "fxapis quickstart" },
      { idempotencyKey: key },
    ),
  );
} catch (err) {
  if (err instanceof FxapisError && err.code === "ORDER_UNRESOLVED") {
    // Never resend: the order may be live. Wait for fxapis to confirm it with the broker.
    order = await waitUntilResolved(fx, orderIdOf(err)!);
  } else if (err instanceof FxapisError && err.code === "ORDER_REJECTED") {
    console.error(`The broker refused the order: ${err.message}`);
    process.exit(1);
  } else {
    throw err;
  }
}
console.log(`order ${order.id}: ${order.state} at ${order.filledPrice} (retcode ${order.retcode})`);

if (order.brokerPositionId) {
  const closed = await fx.postAccountsByIdPositionsByPositionIdClose(accountId, order.brokerPositionId, {}, {
    idempotencyKey: `close_${order.brokerPositionId}`,
  });
  console.log(`closed position ${order.brokerPositionId}: ${closed.state} at ${closed.filledPrice}`);
}

for (const deal of await fx.getOrdersByIdDeals(order.id)) {
  console.log(`deal ${deal.brokerDealId}: ${deal.dealType} ${deal.volume} @ ${deal.price}`);
}

const usage = await fx.getBillingUsage();
console.log(`orders this month: ${usage.usage.orders}`);
