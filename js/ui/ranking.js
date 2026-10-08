import { h, clear, fmtInt, fmtPct, normName } from '../util.js';
import { photoImg, badge } from './common.js';
import { openParticipant } from './participants.js';
import { isGuest } from '../access.js';
import { isFrozenIssue } from '../store.js';

export const Z_OF_LEVEL = { 0.8: 1.2816, 0.9: 1.6449, 0.95: 1.96 };

export function rowFlags(r, settings) {
  const out = [];
  if (r.p1 >= 0.01) out.push(badge(`1º: ${fmtPct(r.p1)}`, 'acc'));
  if (r.tieNext || r.tiePrev) out.push(badge('empate numérico: preferência indefinida', 'warn'));
  else if (r.closeNext || r.closePrev) out.push(badge('ordem incerta com a vizinha', 'warn'));
  if (r.under) out.push(badge(`pouco avaliada (${r.comps})`, 'warn'));
  const defer = [...r.deferred.values()].reduce((a, b) => a + b, 0);
  if (defer) out.push(badge(`adiada ${defer}×`));
  for (const iss of r.issues) out.push(badge(iss, isFrozenIssue(iss) ? 'warn' : 'err'));
  return out;
}

export function renderRanking(app, root, query = {}) {
  const header = h('div');
  const controls = h('div', { class: 'row', style: { margin: '8px 0 12px' } });
  const body = h('div');
  root.append(h('h1', null, 'Ranking'), header, controls, body);
  const q = h('input', { type: 'search', placeholder: 'Buscar nome', style: { maxWidth: '260px' } });
  const filter = h('select', { style: { maxWidth: '240px' } },
    h('option', { value: 'todas' }, 'Todas'),
    h('option', { value: 'top50' }, 'Primeiras 50'),
    h('option', { value: 'duvida' }, 'Ordem incerta ou empate'),
    h('option', { value: 'pouco' }, 'Pouco avaliadas'),
    h('option', { value: 'candidatas' }, 'Candidatas ao 1º lugar'),
    h('option', { value: 'pendencia' }, 'Com pendência de foto'),
    h('option', { value: 'congeladas' }, 'Congeladas (fora dos confrontos)'));
  if (query.filtro && [...filter.options].some((o) => o.value === query.filtro)) filter.value = query.filtro;
  controls.append(q, filter);
  q.addEventListener('input', () => draw());
  filter.addEventListener('change', () => draw());

  function draw() {
    clear(header);
    clear(body);
    const m = app.engine.model;
    if (!app.state.participants.size) {
      body.append(h('div', { class: 'empty' }, isGuest(app.access) ? 'Aguarde a sincronização do catálogo.' : 'Importe as participantes para ver o ranking. ', !isGuest(app.access) ? h('a', { href: '#/participantes?aba=importar' }, 'Importar') : null));
      return;
    }
    if (!m) {
      body.append(h('div', { class: 'empty' }, app.engine.lastError ? 'Erro no cálculo: ' + app.engine.lastError : 'Calculando…'));
      return;
    }
    const settings = m.settings;
    const prog = app.engine.progress();
    const z = Z_OF_LEVEL[settings.level] || 1.6449;
    const lvl = Math.round(settings.level * 100);
    header.append(h('div', { class: prog.valid >= settings.budget ? 'notice ok' : 'notice' },
      prog.valid >= settings.budget
        ? `Orçamento de ${fmtInt(settings.budget)} escolhas atingido. A lista continua sendo uma estimativa: veja em Progresso as posições que ainda têm dúvida.`
        : `Ranking em estimativa: ${fmtInt(prog.valid)} de ${fmtInt(settings.budget)} escolhas válidas. As posições mudam conforme você vota.`,
      ' ', h('span', { class: 'help' }, `Índice de preferência em escala Elo; ± indica a faixa de ${lvl}%. Faixa de posição: intervalo com ${lvl}% de chance estimada. Chances de 1º lugar são estimativas condicionadas ao modelo e aos votos${isGuest(app.access) ? '' : ` (σ do prior: ${m.sigmaUsed ? m.sigmaUsed.toFixed(2) : settings.sigma})`}.`)));
    let rows = app.engine.rankingRows();
    const term = normName(q.value);
    if (term) rows = rows.filter((r) => normName(r.name).includes(term));
    const f = filter.value;
    if (f === 'top50') rows = rows.filter((r) => r.pos <= 50);
    if (f === 'duvida') rows = rows.filter((r) => r.closeNext || r.closePrev || r.tieNext || r.tiePrev);
    if (f === 'pouco') rows = rows.filter((r) => r.under);
    if (f === 'candidatas') rows = rows.filter((r) => r.p1 >= 0.01 || r.lo === 1);
    if (f === 'pendencia') rows = rows.filter((r) => r.issues.some((i) => !isFrozenIssue(i)));
    if (f === 'congeladas') rows = rows.filter((r) => r.frozen);
    if (!rows.length) { body.append(h('div', { class: 'empty' }, 'Nenhuma participante neste filtro.')); return; }
    const wide = window.innerWidth > 900;
    if (wide) {
      const tb = h('tbody');
      for (const r of rows) {
        const tr = h('tr', { class: 'clickable', onclick: () => openParticipant(app, r.pid) },
          h('td', { class: 'num' }, h('b', null, r.pos)),
          h('td', null, photoImg(app, r.photo, { cls: 'thumb sm' })),
          h('td', null, r.name),
          h('td', { class: 'num' }, h('b', null, fmtInt(r.R)), h('span', { class: 'muted' }, ` ±${fmtInt(z * r.sdR)}`)),
          h('td', null, rangeBar(r, m.n), h('small', { class: 'muted' }, ` ${r.lo}–${r.hi}`)),
          h('td', { class: 'num' }, fmtPct(r.p1, r.p1 < 0.1 && r.p1 > 0 ? 1 : 0)),
          h('td', { class: 'num' }, fmtPct(r.pTop)),
          h('td', { class: 'num' }, r.comps),
          h('td', { class: 'num' }, `${r.wins}–${r.losses}`),
          h('td', null, h('div', { class: 'row', style: { gap: '4px' } }, rowFlags(r, settings))));
        tb.append(tr);
      }
      body.append(h('div', { class: 'tablewrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null,
          h('th', { class: 'num' }, 'Pos.'), h('th', null, ''), h('th', null, 'Nome'),
          h('th', { class: 'num', title: 'Índice de preferência em escala Elo' }, 'Índice'),
          h('th', null, `Faixa de posição (${lvl}%)`), h('th', { class: 'num' }, 'Chance de 1º'),
          h('th', { class: 'num' }, `Top ${m.topK}`), h('th', { class: 'num' }, 'Comp.'), h('th', { class: 'num' }, 'V–D'), h('th', null, 'Sinais'))),
        tb)));
    } else {
      const list = h('div', { class: 'rank-list card', style: { padding: 0, overflow: 'hidden' } });
      for (const r of rows) {
        list.append(h('div', { class: 'rank-item', onclick: () => openParticipant(app, r.pid) },
          h('div', { class: 'pos' }, r.pos),
          photoImg(app, r.photo, { cls: 'thumb' }),
          h('div', { style: { minWidth: 0 } },
            h('div', { class: 'name' }, r.name),
            h('div', { class: 'meta' }, `posição ${r.lo}–${r.hi}`, ' · ', `${r.comps} comp.`, ' · ', `${r.wins}–${r.losses}`),
            h('div', { class: 'meta' }, rowFlags(r, settings))),
          h('div', { class: 'score' }, h('b', null, fmtInt(r.R)), h('div', { class: 'muted', style: { fontSize: '12px' } }, `±${fmtInt(z * r.sdR)}`))));
      }
      body.append(list);
    }
    body.append(h('p', { class: 'help', style: { marginTop: '10px' } },
      'Ordem pela estimativa central. Em empate numérico, a lista usa o código da participante como critério técnico estável; a preferência entre elas continua indefinida.'));
  }

  const off1 = app.on('model', draw);
  const off2 = app.on('state', draw);
  draw();
  return () => { off1(); off2(); };
}

export function rangeBar(r, n) {
  const left = ((r.lo - 1) / n) * 100;
  const width = Math.max(1.5, ((r.hi - r.lo + 1) / n) * 100);
  const mid = ((r.pos - 1) / n) * 100;
  return h('span', { class: 'rangebar', title: `Faixa provável de posição: ${r.lo}–${r.hi}` },
    h('span', { style: { left: `${left}%`, width: `${width}%` } }), h('i', { style: { left: `${mid}%` } }));
}
