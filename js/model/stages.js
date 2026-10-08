// Etapas do chaveamento dinâmico.
// Usa a fase e a rodada registradas na apresentação. Uma nova cobertura após a fase
// adaptativa forma outro período, sem acrescentar votos às rodadas anteriores.
// Depois da cobertura, cada bloco de `stageSize` escolhas forma uma etapa.
// Ao fim de cada etapa o app reestima as pontuações só com os votos até ali e forma as faixas.

import { aggregate, fitMAP, toElo } from './bt.js';
import { groupOf } from './pairing.js';

// votes: [{w, l, phase, reason}] em ordem cronológica.
export function computeStages(n, votes, { sigma = 1.5, coverageMin = 6, stageSize = 250, groups = [10, 25, 50, 100, 200, 350] } = {}) {
  const counts = new Int32Array(n);
  const label = new Int32Array(votes.length);
  let adaptiveSeen = 0;
  let period = -1, previousKind = null;
  const periods = [];
  for (let t = 0; t < votes.length; t++) {
    const { w, l, phase, reason } = votes[t];
    const recordedRound = reason?.round;
    const r = Number.isInteger(recordedRound) && recordedRound > 0
      ? recordedRound : Math.min(counts[w], counts[l]) + 1;
    const recordedKind = phase || (reason?.kind === 'cobertura' ? 'cobertura' : reason?.kind ? 'etapa' : null);
    const kind = recordedKind ? (recordedKind === 'cobertura' ? 'cobertura' : 'etapa') : (r <= coverageMin ? 'cobertura' : 'etapa');
    if (kind !== previousKind) { period++; periods.push(new Map()); previousKind = kind; }
    const number = kind === 'cobertura' ? r : 1 + Math.floor(adaptiveSeen++ / stageSize);
    const buckets = periods[period];
    if (!buckets.has(number)) buckets.set(number, { kind, number, votes: [] });
    buckets.get(number).votes.push(t);
    counts[w]++; counts[l]++;
  }
  const stages = [];
  const occurrences = new Map();
  let endIdx = -1;
  for (const buckets of periods) {
    for (const st of [...buckets.values()].sort((a, b) => a.number - b.number)) {
      const key = `${st.kind}:${st.number}`;
      const occurrence = (occurrences.get(key) || 0) + 1;
      occurrences.set(key, occurrence);
      endIdx = Math.max(endIdx, st.votes.at(-1));
      st.label = `${st.kind === 'cobertura' ? 'Rodada' : 'Etapa'} ${st.number}${occurrence > 1 ? ` (retomada ${occurrence - 1})` : ''}`;
      st.occurrence = occurrence;
      st.end = endIdx;
      for (const t of st.votes) label[t] = stages.length + 1;
      stages.push(st);
    }
  }
  let init = null;
  for (const st of stages) {
    const agg = aggregate(n, votes.slice(0, st.end + 1));
    const fit = fitMAP(agg, sigma, init, { tol: 1e-7 });
    init = fit.s;
    const order = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => Math.round(fit.s[b] * 1e6) - Math.round(fit.s[a] * 1e6) || a - b);
    const pos = new Int32Array(n);
    order.forEach((i, p) => { pos[i] = p; });
    const group = new Int8Array(n);
    for (const i of order) group[i] = groupOf(pos[i], groups);
    st.n = order.length;
    st.R = Array.from(toElo(fit.s));
    st.pos = Array.from(pos);
    st.group = Array.from(group);
  }
  const G = groups.length + 1;
  const flows = [];
  for (let k = 0; k + 1 < stages.length; k++) {
    const m = Array.from({ length: G }, () => new Array(G).fill(0));
    for (let i = 0; i < n; i++) {
      const a = stages[k].group[i], b = stages[k + 1].group[i];
      if (a >= 0 && b >= 0) m[a][b]++;
    }
    flows.push(m);
  }
  return { stages, flows, groups, label: Array.from(label) };
}
