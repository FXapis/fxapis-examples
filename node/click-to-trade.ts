// Click-to-trade for signal providers, with the fxapis MetaTrader 5 API.
//
// A signal goes out; each member decides with one click whether to take it on
// their own MT5 account. The pieces, as backend handlers:
//
//   member connects MT5 account  -> onMemberConnects()   POST /v1/accounts (+ warm, to check credentials)
//   member OPENS the signal      -> onSignalViewed()     POST /v1/accounts/prepare
//   member approves              -> onMemberApproves()   POST /v1/accounts/{id}/orders/market
//   member views their trades    -> onTradesViewed()     GET  /v1/accounts/{id}/positions
//   member closes                -> onMemberCloses()     POST /v1/accounts/{id}/positions/{ticket}/close
//   member leaves                -> onMemberLeaves()     POST /v1/accounts/{id}/disconnect
//
// Prepare on view: bring a member's account online when *they* open the signal,
// so it is logged in by the time they tap approve. Signal + member idempotency
// key: a double tap or a retry returns the first answer, never a second position.
//
//   export FXAPIS_API_KEY=fx_test_... FXAPIS_ACCOUNT_ID=<connected DEMO account id>
//   export FXAPIS_EXAMPLES_TRADE=1   # otherwise it stops before the order
//   node click-to-trade.ts
//
// Full guide: https://docs.fxapis.com/signals
import { Fxapis, FxapisError } from "fxapis";
import { env, orderIdOf, waitUntilReady, waitUntilResolved, withSafeRetry } from "./helpers.ts";

type Signal = { id: string; symbol: string; side: "buy" | "sell"; stopLoss: string; takeProfit: string };
type Member = { id: string; fxapisAccountId: string; lotSize: string };

const fx = new Fxapis(env("FXAPIS_API_KEY")); // backend only — never ship the key to an app or browser

const NEEDS_MEMBER: Record<string, string> = {
  invalid_credentials: "The login, password or server is wrong. Use the TRADING password and the exact server name.",
  trading_disabled: "Your broker has disabled trading for this login — ask them to enable it.",
  needs_2fa: "Your account requires two-factor sign-in. Turn it off for this account.",
  needs_certificate: "Your broker requires a certificate. Contact support.",
};

/** Connects a member's account and checks the credentials while they are still on the screen. */
export async function onMemberConnects(memberId: string, form: { login: string; server: string; password: string }) {
  const account = await fx.postAccounts({
    login: form.login,
    server: form.server,
    password: form.password, // never store or log it; fxapis encrypts it and never returns it
    mode: "warm_on_demand",
    label: `member_${memberId}`,
  });
  await fx.postAccountsByIdWarm(account.id); // 202 at once
  try {
    await waitUntilReady(fx, account.id, 90_000);
    return { accountId: account.id as string, message: "Connected. You're ready to take signals." };
  } catch {
    const status = await fx.getAccountsByIdStatus(account.id);
    return { accountId: account.id as string, message: NEEDS_MEMBER[status.state] ?? "Your broker is slow to answer." };
  }
}

/** The member opened the signal: bring their account online now. Fire and forget. */
export function onSignalViewed(member: Member): void {
  fx.postAccountsPrepare({ accountIds: [member.fxapisAccountId] }).catch((err: unknown) => {
    // Preparing is an optimisation; the order brings the account online itself if needed.
    console.warn("prepare failed:", err);
  });
}

/** For a group: prepare accepts up to 200 accounts per call. */
export async function prepareMany(accountIds: string[]): Promise<void> {
  for (let i = 0; i < accountIds.length; i += 200) {
    await fx.postAccountsPrepare({ accountIds: accountIds.slice(i, i + 200) });
  }
}

