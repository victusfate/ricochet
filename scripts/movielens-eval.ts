#!/usr/bin/env tsx
/**
 * Offline BiasedMF evaluation: synthetic dataset (K=10, 800 users, 1 200 items),
 * 80/20 split. Compares global-mean / item-mean / BiasedMF, verifies downvote
 * filter behaviour, and measures ranking quality (P/R@10, NDCG@10).
 * Usage: npm run eval:movielens
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  DEFAULT_MF_PARAMS,
  newFactorRow,
  zeroFactorRow,
  mfLearnOne,
  mfPredict,
} from '../src/scoring.js';
import type { FactorRow, MfParams } from '../src/scoring.js';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR     = path.join(__dirname, '..', 'data');
const ML100K_DATA  = path.join(DATA_DIR, 'ml-100k', 'u.data');
const ML100K_ITEMS = path.join(DATA_DIR, 'ml-100k', 'u.item');
const SYNTH_FILE   = path.join(DATA_DIR, 'synthetic-ratings.tsv');

// ── Synthetic data generation ─────────────────────────────────────────────────

const N_USERS   = 800;
const N_ITEMS   = 1_200;
const N_FACTORS = 10;       // ground-truth latent dimensions
const DENSITY   = 0.125;    // fraction of (user, item) pairs that have a rating
const NOISE_SD  = 0.4;      // rating noise standard deviation
const RATING_MIN = 1;
const RATING_MAX = 5;

const SEED           = 42;   // conventional reproducibility seed; value is arbitrary
const TRAIN_EPOCHS   = 20;
const N_CANDIDATES   = 500;  // candidate pool for ranking evaluation
const SAMPLE_USERS   = 100;  // users sampled for P/R and filter checks
const LABEL_TRUNCATE = 42;   // max chars for item title display

function randn(): number {
  // Box-Muller
  return Math.sqrt(-2 * Math.log(Math.random() + 1e-10)) *
         Math.cos(2 * Math.PI * Math.random());
}

interface Rating { userId: string; itemId: string; rating: number }

// Numerical Recipes LCG: multiplier 1664525, increment 1013904223, modulus 2^32.
function makeLcg(seed: number): () => number {
  // quality-ok: magic-number — LCG constants from Numerical Recipes; 0xffffffff is 2^32-1 bitmask
  let s = seed; return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
}

function generateDataset(seed = SEED): Rating[] {
  const rng = makeLcg(seed);
  const grng = () => {
    // quality-ok: magic-number — 1e-10 is a numerical stability epsilon preventing log(0)
    const u1 = rng() + 1e-10, u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  // Ground-truth latent vectors (N(0, 0.5))
  const userVec = Array.from({ length: N_USERS },  () =>
    Array.from({ length: N_FACTORS }, () => grng() * 0.5),
  );
  const itemVec = Array.from({ length: N_ITEMS },  () =>
    Array.from({ length: N_FACTORS }, () => grng() * 0.5),
  );
  const userBias = Array.from({ length: N_USERS  }, () => grng() * 0.3);
  const itemBias = Array.from({ length: N_ITEMS  }, () => grng() * 0.3);
  const globalMean = 3.5;

  const ratings: Rating[] = [];
  for (let u = 0; u < N_USERS; u++) {
    for (let i = 0; i < N_ITEMS; i++) {
      if (rng() > DENSITY) continue;
      let score = globalMean + userBias[u] + itemBias[i];
      for (let f = 0; f < N_FACTORS; f++) score += userVec[u][f] * itemVec[i][f];
      score += grng() * NOISE_SD;
      const rating = Math.max(RATING_MIN, Math.min(RATING_MAX, Math.round(score)));
      ratings.push({ userId: `u${u}`, itemId: `i${i}`, rating });
    }
  }
  return ratings;
}

function loadItemTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  if (!fs.existsSync(ML100K_ITEMS)) return titles;
  for (const line of fs.readFileSync(ML100K_ITEMS, 'latin1').trim().split('\n')) {
    const parts = line.split('|');
    if (parts.length >= 2) titles.set(parts[0], parts[1]);
  }
  return titles;
}

function ensureDataset(): { ratings: Rating[]; titles: Map<string, string>; source: string } {
  // Prefer real MovieLens 100K if present
  if (fs.existsSync(ML100K_DATA)) {
    process.stdout.write('Loading MovieLens 100K (u.data)… ');
    const ratings = fs.readFileSync(ML100K_DATA, 'utf8').trim().split('\n').map(line => {
      const [userId, itemId, r] = line.split('\t');
      return { userId, itemId, rating: Number(r) };
    });
    console.log(`${ratings.length.toLocaleString()} ratings loaded`);
    const titles = loadItemTitles();
    return { ratings, titles, source: 'MovieLens 100K' };
  }

  // Fall back to cached synthetic data
  if (fs.existsSync(SYNTH_FILE)) {
    process.stdout.write('Loading cached synthetic dataset… ');
    const ratings = fs.readFileSync(SYNTH_FILE, 'utf8').trim().split('\n').map(line => {
      const [userId, itemId, r] = line.split('\t');
      return { userId, itemId, rating: Number(r) };
    });
    console.log(`${ratings.length.toLocaleString()} ratings loaded`);
    return { ratings, titles: new Map(), source: 'synthetic' };
  }

  // Generate synthetic data
  process.stdout.write('Generating synthetic dataset… ');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const ratings = generateDataset(SEED);
  fs.writeFileSync(SYNTH_FILE, ratings.map(r => `${r.userId}\t${r.itemId}\t${r.rating}`).join('\n'));
  console.log(`${ratings.length.toLocaleString()} ratings written to data/synthetic-ratings.tsv`);
  return { ratings, titles: new Map(), source: 'synthetic' };
}

// ── Train / test split ────────────────────────────────────────────────────────

function splitRandom(ratings: Rating[], trainRatio = 0.8, seed = 7): [Rating[], Rating[]] {
  const arr = [...ratings];
  const rng = makeLcg(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const cut = Math.floor(arr.length * trainRatio);
  return [arr.slice(0, cut), arr.slice(cut)];
}

// ── Model ─────────────────────────────────────────────────────────────────────

interface Model {
  userFactors: Map<string, FactorRow>;
  itemFactors: Map<string, FactorRow>;
  globalMean:  number;
  n:           number;
  params:      MfParams;
}

function createModel(params: MfParams): Model {
  return { userFactors: new Map(), itemFactors: new Map(), globalMean: 0, n: 0, params };
}

function trainModel(trainSet: Rating[], epochs: number, params: MfParams): Model {
  const model = createModel(params);
  const shuffled = [...trainSet];
  const rng = makeLcg(1);

  for (let e = 0; e < epochs; e++) {
    // Fisher-Yates shuffle
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    for (const r of shuffled) {
      const u   = model.userFactors.get(r.userId) ?? newFactorRow(params);
      const i   = model.itemFactors.get(r.itemId) ?? newFactorRow(params);
      const res = mfLearnOne({
        params, globalMean: model.globalMean, n: model.n, user: u, item: i, rating: r.rating,
      });
      model.globalMean = res.globalMean;
      model.n          = res.n;
      model.userFactors.set(r.userId, res.user);
      model.itemFactors.set(r.itemId, res.item);
    }
    if ((e + 1) % 5 === 0 || e + 1 === epochs) {
      console.log(`  epoch ${String(e + 1).padStart(2)}/${epochs}  globalMean=${model.globalMean.toFixed(3)}`);
    }
  }
  return model;
}

function predict(model: Model, userId: string, itemId: string): number {
  const u = model.userFactors.get(userId) ?? zeroFactorRow(model.params);
  const i = model.itemFactors.get(itemId) ?? zeroFactorRow(model.params);
  return mfPredict(model.globalMean, u, i);
}

// ── Metrics ───────────────────────────────────────────────────────────────────

interface Metrics { rmse: number; mae: number; n: number }

function evaluate(model: Model, testSet: Rating[]): Metrics {
  let sumSq = 0, sumAbs = 0;
  for (const r of testSet) {
    const e = r.rating - predict(model, r.userId, r.itemId);
    sumSq  += e * e;
    sumAbs += Math.abs(e);
  }
  return { rmse: Math.sqrt(sumSq / testSet.length), mae: sumAbs / testSet.length, n: testSet.length };
}

function globalMeanMetrics(trainSet: Rating[], testSet: Rating[]): Metrics {
  const mean = trainSet.reduce((s, r) => s + r.rating, 0) / trainSet.length;
  let sumSq = 0, sumAbs = 0;
  for (const r of testSet) {
    const e = r.rating - mean;
    sumSq  += e * e;
    sumAbs += Math.abs(e);
  }
  return { rmse: Math.sqrt(sumSq / testSet.length), mae: sumAbs / testSet.length, n: testSet.length };
}

function itemMeanMetrics(trainSet: Rating[], testSet: Rating[]): Metrics {
  const sums = new Map<string, [number, number]>();
  const gm   = trainSet.reduce((s, r) => s + r.rating, 0) / trainSet.length;
  for (const r of trainSet) {
    const [s, c] = sums.get(r.itemId) ?? [0, 0];
    sums.set(r.itemId, [s + r.rating, c + 1]);
  }
  let sumSq = 0, sumAbs = 0;
  for (const r of testSet) {
    const entry = sums.get(r.itemId);
    const e = r.rating - (entry ? entry[0] / entry[1] : gm);
    sumSq  += e * e;
    sumAbs += Math.abs(e);
  }
  return { rmse: Math.sqrt(sumSq / testSet.length), mae: sumAbs / testSet.length, n: testSet.length };
}

// ── Ranking metrics ───────────────────────────────────────────────────────────

const TOP_K = 10;
const LIKE_THRESHOLD    = 4;   // rating ≥ 4 → "liked"
const DISLIKE_THRESHOLD = 2;   // rating ≤ 2 → "downvoted" in ricochet

function precisionRecallAt(
  model: Model,
  testSet: Rating[],
  candidateItems: string[],
  k = TOP_K,
  sampleUsers = SAMPLE_USERS,
): { precision: number; recall: number; ndcg: number } {
  // Group test ratings by user
  const byUser = new Map<string, Map<string, number>>();
  for (const r of testSet) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, new Map());
    byUser.get(r.userId)!.set(r.itemId, r.rating);
  }

  const users = [...byUser.keys()].slice(0, sampleUsers);
  let sumP = 0, sumR = 0, sumNdcg = 0;

  for (const userId of users) {
    const userRatings = byUser.get(userId)!;
    const relevant    = new Set([...userRatings.entries()].filter(([, v]) => v >= LIKE_THRESHOLD).map(([k]) => k));
    if (relevant.size === 0) continue;

    const ranked = candidateItems
      .map(id => ({ id, score: predict(model, userId, id) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    const hits   = ranked.filter(x => relevant.has(x.id)).length;
    const idcg   = Array.from({ length: Math.min(relevant.size, k) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
    const dcg    = ranked.reduce((s, x, i) => s + (relevant.has(x.id) ? 1 / Math.log2(i + 2) : 0), 0);
    sumP    += hits / k;
    sumR    += hits / relevant.size;
    sumNdcg += idcg > 0 ? dcg / idcg : 0;
  }

  const n = users.length;
  return { precision: sumP / n, recall: sumR / n, ndcg: sumNdcg / n };
}

// ── Filter verification ───────────────────────────────────────────────────────
//
// Rather than checking whether disliked items leak into top-K (they rarely do
// because the model already suppresses them globally), we directly compare the
// distribution of predicted scores for liked vs disliked items.  This is a
// cleaner signal for "is the filter learning the right direction?"

interface FilterStats {
  usersChecked:         number;
  // Predicted score distributions
  avgPredLiked:         number;   // avg predicted score for items rated ≥ LIKE_THRESHOLD
  avgPredDisliked:      number;   // avg predicted score for items rated ≤ DISLIKE_THRESHOLD
  // Fraction of pairs where liked item is predicted above disliked item
  pairwiseAccuracy:     number;
  // What fraction of disliked items fall below the filter cutoff
  dislikedBelowCutoff:  number;
  likedAboveCutoff:     number;
}

function verifyFilter(
  model:    Model,
  testSet:  Rating[],
  sampleUsers = SAMPLE_USERS,
): FilterStats {
  const byUser = new Map<string, Map<string, number>>();
  for (const r of testSet) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, new Map());
    byUser.get(r.userId)!.set(r.itemId, r.rating);
  }

  const eligible = [...byUser.entries()]
    .filter(([, m]) =>
      [...m.values()].some(v => v >= LIKE_THRESHOLD) &&
      [...m.values()].some(v => v <= DISLIKE_THRESHOLD),
    )
    .slice(0, sampleUsers);

  // Cutoff mirrors RecDO downvote exclusion: exclude items with low predicted scores
  // Here we use (globalMean - 1) as the predicted-dislike threshold
  const cutoff = model.globalMean - 1.0;

  let sumLiked = 0, nLiked = 0, sumDisliked = 0, nDisliked = 0;
  let pairwiseCorrect = 0, pairwiseTotal = 0;
  let dislikedBelow = 0, nDislikedTotal = 0, likedAbove = 0, nLikedTotal = 0;

  for (const [userId, userRatings] of eligible) {
    const likedItems    = [...userRatings.entries()].filter(([, v]) => v >= LIKE_THRESHOLD);
    const dislikedItems = [...userRatings.entries()].filter(([, v]) => v <= DISLIKE_THRESHOLD);

    const likedPreds    = likedItems.map(([id]) => predict(model, userId, id));
    const dislikedPreds = dislikedItems.map(([id]) => predict(model, userId, id));

    for (const p of likedPreds)    { sumLiked    += p; nLiked++;    }
    for (const p of dislikedPreds) { sumDisliked += p; nDisliked++; }

    // Pairwise: for each (liked, disliked) pair, is liked ranked above disliked?
    for (const lp of likedPreds) {
      for (const dp of dislikedPreds) {
        if (lp > dp) pairwiseCorrect++;
        pairwiseTotal++;
      }
    }

    // Cutoff check
    for (const p of dislikedPreds) { if (p < cutoff) dislikedBelow++; nDislikedTotal++; }
    for (const p of likedPreds)    { if (p >= cutoff) likedAbove++;   nLikedTotal++;    }
  }

  return {
    usersChecked:        eligible.length,
    avgPredLiked:        nLiked    ? sumLiked    / nLiked    : 0,
    avgPredDisliked:     nDisliked ? sumDisliked / nDisliked : 0,
    pairwiseAccuracy:    pairwiseTotal ? pairwiseCorrect / pairwiseTotal : 0,
    dislikedBelowCutoff: nDislikedTotal ? dislikedBelow / nDislikedTotal : 0,
    likedAboveCutoff:    nLikedTotal    ? likedAbove    / nLikedTotal    : 0,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// quality-ok: magic-number — 24 is the display width of the ASCII bar; a visual default
function bar(v: number, w = 24): string {
  const fill = Math.max(0, Math.min(w, Math.round(v * w)));
  return '[' + '█'.repeat(fill) + '░'.repeat(w - fill) + ']';
}
// quality-ok: magic-number — 100 converts 0–1 fraction to percentage
function pct(v: number): string { return (v * 100).toFixed(1) + '%'; }
function fmt(v: number, d = 4): string { return v.toFixed(d); }
function improvementStr(baseline: number, model: number): string {
  // quality-ok: magic-number — 100 converts 0–1 fraction to percentage
  const delta = (1 - model / baseline) * 100;
  return (delta >= 0 ? '+' : '') + delta.toFixed(1) + '%';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Dataset
  const { ratings: all, titles, source } = ensureDataset();
  const users = new Set(all.map(r => r.userId));
  const items = new Set(all.map(r => r.itemId));

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(` ricochet BiasedMF — offline evaluation  [${source}]`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log(`  ${all.length.toLocaleString()} ratings  |  ${users.size} users  |  ${items.size} items`);
  const ratingDist = [1, 2, 3, 4, 5].map(s => ({ star: s, n: all.filter(r => r.rating === s).length }));
  for (const { star, n } of ratingDist) {
    console.log(`  ${star}★  ${String(n).padStart(7)}  ${bar(n / all.length)}`);
  }
  console.log();

  // 2. Split
  const [trainSet, testSet] = splitRandom(all, 0.8);
  // quality-ok: magic-number — 80/20 are display labels matching the 0.8 trainRatio default
  console.log(`Split:   ${trainSet.length.toLocaleString()} train (80%)  /  ${testSet.length.toLocaleString()} test (20%)\n`);

  // 3. Baselines
  const bGlobal = globalMeanMetrics(trainSet, testSet);
  const bItem   = itemMeanMetrics(trainSet, testSet);
  console.log('─── Baselines (no personalisation) ───────────────────────────');
  console.log(`  Global mean       RMSE ${fmt(bGlobal.rmse)}   MAE ${fmt(bGlobal.mae)}`);
  console.log(`  Item mean         RMSE ${fmt(bItem.rmse)}   MAE ${fmt(bItem.mae)}\n`);

  // 4. Train BiasedMF
  const params: MfParams = {
    ...DEFAULT_MF_PARAMS,
    lrBias:    0.005,
    lrLatent:  0.005,
    l2Bias:    0.005,
    l2Latent:  0.02,
    sigmaInit: 0.1,
  };
  console.log(`─── Training BiasedMF (${TRAIN_EPOCHS} epochs) ────────────────────────────`);
  const model = trainModel(trainSet, TRAIN_EPOCHS, params);
  console.log(`  Learned global mean: ${fmt(model.globalMean, 3)}`);
  console.log(`  Users with factors:  ${model.userFactors.size}  |  Items: ${model.itemFactors.size}\n`);

  // 5. Prediction accuracy
  const mf = evaluate(model, testSet);
  console.log('─── Prediction accuracy on held-out 20% ──────────────────────');
  console.log(`  Global mean       RMSE ${fmt(bGlobal.rmse)}   MAE ${fmt(bGlobal.mae)}  (baseline)`);
  console.log(`  Item mean         RMSE ${fmt(bItem.rmse)}   MAE ${fmt(bItem.mae)}  (baseline)`);
  console.log(`  BiasedMF          RMSE ${fmt(mf.rmse)}   MAE ${fmt(mf.mae)}  ← trained model`);
  console.log();
  console.log(`  RMSE improvement vs global mean: ${improvementStr(bGlobal.rmse, mf.rmse)}`);
  console.log(`  RMSE improvement vs item mean:   ${improvementStr(bItem.rmse, mf.rmse)}\n`);

  // 6. Monotonicity check
  console.log('─── Predicted score vs true rating (should increase with ★) ──');
  const buckets: Record<number, number[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (const r of testSet) buckets[r.rating]?.push(predict(model, r.userId, r.itemId));
  let prevMean = -Infinity, monotone = true;
  for (const star of [1, 2, 3, 4, 5]) {
    const preds = buckets[star];
    const mean  = preds.reduce((a, b) => a + b, 0) / preds.length;
    if (mean < prevMean) monotone = false;
    prevMean = mean;
    console.log(`  ${star}★  avg pred ${fmt(mean, 2)}  ${bar(Math.max(0, mean - 1) / 4)}  n=${preds.length}`);
  }
  console.log(`  Monotonicity (1★ < 2★ < 3★ < 4★ < 5★): ${monotone ? '✓ PASS' : '✗ FAIL'}\n`);

  // 7. Ranking quality
  const candidateItems = [...items].slice(0, N_CANDIDATES);
  const ranking = precisionRecallAt(model, testSet, candidateItems, TOP_K, SAMPLE_USERS);
  console.log(`─── Ranking quality  @${TOP_K}  (${SAMPLE_USERS} sample users, ${N_CANDIDATES} candidates) ──`);
  console.log(`  Precision@${TOP_K}:  ${pct(ranking.precision)}  ${bar(ranking.precision)}`);
  console.log(`  Recall@${TOP_K}:     ${pct(ranking.recall)}  ${bar(ranking.recall)}`);
  console.log(`  NDCG@${TOP_K}:       ${pct(ranking.ndcg)}  ${bar(ranking.ndcg)}\n`);

  // 8. Filter verification
  console.log('─── Filter verification ───────────────────────────────────────');
  console.log(`  Liked ≥${LIKE_THRESHOLD}★ vs disliked ≤${DISLIKE_THRESHOLD}★  |  cutoff = globalMean − 1.0 = ${fmt(model.globalMean - 1.0, 2)}\n`);
  const fv = verifyFilter(model, testSet, SAMPLE_USERS);
  console.log(`  Users checked: ${fv.usersChecked}`);
  console.log(`  Avg predicted score — liked items:    ${fmt(fv.avgPredLiked, 3)}  ${bar((fv.avgPredLiked - 1) / 4)}`);
  console.log(`  Avg predicted score — disliked items: ${fmt(fv.avgPredDisliked, 3)}  ${bar((fv.avgPredDisliked - 1) / 4)}`);
  const scoreDelta = fv.avgPredLiked - fv.avgPredDisliked;
  console.log(`  Score gap (liked − disliked):  ${scoreDelta >= 0 ? '+' : ''}${fmt(scoreDelta, 3)}`);
  console.log();
  console.log(`  Pairwise accuracy (liked ranked above disliked): ${pct(fv.pairwiseAccuracy)}  ${bar(fv.pairwiseAccuracy)}`);
  console.log(`  Disliked items below cutoff (filter catches):    ${pct(fv.dislikedBelowCutoff)}  ${bar(fv.dislikedBelowCutoff)}`);
  console.log(`  Liked items above cutoff (not wrongly filtered): ${pct(fv.likedAboveCutoff)}  ${bar(fv.likedAboveCutoff)}`);
  const filterResult = fv.pairwiseAccuracy > 0.6 && scoreDelta > 0 ? '✓ PASS' : '✗ FAIL';
  console.log(`  Filter working: ${filterResult}\n`);

  // 9. Spot-check: one concrete user with movie titles if available
  const spotUser = [...testSet.reduce((m, r) => {
    m.set(r.userId, (m.get(r.userId) ?? 0) + 1); return m;
  }, new Map<string, number>()).entries()]
    .filter(([, c]) => c >= 5)
    .sort(([, a], [, b]) => b - a)[2]?.[0];  // pick 3rd most-rated user for variety

  if (spotUser) {
    const userTest = testSet.filter(r => r.userId === spotUser);
    const liked    = userTest.filter(r => r.rating >= LIKE_THRESHOLD).slice(0, 5);
    const disliked = userTest.filter(r => r.rating <= DISLIKE_THRESHOLD).slice(0, 5);
    const label = (id: string) => titles.get(id)?.substring(0, LABEL_TRUNCATE) ?? id;
    console.log(`─── Spot-check: user ${spotUser} ───────────────────────────────────────`);
    if (liked.length) {
      console.log(`  Items they liked (≥${LIKE_THRESHOLD}★) → predicted:`);
      for (const r of liked) {
        console.log(`    true ${r.rating}★  pred ${fmt(predict(model, r.userId, r.itemId), 2)}  ${label(r.itemId)}`);
      }
    }
    if (disliked.length) {
      console.log(`  Items they disliked (≤${DISLIKE_THRESHOLD}★) → predicted (should be lower):`);
      for (const r of disliked) {
        console.log(`    true ${r.rating}★  pred ${fmt(predict(model, r.userId, r.itemId), 2)}  ${label(r.itemId)}`);
      }
    }
  }

  console.log();
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error(err); process.exit(1); });
