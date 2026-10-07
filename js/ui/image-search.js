import { h } from '../util.js';

export const SEARCH_TERMS = [
  ['portrait', 'Retrato'], ['young adult portrait', 'Fase jovem adulta'],
  ['magazine cover', 'Capa de revista'], ['fashion editorial', 'Editorial'], ['poster', 'Pôster'],
];

export function imageSearchUrl(name, term = 'portrait') {
  const query = `"${String(name || '').trim()}" ${term}`;
  return `https://www.google.com/search?${new URLSearchParams({ tbm: 'isch', q: query })}`;
}

export function imageSearchTerm() {
  const stored = localStorage.getItem('rp-image-search-term');
  return SEARCH_TERMS.some(([value]) => value === stored) ? stored : 'portrait';
}

export function imageSearchShortcut(getName) {
  const el = h('a', { class: 'image-search-shortcut', target: '_blank', rel: 'noopener noreferrer' },
    h('span', { 'aria-hidden': 'true' }, 'G'), h('small', { 'aria-hidden': 'true' }, '↗'));
  const update = () => {
    const name = getName();
    el.hidden = !name;
    el.href = imageSearchUrl(name, imageSearchTerm());
    el.title = `Google Imagens · ${name}`;
    el.setAttribute('aria-label', `Buscar fotos de ${name} no Google Imagens (nova aba)`);
  };
  // O toque no atalho não escolhe a foto nem inicia o gesto de ampliação.
  for (const event of ['click', 'pointerdown', 'keydown']) el.addEventListener(event, e => { e.stopPropagation(); update(); });
  update();
  return { el, update };
}

export function imageSearchControls(getName, { includeLink = true, onChange = () => {} } = {}) {
  const link = h('a', { class: 'btn image-search-link', target: '_blank', rel: 'noopener noreferrer' }, 'Google Imagens ↗');
  const select = h('select', { 'aria-label': 'Tipo de foto para buscar' },
    SEARCH_TERMS.map(([value, label]) => h('option', { value }, label)));
  const update = () => {
    select.value = imageSearchTerm();
    link.href = imageSearchUrl(getName(), select.value);
    link.setAttribute('aria-label', `Buscar fotos de ${getName()} no Google Imagens`);
  };
  select.addEventListener('change', () => {
    localStorage.setItem('rp-image-search-term', select.value);
    update(); onChange();
  });
  link.addEventListener('click', update);
  update();
  return { el: h('div', { class: 'image-search-controls' }, select, includeLink ? link : null), update };
}
