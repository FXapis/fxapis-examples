// A minimal MT5 copy trader with the fxapis MetaTrader 5 API.
//
// Watches a master account's deals and mirrors them onto follower accounts:
//  - a master deal that OPENS a position (entry "in") becomes one multi-account
//    order on every follower (POST /v1/execution-waves);
//  - a deal that CLOSES a master position (entry "out") closes the followers' copies.
//
// There are no event webhooks yet, so this polls: every few seconds it asks
// fxapis to refresh the master from the broker (reconcile) and reads new deals.
// Every copy carries an idempotency key made from the master deal, so a restart
// or retry never copies the same deal twice (keys are honoured for 24 hours;
// the state file covers longer gaps).
//
//   export FXAPIS_API_KEY=fx_test_...
//   export MASTER_ACCOUNT_ID=<id> FOLLOWER_ACCOUNT_IDS=<id>,<id>,...
//   export VOLUME_MULTIPLIER=1.0      # follower lots = master lots x multiplier
//   node copy-trader.ts
//
// Simplifications, on purpose: only buys and sells are copied; a partial close
// of the master is logged, not mirrored; the master's stops are not copied.
// Use broker DEMO accounts while you try it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Fxapis, FxapisError } from "fxapis";
import { env, waitUntilReady, waitUntilResolved } from "./helpers.ts";

type Deal = {
  accountId: string;
  brokerDealId: string;
  brokerPositionId: string | null;
  symbol: string;
  dealType: string; // "buy" | "sell" | "balance" | ...
  entry: string | null; // "in" | "out" | "inout" | "out_by"
  volume: string | null;
  dealtAt: string;
};
type State = { since: string; seen: string[]; copies: Record<string, Record<string, string>> };

const POLL_MS = Number(process.env.POLL_SECONDS ?? "3") * 1000;
const STATE_FILE = process.env.COPY_STATE_FILE ?? "copy-trader-state.json";

const fx = new Fxapis(env("FXAPIS_API_KEY"));
const masterId = env("MASTER_ACCOUNT_ID");
const followers = env("FOLLOWER_ACCOUNT_IDS").split(",").filter(Boolean);
const multiplier = Number(process.env.VOLUME_MULTIPLIER ?? "1");

function loadState(): State {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  return { since: new Date().toISOString(), seen: [], copies: {} }; // first run: copy only from now on
}

