import { h, clear, fmtInt, fmtPct, fmtDate } from '../util.js';
import { badge, modal, toast, confirmDialog, section } from './common.js';
import { validVotes, evalSettings } from '../store.js';
import { rankingTable, decisionsTable, exportCsv, exportXlsx } from '../export.js';

export function buildSnapshot(app) {
  const s = app.state;
  const m = app.engine.model;
  const prog = app.engine.progress();
  const audits = app.engine.audits();
  const rows = rankingTable(app).map((r) => ({
    posicao: r.posicao, nome: r.nome, codigo: r.codigo, indice: r.indice_preferencia_elo,
    indice_inf: r.faixa_indice_inferior, indice_sup: r.faixa_indice_superior,
    pos_inf: r.posicao_faixa_inferior, pos_sup: r.posicao_faixa_superior,
    p1: r.chance_1o_lugar_estimada, ptop: r.chance_top10_estimada, comparacoes: r.comparacoes,
    vitorias: r.vitorias, derrotas: r.derrotas, sinais: r.sinais, foto_id: r.foto_id,
  }));
  return {
    created_at: new Date().toISOString(),
    settings: { ...evalSettings(s), sigma_usado: m?.sigmaUsed ?? evalSettings(s).sigma },
    votes_used: m?.votesUsed ?? 0,
    vote_ids: validVotes(s).map((d) => d.id),
    totals: { ...prog.kinds, valid: prog.valid },
    leader_p1: prog.top?.leaderP1 ?? null,
    contenders: prog.top?.contenders.length ?? null,
    audits: { total: audits.total, agree: audits.agree },
    ranking: rows,
  };
}

export function closeVersionDialog(app) {
  const s = app.state;
  const ev = s.evals.get(s.activeEval);
  if (!ev) return;
  const prog = app.engine.progress();
  modal('Encerrar e guardar esta versão', h('div', null,
    h('p', null, `"${ev.name}" será guardada com a data de hoje, as configurações, a lista atual e os ${fmtInt(prog.valid)} votos válidos usados no cálculo.`),
    h('p', { class: 'help' }, 'Depois de encerrar, você pode começar uma nova avaliação (por exemplo, com outras fotos) ou reabrir esta para continuar votando. O histórico completo continua disponível.')), [
    { label: 'Cancelar' },
    { label: 'Encerrar e guardar', cls: 'primary', fn: async () => {
      const snap = buildSnapshot(app);
      await app.addEvents([app.newEvent('eval_status', { status: 'encerrada', snapshot: snap, prev: s.headIds(`est:${ev.id}`) }, { evalId: ev.id })]);
      toast('Versão encerrada e guardada.');
      app.go('versoes');
    } },
  ]);
}

