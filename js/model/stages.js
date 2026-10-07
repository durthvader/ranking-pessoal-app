// Etapas do chaveamento dinâmico.
// Rodadas de cobertura: um voto pertence à rodada r quando a participante menos avaliada do par
// faz ali sua r-ésima comparação válida (como as rodadas do sistema suíço).
// Depois da cobertura, cada bloco de `stageSize` escolhas forma uma etapa.
// Ao fim de cada etapa o app reestima as pontuações só com os votos até ali e forma as faixas.

import { aggregate, fitMAP, toElo } from './bt.js';
import { groupOf } from './pairing.js';

// votes: [{w, l, k}] em ordem cronológica (k = posição no histórico)
export function computeStages(n, votes, { sigma = 1.5, coverageMin = 6, stageSize = 250, groups = [10, 25, 50, 100, 200, 350] } = {}) {
  const counts = new Int32Array(n);
  const label = new Int32Array(votes.length);
  let adaptiveSeen = 0;
  for (let t = 0; t < votes.length; t++) {
    const { w, l } = votes[t];
    const r = Math.min(counts[w], counts[l]) + 1;
    if (r <= coverageMin) label[t] = r;
    else {
      label[t] = coverageMin + 1 + Math.floor(adaptiveSeen / stageSize);
      adaptiveSeen++;
    }
    counts[w]++; counts[l]++;
  }
  const maxLabel = votes.length ? Math.max(...label) : 0;
  const stages = [];
  let endIdx = -1;
  for (let L = 1; L <= maxLabel; L++) {
    const idx = [];
    for (let t = 0; t < votes.length; t++) if (label[t] === L) idx.push(t);
    if (!idx.length) continue;
    endIdx = Math.max(endIdx, idx[idx.length - 1]);
    stages.push({
      label: L <= coverageMin ? `Rodada ${L}` : `Etapa ${L - coverageMin}`,
      kind: L <= coverageMin ? 'cobertura' : 'etapa',
      number: L <= coverageMin ? L : L - coverageMin,
      votes: idx,
      end: endIdx,
    });
  }
  let init = null;
  for (const st of stages) {
    const agg = aggregate(n, votes.slice(0, st.end + 1));
    const fit = fitMAP(agg, sigma, init, { tol: 1e-7 });
    init = fit.s;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => fit.s[b] - fit.s[a] || a - b);
    const pos = new Int32Array(n);
    order.forEach((i, p) => { pos[i] = p; });
    const group = new Int8Array(n);
    for (let i = 0; i < n; i++) group[i] = groupOf(pos[i], groups);
    st.R = Array.from(toElo(fit.s));
    st.pos = Array.from(pos);
    st.group = Array.from(group);
  }
  const G = groups.length + 1;
  const flows = [];
  for (let k = 0; k + 1 < stages.length; k++) {
    const m = Array.from({ length: G }, () => new Array(G).fill(0));
    for (let i = 0; i < n; i++) m[stages[k].group[i]][stages[k + 1].group[i]]++;
    flows.push(m);
  }
  return { stages, flows, groups, label: Array.from(label) };
}
