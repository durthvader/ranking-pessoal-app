// Exportação do ranking em CSV (separador ";" e vírgula decimal, para o Excel em português) e XLSX.

import { downloadBlob, stamp } from './util.js';
import { xlsxLib } from './backup.js';
import { evalSettings, voteExclusionReason } from './store.js';
import { Z_OF_LEVEL } from './ui/ranking.js';

function flagsText(r) {
  const f = [];
  if (r.tieNext || r.tiePrev) f.push('empate numérico: preferência indefinida');
  else if (r.closeNext || r.closePrev) f.push('ordem incerta com a vizinha');
  if (r.under) f.push('pouco avaliada');
  const d = [...(r.deferred?.values?.() || [])].reduce((a, b) => a + b, 0);
  if (d) f.push(`adiada ${d}x`);
  for (const i of r.issues || []) f.push(i);
  return f.join('; ');
}

export function rankingTable(app) {
  const m = app.engine.model;
  const s = app.state;
  if (!m) return [];
  const z = Z_OF_LEVEL[m.settings.level] || 1.645;
  const rows = app.engine.rankingRows();
  const stats = app.engine.stats();
  return rows.map((r) => {
    const opp = stats.get(r.pid).opponents.map((o) => `${s.participants.get(o.opp)?.name || '?'} (${o.won ? 'V' : 'D'})`);
    return {
      posicao: r.pos,
      nome: r.name,
      codigo: r.code,
      indice_preferencia_elo: Math.round(r.R * 10) / 10,
      faixa_indice_inferior: Math.round((r.R - z * r.sdR) * 10) / 10,
      faixa_indice_superior: Math.round((r.R + z * r.sdR) * 10) / 10,
      posicao_faixa_inferior: r.lo,
      posicao_faixa_superior: r.hi,
      chance_1o_lugar_estimada: Math.round(r.p1 * 10000) / 10000,
      chance_top10_estimada: Math.round(r.pTop * 10000) / 10000,
      comparacoes: r.comps,
      vitorias: r.wins,
      derrotas: r.losses,
      adiamentos: r.abstains,
      sinais: flagsText(r),
      foto_id: r.part.primary || '',
      foto_origem: r.photo?.origin || '',
      foto_epoca: r.photo?.era || r.part.era || '',
      adversarias: opp.join(', '),
    };
  });
}

export function decisionsTable(app, evalId = app.state.activeEval) {
  const s = app.state;
  const settings = evalSettings(s, evalId);
  const name = (pid) => s.participants.get(pid)?.name || pid;
  return (s.decisions.get(evalId) || []).map((d) => ({
    id: d.id,
    data: d.at,
    tipo: { vote: 'voto', abstain: 'rever depois', photo_problem: 'problema na foto', audit: 'auditoria' }[d.kind] || d.kind,
    esquerda: name(d.a),
    direita: name(d.b),
    foto_esquerda: d.pa,
    foto_direita: d.pb,
    escolhida: d.winner ? name(d.winner) : '',
    lado_escolhido: d.side === 'L' ? 'esquerda/cima' : d.side === 'R' ? 'direita/baixo' : '',
    disposicao: d.layout || '',
    fase: d.phase || '',
    situacao: d.conflict ? 'conflito' : d.state.status,
    fora_do_calculo: voteExclusionReason(s, d, settings) || '',
    auditoria_de: d.of || '',
    problema: d.problem || '',
    aparelho: d.device,
    sessao: d.session,
    tempo_decisao_ms: d.ms ?? '',
  }));
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    if (typeof v === 'number') return String(v).replace('.', ',');
    const s = String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(';'), ...rows.map((r) => cols.map((c) => esc(r[c])).join(';'))].join('\r\n');
}

export function exportCsv(app, rows = rankingTable(app), name = 'ranking') {
  const blob = new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, `${name}_${stamp()}.csv`);
}

export async function exportXlsx(app, { rows = rankingTable(app), decisions = decisionsTable(app), settings = evalSettings(app.state), name = 'ranking', extra = {} } = {}) {
  const XLSX = await xlsxLib();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Ranking');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(decisions.length ? decisions : [{ aviso: 'sem confrontos' }]), 'Confrontos');
  const m = app.engine.model;
  const conf = Object.entries({ ...settings, sigma_usado: m?.sigmaUsed ?? settings.sigma, ...extra })
    .map(([k, v]) => ({ configuracao: k, valor: Array.isArray(v) ? v.join(', ') : String(v) }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(conf), 'Configurações');
  const notes = [
    'Ranking pessoal de preferência visual entre as participantes cadastradas, considerando as fotos usadas e os votos desta avaliação.',
    'Modelo: Bradley–Terry com prior gaussiano N(0, σ²) igual para todas; P(i escolhida em vez de j) = 1/(1+exp(-(s_i - s_j))).',
    'Índice de preferência em escala Elo: R = 1500 + (400/ln 10)·(s - média(s)).',
    'Faixas de índice e de posição: aproximação de Laplace da posterior e amostragem conjunta (Monte Carlo).',
    'Chances de 1º lugar e de top 10 são estimativas condicionadas ao modelo e aos votos.',
    'Abstenções ("Rever depois") e problemas de foto não entram no cálculo. Votos de auditoria ficam fora por padrão.',
    `Exportado em ${new Date().toLocaleString('pt-BR')}.`,
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(notes.map((t) => [t])), 'Leia-me');
  XLSX.writeFile(wb, `${name}_${stamp()}.xlsx`, { compression: true });
}