function saveState(state: State): void {
  state.seen = state.seen.slice(-5000);
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Lots as a string with two decimals, rounded down, at least 0.01. Never a float in the request. */
function followerVolume(masterVolume: string): string {
  const hundredths = Math.floor(Math.round(Number(masterVolume) * multiplier * 1e6) / 1e4);
  return (Math.max(hundredths, 1) / 100).toFixed(2);
}

async function keepMasterOnline(): Promise<void> {
  try {
    await fx.postAccountsByIdMode(masterId, { mode: "always_on" });
    console.log("master set to always_on");
  } catch (err) {
    if (!(err instanceof FxapisError && err.code === "FEATURE_NOT_IN_PLAN")) throw err;
    console.log("always_on is not in this plan; the master will be warmed whenever it is offline");
  }
  await fx.postAccountsByIdWarm(masterId);
  await waitUntilReady(fx, masterId);
}

async function ensureOnline(): Promise<void> {
  const status = await fx.getAccountsByIdStatus(masterId);
  if (status.state !== "ready" && status.state !== "executing") {
    await fx.postAccountsByIdWarm(masterId);
    await waitUntilReady(fx, masterId);
  }
}

async function newMasterDeals(state: State): Promise<Deal[]> {
  await fx.postAccountsByIdReconcile(masterId); // pulls the broker's latest deals and positions into fxapis
  const seen = new Set(state.seen);
  const fresh: Deal[] = [];
  let cursor: string | undefined;
  do {
    const page = await fx.getAccountsByIdDeals(masterId, { query: { since: state.since, limit: 200, cursor } });
    fresh.push(...(page as Deal[]).filter((d) => !seen.has(d.brokerDealId)));
    cursor = page.page?.hasMore ? page.page.nextCursor : undefined;
  } while (cursor);
  return fresh.sort((a, b) => a.dealtAt.localeCompare(b.dealtAt)); // newest first from the API; copy in order
}

async function copyOpen(deal: Deal, state: State): Promise<void> {
  const key = `copy-open:${deal.brokerDealId}`;
  const created = await fx.postExecutionwaves(
    {
      accountIds: followers,
      symbol: deal.symbol,
      side: deal.dealType === "buy" ? "buy" : "sell",
      volume: followerVolume(deal.volume ?? "0"),
      barrierPolicy: "release-ready", // trade on the followers that are online in time
      clientWaveId: key,
      label: `copy of master deal ${deal.brokerDealId}`,
    },
    { idempotencyKey: key },
  );

  let wave = created;
  while (!["settled", "cancelled", "abandoned"].includes(wave.state)) {
    await sleep(1000);
    wave = await fx.getExecutionwavesById(created.id);
  }
  console.log(`copied ${deal.dealType} ${deal.symbol}: ${wave.state}`, wave.summary, `spread ${wave.dispatchSpreadMs} ms`);

  // Remember which follower position copies which master position, so a close can follow.
  const copies: Record<string, string> = {};
  for (const leg of wave.legs ?? []) {
    if (leg.orderId && (leg.state === "filled" || leg.state === "unresolved")) {
      const order = await waitUntilResolved(fx, leg.orderId); // returns at once when already settled
      if (order.brokerPositionId) copies[leg.accountId] = order.brokerPositionId;
    }
  }
  state.copies[deal.brokerPositionId ?? deal.brokerDealId] = copies;
}

async function copyClose(deal: Deal, state: State): Promise<void> {
  const masterPosition = deal.brokerPositionId ?? "";
  const copies = state.copies[masterPosition];
  if (!copies) return;
  const stillOpen = (await fx.getAccountsByIdPositions(masterId)).some(
    (p: { brokerPositionId: string }) => p.brokerPositionId === masterPosition,
  );
  if (stillOpen) {
    console.log(`master partially closed ${masterPosition}; partial closes are not mirrored in this example`);
    return;
  }
  for (const [followerId, ticket] of Object.entries(copies)) {
    try {
      await fx.postAccountsByIdPositionsByPositionIdClose(followerId, ticket, {}, {
        idempotencyKey: `copy-close:${deal.brokerDealId}:${followerId}`,
      });
      console.log(`closed copy ${ticket} on ${followerId}`);
    } catch (err) {
      // ORDER_UNRESOLVED: never resend — it will resolve. Anything else: report and move on.
      console.warn(`close of ${ticket} on ${followerId}:`, err instanceof FxapisError ? err.code : err);
    }
  }
  delete state.copies[masterPosition];
}

if (followers.length === 0) throw new Error("Set FOLLOWER_ACCOUNT_IDS.");
const state = loadState();
await keepMasterOnline();
// Followers come online for each copy by themselves; preparing them now makes the first copy fast.
await fx.postAccountsPrepare({ accountIds: followers.slice(0, 200) });
console.log(`watching ${masterId} -> ${followers.length} followers (every ${POLL_MS / 1000}s, Ctrl+C to stop)`);

for (;;) {
  try {
    await ensureOnline();
    for (const deal of await newMasterDeals(state)) {
      if (deal.dealType === "buy" || deal.dealType === "sell") {
        if (deal.entry === "in") await copyOpen(deal, state);
        else if (deal.entry === "out" || deal.entry === "out_by") await copyClose(deal, state);
      }
      state.seen.push(deal.brokerDealId);
      state.since = deal.dealtAt;
      saveState(state);
    }
  } catch (err) {
    console.warn("poll failed, will retry:", err instanceof FxapisError ? `${err.code} ${err.message}` : err);
  }
  await sleep(POLL_MS);
}
