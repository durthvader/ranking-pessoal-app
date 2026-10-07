import { h, clear, fmtInt, fmtNum, fmtPct } from '../util.js';
import { section } from './common.js';
import { isOwner, isCatalogEvent } from '../access.js';
import { materialize, validVotes } from '../store.js';
import { Engine } from '../engine.js';
import { compareRankings } from '../correlation.js';

export function renderCorrelation(app, root, query = {}) {
  if (!isOwner(app.access)) return;
  const select = h('select', { 'aria-label': 'Avaliação do convidado' });
  const refresh = h('button', { class: 'btn', onclick: () => load() }, 'Atualizar comparação');
  const body = h('div');
  root.append(h('h1', null, 'Correlação entre avaliações'),
    h('p', null, 'Compare sua avaliação ativa com a avaliação independente de um convidado. As escolhas continuam separadas.'),
    h('div', { class: 'row' }, select, refresh), body);
  let disposed = false, generation = 0;
  let requests = [];
  select.addEventListener('change', () => load());
  async function init() {
    try {
      requests = (await app.remote.listAccessRequests()).filter(row => row.evaluation_id);
      select.replaceChildren(...requests.map(row => h('option', { value: row.user_id }, row.display_name || row.email)));
      if (requests.some(row => row.user_id === query.convidado)) select.value = query.convidado;
      if (!requests.length) { body.append(h('div', { class: 'empty' }, 'Aprove um convidado em ', h('a', { href: '#/convidados' }, 'Convidados'), ' para acompanhar a comparação.')); refresh.disabled = true; return; }
      await load();
    } catch (error) { if (!disposed) body.append(h('div', { class: 'notice err' }, error.message)); }
  }
  async function load() {
    const stamp = ++generation;
    const account = requests.find(row => row.user_id === select.value);
    if (!account || disposed) return;
    clear(body); body.append(h('p', { class: 'muted' }, 'Calculando comparação…')); refresh.disabled = true;
    try {
      const events = await app.remote.guestEvents(account.user_id);
      if (disposed || stamp !== generation) return;
      const catalog = app.events.filter(isCatalogEvent);
      const state = materialize([...catalog, ...events]);
      // Cálculo isolado: não grava nem materializa votos do convidado na avaliação do dono.
      const guestEngine = new Engine({ state });
      await guestEngine.refresh();
      if (disposed || stamp !== generation) return;
      if (!guestEngine.model) throw new Error(guestEngine.lastError || 'Avaliação ainda indisponível.');
      if (!app.engine.model) { clear(body); body.append(h('p', null, 'Aguarde o cálculo da sua avaliação e atualize a comparação.')); return; }
      const rows = engine => engine.rankingRows().map(row => ({ ...row, score: engine.model.s[engine.model.index.get(row.pid)] }));
      const ownVotes = validVotes(app.state), guestVotes = validVotes(state);
      const result = compareRankings(rows(app.engine), rows(guestEngine), ownVotes, guestVotes);
      draw(result, ownVotes.length, guestVotes.length);
    } catch (error) { if (!disposed && stamp === generation) { clear(body); body.append(h('div', { class: 'notice err' }, error.message)); } }
    finally { if (!disposed && stamp === generation) refresh.disabled = false; }
  }
  function draw(result, ownCount, guestCount) {
    clear(body);
    body.append(h('p', { class: 'muted', style: { marginTop: '12px' } }, `Você: ${fmtInt(ownCount)} escolhas válidas · convidado: ${fmtInt(guestCount)} · ${fmtInt(result.n)} participantes avaliadas por ambos.`));
    if (!guestCount) { body.append(h('div', { class: 'empty' }, 'O convidado ainda não fez escolhas. A comparação aparecerá conforme ele votar.')); return; }
    const grid = h('div', { class: 'grid cols-2' });
    grid.append(section('Correlação de Spearman',
      h('div', { class: 'big' }, result.rho == null ? 'Ainda indisponível' : fmtNum(result.rho,3)),
      h('p', { class: 'help' }, result.rho == null ? 'São necessárias pelo menos três participantes avaliadas pelos dois e diferenças de posição.' : '+1 indica ordens iguais; 0 indica pouca associação entre as posições; −1 indica ordens inversas.'),
      h('p', { class: 'help' }, 'Calculada só entre participantes com comparações válidas nas duas avaliações. Empates recebem a posição média. Com pouca cobertura, o resultado é provisório.')),
    section('Concordância nas mesmas duplas',
      h('div', { class: 'big' }, result.agreement.rate == null ? 'Sem duplas em comum' : fmtPct(result.agreement.rate)),
      h('p', null, `${fmtInt(result.agreement.agreed)} escolhas iguais em ${fmtInt(result.agreement.total)} duplas compartilhadas.`),
      h('p', { class: 'help' }, 'Usa a última escolha válida de cada dupla com as mesmas fotos. Repetições contam uma vez.')));
    body.append(grid);
    if (result.n >= 3) body.append(scatter(result.rows,result.n));
    if (result.rows.length) {
      const differences = result.rows.slice().sort((a,b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0,20);
      body.append(h('h2', { style: { marginTop: '20px' } }, 'Diferenças de posição'),
        h('p', { class: 'help' }, 'Posições recalculadas entre as participantes avaliadas pelos dois. Elas podem diferir das posições no ranking completo.'),
        h('div', { class: 'tablewrap' }, h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, ['Participante','Você','Convidado','Comparações: você / convidado'].map(label => h('th', null,label)))),
          h('tbody', null, differences.map(row => h('tr', null, h('td', null,row.name), h('td', null,fmtNum(row.leftRank,1)), h('td', null,fmtNum(row.rightRank,1)), h('td', null,`${row.leftComps} / ${row.rightComps}`)))))));
    }
  }
  function scatter(rows,n) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox','0 0 500 360'); svg.setAttribute('class','correlation-plot');
    svg.setAttribute('role','img'); svg.setAttribute('aria-label','Posição na sua avaliação no eixo horizontal e na do convidado no vertical. Pontos perto da diagonal indicam posições próximas.');
    const add = (tag,attrs,text) => { const el=document.createElementNS(ns,tag); for(const [k,v] of Object.entries(attrs)) el.setAttribute(k,String(v)); if(text) el.textContent=text; svg.append(el); return el; };
    add('line',{x1:50,y1:30,x2:50,y2:305,stroke:'currentColor'}); add('line',{x1:50,y1:305,x2:470,y2:305,stroke:'currentColor'});
    add('line',{x1:50,y1:30,x2:470,y2:305,stroke:'var(--muted)','stroke-dasharray':'5 5'});
    add('text',{x:250,y:345,'text-anchor':'middle',fill:'currentColor','font-size':13},'Posição na sua avaliação');
    add('text',{x:250,y:16,'text-anchor':'middle',fill:'currentColor','font-size':13},'Posição na avaliação do convidado: de cima para baixo');
    for(const rank of [1,n]) { const t=(rank-1)/Math.max(1,n-1); add('text',{x:50+t*420,y:323,fill:'currentColor','font-size':12},String(rank)); add('text',{x:28,y:34+t*275,fill:'currentColor','font-size':12},String(rank)); }
    for (const row of rows) {
      const dot=add('circle',{cx:50+(row.leftRank-1)/(n-1)*420,cy:30+(row.rightRank-1)/(n-1)*275,r:4,fill:'var(--accent)',opacity:.7,tabindex:0});
      const title=document.createElementNS(ns,'title'); title.textContent=`${row.name}: você ${fmtNum(row.leftRank,1)}; convidado ${fmtNum(row.rightRank,1)}`; dot.append(title);
    }
    return h('div', { class: 'card', style: { marginTop: '16px' } },svg);
  }
  init();
  return () => { disposed = true; ++generation; };
}
