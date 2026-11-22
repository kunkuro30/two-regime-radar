// The two-regime token radar model: one sealed snapshot in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds
// launch candidates below the floor, ranked by an implied value the model states: pre-token
// protocols that pass the same screen the watchlist rule draws (no wrapped, staked or bridged
// products, no versioned clones, no exchange products — see isLaunchCandidate). A protocol is
// pre-token when the snapshot records no token for it (no market cap, no CoinGecko id, no symbol).
// The snapshot's live-token protocols are the peer set the model learns from, never board rows.
//
// Two regimes, two peer groups, two fits. A protocol's regime is the sign of its seven-day TVL
// move: momentum when the move is positive, mean-reversion when it is flat or negative. Each
// regime is priced by the launch-type tokens that trade today in that same state:
//
//   peers     = protocols with a market cap, minus the wrapper categories (Bridge, Canonical
//               Bridge, Liquid Staking, Liquid Restaking, Restaked BTC, CEX), whose market caps
//               price an underlying asset rather than a launch of their own
//   multiple  = the regime's category median of mcap / TVL, shrunk toward the regime median
//               by the category's peer count (shrink weight SHRINK_K)
//   implied   = TVL x multiple x exp(intercept[regime] + b1 x (log TVL - mean log TVL) + b2 x age years)
//
// The category multiples and the intercept are fitted per regime; the size and age slopes are
// pooled across regimes, because one regime's peer group is small (11 of 94 on this snapshot)
// and a slope fitted on 11 points would be noise wearing a uniform. The regression is fit on
// log residuals by iteratively reweighted least squares (Huber weights), so one wild peer
// cannot bend the board. The pure empirical baseline the model must beat is implied = TVL x
// the peer set's global median mcap / TVL, no features at all; lib/validate.ts grades both on
// leave-one-out and on a time split, and prints a negative control (each protocol priced by
// the other regime's multiples and intercept) beside them.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {}

/** The model's version label: the dashboard names it and the dossier quotes it. */
export const MODEL_VERSION = 'regime-radar-1';

/** Categories whose tokens price an underlying asset, set aside from the peer set. */
export const WRAPPER_CATEGORIES: ReadonlySet<string> = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Shrink weight: a category's median counts this many peers toward the regime median. */
export const SHRINK_K = 4;

/** How many board rows the radar carries before the watchlist union, by implied value. */
export const BOARD_TOP = 220;

/** How many live-token protocols the dashboard's reference strip carries, by market cap. */
export const LIVE_ROWS = 24;

/** The two regimes, named as the dashboard names them. */
export type Regime = 'momentum' | 'reversion';

/** Whole days between the snapshot's as-of date and a protocol's listing day, or null. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86_400_000);
}

/** True when the snapshot records no token for the protocol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null && p.mcap_usd === null;
}

const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * A launch candidate: a pre-token protocol that also passes the screen the house's own
 * watchlist rule draws — not a wrapped, staked or bridged product of a token that already
 * trades (the wrapper categories, or a name carrying wrapped/staked/staking), not a
 * versioned clone of one, and not an exchange's own product. WBTC records no token in the
 * snapshot, but it is Bitcoin on Ethereum, not a launch still to come, and a radar that
 * ranks it as one has misread its own data.
 */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (WRAPPER_CATEGORIES.has(p.category ?? '')) return false;
  if (VERSION_MARKER.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  return !EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x));
}

/** The regime a protocol is priced in: the sign of its seven-day TVL move. */
export function regimeOf(p: SnapshotProtocol): Regime {
  return (p.change_7d ?? 0) > 0 ? 'momentum' : 'reversion';
}

/** The peer set: live tokens whose market cap can price a launch, wrappers set aside. */
export function peerPool(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && !WRAPPER_CATEGORIES.has(p.category ?? ''),
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Solve a small linear system by Gaussian elimination with partial pivoting. */
function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    const tmp = m[col]!;
    m[col] = m[piv]!;
    m[piv] = tmp;
    for (let r = col + 1; r < n; r++) {
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c] = m[r]![c]! - f * m[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = m[i]![n]!;
    for (let j = i + 1; j < n; j++) s -= m[i]![j]! * x[j]!;
    x[i] = s / m[i]![i]!;
  }
  return x;
}

