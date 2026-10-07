// Escolha do próximo confronto.
//
// 1. Cobertura: enquanto alguma participante elegível tiver menos de `coverageMin` comparações
//    válidas, o par junta participantes com menos comparações, sem repetir adversária,
//    preferindo componentes diferentes da rede (mantém a rede conectada). Sorteio com semente.
// 2. Conexão: se a rede de comparações estiver dividida, um confronto liga os pedaços.
// 3. Adaptativa (inspirada no sistema suíço): candidatas próximas na estimativa atual,
//    algumas distantes e as candidatas ao 1º lugar. Cada par recebe
//       pontuação = informação esperada (BALD) × importância × penalidades
//    importância = 1 + wTop·(chance de 1º das duas) + wUnder·(falta de comparações) + wCross·(faixas diferentes)
//    penalidades: par repetido, par visto há pouco, par adiado ("Rever depois").
//    O par sai de um sorteio ponderado entre os `randomTop` melhores.
// 4. Revisão do 1º lugar: o mesmo critério restrito às candidatas plausíveis.

import { makeRng } from './rng.js';
import { normCdf } from './bt.js';

const C_BALD = Math.sqrt(Math.PI * Math.LN2 / 2);
const LAMBDA = Math.sqrt(Math.PI / 8);

export const DEFAULT_PAIRING = {
  coverageMin: 6,
  coverageMode: 'aleatorio', // 'aleatorio' | 'suico'
  window: 10, // vizinhas consideradas acima/abaixo na ordem atual
  randomCandidates: 2, // candidatas distantes sorteadas por participante
  wTop: 6,
  wUnder: 1.5,
  wCross: 0.3,
  repeatPenalty: 0.35, // multiplica a pontuação a cada repetição do par
  deferPenalty: 0.35, // a cada "Rever depois" do par
  recentPairWindow: 150, // apresentações até o mesmo par poder voltar sem penalidade forte
  recentParticipantWindow: 2, // a participante não aparece em confrontos seguidos
  randomTop: 6,
  groups: [10, 25, 50, 100, 200, 350],
  reviewMinP1: 0.01,
  reviewTopN: 5,
};

export const pairKey = (i, j) => (i < j ? i * 100000 + j : j * 100000 + i);

function h2(p) {
  if (p <= 0 || p >= 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

// Informação mútua entre o resultado do confronto e a diferença de preferência d ~ N(mu, V)
// (Houlsby et al., 2011), usando σ(d) ≈ Φ(λd), λ = √(π/8). Em bits.
export function bald(mu, V) {
  const m = LAMBDA * mu;
  const v = LAMBDA * LAMBDA * Math.max(0, V);
  const pbar = normCdf(m / Math.sqrt(1 + v));
  const c2 = C_BALD * C_BALD;
  const expected = C_BALD / Math.sqrt(v + c2) * Math.exp(-(m * m) / (2 * (v + c2)));
  return Math.max(0, h2(pbar) - expected);
}

export function groupOf(pos, groups) {
  for (let g = 0; g < groups.length; g++) if (pos < groups[g]) return g;
  return groups.length;
}

export function groupLabel(g, groups, total) {
  const lo = g === 0 ? 1 : groups[g - 1] + 1;
  const hi = g < groups.length ? Math.min(groups[g], total) : total;
  return lo === 1 ? `Top ${hi}` : `${lo}–${hi}`;
}

class UnionFind {
  constructor(n) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i; }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.p[a] = b; }
}

export function components(n, pairCounts, eligible) {
  const uf = new UnionFind(n);
  for (const [key, c] of pairCounts) {
    if (c <= 0) continue;
    const i = Math.floor(key / 100000), j = key % 100000;
    uf.union(i, j);
  }
  const comp = new Int32Array(n).fill(-1);
  const sizes = new Map();
  for (let i = 0; i < n; i++) {
    if (!eligible[i]) continue;
    const r = uf.find(i);
    comp[i] = r;
    sizes.set(r, (sizes.get(r) || 0) + 1);
  }
  return { comp, sizes };
}

function recentSet(ctx, k) {
  const set = new Set();
  const rec = ctx.recent || [];
  for (let t = 0; t < Math.min(k, rec.length); t++) { set.add(rec[t][0]); set.add(rec[t][1]); }
  return set;
}

