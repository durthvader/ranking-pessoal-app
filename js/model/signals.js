// Sinais de consistência e de mudança de preferência.

import { aggregate, fitMAP, sigmoid } from './bt.js';

// Auditorias: compara a escolha repetida com a original.
// audits: [{of, winner, session, at, k}] ; originals: Map id → {winner, session, at, k}
export function auditSummary(audits, originals) {
  const rows = [];
  for (const a of audits) {
    const o = originals.get(a.of);
    if (!o) continue;
    rows.push({
      audit: a.id, original: a.of, agree: a.winner === o.winner,
      sameSession: a.session && a.session === o.session,
      gapVotes: a.k - o.k,
      gapDays: (new Date(a.at) - new Date(o.at)) / 86400000,
    });
  }
  const rate = (arr) => (arr.length ? arr.filter((r) => r.agree).length / arr.length : null);
  return {
    rows,
    total: rows.length,
    agree: rows.filter((r) => r.agree).length,
    rate: rate(rows),
    sameSession: { n: rows.filter((r) => r.sameSession).length, rate: rate(rows.filter((r) => r.sameSession)) },
    otherSession: { n: rows.filter((r) => !r.sameSession).length, rate: rate(rows.filter((r) => !r.sameSession)) },
  };
}

// Ciclos: no grafo da maioria (quem venceu mais vezes cada par), conta triângulos intransitivos
// (A>B, B>C, C>A) entre trios em que os três pares foram comparados.
export function cycleSummary(n, votes, rankOf = null, maxExamples = 12) {
  const net = new Map();
  for (const { w, l } of votes) {
    const i = Math.min(w, l), j = Math.max(w, l);
    const key = i * 100000 + j;
    net.set(key, (net.get(key) || 0) + (w === i ? 1 : -1));
  }
  const beats = Array.from({ length: n }, () => new Map()); // beats[i].get(j) = +1 se i>j, -1 se j>i
  const nb = Array.from({ length: n }, () => []);
  for (const [key, v] of net) {
    if (v === 0) continue;
    const i = Math.floor(key / 100000), j = key % 100000;
    beats[i].set(j, v > 0 ? 1 : -1);
    beats[j].set(i, v > 0 ? -1 : 1);
    nb[i].push(j);
    nb[j].push(i);
  }
  let tri = 0, cyc = 0;
  const examples = [];
  for (let i = 0; i < n; i++) {
    const list = nb[i].filter((x) => x > i);
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const j = list[a], k = list[b];
        const jk = beats[j].get(k);
        if (jk === undefined) continue;
        tri++;
        const ij = beats[i].get(j), ki = beats[k].get(i);
        // ciclo: i>j, j>k, k>i  ou  i<j, j<k, k<i
        if ((ij === 1 && jk === 1 && ki === 1) || (ij === -1 && jk === -1 && ki === -1)) {
          cyc++;
          examples.push(ij === 1 ? [i, j, k] : [i, k, j]);
        }
      }
    }
  }
  if (rankOf) examples.sort((x, y) => Math.min(...x.map(rankOf)) - Math.min(...y.map(rankOf)));
  return { triangles: tri, cyclic: cyc, rate: tri ? cyc / tri : null, examples: examples.slice(0, maxExamples) };
}

// Mudança entre sessões: cada sessão com votos suficientes é comparada com uma estimativa feita
// sem ela. Se a concordância observada fica abaixo da esperada pelo modelo, a sessão é sinalizada.
// votes: [{w, l, session}]
export function sessionDrift(n, votes, sigma, minVotes = 15) {
  const bySession = new Map();
  votes.forEach((v, k) => {
    const s = v.session || 'sem-sessao';
    if (!bySession.has(s)) bySession.set(s, []);
    bySession.get(s).push(k);
  });
  const out = [];
  if (bySession.size < 2) return out;
  const all = aggregate(n, votes);
  const base = fitMAP(all, sigma).s;
  for (const [session, idx] of bySession) {
    if (idx.length < minVotes) continue;
    const inSession = new Set(idx);
    const rest = votes.filter((_, k) => !inSession.has(k));
    const fit = fitMAP(aggregate(n, rest), sigma, base, { tol: 1e-7 });
    let obs = 0, exp = 0, varSum = 0;
    for (const k of idx) {
      const { w, l } = votes[k];
      const p = sigmoid(fit.s[w] - fit.s[l]); // chance prevista da escolha feita
      const pFav = Math.max(p, 1 - p);
      if (p > 0.5) obs += 1;
      else if (p === 0.5) obs += 0.5;
      exp += pFav;
      varSum += pFav * (1 - pFav);
    }
    const z = varSum > 0 ? (obs - exp) / Math.sqrt(varSum) : 0;
    out.push({ session, votes: idx.length, obsAgree: obs / idx.length, expAgree: exp / idx.length, z, flag: z < -2 });
  }
  return out;
}

// Viés de posição: proporção de escolhas da foto da esquerda (ou de cima).
export function sideBias(decisions) {
  let left = 0, total = 0;
  for (const d of decisions) {
    if (d.side !== 'L' && d.side !== 'R') continue;
    total++;
    if (d.side === 'L') left++;
  }
  if (!total) return { total: 0, left: 0, rate: null, z: null };
  const rate = left / total;
  const z = (left - total / 2) / Math.sqrt(total / 4);
  return { total, left, rate, z };
}