/** Weighted least squares through the normal equations, with a whisper of ridge. */
function wls(x: number[][], y: number[], w: number[]): number[] {
  const n = x[0]!.length;
  const a: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  for (let k = 0; k < x.length; k++) {
    for (let i = 0; i < n; i++) {
      b[i]! += w[k]! * x[k]![i]! * y[k]!;
      for (let j = 0; j < n; j++) a[i]![j]! += w[k]! * x[k]![i]! * x[k]![j]!;
    }
  }
  for (let i = 0; i < n; i++) a[i]![i]! += 1e-8;
  return solveLinear(a, b);
}

/** Robust regression: least squares, then three Huber reweighting passes. */
function irls(x: number[][], y: number[]): number[] {
  let beta = wls(x, y, x.map(() => 1));
  for (let iter = 0; iter < 3; iter++) {
    const residuals = x.map((row, k) => y[k]! - row.reduce((s, v, j) => s + v * beta[j]!, 0));
    const scale = median(residuals.map((r) => Math.abs(r))) * 1.4826 + 1e-9;
    const w = residuals.map((r) => (Math.abs(r) <= 1.345 * scale ? 1 : (1.345 * scale) / Math.abs(r)));
    beta = wls(x, y, w);
  }
  return beta;
}

/** One regime's fitted pricing: its own category multiples and intercept. */
export interface RegimeFit {
  regime: Regime;
  /** Peers in this regime (the other regime's count may be much larger). */
  peerCount: number;
  /** Category -> shrunk median of mcap / TVL among this regime's peers. */
  multiples: Map<string, number>;
  /** The regime's own median ratio, for categories with no peer in this regime. */
  fallbackMultiple: number;
  /** This regime's intercept in the pooled size/age regression. */
  intercept: number;
}

/** The whole fitted model, everything the dashboard needs to recompute a row. */
export interface FittedModel {
  version: string;
  peerCount: number;
  /** The pure empirical baseline's single number: the peer set's median mcap / TVL. */
  globalMedianRatio: number;
  /** Age in years imputed where a protocol's listing day is unreported. */
  medianAgeYears: number;
  /** Mean log TVL across the peer set, the regression's centre. */
  meanLogTvl: number;
  /** Pooled slopes: on centred log TVL, and per year of age. */
  sizeSlope: number;
  ageSlope: number;
  regimes: Record<Regime, RegimeFit>;
}

function categoryOf(p: SnapshotProtocol): string {
  return p.category ?? 'Uncategorized';
}

function ageYears(p: SnapshotProtocol, asOf: string, fallback: number): number {
  const days = ageDays(asOf, p.listed_at);
  return days === null ? fallback : days / 365.25;
}

/** One regime's shrunk category multiples, fitted on that regime's peers alone. */
function fitMultiples(regime: Regime, peers: SnapshotProtocol[]): { multiples: Map<string, number>; fallbackMultiple: number; peerCount: number } {
  const own = peers.filter((p) => regimeOf(p) === regime);
  const rows = own.length > 0 ? own : peers;
  const regimeMedian = median(rows.map((p) => p.mcap_usd! / p.tvl_usd));
  const byCategory = new Map<string, number[]>();
  for (const p of rows) {
    const key = categoryOf(p);
    const list = byCategory.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    byCategory.set(key, list);
  }
  const multiples = new Map<string, number>();
  for (const key of [...byCategory.keys()].sort()) {
    const list = byCategory.get(key)!;
    const shrunk = Math.exp((list.length * Math.log(median(list)) + SHRINK_K * Math.log(regimeMedian)) / (list.length + SHRINK_K));
    multiples.set(key, shrunk);
  }
  return { multiples, fallbackMultiple: regimeMedian, peerCount: rows.length };
}

/** Fit both regimes on the snapshot's peer set. Deterministic: no clock, no randomness. */
export function fitModel(snapshot: Snapshot): FittedModel {
  return fitModelOnPeers(peerPool(snapshot), snapshot.as_of);
}

