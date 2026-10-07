import { h } from '../util.js';
import { icon } from './common.js';
import { imageSearchControls, imageSearchShortcut } from './image-search.js';

// O mesmo visualizador permanece montado ao votar e mudar de dupla.
export function createPhotoViewer({ getPair, getName, getUrl, isReady, onChoose, onAction, showNames = () => true, canManage = () => true }) {
  let view = null, cur = 'L', pairId = null, busy = false, generation = 0;
  let mode = localStorage.getItem('rp-viewer-mode') || 'auto';
  let previousFocus, appRoot, previousInert, previousOverflow, ownsFullscreen = false;
  let panels, title, chooseButton, otherButton, fullscreenButton, options, search, status;
  const button = (label, fn, cls = '') => h('button', { class: `btn ${cls}`, onclick: fn }, label);
  const name = () => getName(cur);

  function controls() {
    if (!view) return;
    const ready = !!getPair() && isReady() && panels.L.loaded && panels.R.loaded && !busy;
    chooseButton.disabled = !ready;
    otherButton.disabled = !getPair();
    chooseButton.textContent = busy ? 'Salvando…' : 'Escolher esta';
    title.textContent = `${cur === 'L' ? 'Foto 1' : 'Foto 2'}${showNames() && name() ? ` · ${name()}` : ''}`;
    title.title = title.textContent;
    for (const side of ['L', 'R']) {
      panels[side].el.classList.toggle('selected', cur === side);
      panels[side].el.setAttribute('aria-label', `${side === 'L' ? 'Foto 1' : 'Foto 2'}${showNames() && getName(side) ? ` · ${getName(side)}` : ''}`);
      panels[side].search?.update();
    }
    status.textContent = busy ? 'Salvando escolha…' : !getPair() ? 'Nenhum par disponível. Feche para revisar.'
      : panels.L.failed || panels.R.failed ? 'Uma foto não carregou. Use Opções para marcar o problema ou rever depois.'
      : ready ? '' : 'Carregando as duas fotos…';
    status.hidden = !status.textContent;
    search.update();
  }

  function layout() {
    if (!view) return;
    const two = mode === 'duas' || (mode === 'auto' && window.innerWidth > window.innerHeight);
    view.classList.toggle('two-photos', two);
    view.classList.toggle('show-right', cur === 'R');
    view.dataset.mode = mode;
  }

  function show(side) {
    if (!view) return;
    cur = side;
    for (const panel of Object.values(panels)) panel.reset();
    layout();
    controls();
  }

  function makePanel(side) {
    const img = h('img', { alt: '', draggable: false, referrerpolicy: 'no-referrer' });
    const loading = h('span', { class: 'viewer-loading' }, 'Carregando…');
    const el = h('div', { class: 'viewer-photo', tabindex: '0' }, img, loading);
    const panel = { el, img, loading, loaded: false, failed: false };
    if (canManage()) {
      panel.search = imageSearchShortcut(() => getPair() ? getName(side) : '');
      el.append(panel.search.el);
    }
    let scale = 1, tx = 0, ty = 0, start = null, lastDist = 0, lastTap = null, multi = false;
    const pointers = new Map();
    const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
    panel.reset = () => { scale = 1; tx = ty = 0; start = lastTap = null; pointers.clear(); lastDist = 0; apply(); };
    const zoomAt = (factor, cx, cy) => {
      const r = img.getBoundingClientRect();
      // Retira a transformação atual para encontrar a origem da imagem.
      const bx = r.left - tx, by = r.top - ty;
      const next = Math.min(8, Math.max(1, scale * factor)), k = next / scale;
      tx = (cx - bx) * (1 - k) + k * tx;
      ty = (cy - by) * (1 - k) + k * ty;
      scale = next;
      if (scale === 1) tx = ty = 0;
      apply();
    };
    panel.zoom = zoomAt;
    el.addEventListener('focus', () => { cur = side; layout(); controls(); });
    el.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      cur = side; layout(); controls();
      el.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        multi = false;
        start = { x: e.clientX, y: e.clientY, tx, ty, scale, at: Date.now() };
      } else {
        multi = true; lastTap = null;
        const [a, b] = [...pointers.values()];
        lastDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (lastDist > 0) zoomAt(d / lastDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
        lastDist = d;
      } else if (start && scale > 1) {
        tx = start.tx + e.clientX - start.x; ty = start.ty + e.clientY - start.y; apply();
      }
    });
    const release = (e) => {
      if (!pointers.has(e.pointerId)) return;
      const final = pointers.size === 1;
      if (final && start && !multi && e.type !== 'pointercancel') {
        const dx = e.clientX - start.x, dy = e.clientY - start.y, now = Date.now();
        if (start.scale === 1 && scale === 1 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          lastTap = null;
          show(side === 'L' ? 'R' : 'L');
        } else if (Math.hypot(dx, dy) < 12 && now - start.at < 350) {
          if (lastTap && now - lastTap.at < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
            if (scale > 1) panel.reset(); else zoomAt(2.5, e.clientX, e.clientY);
            lastTap = null;
          } else lastTap = { at: now, x: e.clientX, y: e.clientY };
        } else lastTap = null;
      }
      pointers.delete(e.pointerId);
      lastDist = 0;
      // Após uma pinça, o dedo restante pode mover a imagem sem saltos.
      if (pointers.size === 1) {
        const [a] = pointers.values(); start = { x: a.x, y: a.y, tx, ty, scale, at: Date.now() };
      } else start = null;
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY); }, { passive: false });
    return panel;
  }

  function update() {
    if (!view) return;
    const p = getPair();
    if ((p?.id || null) !== pairId) {
      pairId = p?.id || null;
      const stamp = ++generation;
      busy = false;
      cur = 'L';
      for (const side of ['L', 'R']) {
        const panel = panels[side];
        panel.reset(); panel.loaded = panel.failed = false;
        panel.img.onload = panel.img.onerror = null;
        panel.img.removeAttribute('src'); panel.img.hidden = true;
        panel.loading.hidden = false; panel.loading.textContent = p ? 'Carregando…' : 'Sem foto';
        panel.img.alt = showNames() && getName(side) || (side === 'L' ? 'Foto 1' : 'Foto 2');
        if (!p) continue;
        Promise.resolve().then(() => getUrl(side, p)).then((url) => {
          if (!view || stamp !== generation) return;
          if (!url) throw new Error('Sem imagem');
          panel.img.onload = () => {
            if (!view || stamp !== generation) return;
            panel.loaded = true; panel.img.hidden = false; panel.loading.hidden = true; controls();
          };
          panel.img.onerror = () => failed();
          panel.img.src = url;
        }).catch(() => { if (view && stamp === generation) failed(); });
        function failed() {
          if (!view || stamp !== generation) return;
          panel.loaded = false; panel.failed = true; panel.img.hidden = true;
          panel.loading.hidden = false; panel.loading.textContent = 'A foto não carregou.'; controls();
        }
      }
    }
    layout(); controls();
  }

  function fullscreen() {
    if (document.fullscreenElement) return;
    if (!document.documentElement.requestFullscreen) {
      fullscreenButton.textContent = 'Tela ampliada';
      fullscreenButton.title = 'Este navegador mantém as próprias barras.';
      return;
    }
    // Chamada direta no toque, antes de qualquer await: requisito do navegador.
    try {
      ownsFullscreen = true;
      const requestedView = view;
      Promise.resolve(document.documentElement.requestFullscreen({ navigationUI: 'hide' })).then(() => {
        if (view !== requestedView && document.fullscreenElement) return document.exitFullscreen();
      }).catch(() => {
        ownsFullscreen = false;
        if (view) { fullscreenButton.textContent = 'Tela cheia'; fullscreenButton.title = 'Toque para tentar novamente'; }
      });
    } catch { ownsFullscreen = false; }
  }
  function fullscreenChanged() {
    if (!view) return;
    fullscreenButton.hidden = !!document.fullscreenElement;
    layout();
  }
  function keydown(e) {
    if (!view || document.querySelector('.overlay')) return;
    if (e.target.closest?.('select, input, textarea') && !['Tab', 'Escape'].includes(e.key)) return;
    if (e.target.closest?.('.image-search-shortcut') && !['Tab', 'Escape'].includes(e.key)) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') {
      const focusables = [...view.querySelectorAll('button:not([disabled]), select, a[href], summary, [tabindex="0"]')]
        .filter(el => !el.hidden && !el.closest('[hidden]') && (!el.closest('.viewer-menu') || options.open)
          && (!el.closest('.viewer-photo') || view.classList.contains('two-photos') || el.closest('.viewer-photo') === panels[cur].el));
      const index = focusables.indexOf(document.activeElement);
      if (e.shiftKey && index <= 0) { e.preventDefault(); focusables.at(-1)?.focus(); }
      else if (!e.shiftKey && (index === -1 || index === focusables.length - 1)) { e.preventDefault(); focusables[0]?.focus(); }
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); show(cur === 'L' ? 'R' : 'L'); }
    else if (e.key === 'Enter' && e.target === panels[cur].el) { e.preventDefault(); chooseButton.click(); }
    else if (e.key === '+' || e.key === '=') panels[cur].zoom(1.25, innerWidth / 2, innerHeight / 2);
    else if (e.key === '-') panels[cur].zoom(0.8, innerWidth / 2, innerHeight / 2);
    e.stopPropagation();
  }

  function open(side = 'L') {
    if (view) { show(side); fullscreen(); return; }
    previousFocus = document.activeElement;
    appRoot = document.getElementById('app'); previousInert = appRoot?.inert;
    if (appRoot) appRoot.inert = true;
    previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    document.body.classList.add('viewer-open');
    panels = { L: makePanel('L'), R: makePanel('R') };
    title = h('div', { class: 'viewer-caption' });
    status = h('div', { class: 'viewer-status', role: 'status', 'aria-live': 'polite', hidden: true });
    const selectMode = h('select', { 'aria-label': 'Modo de comparação', onchange: () => {
      mode = selectMode.value; localStorage.setItem('rp-viewer-mode', mode); layout();
    } }, [['auto', 'Automático'], ['uma', 'Uma foto'], ['duas', 'Duas fotos']].map(([value, label]) => h('option', { value, selected: mode === value }, label)));
    fullscreenButton = button('Tela cheia', fullscreen, 'viewer-fullscreen');
    search = imageSearchControls(name, { includeLink: false, onChange: controls });
    options = h('details', { class: 'viewer-options' }, h('summary', null, 'Opções'),
      h('div', { class: 'viewer-menu' },
        button('Rever depois', () => { options.open = false; onAction('later'); }),
        canManage() ? button('Problema na foto', () => { options.open = false; onAction('problem'); }) : null,
        button('Desfazer', () => { options.open = false; onAction('undo'); }),
        canManage() ? h('p', null, 'Termo da busca no Google Imagens:') : null, canManage() ? search.el : null,
        canManage() ? h('small', null, 'Toque em G ↗ sobre a foto para buscar alternativas em outra aba.') : null));
    otherButton = button('Outra foto', () => show(cur === 'L' ? 'R' : 'L'), 'viewer-other');
    otherButton.prepend(icon('dir'));
    chooseButton = button('Escolher esta', () => { if (!chooseButton.disabled) onChoose(cur); }, 'primary viewer-choose');
    const closeButton = button('Fechar', close, 'viewer-close');
    view = h('div', { class: 'zoomview', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Comparar fotos em tela cheia' },
      h('div', { class: 'viewer-toolbar' }, selectMode, fullscreenButton, options),
      h('div', { class: 'viewer-stage' }, panels.L.el, panels.R.el, status),
      h('div', { class: 'viewer-footer' }, title,
        h('div', { class: 'viewer-buttons' }, otherButton, chooseButton, closeButton)),
      h('div', { class: 'viewer-hint' }, 'Arraste para trocar · duplo toque ou pinça para ampliar'));
    document.body.append(view);
    pairId = null; update(); show(side);
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('fullscreenchange', fullscreenChanged);
    window.addEventListener('resize', layout);
    otherButton.focus();
    fullscreen(); fullscreenChanged();
  }
  function close() {
    if (!view) return;
    ++generation;
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('fullscreenchange', fullscreenChanged);
    window.removeEventListener('resize', layout);
    view.remove(); view = null; pairId = null;
    document.body.classList.remove('viewer-open'); document.body.style.overflow = previousOverflow;
    if (appRoot) appRoot.inert = previousInert;
    if (ownsFullscreen && document.fullscreenElement) Promise.resolve(document.exitFullscreen()).catch(() => {});
    ownsFullscreen = false;
    previousFocus?.focus();
  }
  return { open, close, update, setBusy(value) { busy = value; controls(); } };
}
