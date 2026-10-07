// Cálculos pesados, executados no Web Worker (ou na página, se o navegador não suportar workers de módulo).

import { aggregate, fitMAP, posterior, toElo, ELO_K, estimateSigma } from './model/bt.js';

export const SIGMA_AUTO_MIN_VOTES = 300;
import { computeStages } from './model/stages.js';
import { cycleSummary, sessionDrift } from './model/signals.js';

export function compute(msg) {
  const t0 = performance.now();
  if (msg.type === 'fit') {
    const { n, votes, samples, level, topK, init, seed } = msg;
    const list = [];
    for (let k = 0; k < votes.length; k += 2) list.push({ w: votes[k], l: votes[k + 1] });
    const agg = aggregate(n, list);
    const start = init && init.length === n ? init : null;
    // σ do prior: fixo, ou estimado pelos votos (Bayes empírico) a partir de 300 votos.
    // Reestima quando os votos mudam 3% (mínimo 25) desde a última estimativa.
    let sigma = msg.sigmaFixed;
    let sigmaSource = 'fixo';
    let sigmaVotes = msg.sigmaPrevVotes ?? null;
    if (msg.sigmaMode === 'auto') {
      if (list.length < SIGMA_AUTO_MIN_VOTES) sigmaSource = 'inicial';
      else {
        const stale = msg.sigmaPrev == null || sigmaVotes == null
          || Math.abs(list.length - sigmaVotes) >= Math.max(25, 0.03 * list.length);
        if (stale) {
          sigma = estimateSigma(agg, { init: start, lo: msg.sigmaMin ?? 0.25, hi: msg.sigmaMax ?? 5 }).sigma;
          sigmaVotes = list.length;
        } else sigma = msg.sigmaPrev;
        sigmaSource = 'auto';
      }
    }
    const fit = fitMAP(agg, sigma, start);
    let post = null;
    if (n >= 2) post = posterior(agg, fit.s, sigma, { samples, level, topK, seed });
    const R = toElo(fit.s);
    const sdR = new Float64Array(n);
    if (post) for (let i = 0; i < n; i++) sdR[i] = ELO_K * Math.sqrt(post.varC[i]);
    const out = {
      type: 'fit', id: msg.id, n, s: fit.s, R, sdR, iters: fit.iters, converged: fit.converged,
      S: post?.S || new Float64Array(n * n), p1: post?.p1 || new Float64Array(n), pTop: post?.pTop || new Float64Array(n),
      rankLo: post?.rankLo || new Int32Array(n).fill(1), rankHi: post?.rankHi || new Int32Array(n).fill(n),
      rankMed: post?.rankMed || new Int32Array(n).fill(1), rankMean: post?.rankMean || new Float64Array(n),
      samples, level, topK, ms: 0, sigmaUsed: sigma, sigmaSource, sigmaVotes,
    };
    out.ms = performance.now() - t0;
    return { out, transfer: [out.s.buffer, out.R.buffer, out.sdR.buffer, out.S.buffer, out.p1.buffer, out.pTop.buffer,
      out.rankLo.buffer, out.rankHi.buffer, out.rankMed.buffer, out.rankMean.buffer] };
  }
  if (msg.type === 'stages') {
    const res = computeStages(msg.n, msg.votes, msg.options);
    return { out: { type: 'stages', id: msg.id, ...res, ms: performance.now() - t0 }, transfer: [] };
  }
  if (msg.type === 'signals') {
    const cycles = cycleSummary(msg.n, msg.votes, msg.rank ? (i) => msg.rank[i] : null);
    const drift = sessionDrift(msg.n, msg.votes, msg.sigma, msg.minVotes ?? 15);
    return { out: { type: 'signals', id: msg.id, cycles, drift, ms: performance.now() - t0 }, transfer: [] };
  }
  throw new Error('mensagem desconhecida: ' + msg.type);
}
