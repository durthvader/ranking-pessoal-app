// Modelo de Bradley–Terry com prior gaussiano N(0, σ²) igual para todas as participantes.
//
// P(i escolhida em vez de j) = 1 / (1 + exp(-(s_i - s_j)))
// Log-posterior: Σ_votos log σ(s_vencedora - s_perdedora) - Σ_i s_i² / (2σ²)
//
// A função é estritamente côncava (soma de log-sigmoides côncavas com um termo quadrático
// estritamente côncavo); por isso o máximo (MAP) existe, é único e finito, mesmo para
// participantes só com vitórias ou só com derrotas.

import { cholesky, invLower, covFromInvLower, mulLowerT } from './linalg.js';
import { mulberry32 } from './rng.js';

export const ELO_K = 400 / Math.LN10; // ≈ 173,72 pontos por unidade de s

export function sigmoid(x) {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

function logSigmoid(x) {
  return x >= 0 ? -Math.log1p(Math.exp(-x)) : x - Math.log1p(Math.exp(x));
}

// Φ (normal padrão acumulada), erro < 1,5e-7.
export function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

// Agrega votos por par não ordenado. votes: [{w, l}] com índices 0..n-1.
// Retorna listas paralelas: I < J, A = vitórias de I sobre J, B = vitórias de J sobre I.
export function aggregate(n, votes) {
  const map = new Map();
  for (const v of votes) {
    let i = v.w, j = v.l, iWins = true;
    if (i === j) continue;
    if (i > j) { const t = i; i = j; j = t; iWins = false; }
    const key = i * n + j;
    let e = map.get(key);
    if (!e) { e = [i, j, 0, 0]; map.set(key, e); }
    const wt = v.weight == null ? 1 : v.weight;
    if (iWins) e[2] += wt; else e[3] += wt;
  }
  const m = map.size;
  const I = new Int32Array(m), J = new Int32Array(m), A = new Float64Array(m), B = new Float64Array(m);
  let k = 0;
  for (const e of map.values()) { I[k] = e[0]; J[k] = e[1]; A[k] = e[2]; B[k] = e[3]; k++; }
  return { n, m, I, J, A, B };
}

export function logPosterior(agg, s, sigma) {
  const { m, I, J, A, B } = agg;
  let f = 0;
  for (let k = 0; k < m; k++) {
    const d = s[I[k]] - s[J[k]];
    if (A[k]) f += A[k] * logSigmoid(d);
    if (B[k]) f += B[k] * logSigmoid(-d);
  }
  const prec = 1 / (sigma * sigma);
  let q = 0;
  for (let i = 0; i < s.length; i++) q += s[i] * s[i];
  return f - 0.5 * prec * q;
}

// Estimativa MAP por Newton com gradiente conjugado pré-condicionado (Hessiana esparsa)
// e busca linear de Armijo. init permite partida a quente.
export function fitMAP(agg, sigma, init = null, opts = {}) {
  const { n, m, I, J, A, B } = agg;
  const tol = opts.tol ?? 1e-9;
  const maxIter = opts.maxIter ?? 60;
  const prec = 1 / (sigma * sigma);
  const s = new Float64Array(n);
  if (init && init.length === n) s.set(init);
  const g = new Float64Array(n), w = new Float64Array(m), D = new Float64Array(n);
  let f = logPosterior(agg, s, sigma);
  let iters = 0, gInf = Infinity;
  const Hv = (v, out) => {
    for (let i = 0; i < n; i++) out[i] = prec * v[i];
    for (let k = 0; k < m; k++) {
      const d = w[k] * (v[I[k]] - v[J[k]]);
      out[I[k]] += d;
      out[J[k]] -= d;
    }
    return out;
  };
  for (; iters < maxIter; iters++) {
    for (let i = 0; i < n; i++) { g[i] = -prec * s[i]; D[i] = prec; }
    for (let k = 0; k < m; k++) {
      const p = sigmoid(s[I[k]] - s[J[k]]);
      const T = A[k] + B[k];
      const r = A[k] - T * p;
      g[I[k]] += r;
      g[J[k]] -= r;
      w[k] = T * p * (1 - p);
      D[I[k]] += w[k];
      D[J[k]] += w[k];
    }
    gInf = 0;
    let gNorm2 = 0;
    for (let i = 0; i < n; i++) { gInf = Math.max(gInf, Math.abs(g[i])); gNorm2 += g[i] * g[i]; }
    if (gInf < tol) break;
    const delta = pcg(Hv, g, D, Math.min(0.1, Math.sqrt(Math.sqrt(gNorm2))) * Math.sqrt(gNorm2), 300, n);
    let gd = 0;
    for (let i = 0; i < n; i++) gd += g[i] * delta[i];
    let t = 1, fNew = f;
    const sNew = new Float64Array(n);
    for (let ls = 0; ls < 40; ls++) {
      for (let i = 0; i < n; i++) sNew[i] = s[i] + t * delta[i];
      fNew = logPosterior(agg, sNew, sigma);
      if (fNew >= f + 1e-4 * t * gd) break;
      t *= 0.5;
    }
    if (fNew < f) break; // sem progresso numérico
    s.set(sNew);
    f = fNew;
  }
  return { s, f, iters, gInf, converged: gInf < Math.max(tol, 1e-6) };
}

function pcg(Hv, b, D, tolAbs, maxIt, n) {
  const x = new Float64Array(n), r = Float64Array.from(b), z = new Float64Array(n), p = new Float64Array(n),
    Ap = new Float64Array(n);
  for (let i = 0; i < n; i++) { z[i] = r[i] / D[i]; p[i] = z[i]; }
  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i] * z[i];
  for (let it = 0; it < maxIt; it++) {
    Hv(p, Ap);
    let pAp = 0;
    for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
    if (!(pAp > 0)) break;
    const alpha = rz / pAp;
    let rn = 0;
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; rn += r[i] * r[i]; }
    if (Math.sqrt(rn) <= tolAbs) break;
    for (let i = 0; i < n; i++) z[i] = r[i] / D[i];
    let rzNew = 0;
    for (let i = 0; i < n; i++) rzNew += r[i] * z[i];
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  return x;
}