/** The click. */
export async function onMemberApproves(signal: Signal, member: Member) {
  const idempotencyKey = `signal_${signal.id}:member_${member.id}`;
  try {
    const order = await withSafeRetry(() =>
      fx.postAccountsByIdOrdersMarket(
        member.fxapisAccountId,
        {
          symbol: signal.symbol, // as the member's broker names it (some add suffixes, e.g. EURUSD.a)
          side: signal.side,
          volume: member.lotSize, // a string: "0.05", not 0.05
          stopLoss: signal.stopLoss, // absolute prices, not pips
          takeProfit: signal.takeProfit,
          clientOrderId: `signal_${signal.id}`,
        },
        { idempotencyKey },
      ),
    );
    return { order, message: `Filled at ${order.filledPrice}.` };
  } catch (err) {
    if (!(err instanceof FxapisError)) throw err;
    switch (err.code) {
      case "ORDER_REJECTED":
        // Nothing opened. A new attempt needs a NEW key — this one now answers with the rejection.
        return { order: null, message: `Your broker refused the trade: ${err.message}` };
      case "ORDER_UNRESOLVED": {
        // Unknown whether it reached the broker. NEVER resend. Show "confirming…" and poll.
        const order = await waitUntilResolved(fx, orderIdOf(err)!, 60_000);
        return { order, message: `Confirmed: ${order.state}.` };
      }
      case "ACCOUNT_NOT_READY":
      case "NO_RUNTIME":
      case "SEND_FAILED":
      case "IDEMPOTENCY_IN_FLIGHT":
        // Nothing was sent (already retried with the same key). Tapping again is safe: same key, one position.
        return { order: null, message: "Your account is still coming online. Tap again in a few seconds." };
      case "QUOTA_EXCEEDED":
        return { order: null, message: "This trade can't be placed right now. Please contact support." };
      default:
        throw err;
    }
  }
}

/** Positions as last seen; `observedAt` says how fresh each is — show it. */
export async function onTradesViewed(member: Member) {
  const positions = await fx.getAccountsByIdPositions(member.fxapisAccountId);
  for (const p of positions) {
    console.log(`  ${p.symbol} ${p.side} ${p.volume} @ ${p.openPrice} -> P/L ${p.profit} (as of ${p.observedAt})`);
  }
  return positions;
}

/** Closes a position (its brokerPositionId). Always with a key: a repeated close could open the opposite way. */
export async function onMemberCloses(member: Member, ticket: string, volume?: string) {
  const body = volume ? { volume } : {};
  return withSafeRetry(() =>
    fx.postAccountsByIdPositionsByPositionIdClose(member.fxapisAccountId, ticket, body, {
      idempotencyKey: `close_${ticket}_${volume ?? "all"}`,
    }),
  );
}

/** Erases the stored password at once. Their history stays. */
export async function onMemberLeaves(member: Member): Promise<void> {
  await fx.postAccountsByIdDisconnect(member.fxapisAccountId);
}

// --- scripted demo -------------------------------------------------------------

const member: Member = { id: "4821", fxapisAccountId: env("FXAPIS_ACCOUNT_ID"), lotSize: "0.01" };
const signal: Signal = { id: "9931", symbol: "EURUSD", side: "buy", stopLoss: "1.00000", takeProfit: "1.30000" };

console.log("member opens signal 9931 -> prepare");
onSignalViewed(member);

if (process.env.FXAPIS_EXAMPLES_TRADE !== "1") {
  console.log("Stopping before the order. Set FXAPIS_EXAMPLES_TRADE=1 to continue (demo account!).");
  process.exit(0);
}

console.log("member taps approve -> market order");
const first = await onMemberApproves(signal, member);
console.log(`  ${first.message}`);

console.log("member taps approve again (double tap) -> same key, same answer, no second position");
const again = await onMemberApproves(signal, member);
if (first.order && again.order && first.order.id !== again.order.id) throw new Error("expected the same order");

console.log("member views their trades");
await onTradesViewed(member);

if (first.order?.brokerPositionId) {
  console.log("member closes");
  const closed = await onMemberCloses(member, first.order.brokerPositionId);
  console.log(`  closed at ${closed.filledPrice}`);
}
