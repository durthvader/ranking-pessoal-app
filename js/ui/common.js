import { h, clear } from '../util.js';

const ICONS = {
  votar: '<path d="M4 5h7v14H4zM13 5h7v14h-7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  ranking: '<path d="M5 20V10M12 20V4M19 20v-7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/>',
  progresso: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  chave: '<path d="M4 6h5v4H4zM4 14h5v4H4zM15 10h5v4h-5zM9 8h3v8H9M12 12h3" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  historico: '<path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v3.5h3.5M12 8v4l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  mais: '<circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15 15l5 5M10.5 8v5M8 10.5h5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  desfazer: '<path d="M9 7L4 12l5 5M4 12h10a6 6 0 0 1 0 12h-2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 -3)"/>',
  depois: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v4l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  problema: '<path d="M12 4l9 16H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4M12 17v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  fechar: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  esq: '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  dir: '<path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  sync: '<path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3M18 3v4h-4M6 21v-4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  logo: '<rect width="24" height="24" rx="6" fill="var(--accent)"/><rect x="4" y="5" width="7" height="14" rx="2" fill="#fff"/><rect x="13" y="5" width="7" height="14" rx="2" fill="#fff" opacity=".55"/>',
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" class="${cls}">${ICONS[name] || ''}</svg>`;
  return span.firstElementChild;
}

// ------------------------------------------------------------ avisos rápidos
let toastBox = null;
export function toast(msg, { type = 'info', ms = 3500, action = null } = {}) {
  if (!toastBox) {
    toastBox = h('div', { class: 'toastbox', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const el = h('div', { class: `toast ${type === 'err' ? 'err' : ''}` }, h('span', null, msg));
  if (action) el.append(h('button', { onclick: () => { action.fn(); el.remove(); } }, action.label));
  toastBox.append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

// ------------------------------------------------------------ diálogos
export function modal(title, body, actions = [], { onClose } = {}) {
  const ov = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' });
  const close = (v) => { ov.remove(); document.removeEventListener('keydown', onKey, true); onClose?.(v); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
  document.addEventListener('keydown', onKey, true);
  const acts = h('div', { class: 'actions' });
  for (const a of actions) {
    acts.append(h('button', { class: `btn ${a.cls || ''}`, onclick: async () => {
      if (a.fn) { const r = await a.fn(); if (r === false) return; close(r ?? a.value); } else close(a.value);
    } }, a.label));
  }
  const m = h('div', { class: 'modal' }, h('h2', null, title), body, actions.length ? acts : null);
  ov.append(m);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(null); });
  document.body.append(ov);
  const first = m.querySelector('input, select, textarea, button.primary');
  first?.focus();
  return { close, el: m };
}

export function confirmDialog(title, text, okLabel = 'Confirmar', cls = 'primary') {
  return new Promise((resolve) => {
    modal(title, h('p', null, text), [
      { label: 'Cancelar', value: false },
      { label: okLabel, value: true, cls },
    ], { onClose: (v) => resolve(!!v) });
  });
}

export function choiceDialog(title, text, options) {
  return new Promise((resolve) => {
    const body = h('div', { class: 'col' }, text ? h('p', null, text) : null);
    let dlg;
    for (const o of options) {
      body.append(h('button', { class: `btn ${o.cls || ''}`, style: { justifyContent: 'flex-start' }, onclick: () => { resolve(o.value); dlg.close(o.value); } },
        o.label, o.hint ? h('small', { class: 'muted', style: { marginLeft: 'auto' } }, o.hint) : null));
    }
    dlg = modal(title, body, [{ label: 'Cancelar', value: null }], { onClose: (v) => { if (v == null) resolve(null); } });
  });
}

// ------------------------------------------------------------ painel lateral
let drawerEl = null;
export function openDrawer(build) {
  closeDrawer();
  drawerEl = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true' });
  const content = h('div');
  drawerEl.append(h('button', { class: 'btn small close', onclick: closeDrawer, 'aria-label': 'Fechar' }, icon('fechar'), 'Fechar'), content);
  document.body.append(drawerEl);
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.overlay, .zoomview')) closeDrawer(); };
  document.addEventListener('keydown', onKey);
  drawerEl._off = () => document.removeEventListener('keydown', onKey);
  build(content);
  return content;
}
export function closeDrawer() {
  if (drawerEl) { drawerEl._off?.(); drawerEl.remove(); drawerEl = null; }
}
export function drawerOpen() { return !!drawerEl; }

// ------------------------------------------------------------ fotos
// Miniatura que só lê a imagem quando aparece na tela.
const io = typeof IntersectionObserver !== 'undefined'
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      e.target._load?.();
    }
  }, { rootMargin: '300px' })
  : null;

export function photoImg(app, photo, { cls = 'thumb', full = false, alt = '' } = {}) {
  const img = h('img', { class: cls, alt, decoding: 'async', referrerpolicy: 'no-referrer' });
  if (!photo) { img.classList.add('missing'); return img; }
  img._load = async () => {
    const path = full ? photo.path : (photo.thumb || photo.path);
    let url = await app.images.url(path, photo.external_url || null);
    if (!url && !full && photo.path) url = await app.images.url(photo.path, photo.external_url || null);
    if (url) img.src = url;
    else img.alt = 'foto indisponível';
  };
  if (io && !full) io.observe(img); else img._load();
  return img;
}

export function syncText(s) {
  if (!s.online) return { cls: 'pend', text: s.pendingEvents ? `Sem conexão · ${s.pendingEvents} na fila` : 'Sem conexão' };
  if (s.syncing) return { cls: 'busy', text: 'Sincronizando…' };
  if (s.lastError) return { cls: 'err', text: 'Falha ao sincronizar' };
  if (s.pendingEvents) return { cls: 'pend', text: `${s.pendingEvents} pendente${s.pendingEvents > 1 ? 's' : ''}` };
  if (s.pendingImages) return { cls: 'pend', text: `Enviando fotos (${s.pendingImages})` };
  return { cls: 'ok', text: 'Tudo salvo' };
}

export function loadScript(src) {
  if (document.querySelector(`script[data-src="${src}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.dataset.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Falha ao carregar ' + src));
    document.head.append(s);
  });
}

export function badge(text, cls = '') {
  return h('span', { class: `badge ${cls}` }, text);
}

export function section(title, ...children) {
  return h('section', { class: 'card' }, h('h2', null, title), ...children);
}

export function applyTheme() {
  const t = localStorage.getItem('rp-theme') || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

export { h, clear };