// Hessiana negativa densa no ponto s: H = Σ T p(1-p) (e_I - e_J)(e_I - e_J)^T + I/σ².
export function hessianDense(agg, s, sigma) {
  const { n, m, I, J, A, B } = agg;
  const H = new Float64Array(n * n);
  const prec = 1 / (sigma * sigma);
  for (let i = 0; i < n; i++) H[i * n + i] = prec;
  for (let k = 0; k < m; k++) {
    const p = sigmoid(s[I[k]] - s[J[k]]);
    const w = (A[k] + B[k]) * p * (1 - p);
    const i = I[k], j = J[k];
    H[i * n + i] += w;
    H[j * n + j] += w;
    H[i * n + j] -= w;
    H[j * n + i] -= w;
  }
  return H;
}

// Aproximação de Laplace: posterior ≈ N(ŝ, H⁻¹). Calcula covariância, variâncias centradas
// (escala relativa à média, usada no índice Elo) e, por Monte Carlo conjunto, a distribuição
// das posições e a chance de 1º lugar. As amostras preservam as correlações entre parâmetros.
export function posterior(agg, s, sigma, opts = {}) {
  const n = agg.n;
  const samples = opts.samples ?? 1000;
  const topK = opts.topK ?? 10;
  const level = opts.level ?? 0.9;
  const H = hessianDense(agg, s, sigma);
  const L = cholesky(H, n);
  const M = invLower(L, n);
  const S = covFromInvLower(M, n);
  const rowSum = new Float64Array(n);
  let tot = 0;
  for (let i = 0; i < n; i++) {
    let rs = 0;
    const ri = i * n;
    for (let j = 0; j < n; j++) rs += S[ri + j];
    rowSum[i] = rs;
    tot += rs;
  }
  const varC = new Float64Array(n);
  for (let i = 0; i < n; i++) varC[i] = Math.max(0, S[i * n + i] - 2 * rowSum[i] / n + tot / (n * n));

  const rng = mulberry32(opts.seed ?? 12345);
  const hist = new Int32Array(n * n);
  const z = new Float64Array(n), x = new Float64Array(n), v = new Float64Array(n);
  const idx = new Int32Array(n);
  const rankSum = new Float64Array(n);
  for (let t = 0; t < samples; t++) {
    for (let i = 0; i < n; i++) z[i] = rng.normal();
    mulLowerT(M, n, z, x);
    for (let i = 0; i < n; i++) { v[i] = s[i] + x[i]; idx[i] = i; }
    idx.sort((a, b) => v[b] - v[a] || a - b);
    for (let r = 0; r < n; r++) { hist[idx[r] * n + r]++; rankSum[idx[r]] += r + 1; }
  }
  const p1 = new Float64Array(n), pTop = new Float64Array(n), rankLo = new Int32Array(n),
    rankHi = new Int32Array(n), rankMed = new Int32Array(n), rankMean = new Float64Array(n);
  const qLo = (1 - level) / 2 * samples, qHi = (1 + level) / 2 * samples, qMed = 0.5 * samples;
  for (let i = 0; i < n; i++) {
    const ri = i * n;
    p1[i] = hist[ri] / samples;
    let c = 0, lo = -1, hi = -1, med = -1, top = 0;
    for (let r = 0; r < n; r++) {
      const h = hist[ri + r];
      if (r < topK) top += h;
      c += h;
      if (lo < 0 && c > qLo) lo = r;
      if (med < 0 && c >= qMed) med = r;
      if (hi < 0 && c >= qHi) { hi = r; }
    }
    pTop[i] = top / samples;
    rankLo[i] = lo + 1;
    rankHi[i] = (hi < 0 ? n - 1 : hi) + 1;
    rankMed[i] = med + 1;
    rankMean[i] = rankSum[i] / samples;
  }
  return { S, varC, p1, pTop, topK, rankLo, rankHi, rankMed, rankMean, samples, level };
}