/** Fit both regimes on an explicit peer list (the validation and refit code resamples it). */
export function fitModelOnPeers(peers: SnapshotProtocol[], asOf: string): FittedModel {
  const knownAges = peers.map((p) => ageDays(asOf, p.listed_at)).filter((d): d is number => d !== null);
  const medianAge = median(knownAges) / 365.25;
  const mom = fitMultiples('momentum', peers);
  const rev = fitMultiples('reversion', peers);
  const meanLogTvl = mean(peers.map((p) => Math.log(p.tvl_usd)));
  // One pooled robust regression: a separate intercept per regime, shared size/age slopes.
  const x: number[][] = [];
  const y: number[] = [];
  for (const p of peers) {
    const regime = regimeOf(p);
    const fit = regime === 'momentum' ? mom : rev;
    const mult = fit.multiples.get(categoryOf(p)) ?? fit.fallbackMultiple;
    x.push([regime === 'momentum' ? 1 : 0, regime === 'reversion' ? 1 : 0, Math.log(p.tvl_usd) - meanLogTvl, ageYears(p, asOf, medianAge)]);
    y.push(Math.log(p.mcap_usd! / (p.tvl_usd * mult)));
  }
  const beta = irls(x, y);
  return {
    version: MODEL_VERSION,
    peerCount: peers.length,
    globalMedianRatio: median(peers.map((p) => p.mcap_usd! / p.tvl_usd)),
    medianAgeYears: medianAge,
    meanLogTvl,
    sizeSlope: beta[2]!,
    ageSlope: beta[3]!,
    regimes: {
      momentum: { regime: 'momentum', peerCount: mom.peerCount, multiples: mom.multiples, fallbackMultiple: mom.fallbackMultiple, intercept: beta[0]! },
      reversion: { regime: 'reversion', peerCount: rev.peerCount, multiples: rev.multiples, fallbackMultiple: rev.fallbackMultiple, intercept: beta[1]! },
    },
  };
}

/** The pieces of one implied value, so the dashboard can show the arithmetic. */
export interface ImpliedParts {
  implied: number;
  regime: Regime;
  categoryMultiple: number;
  adjustment: number;
}

/** Price one pre-token protocol under the fitted model (or the other regime, for the control). */
export function impliedOf(model: FittedModel, p: SnapshotProtocol, asOf: string, override?: Regime): ImpliedParts {
  const regime = override ?? regimeOf(p);
  const fit = model.regimes[regime];
  const mult = fit.multiples.get(categoryOf(p)) ?? fit.fallbackMultiple;
  const age = ageYears(p, asOf, model.medianAgeYears);
  const adj = Math.exp(fit.intercept + model.sizeSlope * (Math.log(p.tvl_usd) - model.meanLogTvl) + model.ageSlope * age);
  return { implied: Math.max(1, Math.round(p.tvl_usd * mult * adj)), regime, categoryMultiple: mult, adjustment: adj };
}

/** The pure empirical baseline's implied value: TVL times one median, nothing else. */
export function baselineOf(model: FittedModel, p: SnapshotProtocol): number {
  return Math.max(1, Math.round(p.tvl_usd * model.globalMedianRatio));
}

// ---------------------------------------------------------------------------
// Farm plans. One generator for board.json and the dashboard alike: category,
// chain, TVL tier and age decide the action, the capital, the hold and every
// cost and time. No protocol name is ever special-cased.
// ---------------------------------------------------------------------------

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(tvl: number): number {
  if (tvl >= 5e9) return 250;
  if (tvl >= 1e9) return 150;
  if (tvl >= 1e8) return 100;
  if (tvl >= 1e7) return 50;
  return 25;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

type Playbook = 'lending' | 'trading' | 'bridge' | 'staking' | 'vault' | 'rwa' | 'exchange' | 'play' | 'generic';

function playbookOf(p: SnapshotProtocol): Playbook {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'lending';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('staking') || c.includes('restaking')) return 'staking';
  if (c.includes('dex') || c.includes('derivat') || c.includes('option') || c.includes('perpetual')) return 'trading';
  if (c.includes('yield') || c.includes('aggregator') || c.includes('allocator') || c.includes('curator')) return 'vault';
  if (c.includes('rwa') || c.includes('real world')) return 'rwa';
  if (c === 'cex' || c.includes('exchange')) return 'exchange';
  if (c.includes('nft') || c.includes('gaming') || c.includes('game')) return 'play';
  return 'generic';
}

