// Reconstrói o estado do app a partir do log de eventos (append-only).
//
// Edições (correções de voto, troca de foto, nome, status, configurações) formam "cadeias":
// cada revisão aponta em `prev` para a(s) versão(ões) que o aparelho conhecia. Se dois aparelhos
// editam a mesma coisa a partir da mesma versão, a cadeia fica com duas pontas (conflito).
// Nada é sobrescrito em silêncio: o conflito aparece para o usuário escolher, e a escolha vira
// uma nova revisão com `prev` apontando para as duas pontas.

import { DEFAULT_EVAL_SETTINGS, DEFAULT_PREFS } from './settings.js';
import { deepEqual, normName } from './util.js';

const DECISION_TYPES = new Set(['vote', 'abstain', 'photo_problem', 'audit']);

export function sortEvents(events) {
  return events.slice().sort((a, b) => {
    const sa = a.seq ?? Number.MAX_SAFE_INTEGER, sb = b.seq ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

class Chains {
  constructor() { this.map = new Map(); }
  get(key) {
    let c = this.map.get(key);
    if (!c) { c = { rootId: null, rootValue: undefined, revs: [] }; this.map.set(key, c); }
    return c;
  }
  root(key, id, value) { const c = this.get(key); c.rootId = id; c.rootValue = value; }
  rev(key, ev, value) { this.get(key).revs.push({ ev, value }); }
  resolve(key, fallback) {
    const c = this.map.get(key);
    if (!c) return { value: fallback, conflict: false, heads: [], revs: [] };
    if (!c.revs.length) return { value: c.rootValue === undefined ? fallback : c.rootValue, conflict: false, heads: [], revs: [] };
    const referenced = new Set();
    for (const r of c.revs) for (const p of r.ev.data?.prev || []) referenced.add(p);
    const heads = c.revs.filter((r) => !referenced.has(r.ev.id));
    const order = (r) => [r.ev.seq ?? Number.MAX_SAFE_INTEGER, r.ev.at];
    heads.sort((a, b) => {
      const [sa, ta] = order(a), [sb, tb] = order(b);
      return sa - sb || (ta < tb ? -1 : ta > tb ? 1 : 0);
    });
    if (!heads.length) {
      // ciclo improvável: usa a última revisão
      const last = c.revs[c.revs.length - 1];
      return { value: last.value, conflict: false, heads: [last], revs: c.revs };
    }
    const allSame = heads.every((hd) => deepEqual(hd.value, heads[0].value));
    const latest = heads[heads.length - 1];
    return { value: latest.value, conflict: !allSame, heads, revs: c.revs };
  }
  // ids das pontas atuais (para usar como `prev` numa nova revisão)
  headIds(key) {
    const c = this.map.get(key);
    if (!c) return [];
    if (!c.revs.length) return c.rootId ? [c.rootId] : [];
    const referenced = new Set();
    for (const r of c.revs) for (const p of r.ev.data?.prev || []) referenced.add(p);
    const heads = c.revs.filter((r) => !referenced.has(r.ev.id)).map((r) => r.ev.id);
    return heads.length ? heads : [c.revs[c.revs.length - 1].ev.id];
  }
}

export function materialize(rawEvents) {
  const events = sortEvents(rawEvents);
  const chains = new Chains();
  const participants = new Map();
  const photos = new Map();
  const evals = new Map();
  const decisionsById = new Map();
  const decisionsList = [];
  const primaryMarks = new Map(); // id do evento de foto principal → decisões registradas antes dele
  const importReports = [];
  const problemReports = [];
  const resolvedReports = new Set();
  let pending = 0;

  for (const ev of events) {
    if (ev.pending) pending++;
    const d = ev.data || {};
    switch (ev.type) {
      case 'participant_created': {
        if (participants.has(d.pid)) break;
        participants.set(d.pid, {
          pid: d.pid, code: d.code, name: d.name, meta: d.meta || {}, flags: d.flags || [],
          createdEv: ev.id, createdAt: ev.at, photos: [], import: d.import,
        });
        chains.root(`pe:${d.pid}:name`, ev.id, d.name);
        chains.root(`pe:${d.pid}:status`, ev.id, 'ativa');
        chains.root(`pe:${d.pid}:notes`, ev.id, '');
        chains.root(`pe:${d.pid}:era`, ev.id, d.meta?.epoca_sugerida || '');
        chains.root(`pp:${d.pid}`, ev.id, null);
        break;
      }
      case 'participant_edit':
        chains.rev(`pe:${d.pid}:${d.field}`, ev, d.value);
        break;
      case 'photo_added': {
        if (photos.has(d.photo)) break;
        photos.set(d.photo, { ...d, addedEv: ev.id, addedAt: ev.at, device: ev.device });
        chains.root(`pr:${d.photo}`, ev.id, d.review || 'ok');
        break;
      }
      case 'photo_primary':
        primaryMarks.set(ev.id, decisionsList.length);
        chains.rev(`pp:${d.pid}`, ev, d.photo);
        break;
      case 'photo_review':
        chains.rev(`pr:${d.photo}`, ev, d.status);
        break;
      case 'photo_resolve':
        for (const r of d.reports || []) resolvedReports.add(r);
        break;
      case 'eval_created': {
        if (evals.has(ev.eval)) break;
        evals.set(ev.eval, { id: ev.eval, name: d.name, seed: d.seed, createdAt: ev.at, createdEv: ev.id,
          baseSettings: { ...DEFAULT_EVAL_SETTINGS, ...(d.settings || {}) } });
        chains.root(`es:${ev.eval}`, ev.id, { ...DEFAULT_EVAL_SETTINGS, ...(d.settings || {}) });
        chains.root(`est:${ev.eval}`, ev.id, { status: 'ativa' });
        break;
      }
      case 'eval_settings':
        chains.rev(`es:${ev.eval}`, ev, { ...DEFAULT_EVAL_SETTINGS, ...(d.values || {}) });
        break;
      case 'eval_status':
        chains.rev(`est:${ev.eval}`, ev, { status: d.status, snapshot: d.snapshot || null, closedAt: ev.at });
        break;
      case 'revise':
        chains.rev(`r:${d.target}`, ev, d.state);
        break;
      case 'dup_review':
        chains.rev(`dup:${d.key}`, ev, { decision: d.decision, keep: d.keep || null });
        break;
      case 'prefs':
        chains.rev('prefs', ev, { ...DEFAULT_PREFS, ...(d.values || {}) });
        break;
      case 'import_report':
        importReports.push({ ev, ...d });
        break;
      default:
        if (DECISION_TYPES.has(ev.type)) {
          if (decisionsById.has(ev.id)) break;
          const dec = {
            id: ev.id, kind: ev.type, eval: ev.eval, a: d.a, b: d.b, pa: d.pa, pb: d.pb,
            w: d.w ?? null, side: d.side, layout: d.layout, phase: d.phase, reason: d.reason,
            of: d.of ?? null, target: d.target, problem: d.problem, note: d.note,
            at: ev.at, seq: ev.seq ?? null, device: ev.device, session: ev.session,
            shown: d.shown, ms: d.ms, pending: !!ev.pending, ord: decisionsList.length,
          };
          decisionsById.set(ev.id, dec);
          decisionsList.push(dec);
          chains.root(`r:${ev.id}`, ev.id, { status: 'valido', w: d.w ?? null });
          if (ev.type === 'photo_problem') problemReports.push(dec);
        }
    }
  }

  const conflicts = [];
  // participantes
  for (const p of participants.values()) {
    for (const field of ['name', 'status', 'notes', 'era']) {
      const r = chains.resolve(`pe:${p.pid}:${field}`);
      p[field] = r.value;
      if (r.conflict) conflicts.push({ key: `pe:${p.pid}:${field}`, kind: 'participante', field, pid: p.pid, heads: r.heads });
    }
    const pr = chains.resolve(`pp:${p.pid}`, null);
    p.primary = pr.value;
    p.primaryConflict = pr.conflict;
    if (pr.conflict) conflicts.push({ key: `pp:${p.pid}`, kind: 'foto_principal', pid: p.pid, heads: pr.heads });
    p.primaryHistory = pr.revs.map((r) => ({ photo: r.value, at: r.ev.at, device: r.ev.device, id: r.ev.id }));
    // decisões registradas antes da foto principal atual (0 quando a foto veio na importação)
    const head = pr.heads[pr.heads.length - 1];
    p.primaryMark = head ? (primaryMarks.get(head.ev.id) ?? 0) : 0;
  }
  for (const ph of photos.values()) {
    const p = participants.get(ph.pid);
    if (p) p.photos.push(ph.photo);
    const r = chains.resolve(`pr:${ph.photo}`, 'ok');
    ph.reviewStatus = r.value; // 'pendente' | 'confirmada' | 'ok'
    ph.problems = [];
  }
  // decisões e revisões
  for (const dec of decisionsList) {
    const r = chains.resolve(`r:${dec.id}`);
    dec.state = r.value || { status: 'valido', w: dec.w };
    dec.conflict = r.conflict;
    dec.revisions = r.revs.map((x) => ({ id: x.ev.id, at: x.ev.at, device: x.ev.device, state: x.value, why: x.ev.data?.why }));
    dec.valid = dec.state.status === 'valido' && !dec.conflict;
    dec.winner = dec.state.w ?? dec.w;
    if (r.conflict) conflicts.push({ key: `r:${dec.id}`, kind: 'voto', target: dec.id, decision: dec, heads: r.heads });
  }
  for (const rep of problemReports) {
    if (!rep.valid || resolvedReports.has(rep.id)) continue;
    const targets = rep.target === 'LR' ? [rep.pa, rep.pb] : rep.target === 'L' ? [rep.pa] : [rep.pb];
    for (const t of targets) photos.get(t)?.problems.push(rep);
  }
  // avaliações
  for (const e of evals.values()) {
    const rs = chains.resolve(`es:${e.id}`);
    e.settings = { ...DEFAULT_EVAL_SETTINGS, ...(rs.value || {}) };
    e.settingsConflict = rs.conflict;
    e.settingsHistory = rs.revs.map((x) => ({ at: x.ev.at, device: x.ev.device, values: x.value }));
    const rst = chains.resolve(`est:${e.id}`);
    e.status = rst.value?.status || 'ativa';
    e.snapshot = rst.value?.snapshot || null;
    e.closedAt = rst.value?.closedAt || null;
    e.statusHistory = rst.revs.map((x) => ({ at: x.ev.at, status: x.value?.status, device: x.ev.device }));
  }
  const active = [...evals.values()].filter((e) => e.status === 'ativa').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (active.length > 1) conflicts.push({ key: 'evals', kind: 'avaliacoes_ativas', evals: active.map((e) => e.id) });
  // duplicidades
  const dupGroups = buildDupGroups(participants, importReports, chains);
  for (const g of dupGroups) if (g.conflict) conflicts.push({ key: `dup:${g.key}`, kind: 'duplicidade', group: g, heads: g.heads });
  const pr = chains.resolve('prefs', DEFAULT_PREFS);
  const prefs = { ...DEFAULT_PREFS, ...(pr.value || {}) };

  const decisions = new Map();
  for (const dec of decisionsList) {
    if (!decisions.has(dec.eval)) decisions.set(dec.eval, []);
    decisions.get(dec.eval).push(dec);
  }
  for (const list of decisions.values()) list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));

  return {
    participants, photos, evals, decisions, decisionsById, conflicts, dupGroups, prefs, importReports,
    activeEval: active[0]?.id || null,
    decisionCount: decisionsList.length,
    counts: { events: events.length, pending },
    headIds: (key) => chains.headIds(key),
  };
}

function buildDupGroups(participants, importReports, chains) {
  const groups = new Map();
  const addGroup = (pids, tipo) => {
    const valid = [...new Set(pids)].filter((p) => participants.has(p)).sort();
    if (valid.length < 2) return;
    const key = valid.join(',');
    const g = groups.get(key);
    if (g) { if (!g.tipos.includes(tipo)) g.tipos.push(tipo); return; }
    groups.set(key, { key, pids: valid, tipos: [tipo] });
  };
  for (const rep of importReports) for (const g of rep.duplicidades || []) addGroup(g.pids, g.tipo);
  const byName = new Map();
  for (const p of participants.values()) {
    const k = normName(p.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(p.pid);
  }
  for (const pids of byName.values()) if (pids.length > 1) addGroup(pids, 'mesmo nome');
  const out = [];
  for (const g of groups.values()) {
    const r = chains.resolve(`dup:${g.key}`, null);
    out.push({ ...g, decision: r.value?.decision || null, keep: r.value?.keep || null, conflict: r.conflict, heads: r.heads });
  }
  return out;
}

// ---------------------------------------------------------------- seleções usadas pelo app

export function evalSettings(state, evalId = state.activeEval) {
  return state.evals.get(evalId)?.settings || { ...DEFAULT_EVAL_SETTINGS };
}

export function activeParticipants(state) {
  return [...state.participants.values()].filter((p) => p.status !== 'excluida');
}

// Motivos que impedem a participante de entrar em novos confrontos (lista vazia = elegível).
export function eligibilityIssues(state, p, settings, available) {
  const issues = [];
  if (p.status === 'excluida') issues.push('excluída');
  const ph = p.primary ? state.photos.get(p.primary) : null;
  if (!ph) issues.push('sem foto principal');
  else {
    if (ph.problems.length) issues.push('foto com problema');
    if (ph.reviewStatus === 'pendente' && !settings.includePendingPhotos) issues.push('foto aguardando confirmação');
    if (available && !available.has(ph.photo)) issues.push('foto não baixada neste aparelho');
  }
  if (p.primaryConflict) issues.push('troca de foto em conflito');
  const fz = p.status === 'excluida' ? null : frozenInfo(state).get(p.pid);
  if (fz) issues.push(fz.catalog ? 'congelada pelo administrador para todos' : fz.manual ? 'congelada manualmente' : `congelada (chegou a ${fz.w}-${fz.l})`);
  return issues;
}

export const isFrozenIssue = (issue) => issue.startsWith('congelada');

// Regra de congelamento. Percorre os votos válidos na ordem em que chegaram e congela quem chega a
// `freezeMargin` derrotas a mais que vitórias com até `freezeMaxWins` vitórias. A congelada continua no
// cálculo e no ranking; só deixa de entrar em novos confrontos. A regra vale até a foto principal mudar
// depois do congelamento ou até a liberação manual: a contagem então recomeça a partir dali.
// Decisões manuais ficam em settings.freezeOverrides[evalId]: { pid: { mode: 'congelada' | 'liberada', from } },
// em que `from` é o número de decisões registradas no momento da liberação. A chave da avaliação faz com que
// decisões copiadas junto com as configurações (aprovação de convidado) não valham na avaliação de destino.
const frozenCache = new WeakMap();

export function frozenInfo(state, evalId = state.activeEval) {
  let porAval = frozenCache.get(state);
  if (!porAval) { porAval = new Map(); frozenCache.set(state, porAval); }
  if (porAval.has(evalId)) return porAval.get(evalId);
  const settings = evalSettings(state, evalId);
  const overrides = (settings.freezeOverrides || {})[evalId] || {};
  const margin = settings.freezeMargin ?? 5;
  const maxWins = settings.freezeMaxWins ?? 4;
  const votes = validVotes(state, evalId).slice().sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
  // primeira vez em que cada participante atinge a regra, contando a partir de start.get(pid)
  const scan = (start) => {
    const rec = new Map(), hit = new Map();
    for (const d of votes) {
      const o = d.ord ?? 0;
      for (const pid of [d.a, d.b]) {
        if (hit.has(pid) || !start.has(pid) || o < start.get(pid)) continue;
        let r = rec.get(pid);
        if (!r) { r = { w: 0, l: 0 }; rec.set(pid, r); }
        if (d.winner === pid) r.w++; else r.l++;
        if (r.l - r.w >= margin && r.w <= maxWins) hit.set(pid, { ord: o, w: r.w, l: r.l });
      }
    }
    return hit;
  };
  const out = new Map();
  if (settings.freezeEnabled) {
    const start = new Map();
    for (const p of state.participants.values()) if (p.status !== 'excluida') start.set(p.pid, 0);
    const again = new Map();
    for (const [pid, hit] of scan(start)) {
      const ov = overrides[pid];
      const reset = Math.max(state.participants.get(pid).primaryMark ?? 0, ov?.mode === 'liberada' ? (ov.from ?? 0) : -1);
      if (reset > hit.ord) again.set(pid, reset);
      else out.set(pid, { ...hit, manual: false });
    }
    for (const [pid, hit] of scan(again)) out.set(pid, { ...hit, manual: false });
  }
  for (const [pid, ov] of Object.entries(overrides)) {
    const p = state.participants.get(pid);
    if (p && p.status !== 'excluida' && ov?.mode === 'congelada') out.set(pid, { manual: true });
  }
  // O status pertence ao catálogo compartilhado. Vale antes do primeiro voto de cada convidado
  // e permanece até o administrador liberar a participante, inclusive após trocar a foto.
  for (const p of state.participants.values()) {
    if (p.status === 'congelada') out.set(p.pid, { manual: true, catalog: true });
  }
  porAval.set(evalId, out);
  return out;
}

export function globalFreezeCandidates(state) {
  if (!state.activeEval || !state.prefs.shareFrozen) return [];
  const frozen = frozenInfo(state);
  return activeParticipants(state).filter(p => p.status !== 'congelada' && frozen.has(p.pid));
}

// Votos válidos da avaliação para o modelo.
export function validVotes(state, evalId = state.activeEval) {
  const settings = evalSettings(state, evalId);
  const list = state.decisions.get(evalId) || [];
  const out = [];
  for (const d of list) {
    if (!d.valid) continue;
    if (d.kind !== 'vote' && !(d.kind === 'audit' && settings.countAudits)) continue;
    const A = state.participants.get(d.a), B = state.participants.get(d.b);
    if (!A || !B || A.status === 'excluida' || B.status === 'excluida') continue;
    if (settings.photoPolicy === 'descartar' && (d.pa !== A.primary || d.pb !== B.primary)) continue;
    if (d.winner !== d.a && d.winner !== d.b) continue;
    out.push(d);
  }
  return out;
}

export function voteExclusionReason(state, d, settings) {
  if (d.conflict) return 'correção em conflito';
  if (d.state.status === 'anulado') return 'anulado';
  const A = state.participants.get(d.a), B = state.participants.get(d.b);
  if (!A || !B) return 'participante removida';
  if (A.status === 'excluida' || B.status === 'excluida') return 'participante excluída';
  if (settings.photoPolicy === 'descartar' && (d.pa !== A.primary || d.pb !== B.primary)) return 'foto substituída';
  if (d.kind === 'audit' && !settings.countAudits) return 'auditoria (fora do cálculo)';
  return null;
}
