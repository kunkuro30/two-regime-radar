// Two-Regime Radar (token-radar-01 entry, Node 22, standard library only).
//
// Reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), fits the
// two-regime model in lib/model.ts on the snapshot's own peer set, grades that model with
// lib/validate.ts, writes the ranked board to /output/board.json and the dashboard's data
// to /output/data.js, copies dashboard/ and screenshots/ to /output, and writes
// /output/dossier.json last with the vendored make.fun library.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// The run is deterministic: no clock reads (ages count from the snapshot's own as_of),
// no unseeded randomness (the refits use a fixed seed), no network.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_ROWS,
  MODEL_VERSION,
  ageDays,
  boardIssue,
  buildBoard,
  fitModel,
  isLaunchCandidate,
  isPreToken,
  parseSnapshot,
  type RegimeFit,
  type Snapshot,
} from './lib/model.ts';
import { bootstrapRanks, validateModel } from './lib/validate.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes the dossier, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`two-regime radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot: Snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const model = fitModel(snapshot);
const validation = validateModel(snapshot, model);
let board = buildBoard(snapshot, model);
const ranges = bootstrapRanks(snapshot, board);
board = board.map((r) => {
  const range = ranges.get(r.slug);
  return range === undefined ? r : { ...r, rank_lo: range[0], rank_hi: range[1] };
});
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`two-regime radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

function regimeJson(fit: RegimeFit): Record<string, unknown> {
  return {
    peer_count: fit.peerCount,
    fallback_multiple: fit.fallbackMultiple,
    intercept: fit.intercept,
    multiples: Object.fromEntries([...fit.multiples.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
  };
}

const live = snapshot.protocols
  .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0)
  .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1))
  .slice(0, LIVE_ROWS)
  .map((p) => ({
    name: p.name,
    symbol: p.symbol,
    category: p.category,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd!,
    ratio: p.tvl_usd > 0 ? p.mcap_usd! / p.tvl_usd : null,
  }));

const radar = {
  version: MODEL_VERSION,
  as_of: snapshot.as_of,
  source: snapshot.source,
  floor_usd: snapshot.floor_usd,
  counts: {
    protocols: snapshot.protocols.length,
    peers: model.peerCount,
    pretoken: snapshot.protocols.filter(isPreToken).length,
    candidates: snapshot.protocols.filter(isLaunchCandidate).length,
    watchlist: snapshot.watchlist.length,
    board: board.length,
  },
  model: {
    global_median_ratio: model.globalMedianRatio,
    median_age_years: model.medianAgeYears,
    mean_log_tvl: model.meanLogTvl,
    size_slope: model.sizeSlope,
    age_slope: model.ageSlope,
    regimes: { momentum: regimeJson(model.regimes.momentum), reversion: regimeJson(model.regimes.reversion) },
  },
  validation,
  rows: board.map((r) => ({
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    age_days: r.age_days,
    listed_at: r.listed_at,
    regime: r.regime,
    watchlist: r.watchlist,
    implied_value_usd: r.implied_value_usd,
    rank_lo: r.rank_lo,
    rank_hi: r.rank_hi,
    multiple: r.model.category_multiple,
    adjustment: r.model.adjustment,
    farm_steps: r.farm_steps,
  })),
  live,
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), `window.RADAR = ${JSON.stringify(radar)};\n`);

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`two-regime radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`two-regime radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const v = validation;
process.stdout.write(
  `two-regime radar: ${snapshot.protocols.length} protocols, ${model.peerCount} peers, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows ranked\n` +
    `two-regime radar: leave-one-out error ${v.loo.regime} vs baseline ${v.loo.base} vs regime-swapped ${v.loo.neg}; time split ${v.time.regime} vs baseline ${v.time.base}; worst miss ${v.loo.worst.name} x${v.loo.worst.factor}\n` +
    `two-regime radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
