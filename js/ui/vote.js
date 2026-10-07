import { h, clear, fmtInt, fmtPct } from '../util.js';
import { icon, toast, modal, choiceDialog } from './common.js';
import { PHASE_LABEL, REASON_TEXT } from '../engine.js';
import { evalSettings } from '../store.js';

const PROBLEMS = [
  ['nao_carrega', 'A foto não carrega'],
  ['rosto_pouco_visivel', 'Rosto pouco visível ou coberto'],
  ['sem_nitidez', 'Imagem sem nitidez suficiente'],
  ['pessoa_errada', 'Foto de outra pessoa'],
  ['fase', 'Fora da fase adulta escolhida'],
  ['filtro', 'Filtro forte ou alteração evidente'],
  ['enquadramento', 'Enquadramento muito diferente do padrão'],
  ['outro', 'Outro motivo'],
];

export function renderVote(app, root) {
  const wrap = h('div', { class: 'vote' });
  root.append(wrap);
  const st = { cur: null, mode: localStorage.getItem('rp-vote-mode') || 'normal', audit: { left: 0, since: 0 }, busy: false, shownBudget: false };
  const head = h('div', { class: 'vote-head' });
  const pair = h('div', { class: 'pair' });
  const actions = h('div', { class: 'vote-actions' });
  const reason = h('div', { class: 'vote-reason' });
  wrap.append(head, pair, actions, reason);

  const frames = { L: makeFrame('L'), R: makeFrame('R') };
  pair.append(frames.L.el, frames.R.el);

  function makeFrame(side) {
    const img = h('img', { alt: side === 'L' ? 'Foto da esquerda' : 'Foto da direita', referrerpolicy: 'no-referrer', draggable: 'false' });
    const loading = h('div', { class: 'loading' }, 'Carregando…');
    const label = h('div', { class: 'label', hidden: true });
    const sideTag = h('div', { class: 'side' });
    const zoom = h('button', { class: 'zoom', 'aria-label': 'Ampliar foto', title: 'Ampliar', onclick: (e) => { e.stopPropagation(); openZoom(side); } }, icon('zoom'));
    const el = h('div', { class: 'frame', role: 'button', tabindex: '0', 'aria-label': side === 'L' ? 'Escolher a foto da esquerda' : 'Escolher a foto da direita' }, loading, img, label, sideTag, zoom);
    el.addEventListener('click', () => choose(side));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(side); } });
    return { el, img, loading, label, sideTag };
  }

  const btn = (label, ic, fn, kbd, cls = '') => h('button', { class: `btn ${cls}`, onclick: fn }, ic ? icon(ic) : null, label, kbd ? h('span', { class: 'kbd' }, kbd) : null);
  const bLater = btn('Rever depois', 'depois', () => later(), 'S');
  const bProblem = btn('Problema na foto', 'problema', () => problem(), 'P');
  const bUndo = btn('Desfazer', 'desfazer', () => undo(), 'Z');
  const bMore = btn('Mais', 'mais', () => more(), null, 'ghost');
  actions.append(bLater, bProblem, bUndo, bMore);

  function layout() {
    const pref = app.state.prefs.layout;
    const narrow = window.innerWidth < 720 && window.innerHeight > window.innerWidth * 1.05;
    const stack = pref === 'pilha' || (pref === 'auto' && narrow);
    pair.classList.toggle('stack', stack);
    frames.L.sideTag.textContent = stack ? 'de cima' : 'esquerda';
    frames.R.sideTag.textContent = stack ? 'de baixo' : 'direita';
    return stack ? 'pilha' : 'lado';
  }

  function renderHead() {
    clear(head);
    const s = app.state;
    if (!s.activeEval) return;
    const settings = evalSettings(s);
    const prog = app.engine.progress();
    const valid = prog.valid;
    const pct = Math.min(1, valid / settings.budget);
    let phase = st.cur ? PHASE_LABEL[st.cur.phase] || '' : '';
    if (st.cur?.phase === 'cobertura') phase += ` · rodada ${st.cur.reason.round} de ${st.cur.reason.of}`;
    if (st.mode === 'revisao' && st.cur?.phase !== 'auditoria') phase = PHASE_LABEL.revisao;
    else if (st.cur?.reason?.auto) phase = 'Etapa de revisão do 1º lugar';
    if (st.audit.left > 0) phase += ` · auditoria: ${st.audit.left} restante${st.audit.left > 1 ? 's' : ''}`;
    head.append(
      h('span', null, phase),
      h('div', { class: 'bar' }, h('span', { style: { width: `${(pct * 100).toFixed(1)}%` } })),
      h('span', null, h('strong', null, fmtInt(valid)), ` de ${fmtInt(settings.budget)} escolhas válidas`),
    );
  }

  function showReason() {
    clear(reason);
    if (!st.cur || !app.state.prefs.showReason) return;
    const r = st.cur.reason;
    let txt = (REASON_TEXT[r.kind] || (() => ''))(r);
    if (app.state.prefs.showScores && r.swap != null) txt += ` · chance de ordem invertida ${fmtPct(r.swap)}`;
    if (r.deferred) txt += ` · par adiado ${r.deferred}× antes`;
    reason.append(txt);
  }

  function emptyState(res) {
    clear(pair);
    pair.classList.remove('stack');
    const s = app.state;
    const box = h('div', { class: 'empty', style: { gridColumn: '1 / -1' } });
    if (!s.participants.size) {
      box.append(h('h2', null, 'Ainda não há participantes'), h('p', null, 'Importe o pacote inicial (.zip) ou uma planilha para começar.'),
        h('a', { class: 'btn primary', href: '#/participantes?aba=importar' }, 'Importar participantes'));
    } else if (!s.activeEval) {
      box.append(h('h2', null, 'Nenhuma avaliação ativa'), h('p', null, 'Comece uma nova avaliação na tela Versões.'), h('a', { class: 'btn primary', href: '#/versoes' }, 'Abrir Versões'));
    } else {
      const reasons = res?.ctx?.reasons;
      const counts = new Map();
      if (reasons) for (const list of reasons.values()) for (const r of list) counts.set(r, (counts.get(r) || 0) + 1);
      box.append(h('h2', null, 'Nenhum par disponível agora'),
        h('p', null, 'Para formar um par, pelo menos duas participantes precisam ter foto pronta.'),
        counts.size ? h('p', null, [...counts].map(([k, v]) => `${v} com ${k}`).join(' · ')) : null,
        !navigator.onLine ? h('p', null, 'Sem conexão: só entram fotos já baixadas neste aparelho.') : null,
        h('a', { class: 'btn', href: '#/participantes?aba=revisar' }, 'Revisar fotos'));
    }
    pair.append(box);
    actions.hidden = true;
  }

  function restoreFrames() {
    if (frames.L.el.parentNode !== pair) { clear(pair); pair.append(frames.L.el, frames.R.el); }
    actions.hidden = false;
  }

  async function present(p) {
    st.cur = p;
    restoreFrames();
    const lay = layout();
    p.layout = lay;
    p.ready = false;
    p.locked = false;
    for (const side of ['L', 'R']) {
      const f = frames[side];
      f.el.classList.remove('chosen');
      f.img.removeAttribute('src');
      f.img.hidden = true;
      f.loading.hidden = false;
      f.loading.textContent = 'Carregando…';
      const pid = side === 'L' ? p.left : p.right;
      const part = app.state.participants.get(pid);
      f.label.textContent = part?.name || '';
      f.label.hidden = !app.state.prefs.showNames;
    }
    renderHead();
    showReason();
    const load = (side) => new Promise((resolve) => {
      const f = frames[side];
      const photoId = side === 'L' ? p.pl : p.pr;
      const ph = app.state.photos.get(photoId);
      app.images.url(ph?.path, ph?.external_url || null).then((url) => {
        if (st.cur !== p) return resolve(false);
        if (!url) { f.loading.textContent = 'A foto não carregou.'; return resolve(false); }
        f.img.onload = () => { f.img.hidden = false; f.loading.hidden = true; resolve(true); };
        f.img.onerror = () => { f.loading.textContent = 'A foto não carregou.'; resolve(false); };
        f.img.src = url;
      });
    });
    const [okL, okR] = await Promise.all([load('L'), load('R')]);
    if (st.cur !== p) return;
    if (!okL || !okR) {
      p.failed = true;
      toast('Uma das fotos não carregou. Use "Problema na foto" ou pule o par em "Mais".', { ms: 6000 });
      return;
    }
    p.shownAt = new Date().toISOString();
    p.shownMs = performance.now();
    p.ready = true;
    prefetchNext();
  }

  function prefetchNext() {
    // baixa com antecedência as fotos de pares prováveis (vizinhas e candidatas)
    const m = app.engine.model;
    if (!m) return;
    const paths = [];
    for (let k = 0; k < Math.min(12, m.n); k++) {
      const pid = m.pids[m.order[k]];
      const ph = app.state.photos.get(app.state.participants.get(pid)?.primary);
      if (ph?.path) paths.push(ph.path);
    }
    app.images.prefetch(paths);
  }

  function available() {
    if (navigator.onLine && app.remote?.uid) return null;
    const set = new Set();
    for (const ph of app.state.photos.values()) if ((ph.path && app.images.has(ph.path)) || ph.external_url) set.add(ph.photo);
    return set;
  }

  function nextPresentation() {
    if (!app.state.activeEval) return emptyState();
    const doAudit = st.audit.left > 0 && st.audit.since >= 2;
    let p = app.engine.next({ mode: st.mode, current: st.cur, available: available(), audit: doAudit });
    if (p && p.kind === 'audit') { st.audit.left--; st.audit.since = 0; } else if (doAudit && p && !p.empty) {
      st.audit.left = 0;
      toast('Não há pares antigos suficientes para auditar agora.');
    }
    if (!p || p.empty) return emptyState(p);
    if (st.audit.left > 0 && p.kind !== 'audit') st.audit.since++;
    if (p.phase === 'auditoria') p.phase = 'auditoria';
    present(p);
    checkBudget();
  }

  function checkReviewStage() {
    const rs = app.engine.reviewStage();
    if (!rs.active) return;
    const key = `rp-etapa-revisao-${app.state.activeEval}`;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
    modal('Etapa de revisão do 1º lugar', h('div', null,
      h('p', null, `Você chegou a ${fmtInt(rs.valid)} escolhas válidas. A partir de agora, ${rs.share >= 1 ? 'os pares vêm' : `${Math.round(rs.share * 100)}% dos pares vêm`} das candidatas ao 1º lugar e das pouco avaliadas que ainda podem alcançar a líder.`),
      h('p', { class: 'help' }, 'Nas simulações, esta etapa nas últimas 1.000 escolhas aumentou o acerto da 1ª colocada. Os votos entram no histórico como os demais, e a liderança continua calculada pelo conjunto dos votos. Dá para desligar em Configurações.')), [
      { label: 'Entendi', cls: 'primary' },
    ]);
  }

  function checkBudget() {
    checkReviewStage();
    const prog = app.engine.progress();
    if (st.shownBudget || prog.valid < prog.budget) return;
    const key = `rp-budget-${app.state.activeEval}-${prog.budget}`;
    if (localStorage.getItem(key)) return;
    st.shownBudget = true;
    localStorage.setItem(key, '1');
    modal('Orçamento atingido', h('div', null,
      h('p', null, `Você chegou a ${fmtInt(prog.valid)} escolhas válidas, o total planejado.`),
      h('p', null, 'A tela de progresso mostra a lista atual, a disputa pelo 1º lugar e as posições que ainda têm dúvida. Você pode encerrar esta versão ou continuar avaliando.')), [
      { label: 'Continuar avaliando' },
      { label: 'Ver resultado', cls: 'primary', fn: () => app.go('progresso') },
    ]);
  }

  async function record(type, data) {
    const p = st.cur;
    const evalId = app.state.activeEval;
    const ev = {
      ...app.newEvent(type, {
        a: p.left, b: p.right, pa: p.pl, pb: p.pr, phase: p.phase, reason: p.reason, layout: p.layout,
        shown: p.shownAt || null, ms: p.shownMs ? Math.round(performance.now() - p.shownMs) : null,
        names: !!app.state.prefs.showNames, ...data,
      }, { evalId }),
      id: p.id, // a apresentação tem id próprio: toque repetido no mesmo par não cria outro voto
    };
    await app.addEvents([ev]);
    return ev;
  }

  // Trava contra toque duplo: ignora toques nos primeiros 250 ms depois que as duas fotos aparecem
  // (conferido pelo relógio, sem depender de temporizador, que atrasa em aparelhos lentos).
  async function choose(side) {
    const p = st.cur;
    if (!p || p.locked || !p.ready || st.busy) return;
    if (performance.now() - p.shownMs < 250) return;
    p.locked = true;
    st.busy = true;
    frames[side].el.classList.add('chosen');
    const w = side === 'L' ? p.left : p.right;
    try {
      await record(p.kind === 'audit' ? 'audit' : 'vote', { w, side, of: p.of || null });
    } catch (e) {
      toast('Não foi possível salvar: ' + e.message, { type: 'err' });
      p.locked = false;
      st.busy = false;
      return;
    }
    setTimeout(() => { st.busy = false; nextPresentation(); }, 140);
  }

  async function later() {
    const p = st.cur;
    if (!p || p.locked || st.busy) return;
    p.locked = true;
    st.busy = true;
    try { await record('abstain', {}); } finally { st.busy = false; }
    toast('Par guardado para outra ocasião.', { ms: 1800 });
    nextPresentation();
  }

  async function problem() {
    const p = st.cur;
    if (!p || p.locked || st.busy) return;
    const target = await choiceDialog('Problema na foto', 'Qual foto tem problema?', [
      { label: st.cur.layout === 'pilha' ? 'A de cima' : 'A da esquerda', value: 'L' },
      { label: st.cur.layout === 'pilha' ? 'A de baixo' : 'A da direita', value: 'R' },
      { label: 'As duas', value: 'LR' },
    ]);
    if (!target) return;
    const kind = await choiceDialog('Problema na foto', 'O que acontece?', PROBLEMS.map(([v, l]) => ({ label: l, value: v })));
    if (!kind) return;
    if (st.cur !== p || p.locked) return;
    p.locked = true;
    await record('photo_problem', { target, problem: kind });
    toast('Problema registrado. A participante sai dos confrontos até a foto ser revisada.', { ms: 4500 });
    nextPresentation();
  }

  async function undo() {
    if (st.busy) return;
    const s = app.state;
    const list = (s.decisions.get(s.activeEval) || []).filter((d) => d.device === app.device.id && d.valid);
    const last = list[list.length - 1];
    if (!last) { toast('Nada para desfazer neste aparelho.'); return; }
    st.busy = true;
    try {
      await app.revise(last.id, { status: 'anulado', w: last.w }, 'desfazer');
    } finally { st.busy = false; }
    const A = s.participants.get(last.a), B = s.participants.get(last.b);
    toast('Última ação desfeita. O par volta para você decidir.', { ms: 2500 });
    if (last.kind === 'audit') st.audit.left++;
    present({
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), kind: last.kind === 'audit' ? 'audit' : 'vote',
      left: last.a, right: last.b, pl: app.state.participants.get(last.a)?.primary || last.pa,
      pr: app.state.participants.get(last.b)?.primary || last.pb, reason: last.reason || { kind: 'proximas' },
      phase: last.phase || 'adaptativa', of: last.of || null, undoOf: last.id,
    });
    void A; void B;
  }

  async function more() {
    const settings = evalSettings(app.state);
    const rs = st.mode === 'revisao' ? null : app.engine.reviewSet();
    const v = await choiceDialog('Mais opções', null, [
      st.mode === 'revisao'
        ? { label: 'Encerrar revisão do 1º lugar', value: 'sair_revisao' }
        : { label: 'Revisão do 1º lugar', value: 'revisao', hint: rs ? `${rs.contenders.length} candidatas + ${rs.under.length} pouco avaliadas` : '' },
      { label: st.audit.left ? 'Cancelar auditoria' : 'Rodada de auditoria (10 pares)', value: st.audit.left ? 'sem_auditoria' : 'auditoria', hint: `pares vistos há ${settings.auditGap}+ confrontos` },
      { label: 'Pular este par sem registrar', value: 'pular' },
      { label: 'Atalhos do teclado', value: 'atalhos' },
    ]);
    if (v === 'revisao') {
      st.mode = 'revisao';
      localStorage.setItem('rp-vote-mode', 'revisao');
      toast('Revisão do 1º lugar: os pares vêm das candidatas plausíveis.');
      nextPresentation();
    } else if (v === 'sair_revisao') {
      st.mode = 'normal';
      localStorage.setItem('rp-vote-mode', 'normal');
      nextPresentation();
    } else if (v === 'auditoria') {
      st.audit = { left: 10, since: 2 };
      toast('Auditoria: 10 pares já vistos vão aparecer entre os próximos confrontos.');
      nextPresentation();
    } else if (v === 'sem_auditoria') {
      st.audit = { left: 0, since: 0 };
      renderHead();
    } else if (v === 'pular') {
      nextPresentation();
    } else if (v === 'atalhos') {
      shortcuts();
    }
  }

  function shortcuts() {
    const rows = [
      ['← ou A', 'escolher a foto da esquerda (ou de cima)'],
      ['→ ou D', 'escolher a foto da direita (ou de baixo)'],
      ['S ou ↓', 'rever depois'],
      ['P', 'problema na foto'],
      ['Z, Backspace ou Ctrl+Z', 'desfazer a última ação'],
      ['Q / E', 'ampliar a foto da esquerda / da direita'],
      ['Esc', 'fechar a ampliação'],
    ];
    modal('Atalhos do teclado', h('table', { class: 'tbl' }, rows.map(([k, d]) => h('tr', null, h('td', null, h('span', { class: 'kbd' }, k)), h('td', null, d)))), [{ label: 'Fechar' }]);
  }

  function openZoom(side) {
    const p = st.cur;
    if (!p) return;
    let cur = side;
    const img = h('img', { alt: '', referrerpolicy: 'no-referrer', draggable: 'false' });
    const stage = h('div', { class: 'stage' }, img, h('div', { class: 'hint' }, 'Pinça, roda do mouse ou duplo toque para ampliar'));
    const title = h('span', { style: { color: '#ddd', alignSelf: 'center' } });
    const view = h('div', { class: 'zoomview', role: 'dialog', 'aria-modal': 'true' }, stage,
      h('div', { class: 'bar2' },
        h('button', { class: 'btn', onclick: () => show(cur === 'L' ? 'R' : 'L') }, icon(cur === 'L' ? 'dir' : 'esq'), 'Outra foto'),
        title,
        h('button', { class: 'btn primary', onclick: () => { close(); choose(cur); } }, 'Escolher esta'),
        h('button', { class: 'btn', onclick: () => close() }, icon('fechar'), 'Fechar')));
    document.body.append(view);
    let scale = 1, tx = 0, ty = 0;
    const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
    const reset = () => { scale = 1; tx = 0; ty = 0; apply(); };
    // Amplia mantendo fixo o ponto sob o cursor (transform-origin 0 0):
    // ponto da tela = base + t + s·u  ⇒  t' = (c − base)(1 − k) + k·t, com k = s'/s.
    const zoomAt = (factor, cx, cy) => {
      const r = img.getBoundingClientRect();
      const bx = r.left - tx, by = r.top - ty;
      const ns = Math.min(8, Math.max(1, scale * factor));
      const k = ns / scale;
      tx = (cx - bx) * (1 - k) + k * tx;
      ty = (cy - by) * (1 - k) + k * ty;
      scale = ns;
      if (scale === 1) { tx = 0; ty = 0; }
      apply();
    };
    function show(s) {
      cur = s;
      reset();
      const ph = app.state.photos.get(s === 'L' ? p.pl : p.pr);
      app.images.url(ph?.path, ph?.external_url || null).then((u) => { if (u) img.src = u; });
      title.textContent = p.layout === 'pilha' ? (s === 'L' ? 'Foto de cima' : 'Foto de baixo') : (s === 'L' ? 'Foto da esquerda' : 'Foto da direita');
      if (app.state.prefs.showNames) title.textContent += ' · ' + (app.state.participants.get(s === 'L' ? p.left : p.right)?.name || '');
      view.querySelector('.bar2 .btn').replaceChildren(icon(s === 'L' ? 'dir' : 'esq'), 'Outra foto');
    }
    const pointers = new Map();
    let lastDist = 0, lastTap = 0, panStart = null;
    stage.addEventListener('pointerdown', (e) => {
      stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        const now = Date.now();
        if (now - lastTap < 300) { if (scale > 1) reset(); else zoomAt(2.5, e.clientX, e.clientY); lastTap = 0; } else lastTap = now;
        panStart = { x: e.clientX, y: e.clientY, tx, ty };
      }
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        lastDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (lastDist > 0) zoomAt(d / lastDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
        lastDist = d;
      } else if (pointers.size === 1 && panStart && scale > 1) {
        tx = panStart.tx + (e.clientX - panStart.x);
        ty = panStart.ty + (e.clientY - panStart.y);
        apply();
      }
    });
    const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) lastDist = 0; if (!pointers.size) panStart = null; };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY); }, { passive: false });
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); show(cur === 'L' ? 'R' : 'L'); }
      else if (e.key === 'Enter') { e.preventDefault(); close(); choose(cur); }
      else if (e.key === '+' || e.key === '=') zoomAt(1.25, innerWidth / 2, innerHeight / 2);
      else if (e.key === '-') zoomAt(0.8, innerWidth / 2, innerHeight / 2);
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    function close() { document.removeEventListener('keydown', onKey, true); view.remove(); }
    show(side);
  }

  function onKey(e) {
    if (e.target.closest('input, textarea, select') || document.querySelector('.overlay, .zoomview, .drawer')) return;
    if (e.altKey || e.metaKey) return;
    const k = e.key;
    const stack = st.cur?.layout === 'pilha';
    if (e.ctrlKey && (k === 'z' || k === 'Z')) { e.preventDefault(); undo(); return; }
    if (e.ctrlKey) return;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A' || (stack && k === 'ArrowUp')) { e.preventDefault(); choose('L'); }
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') { e.preventDefault(); choose('R'); }
    else if (k === 'ArrowDown' && stack) { e.preventDefault(); choose('R'); }
    else if (k === 's' || k === 'S' || (k === 'ArrowDown' && !stack)) { e.preventDefault(); later(); }
    else if (k === 'p' || k === 'P') { e.preventDefault(); problem(); }
    else if (k === 'z' || k === 'Z' || k === 'Backspace') { e.preventDefault(); undo(); }
    else if (k === 'q' || k === 'Q') { e.preventDefault(); openZoom('L'); }
    else if (k === 'e' || k === 'E') { e.preventDefault(); openZoom('R'); }
    else if (k === '?') shortcuts();
  }
  document.addEventListener('keydown', onKey);
  const onResize = () => { if (st.cur) st.cur.layout = layout(); };
  window.addEventListener('resize', onResize);
  const offModel = app.on('model', () => { renderHead(); if (!st.cur || st.cur.empty) maybeStart(); });
  const offState = app.on('state', () => {
    renderHead();
    // se a participante atual deixou de ser elegível (excluída, foto trocada), troca o par
    const p = st.cur;
    if (p && !p.locked) {
      const A = app.state.participants.get(p.left), B = app.state.participants.get(p.right);
      if (!A || !B || A.status === 'excluida' || B.status === 'excluida' || A.primary !== p.pl || B.primary !== p.pr) nextPresentation();
    } else if (!p) maybeStart();
  });

  function maybeStart() {
    if (!st.cur) nextPresentation();
  }
  nextPresentation();
  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    offModel();
    offState();
  };
}