// Converte s para o índice de preferência em escala Elo: R = 1500 + K (s - média(s)).
export function toElo(s) {
  const n = s.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += s[i];
  mean /= n || 1;
  const R = new Float64Array(n);
  for (let i = 0; i < n; i++) R[i] = 1500 + ELO_K * (s[i] - mean);
  return R;
}

// Probabilidade de i ficar acima de j considerando a incerteza conjunta (normal).
export function probAbove(mu, S, n, i, j) {
  const V = S[i * n + i] + S[j * n + j] - 2 * S[i * n + j];
  if (V <= 1e-12) return mu[i] > mu[j] ? 1 : mu[i] < mu[j] ? 0 : 0.5;
  return normCdf((mu[i] - mu[j]) / Math.sqrt(V));
}

// Probabilidade preditiva de i vencer j num novo confronto (aproximação probit da logística).
export function predictive(mu, S, n, i, j) {
  const V = S ? S[i * n + i] + S[j * n + j] - 2 * S[i * n + j] : 0;
  return sigmoid((mu[i] - mu[j]) / Math.sqrt(1 + Math.PI * V / 8));
}

// Evidência aproximada (Laplace) dos votos para um dado σ do prior:
// log p(votos | σ) ≈ ℓ(ŝ) − ŝᵀŝ/(2σ²) − n·log σ − ½·log det H   (as constantes 2π se cancelam)
export function logEvidence(agg, sigma, init = null) {
  const n = agg.n;
  const fit = fitMAP(agg, sigma, init, { tol: 1e-8 });
  const H = hessianDense(agg, fit.s, sigma);
  const L = cholesky(H, n);
  let logdet = 0;
  for (let i = 0; i < n; i++) logdet += 2 * Math.log(L[i * n + i]);
  const value = logPosterior(agg, fit.s, sigma) - n * Math.log(sigma) - 0.5 * logdet;
  return { value, s: fit.s };
}

// Bayes empírico: escolhe o σ que maximiza a evidência, por busca de seção áurea em log σ.
export function estimateSigma(agg, { lo = 0.25, hi = 5, init = null, iters = 16 } = {}) {
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = Math.log(lo), b = Math.log(hi);
  let s0 = init;
  const f = (t) => {
    const r = logEvidence(agg, Math.exp(t), s0);
    s0 = r.s;
    return r.value;
  };
  let c = b - phi * (b - a), d = a + phi * (b - a);
  let fc = f(c), fd = f(d);
  for (let k = 0; k < iters; k++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - phi * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + phi * (b - a); fd = f(d); }
  }
  const t = fc > fd ? c : d;
  const sigma = Math.exp(t);
  return { sigma, atBound: sigma < lo * 1.05 || sigma > hi / 1.05 };
}

// Ajuste completo (MAP + Laplace + Monte Carlo) em um passo.
export function fitAll(n, votes, sigma, opts = {}) {
  const agg = aggregate(n, votes);
  const fit = fitMAP(agg, sigma, opts.init || null);
  const post = posterior(agg, fit.s, sigma, opts);
  return { agg, fit, post, R: toElo(fit.s) };
}
