import { h, clear, fmtInt, fmtPct, fmtNum, plural } from '../util.js';
import { photoImg, badge, section, toast } from './common.js';
import { openParticipant } from './participants.js';
import { closeVersionDialog } from './versions.js';
import { isOwner } from '../access.js';

export function renderProgress(app, root) {
  const body = h('div');
  root.append(h('h1', null, 'Progresso'), body);
  let signals = null;
  let loadingSignals = false;

  async function loadSignals() {
    if (loadingSignals) return;
    loadingSignals = true;
    try { signals = await app.engine.signals(); } catch (e) { signals = { error: e.message }; }
    loadingSignals = false;
    draw();
  }

  function draw() {
    clear(body);
    const s = app.state;
    if (!s.participants.size) { body.append(h('div', { class: 'empty' }, isOwner(app.access) ? 'Importe as participantes para começar.' : 'Aguarde a sincronização do catálogo.')); return; }
    if (!s.activeEval) { body.append(h('div', { class: 'empty' }, 'Nenhuma avaliação ativa. ', isOwner(app.access) ? h('a', { href: '#/versoes' }, 'Abrir Versões') : null)); return; }
    const prog = app.engine.progress();
    const m = app.engine.model;
    const settings = prog.settings;
    const reached = prog.valid >= prog.budget;
    const name = (pid) => s.participants.get(pid)?.name || '?';
    const photoOf = (pid) => { const p = s.participants.get(pid); return p?.primary ? s.photos.get(p.primary) : null; };

    if (reached) {
      body.append(h('div', { class: 'notice ok' },
        h('strong', null, `Orçamento atingido: ${fmtInt(prog.valid)} escolhas válidas. `),
        isOwner(app.access) ? 'A lista abaixo mostra a situação atual e as dúvidas que restam. Você pode encerrar esta versão (fica guardada com data, configurações e votos) ou continuar avaliando.' : 'A lista abaixo mostra seu ranking atual e as posições que ainda têm dúvida. Você pode continuar avaliando.',
        h('div', { class: 'row', style: { marginTop: '8px' } },
          h('a', { class: 'btn', href: '#/ranking' }, 'Ver lista completa'),
          isOwner(app.access) ? h('button', { class: 'btn primary', onclick: () => closeVersionDialog(app) }, 'Encerrar esta versão') : null,
          h('a', { class: 'btn', href: '#/votar' }, 'Continuar avaliando'))));
    }

    const grid = h('div', { class: 'grid cols-2' });
    body.append(grid);
    // 1. orçamento
    const pct = Math.min(1, prog.valid / prog.budget);
    grid.append(section('Escolhas válidas',
      h('div', { class: 'big' }, `${fmtInt(prog.valid)} `, h('span', { class: 'muted', style: { fontSize: '16px' } }, `de ${fmtInt(prog.budget)}`)),
      h('div', { class: `bar ${reached ? 'ok' : ''}`, style: { margin: '8px 0' } }, h('span', { style: { width: `${pct * 100}%` } })),
      h('p', { class: 'help' }, 'O orçamento serve para planejar. A quantidade necessária depende de quão parecidas são suas preferências e da consistência das escolhas.'),
      h('table', { class: 'tbl' },
        h('tr', null, h('td', null, 'Rever depois (fora da contagem)'), h('td', { class: 'num' }, fmtInt(prog.kinds.abstain || 0))),
        h('tr', null, h('td', null, 'Problemas de foto (fora da contagem)'), h('td', { class: 'num' }, fmtInt(prog.kinds.photo_problem || 0))),
        h('tr', null, h('td', null, 'Auditorias (guardadas à parte)'), h('td', { class: 'num' }, fmtInt(prog.kinds.audit || 0))),
        h('tr', null, h('td', null, 'Ações desfeitas ou anuladas'), h('td', { class: 'num' }, fmtInt(prog.kinds.anulado || 0))),
        h('tr', null, h('td', null, 'Votos fora do cálculo (foto trocada, exclusão, conflito)'), h('td', { class: 'num' }, fmtInt(Math.max(0, (prog.kinds.vote || 0) - prog.valid)))))));

    // 2. cobertura
    const order = ['0', '1', '2', '3', '4', '5', '6', '7–9', '10–14', '15+'];
    const maxH = Math.max(1, ...order.map((k) => prog.hist.get(k) || 0));
    grid.append(section('Cobertura por participante',
      h('div', { class: 'big' }, `${fmtInt(prog.covered)} `, h('span', { class: 'muted', style: { fontSize: '16px' } }, `de ${fmtInt(prog.activeN)} com ${prog.coverageMin}+ comparações`)),
      h('div', { class: 'histo', 'aria-label': 'Participantes por número de comparações' },
        order.map((k) => {
          const v = prog.hist.get(k) || 0;
          const okBin = k.includes('–') || k.includes('+') || Number(k) >= prog.coverageMin;
          return h('div', { class: 'b', title: `${v} participantes com ${k} comparações` }, h('small', null, v || ''), h('span', { class: okBin ? 'ok' : '', style: { height: `${(v / maxH) * 80}%` } }), k);
        })),
      h('p', { class: 'help' }, prog.uncoveredEligible > 0
        ? `Fase de cobertura: faltam cerca de ${fmtInt(Math.ceil(prog.missingCoverage / 2))} confrontos para todas chegarem a ${prog.coverageMin} comparações.`
        : 'Cobertura completa. Os confrontos agora seguem a fase adaptativa.'),
      prog.photoBlockedN > 0 ? h('p', { class: 'help' }, `${prog.photoBlockedN} participantes estão fora dos confrontos por pendência de foto. `, isOwner(app.access) ? h('a', { href: '#/participantes?aba=revisar' }, 'Revisar') : null) : null,
      prog.frozenN > 0 ? h('p', { class: 'help' }, `${prog.frozenN} participantes congeladas pela regra das derrotas: continuam no ranking e no cálculo, fora de novos confrontos. `, h('a', { href: '#/ranking?filtro=congeladas' }, 'Ver congeladas')) : null));

    // 3. disputa pelo 1º lugar
    if (m && prog.top) {
      const t = prog.top;
      const box = section('Disputa pelo 1º lugar');
      const status = t.leaderP1 >= 0.9
        ? `A líder atual tem ${fmtPct(t.leaderP1)} de chance estimada de ser a sua 1ª colocada.`
        : `Disputa aberta: ${t.contenders.length} participantes têm 1% ou mais de chance estimada; a líder atual tem ${fmtPct(t.leaderP1)}.`;
      box.append(h('p', null, status),
        prog.uncoveredEligible > 0 ? h('p', { class: 'help' }, 'Durante a fase de cobertura as chances ficam espalhadas: a maioria das participantes ainda tem poucas comparações, e quem não tem nenhuma mantém a incerteza do prior.') : null,
        h('p', { class: 'help' }, `Estimativas condicionadas ao modelo e aos votos, calculadas com ${fmtInt(m.samples)} amostras conjuntas de todas as participantes. Número efetivo de candidatas: ${fmtNum(t.effective, 1)}.`));
      for (const r of t.byP1.filter((x) => x.p1 > 0).slice(0, 8)) {
        box.append(h('div', { class: 'p1row', style: { cursor: 'pointer' }, onclick: () => openParticipant(app, r.pid) },
          photoImg(app, r.photo, { cls: 'thumb sm' }),
          h('div', { style: { minWidth: 0 } }, h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${r.pos}º · ${r.name}`), h('small', { class: 'muted' }, `${plural(r.comps, 'comparação', 'comparações')} · faixa ${r.lo}–${r.hi}`)),
          h('div', { class: 'bar' }, h('span', { style: { width: `${r.p1 * 100}%` } })),
          h('div', { class: 'num', style: { textAlign: 'right' } }, fmtPct(r.p1, r.p1 < 0.1 ? 1 : 0))));
      }
      const stage = app.engine.reviewStage();
      box.append(h('p', { class: 'help' }, settings.reviewAuto
        ? (stage.active ? `Etapa de revisão do 1º lugar em andamento (começou em ${fmtInt(stage.from)} escolhas).` : `A etapa de revisão do 1º lugar começa sozinha em ${fmtInt(stage.from)} escolhas válidas.`)
        : 'A etapa de revisão automática está desligada; use o botão abaixo quando quiser.'));
      const rs = app.engine.reviewSet();
      box.append(h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn', onclick: () => { localStorage.setItem('rp-vote-mode', 'revisao'); app.go('votar'); } }, `Revisar o 1º lugar (${rs.contenders.length} candidatas + ${rs.under.length} pouco avaliadas)`)));
      grid.append(box);

      // 4. posições que precisam de comparação
      grid.append(section('Posições que ainda precisam de comparação',
        h('p', null, `${t.closeTop50} das 50 primeiras posições têm ordem incerta em relação à vizinha seguinte (chance de ordem correta abaixo de ${fmtPct(settings.closeThreshold)}). No ranking inteiro: ${t.closeAll}.`),
        h('p', { class: 'help' }, 'Faixas de posição mais largas:'),
        h('table', { class: 'tbl' }, t.wide.slice(0, 6).map((r) => h('tr', { class: 'clickable', onclick: () => openParticipant(app, r.pid) },
          h('td', null, `${r.pos}º`), h('td', null, r.name), h('td', { class: 'num' }, `${r.lo}–${r.hi}`), h('td', { class: 'num muted' }, plural(r.comps, 'comp.', 'comp.')))))));

      // 5. confrontos mais úteis
      const useful = app.engine.useful(8);
      grid.append(section('Confrontos que mais ajudam agora',
        h('p', { class: 'help' }, 'Calculados pela informação esperada de cada confronto, com prioridade para a disputa do 1º lugar, para participantes pouco avaliadas e para as divisas entre faixas. A tela de votação segue esta mesma lógica.'),
        useful.length ? h('table', { class: 'tbl' }, useful.map((u) => h('tr', null,
          h('td', null, h('div', { class: 'row', style: { flexWrap: 'nowrap', gap: '4px' } }, photoImg(app, photoOf(u.a), { cls: 'thumb sm' }), photoImg(app, photoOf(u.b), { cls: 'thumb sm' }))),
          h('td', null, `${name(u.a)} × ${name(u.b)}`, h('div', { class: 'muted', style: { fontSize: '12px' } }, u.text + (u.reason.swap != null ? ` · chance de ordem invertida ${fmtPct(u.reason.swap)}` : '')))))) : h('p', { class: 'muted' }, 'Disponível depois do primeiro cálculo.')));
    }

    // 6. consistência
    const audits = app.engine.audits();
    const bias = app.engine.sideBias();
    const cons = section('Consistência e mudanças de preferência');
    cons.append(h('p', null, audits.total
      ? `Auditorias: ${audits.agree} de ${audits.total} repetiram a escolha original (${fmtPct(audits.rate)}).` + (audits.otherSession.n ? ` Em sessões diferentes: ${fmtPct(audits.otherSession.rate)} de ${audits.otherSession.n}.` : '') + (audits.sameSession.n ? ` Na mesma sessão: ${fmtPct(audits.sameSession.rate)} de ${audits.sameSession.n}.` : '')
      : 'Nenhuma auditoria ainda. Em Votar → Mais, a rodada de auditoria repete 10 pares já vistos, com lados sorteados de novo e intercalados com outros confrontos.'));
    if (bias.total >= 30) {
      cons.append(h('p', null, `Lado escolhido: esquerda/cima em ${fmtPct(bias.rate)} de ${fmtInt(bias.total)} escolhas` + (Math.abs(bias.z) > 2.5 ? ' (acima da variação esperada ao acaso).' : ' (dentro da variação esperada ao acaso).')));
    }
    if (signals?.error) cons.append(h('p', { class: 'notice err' }, signals.error));
    else if (signals) {
      const c = signals.cycles;
      cons.append(h('p', null, c.triangles
        ? `Ciclos: ${c.cyclic} de ${fmtInt(c.triangles)} trios comparados entre si formam ciclo (A > B, B > C, C > A), ${fmtPct(c.rate, 1)}.`
        : 'Ciclos: ainda não há trios com os três pares comparados.'));
      if (c.examples.length) {
        cons.append(h('details', null, h('summary', null, 'Exemplos de ciclos'),
          h('ul', null, c.examples.slice(0, 8).map((tri) => h('li', null, tri.map((i) => name(signals.pids[i])).join(' > ') + ' > ' + name(signals.pids[tri[0]]))))));
      }
      const flagged = signals.drift.filter((d) => d.flag);
      cons.append(h('p', null, signals.drift.length
        ? `Sessões avaliadas: ${signals.drift.length}. Com escolhas abaixo da concordância esperada: ${flagged.length}.`
        : 'Mudança entre sessões: são necessárias pelo menos duas sessões com 15 escolhas.'));
      if (signals.drift.length) {
        cons.append(h('details', null, h('summary', null, 'Detalhe por sessão'),
          h('table', { class: 'tbl' }, h('tr', null, h('th', null, 'Sessão'), h('th', { class: 'num' }, 'Escolhas'), h('th', { class: 'num' }, 'Concordância'), h('th', { class: 'num' }, 'Esperada'), h('th', null, '')),
            signals.drift.map((d) => h('tr', null, h('td', { class: 'mono' }, d.session.slice(0, 8)), h('td', { class: 'num' }, d.votes),
              h('td', { class: 'num' }, fmtPct(d.obsAgree)), h('td', { class: 'num' }, fmtPct(d.expAgree)), h('td', null, d.flag ? badge('divergente', 'warn') : ''))))));
      }
    } else {
      cons.append(h('button', { class: 'btn small', onclick: loadSignals }, 'Calcular ciclos e mudanças entre sessões'));
    }
    cons.append(h('p', { class: 'help', style: { marginTop: '8px' } },
      'Como ler: o ranking resume todas as escolhas numa ordem única. Ciclos e mudanças entre sessões mostram trechos em que nenhuma ordem única reproduz todas as suas escolhas. Nessas posições a lista indica tendência, e as faixas de posição ficam mais largas. Uma vitória isolada numa rodada final entra no histórico como qualquer outra; a liderança continua calculada pelo conjunto dos votos.'));
    body.append(h('div', { style: { marginTop: '12px' } }, cons));
    body.append(h('p', { class: 'help', style: { marginTop: '10px' } }, h('a', { href: '#/metodo' }, 'Como o ranking é calculado'), m ? ` · último cálculo: ${fmtInt(m.votesUsed)} escolhas, ${Math.round(m.ms)} ms` : ''));
    if (!signals && !loadingSignals && m) loadSignals();
  }

  const off1 = app.on('model', () => { signals = null; draw(); });
  const off2 = app.on('state', draw);
  draw();
  return () => { off1(); off2(); };
}

export { toast };