// ctx: ver documentação no topo. Retorna {i, j, reason} ou null.
export function nextPair(ctx) {
  const st = { ...DEFAULT_PAIRING, ...(ctx.settings || {}) };
  const rng = makeRng('par', ctx.seed ?? 0, ctx.presIndex ?? 0, ctx.salt ?? '');
  const elig = [];
  for (let i = 0; i < ctx.n; i++) if (ctx.eligible[i]) elig.push(i);
  if (elig.length < 2) return null;
  const excluded = ctx.excludePairs || new Set();

  if (ctx.mode !== 'revisao') {
    const cov = coveragePair(ctx, st, rng, elig, excluded);
    if (cov) return withSide(cov, rng);
    const bridge = bridgePair(ctx, st, rng, elig, excluded);
    if (bridge) return withSide(bridge, rng);
  }
  if (!ctx.model) {
    // sem estimativa ainda: sorteio entre pares não repetidos
    return withSide(randomPair(ctx, st, rng, elig, excluded), rng);
  }
  const res = adaptivePair(ctx, st, rng, elig, excluded, ctx.mode === 'revisao');
  if (res) return withSide(res, rng);
  return withSide(randomPair(ctx, st, rng, elig, excluded), rng);
}

function withSide(p, rng) {
  if (!p) return null;
  // Lado esquerdo/direito sorteado; o app registra a posição apresentada.
  if (rng() < 0.5) return { ...p, left: p.i, right: p.j };
  return { ...p, left: p.j, right: p.i };
}

function coveragePair(ctx, st, rng, elig, excluded) {
  const { counts, pairCounts } = ctx;
  const need = elig.filter((i) => counts[i] < st.coverageMin);
  if (need.length === 0) return null;
  const recent = recentSet(ctx, st.recentParticipantWindow);
  let pool = need.filter((i) => !recent.has(i));
  if (pool.length === 0) pool = need;
  let minC = Infinity;
  for (const i of pool) minC = Math.min(minC, counts[i]);
  const firstTier = rng.shuffle(pool.filter((i) => counts[i] === minC));
  const { comp } = components(ctx.n, pairCounts, ctx.eligible);
  for (const i of firstTier) {
    for (const relax of [0, 1, 2]) {
      const opp = [];
      for (const j of elig) {
        if (j === i) continue;
        const key = pairKey(i, j);
        if (excluded.has(key)) continue;
        if (relax < 2 && (pairCounts.get(key) || 0) > 0) continue;
        if (relax < 1 && recent.has(j)) continue;
        if (relax < 1 && (ctx.deferrals?.get(key) || 0) >= 2) continue;
        opp.push(j);
      }
      if (!opp.length) continue;
      // preferências em ordem: precisa de cobertura, menos comparações, outro componente
      let best = Infinity;
      const scoreOf = (j) => (counts[j] < st.coverageMin ? 0 : 1) * 1e6 + counts[j] * 10 + (comp[j] === comp[i] ? 1 : 0);
      for (const j of opp) best = Math.min(best, scoreOf(j));
      let tier = opp.filter((j) => scoreOf(j) === best);
      if (st.coverageMode === 'suico' && ctx.model && counts[i] >= 2 && tier.length > 3) {
        const mu = ctx.model.mu;
        tier.sort((a, b) => Math.abs(mu[a] - mu[i]) - Math.abs(mu[b] - mu[i]));
        tier = tier.slice(0, Math.max(3, Math.ceil(tier.length * 0.1)));
      }
      const j = rng.pick(tier);
      return { i, j, reason: { kind: 'cobertura', round: Math.min(counts[i], counts[j]) + 1, of: st.coverageMin } };
    }
  }
  return null;
}

function bridgePair(ctx, st, rng, elig, excluded) {
  const { comp, sizes } = components(ctx.n, ctx.pairCounts, ctx.eligible);
  if (sizes.size <= 1) return null;
  let largest = null, smallest = null;
  for (const [r, sz] of sizes) {
    if (largest === null || sz > sizes.get(largest)) largest = r;
    if (smallest === null || sz < sizes.get(smallest)) smallest = r;
  }
  const recent = recentSet(ctx, st.recentParticipantWindow);
  const A = elig.filter((i) => comp[i] === smallest);
  const B = elig.filter((i) => comp[i] === largest);
  const pickFrom = (arr) => {
    const f = arr.filter((x) => !recent.has(x));
    return rng.pick(f.length ? f : arr);
  };
  const i = pickFrom(A);
  let j;
  if (ctx.model) {
    const mu = ctx.model.mu;
    const sorted = B.filter((x) => !excluded.has(pairKey(i, x)))
      .sort((a, b) => Math.abs(mu[a] - mu[i]) - Math.abs(mu[b] - mu[i]));
    j = rng.pick(sorted.slice(0, 5).length ? sorted.slice(0, 5) : B);
  } else {
    j = pickFrom(B);
  }
  return { i, j, reason: { kind: 'conexao', components: sizes.size } };
}