export function renderVersions(app, root) {
  const body = h('div');
  root.append(h('h1', null, 'Versões da avaliação'), body);

  function draw() {
    clear(body);
    const s = app.state;
    const evals = [...s.evals.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const active = s.evals.get(s.activeEval);
    if (active) {
      const prog = app.engine.progress();
      const st = active.settings;
      body.append(section(`Ativa: ${active.name}`,
        h('p', { class: 'muted' }, `Criada em ${fmtDate(active.createdAt)} · semente do sorteio ${active.seed}`),
        h('p', null, `${fmtInt(prog.valid)} escolhas válidas de ${fmtInt(st.budget)} planejadas.`),
        h('p', { class: 'help' }, `Prior: ${st.sigmaMode === 'auto' ? `σ estimado pelos votos (atual ${app.engine.model?.sigmaUsed?.toFixed(2) ?? '–'})` : `σ fixo = ${st.sigma}`} · cobertura mínima ${st.coverageMin} · troca de foto: ${st.photoPolicy === 'descartar' ? 'votos da foto anterior saem do cálculo' : 'votos continuam valendo'} · auditorias ${st.countAudits ? 'contam' : 'não contam'} no cálculo.`),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => exportCsv(app) }, 'Exportar CSV'),
          h('button', { class: 'btn', onclick: () => exportXlsx(app).catch((e) => toast(e.message, { type: 'err' })) }, 'Exportar XLSX'),
          h('button', { class: 'btn primary', onclick: () => closeVersionDialog(app) }, 'Encerrar e guardar esta versão'))));
    } else {
      body.append(h('div', { class: 'notice' }, 'Nenhuma avaliação ativa.'));
    }
    body.append(h('div', { class: 'row', style: { margin: '12px 0' } },
      h('button', { class: 'btn', onclick: () => newEvalDialog(app) }, 'Começar nova avaliação')));
    const closed = evals.filter((e) => e.status !== 'ativa');
    if (closed.length) {
      body.append(h('h2', null, 'Versões encerradas'));
      for (const e of closed) {
        const snap = e.snapshot;
        body.append(h('div', { class: 'card', style: { marginBottom: '10px' } },
          h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h3', null, e.name), badge('encerrada')),
          h('p', { class: 'muted' }, `Criada em ${fmtDate(e.createdAt)} · encerrada em ${fmtDate(e.closedAt)}`),
          snap ? h('p', null, `${fmtInt(snap.votes_used)} votos usados · líder: ${snap.ranking[0]?.nome || '–'} (chance estimada ${fmtPct(snap.leader_p1)}) · σ ${Number(snap.settings.sigma_usado).toFixed(2)}`) : h('p', { class: 'muted' }, 'Encerrada sem lista guardada.'),
          snap ? h('ol', { class: 'help' }, snap.ranking.slice(0, 10).map((r) => h('li', null, `${r.nome} (${Math.round(r.indice)})`))) : null,
          h('div', { class: 'row' },
            snap ? h('button', { class: 'btn small', onclick: () => showSnapshot(e) }, 'Ver lista completa') : null,
            snap ? h('button', { class: 'btn small', onclick: () => exportCsv(app, snap.ranking, `ranking_${slug(e.name)}`) }, 'CSV') : null,
            snap ? h('button', { class: 'btn small', onclick: () => exportXlsx(app, { rows: snap.ranking, decisions: decisionsTable(app, e.id), settings: snap.settings, name: `ranking_${slug(e.name)}` }) }, 'XLSX') : null,
            !active ? h('button', { class: 'btn small', onclick: async () => {
              if (await confirmDialog('Reabrir versão', 'A avaliação volta a ficar ativa e você pode continuar votando nela.', 'Reabrir')) {
                await app.addEvents([app.newEvent('eval_status', { status: 'ativa', prev: s.headIds(`est:${e.id}`) }, { evalId: e.id })]);
              }
            } }, 'Reabrir') : null)));
      }
    }
  }

  function showSnapshot(e) {
    const snap = e.snapshot;
    modal(`${e.name} · ${fmtDate(e.closedAt)}`, h('div', { style: { maxHeight: '60vh', overflow: 'auto' } },
      h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Pos.'), h('th', null, 'Nome'), h('th', { class: 'num' }, 'Índice'), h('th', null, 'Faixa'), h('th', { class: 'num' }, 'Comp.')),
        snap.ranking.map((r) => h('tr', null, h('td', null, r.posicao), h('td', null, r.nome), h('td', { class: 'num' }, Math.round(r.indice)), h('td', null, `${r.pos_inf}–${r.pos_sup}`), h('td', { class: 'num' }, r.comparacoes))))), [{ label: 'Fechar' }]);
  }

  const off = app.on('state', draw);
  const off2 = app.on('model', draw);
  draw();
  return () => { off(); off2(); };
}

function slug(s) {
  return String(s).normalize('NFKD').replace(/[^\w]+/g, '_').toLowerCase();
}

function newEvalDialog(app) {
  const name = h('input', { type: 'text', value: `Avaliação ${app.state.evals.size + 1}` });
  const copy = h('input', { type: 'checkbox', checked: true });
  modal('Começar nova avaliação', h('div', { class: 'form' },
    h('label', { class: 'field' }, h('span', null, 'Nome'), name),
    h('label', { class: 'check' }, copy, h('span', null, 'Copiar as configurações da avaliação atual')),
    h('p', { class: 'help' }, 'A nova avaliação começa sem votos e com um novo sorteio. A atual é encerrada e guardada. Votos antigos continuam no histórico e nos backups.')), [
    { label: 'Cancelar' },
    { label: 'Começar', cls: 'primary', fn: async () => {
      const s = app.state;
      if (s.activeEval) {
        const snap = buildSnapshot(app);
        await app.addEvents([app.newEvent('eval_status', { status: 'encerrada', snapshot: snap, prev: s.headIds(`est:${s.activeEval}`) }, { evalId: s.activeEval })]);
      }
      await app.newEvaluation(name.value.trim() || 'Nova avaliação', copy.checked ? evalSettings(app.state, s.activeEval) : {});
      toast('Nova avaliação iniciada.');
    } },
  ]);
}
