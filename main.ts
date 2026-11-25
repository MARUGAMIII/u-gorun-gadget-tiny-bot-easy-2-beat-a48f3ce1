// "Dip-Catcher" — a long-only hourly mean-reversion bot for agent-fun/bars-replay/v1.
//
// Own design, written from scratch for this competition. The final window
// is only 72 hourly bars, so the bot does not try to out-hold buy-and-hold:
// it buys sharp dips and banks the bounce, and otherwise sits in cash.
//
// Per symbol it keeps an EMA(18) of log closes (seeded as the mean of its
// first 18 closes, then 2/19 of the way to each new close). The gap
// z = log(close) - log(EMA18) measures how far price has stretched below
// its own recent mean.
//
// Entry (flat, not warming up): z <= -2% — the symbol is 2% under its
// 18-hour mean. No other filter: in a 3-day window a dip that deep is the
// signal, and waiting for a "turning up" bar costs the bounce.
//
// Exit (holding), whole position, whichever comes first:
//   - recovered to the mean: z >= 0 (the bounce did its job), or
//   - take profit: value 5% over cost, or
//   - trailing stop: value 2% under the best value seen since entry, or
//   - hard stop: value 5% under cost (a dip that keeps falling is not a
//     bargain, it is a knife), or
//   - stale: 24 bars held without recovering (capital is better used on
//     the next dip).
//
// Sizing: one equal slice of equity per symbol (equity / universe size),
// capped by the 25% per-symbol weight cap and by the cash on hand; sells
// go out before buys, at most the harness's per-bar order cap. Slippage
// is capped at 100 bps past the close the decision was made on, so an
// order into a liquidity gap is refused and retried next bar instead of
// filled for almost nothing. No clock, no environment, no randomness:
// the same bars always give the same orders.
//
// The entrypoint runs under `node /bot/main.ts`; vendor/makefun-bars.ts
// is the kit SDK copied unchanged.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const EMA_SPAN = 18;
/** Entry: log(close) at least 2% under the EMA(18) of log closes. */
const DIP = 0.02;
/** Exit: back at or above the mean. */
const MEAN = 0;
/** Take profit: value 5% over cost. */
const TAKE = [105n, 100n] as const;
/** Trailing stop: value 2% under its peak since entry. */
const TRAIL = [98n, 100n] as const;
/** Hard stop: value 5% under cost. */
const STOP = [95n, 100n] as const;
/** Stale: give up after 24 bars without recovering. */
const MAX_HOLD_BARS = 24;
const MAX_SLIPPAGE_BPS = 100;

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  ema: Ema;
  /** Log closes, newest last. */
  logCloses: number[];
  /** Best (highest) position value seen since the current entry, in quote units. */
  peak: bigint;
  /** Batch seq the current position was decided on (its fill lands one bar later). */
  entrySeq: number;
}

const series = new Map<string, Series>();

function stepEma(e: Ema, x: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (x - e.value);
    return;
  }
  e.warm.push(x);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, v) => a + v, 0) / e.span;
}

function freshSeries(): Series {
  return { ema: { span: EMA_SPAN, warm: [], value: null }, logCloses: [], peak: 0n, entrySeq: -1 };
}

/** Fold one bar in. Returns the dip gap z, or null while the EMA is seeding. */
function push(bar: Bar): number | null {
  let s = series.get(bar.symbol);
  if (s === undefined) series.set(bar.symbol, (s = freshSeries()));
  const c = Number(bar.c);
  if (c <= 0) return null;
  const lc = Math.log(c);
  s.logCloses.push(lc);
  stepEma(s.ema, lc);
  return s.ema.value === null ? null : lc - s.ema.value;
}

/** Whether a held position exits on this close. */
function exits(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, s: Series, z: number | null): boolean {
  const value = state.value(symbol, held.qty);
  if (value > s.peak) s.peak = value;
  if (z !== null && z >= MEAN) return true;
  if (value * TAKE[1] >= held.cost * TAKE[0]) return true;
  if (value * TRAIL[1] <= s.peak * TRAIL[0]) return true;
  if (value * STOP[1] <= held.cost * STOP[0]) return true;
  if (s.entrySeq >= 0 && state.seq - s.entrySeq >= MAX_HOLD_BARS) return true;
  return false;
}

await runBars({
  onBatch(state, batch) {
    const gaps = new Map<string, number | null>();
    for (const bar of batch.bars) gaps.set(bar.symbol, push(bar));
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!gaps.has(symbol)) continue;
      const s = series.get(symbol)!;
      const z = gaps.get(symbol)!;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (exits(state, symbol, held, s, z)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          s.peak = 0n;
          s.entrySeq = -1;
        }
      } else if (z !== null && z <= -DIP) {
        entries.push(symbol);
        s.peak = 0n;
        s.entrySeq = state.seq;
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