function randomPair(ctx, st, rng, elig, excluded) {
  const recent = recentSet(ctx, st.recentParticipantWindow);
  for (let t = 0; t < 400; t++) {
    const i = rng.pick(elig), j = rng.pick(elig);
    if (i === j) continue;
    const key = pairKey(i, j);
    if (excluded.has(key)) continue;
    if (t < 300 && (recent.has(i) || recent.has(j))) continue;
    if (t < 200 && (ctx.pairCounts.get(key) || 0) > 0) continue;
    return { i, j, reason: { kind: 'sorteio' } };
  }
  return null;
}

function median(arr) {
  if (!arr.length) return 0;
  const a = Float64Array.from(arr).sort();
  return a[Math.floor(a.length / 2)];
}

export function contenders(ctx, st, elig) {
  const { mu, p1 } = ctx.model;
  const byMu = elig.slice().sort((a, b) => mu[b] - mu[a] || a - b);
  const set = new Set(byMu.slice(0, st.reviewTopN));
  if (p1) for (const i of elig) if (p1[i] >= st.reviewMinP1) set.add(i);
  if (ctx.model.rankLo) for (const i of elig) if (ctx.model.rankLo[i] === 1) set.add(i);
  return { set, byMu };
}

// Participantes pouco avaliadas cuja faixa plausível alcança a líder (possível subestimação).
export function underestimated(ctx, st, elig, leader) {
  const { mu, S } = ctx.model;
  const n = ctx.n;
  const counts = elig.map((i) => ctx.counts[i]);
  const med = median(counts);
  const out = [];
  for (const i of elig) {
    if (ctx.counts[i] > med) continue;
    const sd = S ? Math.sqrt(Math.max(0, S[i * n + i])) : 1;
    if (mu[i] + 2 * sd >= mu[leader]) out.push(i);
  }
  return out;
}

function adaptivePair(ctx, st, rng, elig, excluded, reviewMode) {
  const n = ctx.n;
  const { mu, S, p1 } = ctx.model;
  const counts = ctx.counts;
  const order = elig.slice().sort((a, b) => mu[b] - mu[a] || a - b);
  const pos = new Int32Array(n).fill(-1);
  order.forEach((i, k) => { pos[i] = k; });
  const grp = (i) => groupOf(pos[i], st.groups);
  let p1max = 1 / elig.length;
  if (p1) for (const i of elig) p1max = Math.max(p1max, p1[i]);
  const target = Math.max(st.coverageMin, median(elig.map((i) => counts[i])));
  const recent = recentSet(ctx, reviewMode ? 1 : st.recentParticipantWindow);

  const cand = new Map();
  const add = (i, j) => {
    if (i === j) return;
    const key = pairKey(i, j);
    if (excluded.has(key) || cand.has(key)) return;
    cand.set(key, [i, j]);
  };
  const { set: cont, byMu } = contenders(ctx, st, elig);
  if (reviewMode) {
    const lead = byMu[0];
    const under = underestimated(ctx, st, elig, lead);
    const cs = [...cont];
    for (let a = 0; a < cs.length; a++) for (let b = a + 1; b < cs.length; b++) add(cs[a], cs[b]);
    for (const u of under) for (const c of cs) add(u, c);
  } else {
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      for (let d = 1; d <= st.window && k + d < order.length; d++) add(i, order[k + d]);
      for (let r = 0; r < st.randomCandidates; r++) add(i, order[rng.int(order.length)]);
    }
    const cs = [...cont];
    for (let a = 0; a < cs.length; a++) for (let b = a + 1; b < cs.length; b++) add(cs[a], cs[b]);
  }

  const scored = [];
  const fallback = [];
  for (const [key, [i, j]] of cand) {
    const V = S ? S[i * n + i] + S[j * n + j] - 2 * S[i * n + j] : 2 / (1 + Math.min(counts[i], counts[j]));
    const info = bald(mu[i] - mu[j], V);
    const top = p1 ? (p1[i] + p1[j]) / (2 * p1max) : 0;
    const under = Math.max(0, (target - Math.min(counts[i], counts[j])) / target);
    const cross = grp(i) !== grp(j) ? 1 : 0;
    const bTop = st.wTop * top, bUnder = st.wUnder * under, bCross = st.wCross * cross;
    const imp = 1 + bTop + bUnder + bCross;
    let pen = 1;
    const pc = ctx.pairCounts.get(key) || 0;
    pen *= Math.pow(reviewMode ? 0.6 : st.repeatPenalty, pc);
    const last = ctx.pairLastSeen?.get(key);
    if (last != null && (ctx.presIndex ?? 0) - last < st.recentPairWindow) pen *= reviewMode ? 0.2 : 0.02;
    const def = ctx.deferrals?.get(key) || 0;
    pen *= Math.pow(st.deferPenalty, def);
    const score = info * imp * pen;
    const item = { i, j, score, info, bTop, bUnder, bCross, V, def };
    if (recent.has(i) || recent.has(j)) fallback.push(item);
    else scored.push(item);
  }
  const pool = scored.length ? scored : fallback;
  if (!pool.length) return null;
  pool.sort((a, b) => b.score - a.score);
  const top = pool.slice(0, Math.max(1, st.randomTop));
  let tot = 0;
  for (const t of top) tot += t.score;
  let r = rng() * tot, chosen = top[0];
  if (tot > 0) {
    for (const t of top) { r -= t.score; if (r <= 0) { chosen = t; break; } }
  } else {
    chosen = rng.pick(top);
  }
  return { i: chosen.i, j: chosen.j, reason: explain(chosen, ctx, pos, reviewMode) };
}

