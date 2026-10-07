import { h, clear, fmtDate, normName } from '../util.js';
import { photoImg, badge, toast, modal, confirmDialog } from './common.js';
import { evalSettings, voteExclusionReason } from '../store.js';
import { openParticipant } from './participants.js';
import { isOwner } from '../access.js';

const KIND = { vote: 'Voto', abstain: 'Rever depois', photo_problem: 'Problema na foto', audit: 'Auditoria' };
const PAGE = 60;

export function renderHistory(app, root, query = {}) {
  const conflictsBox = h('div');
  const controls = h('div', { class: 'row', style: { margin: '8px 0 12px' } });
  const list = h('div', { class: 'card', style: { padding: 0 } });
  const more = h('div', { style: { textAlign: 'center', margin: '12px' } });
  root.append(h('h1', null, 'Histórico'), conflictsBox, controls, list, more);
  const kind = h('select', { style: { maxWidth: '220px' } },
    h('option', { value: 'todos' }, 'Tudo'), h('option', { value: 'vote' }, 'Votos'), h('option', { value: 'abstain' }, 'Rever depois'),
    h('option', { value: 'photo_problem' }, 'Problemas de foto'), h('option', { value: 'audit' }, 'Auditorias'),
    h('option', { value: 'fora' }, 'Fora do cálculo'), h('option', { value: 'pendente' }, 'Aguardando envio'));
  const q = h('input', { type: 'search', placeholder: 'Filtrar por nome', style: { maxWidth: '240px' }, value: query.p ? (app.state.participants.get(query.p)?.name || '') : '' });
  controls.append(kind, q);
  let limit = PAGE;
  kind.addEventListener('change', () => { limit = PAGE; draw(); });
  q.addEventListener('input', () => { limit = PAGE; draw(); });

  function draw() {
    const s = app.state;
    drawConflicts();
    clear(list);
    clear(more);
    if (!s.activeEval) { list.append(h('div', { class: 'empty' }, 'Nenhuma avaliação ativa.')); return; }
    const settings = evalSettings(s);
    const name = (pid) => s.participants.get(pid)?.name || '?';
    const term = normName(q.value);
    let items = (s.decisions.get(s.activeEval) || []).slice().reverse();
    if (kind.value === 'fora') items = items.filter((d) => d.kind === 'vote' && voteExclusionReason(s, d, settings));
    else if (kind.value === 'pendente') items = items.filter((d) => d.pending);
    else if (kind.value !== 'todos') items = items.filter((d) => d.kind === kind.value);
    if (term) items = items.filter((d) => normName(name(d.a)).includes(term) || normName(name(d.b)).includes(term));
    if (!items.length) { list.append(h('div', { class: 'empty' }, 'Nada registrado neste filtro.')); return; }
    for (const d of items.slice(0, limit)) list.append(item(d, settings, name));
    if (items.length > limit) more.append(h('button', { class: 'btn', onclick: () => { limit += PAGE; draw(); } }, `Mostrar mais (${items.length - limit} restantes)`));
  }

  function item(d, settings, name) {
    const s = app.state;
    const pa = s.photos.get(d.pa), pb = s.photos.get(d.pb);
    const imgA = photoImg(app, pa, { cls: `thumb ${d.winner === d.a && d.kind !== 'abstain' && d.kind !== 'photo_problem' ? 'win' : ''}` });
    const imgB = photoImg(app, pb, { cls: `thumb ${d.winner === d.b && d.kind !== 'abstain' && d.kind !== 'photo_problem' ? 'win' : ''}` });
    const reason = d.kind === 'vote' || d.kind === 'audit' ? voteExclusionReason(s, d, settings) : null;
    const status = [];
    status.push(badge(KIND[d.kind] || d.kind, d.kind === 'vote' ? 'acc' : ''));
    if (d.conflict) status.push(badge('correções em conflito', 'err'));
    else if (d.state.status === 'anulado') status.push(badge(d.revisions.at(-1)?.why === 'desfazer' ? 'desfeito' : 'anulado', 'warn'));
    else if (d.revisions.length) status.push(badge('corrigido', 'warn'));
    if (reason && d.state.status !== 'anulado' && !d.conflict) status.push(badge('fora do cálculo: ' + reason));
    if (d.pending) status.push(badge('aguardando envio', 'warn'));
    if (d.kind === 'photo_problem') status.push(badge(`${d.target === 'LR' ? 'as duas' : d.target === 'L' ? 'esquerda' : 'direita'}: ${d.problem}`, 'err'));
    let txt;
    if (d.kind === 'vote' || d.kind === 'audit') txt = h('span', null, h('strong', null, name(d.winner)), ' escolhida em vez de ', name(d.winner === d.a ? d.b : d.a));
    else txt = h('span', null, `${name(d.a)} × ${name(d.b)}`);
    const acts = h('div', { class: 'row', style: { gap: '4px' } });
    if ((d.kind === 'vote' || d.kind === 'audit') && !d.conflict) {
      if (d.state.status === 'valido') {
        acts.append(h('button', { class: 'btn small', onclick: async () => {
          const other = d.winner === d.a ? d.b : d.a;
          if (await confirmDialog('Corrigir escolha', `Trocar a escolha para ${name(other)}? O voto original fica no histórico.`, 'Trocar')) {
            await app.revise(d.id, { status: 'valido', w: other }, 'correcao');
            toast('Escolha corrigida.');
          }
        } }, 'Trocar escolha'));
        acts.append(h('button', { class: 'btn small', onclick: async () => { await app.revise(d.id, { status: 'anulado', w: d.winner }, 'correcao'); toast('Voto anulado.'); } }, 'Anular'));
      } else {
        acts.append(h('button', { class: 'btn small', onclick: async () => { await app.revise(d.id, { status: 'valido', w: d.winner }, 'correcao'); toast('Voto restaurado.'); } }, 'Restaurar'));
      }
    } else if ((d.kind === 'abstain' || d.kind === 'photo_problem') && !d.conflict) {
      acts.append(h('button', { class: 'btn small', onclick: async () => { await app.revise(d.id, { status: d.state.status === 'valido' ? 'anulado' : 'valido' }, 'correcao'); } }, d.state.status === 'valido' ? 'Anular' : 'Restaurar'));
    }
    if (d.revisions.length) acts.append(h('button', { class: 'btn small ghost', onclick: () => showRevisions(d, name) }, `Revisões (${d.revisions.length})`));
    const dev = d.device === app.device.id ? 'este aparelho' : 'outro aparelho';
    return h('div', { class: 'hist-item' },
      h('div', { class: 'hist-pair' }, wrapClick(imgA, d.a), wrapClick(imgB, d.b)),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'who' }, txt), h('div', { class: 'row', style: { gap: '4px', marginTop: '4px' } }, status),
        h('div', { class: 'when' }, `${fmtDate(d.at)} · ${dev} · ${d.phase || ''}${d.ms ? ` · ${(d.ms / 1000).toFixed(1)} s para decidir` : ''}`)),
      acts);
  }

  function wrapClick(el, pid) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => openParticipant(app, pid));
    return el;
  }

  function showRevisions(d, name) {
    const lab = (st) => (st?.status === 'anulado' ? 'anulado' : st?.w ? `válido · escolhida ${name(st.w)}` : 'válido');
    modal('Revisões deste registro', h('div', null,
      h('p', null, `Original (${fmtDate(d.at)}): ${d.winner && d.kind !== 'abstain' ? 'escolhida ' + name(d.w) : KIND[d.kind]}`),
      h('ol', null, d.revisions.map((r) => h('li', null, `${fmtDate(r.at)} · ${r.why || 'correção'} · ${lab(r.state)} · ${r.device === app.device.id ? 'este aparelho' : 'outro aparelho'}`)))), [{ label: 'Fechar' }]);
  }

  function drawConflicts() {
    clear(conflictsBox);
    const s = app.state;
    const cs = s.conflicts;
    if (!cs.length) return;
    const name = (pid) => s.participants.get(pid)?.name || '?';
    const box = h('div', { class: 'notice err' }, h('strong', null, `${cs.length} conflito${cs.length > 1 ? 's' : ''} entre aparelhos. `),
      'Duas alterações foram feitas sobre a mesma informação sem que um aparelho visse a do outro. Nada foi sobrescrito: escolha qual versão vale.');
    for (const c of cs) {
      const row = h('div', { class: 'card', style: { marginTop: '8px' } });
      if (c.kind === 'voto') {
        const d = c.decision;
        row.append(h('p', null, `${name(d.a)} × ${name(d.b)} (${fmtDate(d.at)})`));
        for (const hd of c.heads) {
          const st = hd.value;
          const label = st?.status === 'anulado' ? 'Anular o voto' : `Manter ${name(st?.w)} como escolhida`;
          row.append(h('button', { class: 'btn small', style: { margin: '2px' }, onclick: () => app.revise(d.id, st, 'conflito', c.heads.map((x) => x.ev.id)) },
            `${label} (${hd.ev.device === app.device.id ? 'este aparelho' : 'outro aparelho'}, ${fmtDate(hd.ev.at)})`));
        }
      } else if (!isOwner(app.access)) {
        row.append(h('p', null, 'O catálogo aguarda revisão do administrador.'));
      } else if (c.kind === 'foto_principal') {
        row.append(h('p', null, `Foto principal de ${name(c.pid)}`));
        for (const hd of c.heads) {
          row.append(h('div', { class: 'row' }, photoImg(app, s.photos.get(hd.value), { cls: 'thumb' }),
            h('button', { class: 'btn small', onclick: () => app.setPrimary(c.pid, hd.value, c.heads.map((x) => x.ev.id)) }, `Usar esta (${fmtDate(hd.ev.at)})`)));
        }
      } else if (c.kind === 'participante') {
        row.append(h('p', null, `Campo "${c.field}" de ${name(c.pid)}`));
        for (const hd of c.heads) {
          row.append(h('button', { class: 'btn small', style: { margin: '2px' }, onclick: async () => {
            await app.addEvents([app.newEvent('participant_edit', { pid: c.pid, field: c.field, value: hd.value, prev: c.heads.map((x) => x.ev.id) })]);
          } }, `Usar "${hd.value}"`));
        }
      } else if (c.kind === 'duplicidade') {
        row.append(h('p', null, 'Decisão de duplicidade em conflito'), h('a', { href: '#/participantes?aba=duplicidades' }, 'Abrir duplicidades'));
      } else if (c.kind === 'avaliacoes_ativas') {
        row.append(h('p', null, 'Há mais de uma avaliação ativa (criadas em aparelhos diferentes).'), h('a', { href: '#/versoes' }, 'Abrir Versões e encerrar uma delas'));
      }
      box.append(row);
    }
    conflictsBox.append(box);
  }

  const off = app.on('state', draw);
  draw();
  return () => off();
}
