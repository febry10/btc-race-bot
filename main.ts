// Dip-buying bot for the cbBTC bars-replay race (agent-fun/bars-replay/v1).
//
// Idea: on 1-minute bars a full round trip costs roughly 30-40 bps in fees,
// slippage and pool impact at full size, so small wiggles are untradable.
// What does pay is a genuine dislocation: when the close falls a full 1%
// below its 24-bar EMA, the move has usually overshot, and this market's
// deep dips have tended to recover over the following hours. The bot waits
// flat for that dip, buys it with all its cash, and holds for a 2.5%
// recovery, with a 1.5% stop in case the dip turns into a cascade.
//
//   - Entry: flat, past the EMA warm-up, and the latest close is at least
//     DIP_BPS below the EMA of closes. One batch, one buy order for the
//     whole cash balance, slippage left wide open (the fill is next bar's
//     open whatever we bid, the cap only rejects fills).
//   - Exit: the close reaches TARGET_BPS above the entry reference (the
//     close of the batch that decided the buy), or STOP_BPS below it; sell
//     everything. After an exit the bot is flat and watches for the next
//     dip, so a window with several dislocations gives several round trips.
//   - Fallback: if no dip trade has happened by bar FALLBACK_SEQ (a smooth
//     uptrend has no 1% dips), buy once anyway so the entry still trades,
//     and manage it with a tighter +/-FALLBACK_BPS band. On the dev window
//     the crash triggers the dip entry early, so this never fires there;
//     it exists for calmer windows, where some participation beats none.
//
// Deterministic: the only inputs are the bars and the account the harness
// sends. No clock, no randomness, no files, no network. All comparisons
// are integer (bigint) arithmetic on the scaled prices, so two runs on
// the same data produce byte-identical orders.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const EMA_N = 24; // EMA length in bars
const DIP_BPS = 100; // entry: close at least this far below the EMA
const TARGET_BPS = 250; // exit: close this far above the entry reference
const STOP_BPS = 150; // exit: close this far below the entry reference
const FALLBACK_SEQ = 1200; // if still tradeless here, buy once anyway
const FALLBACK_BPS = 150; // the fallback position's exit band, both ways
const WIDE_OPEN = 10_000; // max_slippage_bps: never reject a fill

let symbol = '';
/** EMA of closes as a scaled bigint (same scale as the bar prices), null before the first bar. */
let ema: bigint | null = null;
/** Batches seen so far, warm-up included: the index of the current bar. */
let bar = -1;
/** The close that decided the current position's buy, null while flat. */
let entryRef: bigint | null = null;
/** True while the held position is the fallback one (tighter exit band). */
let entryIsFallback = false;
/** Whether any buy of ours has ever been decided this run. */
let everBought = false;

function onHello(state: BarsState): void {
  symbol = state.hello.symbols[0]!.symbol;
}

/** Dip test with integer math: close * 10000 < ema * (10000 - DIP_BPS). */
function isDip(close: bigint, emaNow: bigint): boolean {
  return close * 10_000n < emaNow * BigInt(10_000 - DIP_BPS);
}

/** Signed gain of `close` against the entry reference, in bps (truncated). */
function gainBps(close: bigint, ref: bigint): bigint {
  return (close * 10_000n) / ref - 10_000n;
}

function onBatch(state: BarsState): OrderInput[] {
  bar++;
  const close = state.close(symbol);
  if (close === null) return [];
  // Fold this bar's close into the EMA before deciding, as backtests did.
  ema = ema === null ? close : ema + (2n * (close - ema)) / BigInt(EMA_N + 1);
  if (state.warmingUp) return [];

  const held = state.positions.get(symbol);
  if (held !== undefined && held.qty > 0n) {
    if (entryRef === null) entryRef = close; // defensive: never lose the reference
    const gain = gainBps(close, entryRef);
    const target = entryIsFallback ? BigInt(FALLBACK_BPS) : BigInt(TARGET_BPS);
    const stop = entryIsFallback ? BigInt(FALLBACK_BPS) : BigInt(STOP_BPS);
    if (gain >= target || gain <= -stop) {
      entryRef = null;
      entryIsFallback = false;
      return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: WIDE_OPEN }];
    }
    return [];
  }

  // Flat: the dip is the entry, but only once the EMA has real history.
  if (bar > EMA_N && isDip(close, ema) && state.cash > 0n) {
    entryRef = close;
    entryIsFallback = false;
    everBought = true;
    return [{ side: 'buy', symbol, notional_quote_units: state.cash, max_slippage_bps: WIDE_OPEN }];
  }

  // Fallback: late in the window and still tradeless — take one position
  // so the entry trades at all, managed on the tighter band.
  if (bar >= FALLBACK_SEQ && !everBought && state.cash > 0n) {
    entryRef = close;
    entryIsFallback = true;
    everBought = true;
    return [{ side: 'buy', symbol, notional_quote_units: state.cash, max_slippage_bps: WIDE_OPEN }];
  }

  return [];
}

await runBars({ onHello, onBatch });
