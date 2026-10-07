// Small helpers shared by the examples. Copy what you need.
import { setTimeout as sleep } from "node:timers/promises";
import { type Fxapis, FxapisError } from "fxapis";

/** States only a person can fix. Polling longer tells you nothing new. */
export const NEEDS_ATTENTION = ["invalid_credentials", "needs_2fa", "needs_certificate", "trading_disabled"];

export function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name}.`);
    process.exit(1);
  }
  return value;
}

/** Polls GET /v1/accounts/{id}/status until the account is online, or clearly will not be. */
export async function waitUntilReady(fx: Fxapis, accountId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await fx.getAccountsByIdStatus(accountId);
    if (status.state === "ready" || status.state === "executing") return status;
    if (NEEDS_ATTENTION.includes(status.state)) {
      throw new Error(`account needs attention: ${status.state} — ${status.detail ?? ""}`);
    }
    if (Date.now() + 2000 > deadline) throw new Error(`not online within ${timeoutMs / 1000}s (last: ${status.state})`);
    await sleep(2000);
  }
}

/** The answer to ORDER_UNRESOLVED: poll the order until it leaves "unknown". Never resend it. */
export async function waitUntilResolved(fx: Fxapis, orderId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const order = await fx.getOrdersById(orderId);
    if (!["unknown", "validating", "sending"].includes(order.state)) return order;
    if (Date.now() + 2000 > deadline) throw new Error(`order ${orderId} still ${order.state}`);
    await sleep(2000);
  }
}

/** Codes proving nothing was sent: resending with the SAME idempotency key is safe. */
const NOTHING_SENT = ["SEND_FAILED", "ACCOUNT_NOT_READY", "NO_RUNTIME", "IDEMPOTENCY_IN_FLIGHT", "RATE_LIMITED"];

/**
 * Sends a trading request, retrying with the same idempotency key only when nothing was sent.
 * Never retries ORDER_UNRESOLVED (the order may be live) or ORDER_REJECTED (needs a new key).
 */
export async function withSafeRetry<T>(send: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      const retry = err instanceof FxapisError && NOTHING_SENT.includes(err.code) && attempt < attempts;
      if (!retry) throw err;
      await sleep(1000 * attempt);
    }
  }
}

/** The order id an error refers to (details[0].orderId), e.g. for ORDER_UNRESOLVED. */
export function orderIdOf(err: FxapisError): string | undefined {
  const detail = Array.isArray(err.details) ? (err.details[0] as { orderId?: string } | undefined) : undefined;
  return detail?.orderId;
}
