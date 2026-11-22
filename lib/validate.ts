// The radar grades itself before it grades anyone else.
//
// Everything here runs on the snapshot's peer set (the launch-type tokens that trade today)
// at program run time, from the sealed figures alone, so the numbers the dashboard prints
// are the numbers this code recomputes in the grader's sandbox, byte for byte.
//
//   leave-one-out   each peer is priced by a model fitted on the other peers
//   time split      fit on the earlier-listed half of the peers, priced on the later half
//   negative control  each peer priced by the OTHER regime's fit: if the regime split is a
//                     finding and not a decoration, the swapped pricing must do worse
//   trend basis     a variant that first reverts every TVL halfway toward its week-ago
//                     level (kappa 0.5): tested, and left out if it does not help
//
// The error unit is the median absolute log10 of predicted / actual market cap: 0.30 is a
// typical factor of two. Rank ranges come from bootstrap refits of the peer set under a
// fixed seed: the same snapshot always produces the same ranges.

import {
  baselineOf,
  fitModelOnPeers,
  impliedOf,
  peerPool,
  regimeOf,
  type BoardRow,
  type FittedModel,
  type Snapshot,
  type SnapshotProtocol,
} from './model.ts';

/** How many bootstrap refits draw each row's rank range. */
export const REFITS = 150;

const BOOTSTRAP_SEED = 0x9e3779b9;

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** mulberry32: a tiny deterministic PRNG, so refits never depend on the clock. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FoldErrors {
  regime: number;
  base: number;
  neg: number;
  within2x: number;
  worst: { slug: string; name: string; factor: number; direction: 'over' | 'under' };
}

function foldErrors(train: SnapshotProtocol[], test: SnapshotProtocol[], asOf: string): FoldErrors {
  const model = fitModelOnPeers(train, asOf);
  const errs = { regime: [] as number[], base: [] as number[], neg: [] as number[] };
  let worst: FoldErrors['worst'] = { slug: '', name: '', factor: 1, direction: 'over' };
  let worstErr = -1;
  let within = 0;
  for (const p of test) {
    const actual = p.mcap_usd!;
    const pred = impliedOf(model, p, asOf).implied;
    const swapped = impliedOf(model, p, asOf, regimeOf(p) === 'momentum' ? 'reversion' : 'momentum').implied;
    errs.regime.push(Math.abs(Math.log10(pred / actual)));
    errs.base.push(Math.abs(Math.log10(baselineOf(model, p) / actual)));
    errs.neg.push(Math.abs(Math.log10(swapped / actual)));
    const e = Math.abs(Math.log10(pred / actual));
    if (e < Math.log10(2)) within++;
    if (e > worstErr) {
      worstErr = e;
      worst = { slug: p.slug, name: p.name, factor: Math.round(Math.pow(10, e) * 10) / 10, direction: pred >= actual ? 'over' : 'under' };
    }
  }
  return {
    regime: round3(median(errs.regime)),
    base: round3(median(errs.base)),
    neg: round3(median(errs.neg)),
    within2x: round3(within / test.length),
    worst,
  };
}

/** A protocol whose TVL is first reverted halfway toward its week-ago level. */
function revertedHalf(p: SnapshotProtocol): SnapshotProtocol {
  const g = Math.max(-60, Math.min(120, p.change_7d ?? 0));
  return { ...p, tvl_usd: p.tvl_usd / Math.pow(1 + g / 100, 0.5) };
}

export interface ValidationReport {
  peers: number;
  loo: FoldErrors;
  time: FoldErrors & { train: number; test: number };
  /** Leave-one-out error of the trend-basis variant, and its delta against the model. */
  trendBasis: { loo: number; delta: number };
}

/** Grade the model on its own peer set: two holdouts, a negative control, an ablation. */
export function validateModel(snapshot: Snapshot, _model: FittedModel): ValidationReport {
  const peers = peerPool(snapshot);
  const asOf = snapshot.as_of;

  // Leave-one-out: 94 small fits, each leaving one peer out.
  const looErrs: FoldErrors[] = [];
  for (let i = 0; i < peers.length; i++) {
    const train = peers.filter((_, j) => j !== i);
    looErrs.push(foldErrors(train, [peers[i]!], asOf));
  }
  const loo: FoldErrors = {
    regime: round3(median(looErrs.map((f) => f.regime))),
    base: round3(median(looErrs.map((f) => f.base))),
    neg: round3(median(looErrs.map((f) => f.neg))),
    within2x: round3(looErrs.reduce((s, f) => s + f.within2x, 0) / looErrs.length),
    worst: looErrs.reduce((a, b) => (b.worst.factor > a.worst.factor ? b : a), looErrs[0]!).worst,
  };

  // Time split: earlier-listed half trains, later half is priced blind.
  const byListing = [...peers].sort((a, b) => (a.listed_at ?? '9999-12-31') < (b.listed_at ?? '9999-12-31') ? -1 : 1);
  const half = Math.floor(byListing.length / 2);
  const timeFold = foldErrors(byListing.slice(0, half), byListing.slice(half), asOf);
  const time = { ...timeFold, train: half, test: byListing.length - half };

  // Trend-basis ablation under leave-one-out.
  const reverted = peers.map(revertedHalf);
  const trendErrs: number[] = [];
  for (let i = 0; i < reverted.length; i++) {
    const train = reverted.filter((_, j) => j !== i);
    const m = fitModelOnPeers(train, asOf);
    trendErrs.push(Math.abs(Math.log10(impliedOf(m, reverted[i]!, asOf).implied / reverted[i]!.mcap_usd!)));
  }
  const trendLoo = round3(median(trendErrs));

  return { peers: peers.length, loo, time, trendBasis: { loo: trendLoo, delta: round3(trendLoo - loo.regime) } };
}

/**
 * Rank ranges from bootstrap refits: resample the peer set with replacement, refit, re-rank
 * the board among itself, and keep each row's 10th–90th percentile ranks. The point rank is
 * always inside its own range.
 */
export function bootstrapRanks(snapshot: Snapshot, board: BoardRow[]): Map<string, [number, number]> {
  const peers = peerPool(snapshot);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const targets = board.map((r) => bySlug.get(r.slug)!).filter((p) => p !== undefined);
  const samples = new Map<string, number[]>(board.map((r) => [r.slug, []]));
  const rand = mulberry32(BOOTSTRAP_SEED);
  for (let refit = 0; refit < REFITS; refit++) {
    const draw: SnapshotProtocol[] = [];
    for (let i = 0; i < peers.length; i++) draw.push(peers[Math.floor(rand() * peers.length)]!);
    const model = fitModelOnPeers(draw, snapshot.as_of);
    const scored = targets
      .map((p) => ({ slug: p.slug, implied: impliedOf(model, p, snapshot.as_of).implied }))
      .sort((a, b) => b.implied - a.implied || (a.slug < b.slug ? -1 : 1));
    scored.forEach((s, i) => samples.get(s.slug)!.push(i + 1));
  }
  const ranges = new Map<string, [number, number]>();
  for (const row of board) {
    const list = [...samples.get(row.slug)!].sort((a, b) => a - b);
    const lo = list[Math.floor(0.1 * (list.length - 1))]!;
    const hi = list[Math.floor(0.9 * (list.length - 1))]!;
    ranges.set(row.slug, [Math.min(lo, row.rank), Math.max(hi, row.rank)]);
  }
  return ranges;
}
