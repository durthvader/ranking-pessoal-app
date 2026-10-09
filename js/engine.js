// Liga o estado (eventos materializados) ao modelo e ao pareamento.

import { activeParticipants, validVotes, evalSettings, eligibilityIssues, isFrozenIssue } from './store.js';
import { nextPair, pickAudit, usefulPairs, pairKey, groupOf, groupLabel, contenders, underestimated, DEFAULT_PAIRING } from './model/pairing.js';
import { probAbove, normCdf } from './model/bt.js';
import { auditSummary, sideBias } from './model/signals.js';
import { uuid } from './util.js';
import { makeRng } from './model/rng.js';

const byCode = (a, b) => (a.code ?? 1e12) - (b.code ?? 1e12) || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0);

function hashInts(arr) {
  let h = 0x811c9dc5;
  for (let k = 0; k < arr.length; k++) {
    h ^= arr[k] & 0xffff;
    h = Math.imul(h, 0x01000193);
    h ^= arr[k] >>> 16;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + arr.length;
}

export const PHASE_LABEL = {
  cobertura: 'Fase de cobertura',
  conexao: 'Ligação da rede de comparações',
  adaptativa: 'Fase adaptativa',
  sorteio: 'Sorteio',
  revisao: 'Revisão do 1º lugar',
  auditoria: 'Auditoria',
};

export const REASON_TEXT = {
  cobertura: (r) => `Cobertura: rodada ${r.round} de ${r.of}`,
  conexao: () => 'Liga partes da rede de comparações que ainda não se encontraram',
  disputa_1: () => 'Pode mudar a disputa pelo 1º lugar',
  pouco_avaliada: () => 'Participante com poucas comparações',
  entre_faixas: () => 'Confere a divisão entre faixas vizinhas',
  faixa_prioritaria: (r) => `Refina a ordem entre as posições ${r.from} e ${r.to}`,
  ampliar_ranking: (r) => `Avalia participantes a partir da posição ${r.from}`,
  proximas: () => 'Ordem ainda incerta entre participantes próximas',
  revisao: () => 'Revisão entre candidatas ao 1º lugar',
  auditoria: () => 'Auditoria: par já visto, com lados sorteados de novo',
  sorteio: () => 'Sorteio entre pares ainda não vistos',
};

export function phaseOf(kind) {
  if (kind === 'cobertura') return 'cobertura';
  if (kind === 'conexao') return 'conexao';
  if (kind === 'revisao') return 'revisao';
  if (kind === 'auditoria') return 'auditoria';
  if (kind === 'sorteio') return 'sorteio';
  return 'adaptativa';
}

export class Engine {
  constructor(app) {
    this.app = app;
    this.model = null;
    this.reqId = 0;
    this.calls = new Map();
    this.listeners = new Set();
    this.fitKey = null;
    this.fitting = false;
    this.dirty = false;
    this.cache = new Map();
    this.lastError = null;
  }

  start() {
    try {
      this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const c = this.calls.get(e.data.id);
        if (!c) return;
        this.calls.delete(e.data.id);
        if (e.data.error) c.reject(new Error(e.data.error));
        else c.resolve(e.data);
      };
      this.worker.onerror = (e) => {
        console.warn('Worker indisponível; cálculo continua na página.', e.message);
        this.worker = null;
        const pend = [...this.calls.values()];
        this.calls.clear();
        for (const c of pend) this._local(c.msg).then(c.resolve, c.reject);
      };
    } catch {
      this.worker = null;
    }
  }

  async _local(msg) {
    const { compute } = await import('./compute.js');
    return compute(msg).out;
  }

  call(msg) {
    msg.id = ++this.reqId;
    if (!this.worker) return this._local(msg);
    return new Promise((resolve, reject) => {
      this.calls.set(msg.id, { resolve, reject, msg });
      this.worker.postMessage(msg);
    });
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this.model); }

  input() {
    const st = this.app.state;
    const evalId = st.activeEval;
    const settings = evalSettings(st, evalId);
    const parts = activeParticipants(st).sort(byCode);
    const pids = parts.map((p) => p.pid);
    const index = new Map(pids.map((p, i) => [p, i]));
    const decs = validVotes(st, evalId);
    const votes = new Int32Array(decs.length * 2);
    decs.forEach((d, k) => {
      votes[2 * k] = index.get(d.winner);
      votes[2 * k + 1] = index.get(d.winner === d.a ? d.b : d.a);
    });
    return { evalId, settings, parts, pids, index, decs, votes };
  }

  async refresh() {
    if (!this.app.state?.activeEval) { this.model = null; this.emit(); return; }
    if (this.fitting) { this.dirty = true; return; }
    const inp = this.input();
    const s = inp.settings;
    const key = [inp.evalId, inp.pids.join(',').length, inp.pids.length, hashInts(inp.votes), s.sigmaMode, s.sigma, s.mcSamples, s.level, s.topK].join('|');
    if (key === this.fitKey && this.model) return;
    this.fitting = true;
    try {
      const init = this.model ? this._alignInit(inp.pids) : null;
      const sg = this.sigmaState?.evalId === inp.evalId && this.sigmaState.mode === s.sigmaMode ? this.sigmaState : {};
      const res = await this.call({
        type: 'fit', n: inp.pids.length, votes: inp.votes, sigmaMode: s.sigmaMode, sigmaFixed: s.sigma,
        sigmaPrev: sg.value ?? null, sigmaPrevVotes: sg.votes ?? null, samples: s.mcSamples,
        level: s.level, topK: s.topK, init, seed: inp.decs.length + 1,
      });
      this.sigmaState = { evalId: inp.evalId, mode: s.sigmaMode, value: res.sigmaUsed, votes: res.sigmaVotes };
      this.model = this._assemble(res, inp);
      this.fitKey = key;
      this.cache.clear();
      this.lastError = null;
      this.emit();
    } catch (e) {
      this.lastError = e.message || String(e);
      console.error(e);
    } finally {
      this.fitting = false;
      if (this.dirty) { this.dirty = false; this.refresh(); }
    }
  }

  _alignInit(pids) {
    const m = this.model;
    const init = new Float64Array(pids.length);
    pids.forEach((pid, i) => { const k = m.index.get(pid); init[i] = k == null ? 0 : m.s[k]; });
    return init;
  }

  _assemble(res, inp) {
    const n = inp.pids.length;
    const { s } = res;
    const codeOf = (i) => inp.parts[i].code ?? 1e12;
    // Ordena pela estimativa arredondada (6 casas): diferenças numéricas menores que isso dependem
    // do ponto de partida do cálculo e não podem decidir a ordem. Empates usam o código da
    // participante, critério técnico estável e igual em todos os aparelhos.
    const q = Array.from(s, (v) => Math.round(v * 1e6));
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => q[b] - q[a] || codeOf(a) - codeOf(b) || (inp.pids[a] < inp.pids[b] ? -1 : 1));
    const pos = new Int32Array(n);
    order.forEach((i, p) => { pos[i] = p + 1; });
    return {
      version: (this.model?.version || 0) + 1, evalId: inp.evalId, pids: inp.pids, index: inp.index, n,
      s, R: res.R, sdR: res.sdR, S: res.S, p1: res.p1, pTop: res.pTop, rankLo: res.rankLo, rankHi: res.rankHi,
      rankMed: res.rankMed, rankMean: res.rankMean, order, pos, votesUsed: inp.decs.length,
      settings: inp.settings, samples: res.samples, level: res.level, topK: res.topK, ms: res.ms,
      computedAt: new Date().toISOString(), converged: res.converged,
      sigmaUsed: res.sigmaUsed, sigmaSource: res.sigmaSource, sigmaVotes: res.sigmaVotes,
    };
  }

  // Modelo alinhado às participantes atuais (novas recebem o prior: média 0, variância σ²).
  alignedModel(pids, sigma) {
    const m = this.model;
    if (!m) return null;
    const same = m.pids.length === pids.length && m.pids.every((p, i) => p === pids[i]);
    if (same) return { mu: m.s, S: m.S, p1: m.p1, rankLo: m.rankLo };
    const n = pids.length;
    const mu = new Float64Array(n), S = new Float64Array(n * n), p1 = new Float64Array(n), rankLo = new Int32Array(n);
    const map = pids.map((p) => m.index.get(p));
    for (let i = 0; i < n; i++) {
      const a = map[i];
      if (a == null) { S[i * n + i] = sigma * sigma; rankLo[i] = 1; continue; }
      mu[i] = m.s[a];
      p1[i] = m.p1[a];
      rankLo[i] = m.rankLo[a];
      for (let j = 0; j < n; j++) {
        const b = map[j];
        if (b != null) S[i * n + j] = m.S[a * m.n + b];
      }
    }
    return { mu, S, p1, rankLo };
  }

  // ------------------------------------------------------------ estatísticas por participante

  stats() {
    const ck = 'stats';
    if (this.cache.has(ck)) return this.cache.get(ck);
    const st = this.app.state;
    const evalId = st.activeEval;
    const valid = validVotes(st, evalId);
    const all = st.decisions.get(evalId) || [];
    const per = new Map();
    const get = (pid) => {
      let r = per.get(pid);
      if (!r) { r = { comps: 0, wins: 0, losses: 0, abstains: 0, problems: 0, opponents: [], deferred: new Map(), audits: 0 }; per.set(pid, r); }
      return r;
    };
    for (const d of valid) {
      const w = d.winner, l = d.winner === d.a ? d.b : d.a;
      const W = get(w), L = get(l);
      W.comps++; L.comps++; W.wins++; L.losses++;
      W.opponents.push({ opp: l, won: true, id: d.id, at: d.at });
      L.opponents.push({ opp: w, won: false, id: d.id, at: d.at });
    }
    const deferredPairs = new Map();
    for (const d of all) {
      if (!d.valid) continue;
      if (d.kind === 'abstain') {
        get(d.a).abstains++; get(d.b).abstains++;
        const k = d.a < d.b ? `${d.a}|${d.b}` : `${d.b}|${d.a}`;
        deferredPairs.set(k, (deferredPairs.get(k) || 0) + 1);
        get(d.a).deferred.set(d.b, (get(d.a).deferred.get(d.b) || 0) + 1);
        get(d.b).deferred.set(d.a, (get(d.b).deferred.get(d.a) || 0) + 1);
      } else if (d.kind === 'photo_problem') {
        get(d.a).problems++; get(d.b).problems++;
      } else if (d.kind === 'audit') {
        get(d.a).audits++; get(d.b).audits++;
      }
    }
    const out = { per, get, valid, all, deferredPairs };
    this.cache.set(ck, out);
    return out;
  }

  // Linhas do ranking na ordem da estimativa central.
  rankingRows() {
    const ck = 'rows';
    if (this.cache.has(ck)) return this.cache.get(ck);
    const m = this.model;
    const st = this.app.state;
    if (!m) return [];
    const settings = m.settings;
    const stats = this.stats();
    const rows = [];
    for (let p = 0; p < m.n; p++) {
      const i = m.order[p];
      const pid = m.pids[i];
      const part = st.participants.get(pid);
      if (!part) continue;
      const ps = stats.get(pid);
      const ph = part.primary ? st.photos.get(part.primary) : null;
      const issues = eligibilityIssues(st, part, settings, null);
      rows.push({
        pos: p + 1, i, pid, name: part.name, code: part.code, part, photo: ph,
        R: m.R[i], sdR: m.sdR[i], lo: m.rankLo[i], hi: m.rankHi[i], med: m.rankMed[i],
        p1: m.p1[i], pTop: m.pTop[i], comps: ps.comps, wins: ps.wins, losses: ps.losses,
        abstains: ps.abstains, deferred: ps.deferred, under: ps.comps < settings.coverageMin,
        issues, frozen: issues.some(isFrozenIssue),
      });
    }
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k];
      const nx = rows[k + 1], pv = rows[k - 1];
      r.pNext = nx ? probAbove(m.s, m.S, m.n, r.i, nx.i) : null;
      r.closeNext = nx ? r.pNext < settings.closeThreshold : false;
      r.closePrev = pv ? pv.closeNext : false;
      r.tieNext = nx ? Math.round(r.R) === Math.round(nx.R) : false;
      r.tiePrev = pv ? pv.tieNext : false;
    }
    this.cache.set(ck, rows);
    return rows;
  }

  // ------------------------------------------------------------ pareamento

  pairingSettings(settings) {
    return {
      ...DEFAULT_PAIRING, coverageMin: settings.coverageMin, coverageMode: settings.coverageMode,
      wTop: settings.wTop, wUnder: settings.wUnder, wCross: settings.wCross, window: settings.window,
      groups: settings.groups, reviewMinP1: settings.reviewMinP1,
      focusTopN: settings.focusTopN, focusShare: settings.focusShare,
    };
  }

  pairingContext({ mode = 'normal', current = null, available = null } = {}) {
    const st = this.app.state;
    const evalId = st.activeEval;
    const ev = st.evals.get(evalId);
    const settings = evalSettings(st, evalId);
    const parts = activeParticipants(st).sort(byCode);
    const pids = parts.map((p) => p.pid);
    const index = new Map(pids.map((p, i) => [p, i]));
    const n = pids.length;
    const eligible = new Uint8Array(n);
    const reasons = new Map();
    parts.forEach((p, i) => {
      const iss = eligibilityIssues(st, p, settings, available);
      eligible[i] = iss.length ? 0 : 1;
      if (iss.length) reasons.set(p.pid, iss);
    });
    const counts = new Int32Array(n);
    const pairCounts = new Map();
    for (const d of validVotes(st, evalId)) {
      const i = index.get(d.a), j = index.get(d.b);
      if (i == null || j == null) continue;
      counts[i]++; counts[j]++;
      const k = pairKey(i, j);
      pairCounts.set(k, (pairCounts.get(k) || 0) + 1);
    }
    const all = st.decisions.get(evalId) || [];
    const pairLastSeen = new Map(), deferrals = new Map();
    all.forEach((d, k) => {
      const i = index.get(d.a), j = index.get(d.b);
      if (i == null || j == null) return;
      const key = pairKey(i, j);
      pairLastSeen.set(key, k);
      if (d.kind === 'abstain' && d.valid) deferrals.set(key, (deferrals.get(key) || 0) + 1);
    });
    const recent = [];
    if (current) {
      const a = index.get(current.left), b = index.get(current.right);
      if (a != null && b != null) recent.push([a, b]);
    }
    for (let k = all.length - 1; k >= 0 && recent.length < 10; k--) {
      const a = index.get(all[k].a), b = index.get(all[k].b);
      if (a != null && b != null) recent.push([a, b]);
    }
    const excludePairs = new Set();
    if (current) {
      const a = index.get(current.left), b = index.get(current.right);
      if (a != null && b != null) excludePairs.add(pairKey(a, b));
    }
    // possíveis duplicidades ainda sem revisão não se enfrentam
    for (const g of st.dupGroups) {
      if (g.decision) continue;
      for (let x = 0; x < g.pids.length; x++) for (let y = x + 1; y < g.pids.length; y++) {
        const a = index.get(g.pids[x]), b = index.get(g.pids[y]);
        if (a != null && b != null) excludePairs.add(pairKey(a, b));
      }
    }
    return {
      n, pids, index, parts, eligible, reasons, counts, pairCounts, pairLastSeen, deferrals, recent,
      presIndex: all.length, seed: ev?.seed ?? 0, model: this.alignedModel(pids, this.model?.sigmaUsed ?? settings.sigma),
      settings: this.pairingSettings(settings), mode, excludePairs, evalSettings: settings,
    };
  }

  // Etapa automática de revisão do 1º lugar: a partir de reviewFrom × orçamento escolhas válidas,
  // uma fração reviewShare dos pares vem das candidatas (sorteio com semente).
  reviewStage() {
    const st = this.app.state;
    const settings = evalSettings(st);
    const valid = this.stats().valid.length;
    const from = Math.round((settings.reviewFrom ?? 0.75) * settings.budget);
    return { active: !!settings.reviewAuto && valid >= from, from, share: settings.reviewShare ?? 1, valid };
  }

  next({ mode = 'normal', current = null, available = null, audit = false } = {}) {
    const st = this.app.state;
    if (!st.activeEval) return null;
    let auto = false;
    if (mode !== 'revisao') {
      const rs = this.reviewStage();
      const prog = this.progress();
      // participantes que ainda não completaram a cobertura têm prioridade sobre a revisão
      if (rs.active && prog.uncoveredEligible === 0) {
        const all = st.decisions.get(st.activeEval) || [];
        const ev = st.evals.get(st.activeEval);
        if (makeRng('etapa-revisao', ev?.seed ?? 0, all.length)() < rs.share) { mode = 'revisao'; auto = true; }
      }
    }
    const ctx = this.pairingContext({ mode, current, available });
    let p = null;
    if (audit) {
      const history = [];
      const audited = new Set();
      for (const d of st.decisions.get(st.activeEval) || []) if (d.kind === 'audit' && d.valid) audited.add(d.of);
      (st.decisions.get(st.activeEval) || []).forEach((d, k) => {
        if (d.kind !== 'vote' || !d.valid) return;
        const i = ctx.index.get(d.a), j = ctx.index.get(d.b);
        if (i == null || j == null) return;
        history.push({ id: d.id, i, j, idx: k, audited: audited.has(d.id) });
      });
      p = pickAudit(ctx, history, { minGap: ctx.evalSettings.auditGap });
    }
    if (!p) p = nextPair(ctx);
    if (!p) return { empty: true, ctx };
    const left = ctx.pids[p.left], right = ctx.pids[p.right];
    return {
      id: uuid(), kind: p.of ? 'audit' : 'vote', left, right,
      pl: st.participants.get(left).primary, pr: st.participants.get(right).primary,
      reason: auto && p.reason.kind === 'revisao' ? { ...p.reason, auto: true } : p.reason,
      of: p.of || null, phase: phaseOf(p.reason.kind), ctxN: ctx.n,
    };
  }

  // ------------------------------------------------------------ resumos

  progress() {
    const ck = 'progress';
    if (this.cache.has(ck)) return this.cache.get(ck);
    const st = this.app.state;
    const evalId = st.activeEval;
    const settings = evalSettings(st, evalId);
    const stats = this.stats();
    const all = stats.all;
    const ctx = this.pairingContext({});
    const elig = ctx.eligible.reduce((a, b) => a + b, 0);
    const activeN = ctx.n;
    const counts = Array.from(ctx.counts);
    const covered = counts.filter((c) => c >= settings.coverageMin).length;
    let uncoveredEligible = 0;
    for (let i = 0; i < ctx.n; i++) if (ctx.eligible[i] && ctx.counts[i] < settings.coverageMin) uncoveredEligible++;
    const hist = new Map();
    for (const c of counts) {
      const b = c >= 15 ? '15+' : c >= 10 ? '10–14' : c >= 7 ? '7–9' : String(c);
      hist.set(b, (hist.get(b) || 0) + 1);
    }
    const kinds = { vote: 0, abstain: 0, photo_problem: 0, audit: 0, anulado: 0 };
    for (const d of all) {
      if (!d.valid) { kinds.anulado++; continue; }
      kinds[d.kind] = (kinds[d.kind] || 0) + 1;
    }
    const valid = stats.valid.length;
    const m = this.model;
    let top = null;
    if (m) {
      const rows = this.rankingRows();
      const byP1 = rows.slice().sort((a, b) => b.p1 - a.p1);
      const contendersList = byP1.filter((r) => r.p1 >= 0.01);
      let H = 0;
      for (const r of rows) if (r.p1 > 0) H -= r.p1 * Math.log(r.p1);
      const leader = rows[0];
      top = { leader, leaderP1: leader?.p1 ?? 0, contenders: contendersList, effective: Math.exp(H), byP1: byP1.slice(0, 10) };
      const closeTop = rows.slice(0, 50).filter((r) => r.closeNext).length;
      const closeAll = rows.filter((r) => r.closeNext).length;
      const wide = rows.slice().sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo)).slice(0, 10);
      top.closeTop50 = closeTop;
      top.closeAll = closeAll;
      top.wide = wide;
    }
    const phase = uncoveredEligible > 0 ? 'cobertura' : 'adaptativa';
    // fora dos confrontos: congeladas pela regra das derrotas e pendências de foto, contadas à parte
    let frozenN = 0;
    for (const iss of ctx.reasons.values()) if (iss.some(isFrozenIssue)) frozenN++;
    const photoBlockedN = ctx.reasons.size - frozenN;
    const out = {
      settings, valid, budget: settings.budget, kinds, activeN, eligibleN: elig, covered, uncoveredEligible, hist,
      coverageMin: settings.coverageMin, top, phase, reasons: ctx.reasons, frozenN, photoBlockedN,
      missingCoverage: counts.reduce((a, c) => a + Math.max(0, settings.coverageMin - c), 0),
    };
    this.cache.set(ck, out);
    return out;
  }

  useful(limit = 8) {
    const ctx = this.pairingContext({});
    if (!ctx.model) return [];
    return usefulPairs(ctx, limit).map((p) => ({
      a: ctx.pids[p.i], b: ctx.pids[p.j], reason: p.reason,
      text: (REASON_TEXT[p.reason.kind] || (() => ''))(p.reason),
    }));
  }

  reviewSet() {
    const ctx = this.pairingContext({});
    if (!ctx.model) return { contenders: [], under: [] };
    const elig = [];
    for (let i = 0; i < ctx.n; i++) if (ctx.eligible[i]) elig.push(i);
    const { set, byMu } = contenders(ctx, ctx.settings, elig);
    const under = byMu.length ? underestimated(ctx, ctx.settings, elig, byMu[0]) : [];
    return { contenders: [...set].map((i) => ctx.pids[i]), under: under.map((i) => ctx.pids[i]).filter((p) => !set.has(ctx.index.get(p))) };
  }

  audits() {
    const st = this.app.state;
    const all = st.decisions.get(st.activeEval) || [];
    const originals = new Map();
    const audits = [];
    all.forEach((d, k) => {
      if (d.kind === 'vote' && d.valid) originals.set(d.id, { winner: d.winner, session: d.session, at: d.at, k });
      if (d.kind === 'audit' && d.valid) audits.push({ id: d.id, of: d.of, winner: d.winner, session: d.session, at: d.at, k });
    });
    return auditSummary(audits, originals);
  }

  sideBias() {
    const st = this.app.state;
    return sideBias((st.decisions.get(st.activeEval) || []).filter((d) => d.valid && (d.kind === 'vote' || d.kind === 'audit')));
  }

  async stages() {
    const inp = this.input();
    const key = 'stages:' + JSON.stringify([inp.evalId, inp.pids, hashInts(inp.votes),
      inp.decs.map(d => [d.phase, d.reason?.kind, d.reason?.round]),
      inp.settings.coverageMin, inp.settings.stageSize, inp.settings.groups, inp.settings.sigma]);
    if (this.cache.has(key)) return this.cache.get(key);
    const votes = [];
    for (let k = 0; k < inp.votes.length; k += 2) votes.push({
      w: inp.votes[k], l: inp.votes[k + 1], phase: inp.decs[k / 2].phase, reason: inp.decs[k / 2].reason,
    });
    const res = await this.call({
      type: 'stages', n: inp.pids.length, votes,
      options: { sigma: inp.settings.sigma, coverageMin: inp.settings.coverageMin, stageSize: inp.settings.stageSize, groups: inp.settings.groups },
    });
    const out = { ...res, pids: inp.pids, index: inp.index, decs: inp.decs };
    this.cache.set(key, out);
    return out;
  }

  async signals() {
    const inp = this.input();
    const key = 'signals:' + hashInts(inp.votes);
    if (this.cache.has(key)) return this.cache.get(key);
    const votes = inp.decs.map((d, k) => ({ w: inp.votes[2 * k], l: inp.votes[2 * k + 1], session: d.session }));
    const rank = this.model ? Array.from(this.model.pos) : null;
    const res = await this.call({ type: 'signals', n: inp.pids.length, votes, sigma: inp.settings.sigma, rank });
    const out = { ...res, pids: inp.pids };
    this.cache.set(key, out);
    return out;
  }

  groupInfo(pos) {
    const groups = this.model?.settings.groups || [10, 25, 50, 100, 200, 350];
    const g = groupOf(pos - 1, groups);
    return { g, label: groupLabel(g, groups, this.model?.n || 0) };
  }
}

export { normCdf };
