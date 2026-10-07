import { h } from '../util.js';

export const SEARCH_TERMS = [
  ['portrait', 'Retrato'], ['young adult portrait', 'Fase jovem adulta'],
  ['magazine cover', 'Capa de revista'], ['fashion editorial', 'Editorial'], ['poster', 'Pôster'],
];

export function imageSearchUrl(name, term = 'portrait') {
  const query = `"${String(name || '').trim()}" ${term}`;
  return `https://www.google.com/search?${new URLSearchParams({ tbm: 'isch', q: query })}`;
}

export function imageSearchControls(getName) {
  const link = h('a', { class: 'btn image-search-link', target: '_blank', rel: 'noopener noreferrer' }, 'Google Imagens ↗');
  const select = h('select', { 'aria-label': 'Tipo de foto para buscar' },
    SEARCH_TERMS.map(([value, label]) => h('option', { value }, label)));
  const update = () => {
    link.href = imageSearchUrl(getName(), select.value);
    link.setAttribute('aria-label', `Buscar fotos de ${getName()} no Google Imagens`);
  };
  select.addEventListener('change', update);
  link.addEventListener('click', update);
  update();
  return { el: h('div', { class: 'image-search-controls' }, select, link), update };
}