/** Five concrete steps per protocol, each carrying its cost and its time. */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const name = p.name;
  const keep = `Keep the ${name} position open for ${hold} days and check it once a week. Cost: $0 beyond the opening gas. Time: 5 minutes a week.`;
  const record = `Log every ${name} transaction hash and a balance screenshot in a dated farm diary. Cost: $0. Time: 5 minutes a week, and it is your proof of early activity if a snapshot is ever announced.`;
  const review = `On day ${hold}, review ${name}: if no token or points program has appeared, withdraw and pay the exit gas. Cost: about $4 in gas on ${chain}. Time: 15 minutes.`;
  switch (playbookOf(p)) {
    case 'lending':
      return [
        `Supply $${capital} of USDC as collateral to ${name} on ${chain} and leave it supplied. Cost: about $6 in gas. Time: 10 minutes.`,
        `Borrow about $${Math.round(capital / 3)} of USDC against the collateral, repay it within the hour, and repeat the loop twice more this week. Cost: about $9 in gas across the loops. Time: 30 minutes.`,
        keep,
        record,
        review,
      ];
    case 'trading':
      return [
        `Swap $${capital} of USDC into ETH and back on ${name} on ${chain}, in two separate sessions a day apart. Cost: about $8 in gas and slippage. Time: 20 minutes in all.`,
        `Add $${capital} of two-sided liquidity to ${name}'s busiest pool and leave the position open. Cost: about $5 in gas. Time: 10 minutes.`,
        keep,
        record,
        review,
      ];
    case 'bridge':
      return [
        `Bridge $${capital} of USDC from Ethereum to ${chain} through ${name}. Cost: about $7 in bridge and gas fees. Time: 15 minutes including the wait for finality.`,
        `Use the bridged funds in one ${chain} app the same day (a swap or a supply), so the trip reads as use, not a pass-through. Cost: about $4 in gas. Time: 10 minutes.`,
        `Repeat the bridge run once a week for ${Math.min(hold, 28)} days, alternating direction. Cost: about $7 a run. Time: 15 minutes a run.`,
        record,
        review,
      ];
    case 'staking':
      return [
        `Stake $${capital} of ETH through ${name} on ${chain} and hold the receipt token in the same wallet. Cost: about $6 in gas. Time: 10 minutes.`,
        `Use the receipt token once in a ${chain} lending market or pool, so the position counts as activity in two places. Cost: about $5 in gas. Time: 10 minutes.`,
        keep,
        record,
        review,
      ];
    case 'vault':
      return [
        `Deposit $${capital} of USDC into ${name}'s main vault on ${chain} and hold the vault shares. Cost: about $5 in gas. Time: 10 minutes.`,
        `Split a second $${Math.round(capital / 2)} across one more ${name} vault or strategy, so your activity is not a single deposit. Cost: about $5 in gas. Time: 10 minutes.`,
        keep,
        record,
        review,
      ];
    case 'rwa':
      return [
        `Complete ${name}'s onboarding or KYC if it asks for one, then buy $${capital} of its smallest tokenised asset on ${chain}. Cost: about $6 in gas plus any onboarding fee shown before you sign. Time: 25 minutes.`,
        `Hold the asset and claim or reinvest any yield it pays out during the hold. Cost: about $3 in gas a claim. Time: 5 minutes a claim.`,
        keep,
        record,
        review,
      ];
    case 'exchange':
      return [
        `Open an account at ${name}, pass its verification, and deposit $${capital} of USDC. Cost: $0 to deposit on most rails. Time: 20 minutes including verification.`,
        `Make two spot trades a week (USDC into BTC or ETH and back) for ${Math.min(hold, 28)} days, so the account shows real use. Cost: about $${Math.max(1, Math.round(capital * 0.02))} in trading fees across the month. Time: 5 minutes a trade.`,
        `Keep a small balance (about $${Math.round(capital / 5)}) on the exchange for the whole ${hold} days rather than withdrawing after each trade. Cost: $0. Time: none, it sits.`,
        record,
        review,
      ];
    case 'play':
      return [
        `Create a ${name} account, connect the wallet you farm with, and finish its opening quest or first mint on ${chain}. Cost: about $4 in gas. Time: 20 minutes.`,
        `Play or mint once a week for ${Math.min(hold, 28)} days; steady weekly activity is what these snapshots usually count. Cost: about $3 in gas a session. Time: 15 minutes a session.`,
        keep,
        record,
        review,
      ];
    default:
      return [
        `Use ${name}'s core feature on ${chain} with $${capital} of USDC (a deposit, a swap or a stake, whichever it offers first). Cost: about $6 in gas. Time: 15 minutes.`,
        `Repeat the core action once a week for ${Math.min(hold, 28)} days, varying the amount slightly each time. Cost: about $5 in gas a session. Time: 10 minutes a session.`,
        keep,
        record,
        review,
      ];
  }
}

