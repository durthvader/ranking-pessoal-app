// Etapas do chaveamento dinâmico.
// Agrupa os votos em blocos cronológicos de pelo menos 200 escolhas.
// Retomadas de cobertura e revisões ficam dentro do mesmo bloco.
// Ao fim de cada etapa o app reestima as pontuações só com os votos até ali e forma as faixas.

import { aggregate, fitMAP, toElo } from './bt.js';
import { groupOf } from './pairing.js';

// votes: [{w, l, phase, reason}] em ordem cronológica.
export function computeStages(n, votes, { sigma = 1.5, stageSize = 200, groups = [10, 25, 50, 100, 200, 350] } = {}) {
  const size = Number.isFinite(stageSize) ? Math.max(200, Math.floor(stageSize)) : 200;
  const label = new Int32Array(votes.length);
  const stages = [];
  for (let start = 0; start < votes.length; start += size) {
    const end = Math.min(start + size, votes.length) - 1;
    const number = stages.length + 1;
    const complete = end - start + 1 === size;
    const indices = [], phases = {};
    for (let t = start; t <= end; t++) {
      indices.push(t);
      label[t] = number;
      const phase = votes[t].phase || (votes[t].reason?.kind === 'cobertura' ? 'cobertura' : 'adaptativa');
      phases[phase] = (phases[phase] || 0) + 1;
    }
    stages.push({ kind: 'etapa', number, occurrence: 1, start, end, votes: indices,
      complete, target: size, phases, label: `Etapa ${number}${complete ? '' : ' (em andamento)'}` });
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
  return { stages, flows, groups, stageSize: size, label: Array.from(label) };
}
