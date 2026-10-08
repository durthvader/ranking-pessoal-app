import { h, clear, fmtInt, normName, fmtDate } from '../util.js';
import { badge, photoImg } from './common.js';
import { groupLabel } from '../model/pairing.js';
import { openParticipant } from './participants.js';

const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const c of kids) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export function renderBracket(app, root, query = {}) {
  const intro = h('p', { class: 'help' },
    'Rodadas: confrontos da fase de cobertura, conforme a rodada registrada ao votar. Etapas: blocos de escolhas da fase adaptativa. '
    + 'Ao fim de cada rodada ou etapa, o app reestima as pontuações só com os votos até ali e refaz as faixas. O ranking mantém as participantes congeladas e seus votos. '
    + 'Uma cobertura retomada aparece depois das etapas já realizadas. Todas as participantes atuais aparecem desde o início; as novas começam com zero votos nas fases anteriores. '
    + 'Faixas em azul mostram quem permaneceu; faixas em laranja mostram quem mudou de faixa.');
  const pick = h('input', { type: 'search', placeholder: 'Ver o caminho de… (nome)', list: 'rp-names', style: { maxWidth: '320px' } });
  const datalist = h('datalist', { id: 'rp-names' });
  const chart = h('div', { class: 'bracket-wrap' }, h('div', { class: 'empty' }, 'Calculando etapas…'));
  const pathBox = h('div', { style: { marginTop: '12px' } });
  const summary = h('div', { style: { marginTop: '12px' } });
  root.append(h('h1', null, 'Chaveamento'), intro, h('div', { class: 'row', style: { marginBottom: '10px' } }, pick, datalist), chart, pathBox, summary);
  let data = null;
  let selected = query.p || null;
  let alive = true;
  let loadId = 0;

  for (const p of app.state.participants.values()) if (p.status !== 'excluida') datalist.append(h('option', { value: p.name }));
  if (selected) pick.value = app.state.participants.get(selected)?.name || '';
  pick.addEventListener('change', () => {
    const t = normName(pick.value);
    const p = [...app.state.participants.values()].find((x) => normName(x.name) === t);
    selected = p?.pid || null;
    draw();
  });

  async function load() {
    const request = ++loadId;
    try {
      const d = await app.engine.stages();
      if (!alive || request !== loadId) return;
      data = d;
      draw();
    } catch (e) {
      if (!alive || request !== loadId) return;
      clear(chart);
      chart.append(h('div', { class: 'notice err' }, 'Erro ao calcular etapas: ' + e.message));
    }
  }

  function draw() {
    clear(chart);
    clear(pathBox);
    clear(summary);
    if (!data) { chart.append(h('div', { class: 'empty' }, 'Calculando etapas…')); return; }
    const { stages, flows, groups, pids, index } = data;
    if (!stages.length) { chart.append(h('div', { class: 'empty' }, 'Ainda não há votos válidos nesta avaliação.')); return; }
    const n = pids.length;
    const G = groups.length + 1;
    const bounds = [0, ...groups.map((g) => Math.min(g, n)), n];
    const sizes = Array.from({ length: G }, (_, g) => Math.max(0, bounds[g + 1] - bounds[g]));
    const colW = 104, blockW = 34, blockH = 46, gap = 10, top = 36, left = 92;
    const width = left + stages.length * colW + 20;
    const height = top + G * (blockH + gap) + 10;
    const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Chaveamento por faixas ao longo das etapas' });
    const yOf = (g) => top + g * (blockH + gap);
    const xOf = (k) => left + k * colW;
    // rótulos das faixas
    for (let g = 0; g < G; g++) {
      if (!sizes[g]) continue;
      svg.append(s('text', { x: 6, y: yOf(g) + blockH / 2 + 4 }, groupLabel(g, groups, n)));
    }
    // fluxos
    for (let k = 0; k < flows.length; k++) {
      const M = flows[k];
      const outOff = new Array(G).fill(0), inOff = new Array(G).fill(0);
      const pairs = [];
      for (let a = 0; a < G; a++) for (let b = 0; b < G; b++) if (M[a][b]) pairs.push([a, b, M[a][b]]);
      pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      const inOrder = pairs.slice().sort((p, q) => p[1] - q[1] || p[0] - q[0]);
      const inStart = new Map();
      for (const [a, b, c] of inOrder) { inStart.set(`${a}-${b}`, inOff[b]); inOff[b] += c; }
      for (const [a, b, c] of pairs) {
        const h1 = (c / sizes[a]) * blockH, h2 = (c / sizes[b]) * blockH;
        const y1 = yOf(a) + (outOff[a] / sizes[a]) * blockH;
        const y2 = yOf(b) + (inStart.get(`${a}-${b}`) / sizes[b]) * blockH;
        outOff[a] += c;
        const x1 = xOf(k) + blockW, x2 = xOf(k + 1);
        const mx = (x1 + x2) / 2;
        const d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2} L${x2},${y2 + h2} C${mx},${y2 + h2} ${mx},${y1 + h1} ${x1},${y1 + h1} Z`;
        svg.append(s('path', { d, class: a === b ? 'flowpath' : 'flowpath move' }, s('title', null, `${groupLabel(a, groups, n)} → ${groupLabel(b, groups, n)}: ${c}`)));
      }
    }
    // blocos e cabeçalhos
    const selIdx = selected != null ? index.get(selected) : null;
    stages.forEach((st, k) => {
      svg.append(s('text', { x: xOf(k) - 4, y: 14, class: 'muted' }, `${st.kind === 'cobertura' ? 'R' : 'E'}${st.number}${st.occurrence > 1 ? ` (${st.occurrence})` : ''}`, s('title', null, st.label)));
      svg.append(s('text', { x: xOf(k) - 4, y: 27, class: 'muted' }, `${st.votes.length} conf.`));
      for (let g = 0; g < G; g++) {
        if (!sizes[g]) continue;
        let entrants = 0;
        if (k > 0) for (let i = 0; i < n; i++) if (st.group[i] === g && stages[k - 1].group[i] !== g) entrants++;
        const hl = selIdx != null && st.group[selIdx] === g;
        svg.append(s('rect', { x: xOf(k), y: yOf(g), width: blockW, height: blockH, rx: 5, class: `gblock ${hl ? 'hl' : ''}` },
          s('title', null, `${st.label} · ${groupLabel(g, groups, n)}${k > 0 ? ` · ${entrants} entraram nesta faixa` : ''}`)));
        if (k > 0 && entrants) svg.append(s('text', { x: xOf(k) + 3, y: yOf(g) + blockH / 2 + 4 }, `+${entrants}`));
      }
    });
    // caminho da participante
    if (selIdx != null) {
      const pts = stages.map((st, k) => {
        const g = st.group[selIdx];
        const within = (st.pos[selIdx] - bounds[g]) / Math.max(1, sizes[g]);
        return [xOf(k) + blockW / 2, yOf(g) + 4 + within * (blockH - 8)];
      });
      svg.append(s('polyline', { points: pts.map((p) => p.join(',')).join(' '), class: 'pathline' }));
      pts.forEach(([x, y], k) => svg.append(s('circle', { cx: x, cy: y, r: 4, class: 'pathdot' }, s('title', null, `${stages[k].label}: ${stages[k].pos[selIdx] + 1}ª posição, índice ${Math.round(stages[k].R[selIdx])}`))));
    }
    chart.append(svg);

    // tabela do caminho
    if (selIdx != null) {
      const p = app.state.participants.get(selected);
      const name = (pid) => app.state.participants.get(pid)?.name || '?';
      const tb = h('tbody');
      stages.forEach((st, k) => {
        const games = st.votes.map((t) => data.decs[t]).filter((d) => d.a === selected || d.b === selected);
        tb.append(h('tr', null,
          h('td', null, st.label),
          h('td', null, groupLabel(st.group[selIdx], groups, n), k > 0 && stages[k - 1].group[selIdx] !== st.group[selIdx] ? h('span', null, ' ', badge(st.group[selIdx] < stages[k - 1].group[selIdx] ? 'subiu' : 'desceu', st.group[selIdx] < stages[k - 1].group[selIdx] ? 'ok' : 'warn')) : null),
          h('td', { class: 'num' }, `${st.pos[selIdx] + 1}º`),
          h('td', { class: 'num' }, fmtInt(st.R[selIdx])),
          h('td', null, games.length ? games.map((d) => {
            const won = d.winner === selected;
            const opp = d.a === selected ? d.b : d.a;
            return h('div', { style: { fontSize: '13px' } }, won ? badge('V', 'ok') : badge('D', 'err'), ' ', name(opp));
          }) : h('span', { class: 'muted' }, 'sem confronto (folga)'))));
      });
      pathBox.append(h('div', { class: 'card' },
        h('div', { class: 'row', style: { justifyContent: 'space-between' } },
          h('h2', null, `Caminho de ${p?.name || '?'}`), h('button', { class: 'btn small', onclick: () => openParticipant(app, selected) }, 'Abrir ficha')),
        h('p', { class: 'help' }, 'Posição e índice ao fim de cada rodada ou etapa, calculados só com os votos até ali. Folgas não mudam pontuação nem contagens.'),
        h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, h('th', null, 'Etapa'), h('th', null, 'Faixa'), h('th', { class: 'num' }, 'Posição'), h('th', { class: 'num' }, 'Índice'), h('th', null, 'Confrontos'))), tb))));
    }
    // resumo das etapas
    const rows = stages.map((st, k) => {
      let moves = 0;
      if (k > 0) for (let i = 0; i < n; i++) if (st.group[i] !== stages[k - 1].group[i]) moves++;
      return h('tr', null, h('td', null, st.label), h('td', { class: 'num' }, st.votes.length), h('td', { class: 'num' }, k ? moves : '–'),
        h('td', null, pids[st.pos.indexOf(0)] ? app.state.participants.get(pids[st.pos.indexOf(0)])?.name : '–'));
    });
    summary.append(h('div', { class: 'card' }, h('h2', null, 'Etapas'),
      h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Etapa'), h('th', { class: 'num' }, 'Confrontos'), h('th', { class: 'num' }, 'Mudanças de faixa'), h('th', null, 'Líder ao fim'))), h('tbody', null, rows)))));
  }

  const off = app.on('model', () => { data = null; load(); });
  load();
  return () => { alive = false; off(); };
}

export { photoImg, fmtDate };