// ---------------------------------------------------------------------------
// The board.
// ---------------------------------------------------------------------------

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  regime: Regime;
  watchlist: boolean;
  implied_value_usd: number;
  rank_lo: number;
  rank_hi: number;
  model: { category_multiple: number; adjustment: number };
  farm_steps: string[];
}

/** Build the ranked board: top rows by implied value, unioned with the whole watchlist. */
export function buildBoard(snapshot: Snapshot, model: FittedModel): BoardRow[] {
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isLaunchCandidate)
    .map((p) => ({ p, parts: impliedOf(model, p, snapshot.as_of) }))
    .sort((a, b) => b.parts.implied - a.parts.implied || (a.p.slug < b.p.slug ? -1 : 1));
  const chosen = new Map<string, (typeof scored)[number]>();
  for (const s of scored.slice(0, BOARD_TOP)) chosen.set(s.p.slug, s);
  for (const s of scored) if (watch.has(s.p.slug)) chosen.set(s.p.slug, s);
  const rows = [...chosen.values()].sort((a, b) => b.parts.implied - a.parts.implied || (a.p.slug < b.p.slug ? -1 : 1));
  return rows.map((s, i) => {
    const age = ageDays(snapshot.as_of, s.p.listed_at);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: null,
      listed_at: s.p.listed_at,
      gecko_id: null,
      symbol: null,
      token_status: 'pre-token',
      age_days: age,
      regime: s.parts.regime,
      watchlist: watch.has(s.p.slug),
      implied_value_usd: s.parts.implied,
      rank_lo: i + 1,
      rank_hi: i + 1,
      model: { category_multiple: s.parts.categoryMultiple, adjustment: s.parts.adjustment },
      farm_steps: farmSteps(s.p, age),
    };
  });
}

/** The first gate failure in a board, or null when the board is gate-clean. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'a slug appears twice';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `row names an invented slug: ${r.slug}`;
  for (const slug of snapshot.watchlist) if (!slugs.has(slug)) return `watchlist slug missing from the board: ${slug}`;
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (r.rank !== i + 1) return `rank ${r.rank} out of place at row ${i}`;
    if (i > 0 && board[i - 1]!.implied_value_usd < r.implied_value_usd) return 'implied value rises as rank ascends';
    if (!(r.implied_value_usd > 0)) return `implied value not positive at ${r.slug}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `farm_steps count ${r.farm_steps.length} at ${r.slug}`;
    for (const step of r.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `farm step of ${len} chars at ${r.slug}`;
    }
  }
  if (board.length >= 2 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) return 'every implied value is the same';
  return null;
}

/** Parse and lightly validate the sealed snapshot text. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot is not JSON');
  }
  const doc = raw as Partial<Snapshot>;
  if (typeof doc.as_of !== 'string' || typeof doc.floor_usd !== 'number' || !Array.isArray(doc.protocols) || !Array.isArray(doc.watchlist)) {
    throw new SnapshotError('snapshot is missing as_of, floor_usd, protocols or watchlist');
  }
  for (const p of doc.protocols) {
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Array.isArray(p.chains)) {
      throw new SnapshotError(`protocol entry is malformed at ${String((p as SnapshotProtocol).slug)}`);
    }
  }
  return doc as Snapshot;
}