function explain(c, ctx, pos, reviewMode) {
  const { i, j, info, bTop, bUnder, bCross, V } = c;
  const mu = ctx.model.mu;
  const swap = normCdf(-Math.abs(mu[i] - mu[j]) / Math.sqrt(Math.max(V, 1e-9)));
  const base = { info, swap, posA: pos[i] + 1, posB: pos[j] + 1, deferred: c.def };
  if (reviewMode) return { kind: 'revisao', ...base };
  const m = Math.max(bTop, bUnder, bCross);
  if (m > 0.05 && m === bTop) return { kind: 'disputa_1', ...base };
  if (m > 0.05 && m === bUnder) return { kind: 'pouco_avaliada', ...base };
  if (m > 0 && m === bCross) return { kind: 'entre_faixas', ...base };
  return { kind: 'proximas', ...base };
}

// Lista os confrontos mais úteis no momento (para a tela de progresso).
export function usefulPairs(ctx, limit = 10) {
  const st = { ...DEFAULT_PAIRING, ...(ctx.settings || {}) };
  const elig = [];
  for (let i = 0; i < ctx.n; i++) if (ctx.eligible[i]) elig.push(i);
  if (elig.length < 2 || !ctx.model) return [];
  const out = [];
  const excluded = new Set(ctx.excludePairs || []);
  const rng = makeRng('uteis', ctx.seed ?? 0, ctx.presIndex ?? 0);
  for (let t = 0; t < limit; t++) {
    const res = adaptivePair({ ...ctx, recent: [] }, { ...st, randomTop: 1 }, rng, elig, excluded, false);
    if (!res) break;
    out.push(res);
    excluded.add(pairKey(res.i, res.j));
  }
  return out;
}

// Auditoria: escolhe um voto antigo para repetir com lados sorteados de novo.
// history: [{id, i, j, idx (posição na sequência de apresentações), audited}]
export function pickAudit(ctx, history, opts = {}) {
  const minGap = opts.minGap ?? 25;
  const rng = makeRng('auditoria', ctx.seed ?? 0, ctx.presIndex ?? 0);
  const recent = recentSet(ctx, 2);
  const mu = ctx.model?.mu;
  const p1 = ctx.model?.p1;
  const cands = [];
  for (const h of history) {
    if (h.audited) continue;
    if ((ctx.presIndex ?? 0) - h.idx < minGap) continue;
    if (!ctx.eligible[h.i] || !ctx.eligible[h.j]) continue;
    if (recent.has(h.i) || recent.has(h.j)) continue;
    let w = 1;
    if (mu) w += 2 * Math.exp(-Math.abs(mu[h.i] - mu[h.j])); // pares próximos
    if (p1) w += 10 * (p1[h.i] + p1[h.j]); // pares da disputa pelo 1º lugar
    cands.push({ h, w });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.w - a.w);
  const top = cands.slice(0, 15);
  let tot = top.reduce((s, c) => s + c.w, 0);
  let r = rng() * tot;
  let chosen = top[0];
  for (const c of top) { r -= c.w; if (r <= 0) { chosen = c; break; } }
  const left = rng() < 0.5 ? chosen.h.i : chosen.h.j;
  const right = left === chosen.h.i ? chosen.h.j : chosen.h.i;
  return { i: chosen.h.i, j: chosen.h.j, left, right, of: chosen.h.id, reason: { kind: 'auditoria' } };
}
