import { h, clear, fmtInt, fmtPct, fmtDate, normName } from '../util.js';
import { photoImg, badge, openDrawer, closeDrawer, toast, modal, confirmDialog, choiceDialog } from './common.js';
import { eligibilityIssues, evalSettings, frozenInfo } from '../store.js';
import { Z_OF_LEVEL } from './ranking.js';
import { restoreBackup, importSpreadsheet } from '../backup.js';
import { imageSearchControls } from './image-search.js';
import { isOwner } from '../access.js';

const ORIGIN_LABEL = {
  'importacao:planilha': 'link da planilha',
  'importacao:planilha_pagina': 'link da planilha (página convertida em imagem)',
  'importacao:planilha_proxy': 'link da planilha (endereço original da imagem)',
  'importacao:pagina_de_origem': 'página de origem da planilha',
  'importacao:wikipedia': 'Wikipedia (substituta automática)',
  'importacao:alternativa_wikipedia': 'Wikipedia (alternativa sugerida)',
  upload: 'arquivo enviado',
  link: 'link informado no app',
  link_externo: 'link externo (não guardado)',
};

export function photoFlags(ph) {
  const out = [];
  if (!ph) return [badge('sem foto', 'err')];
  if (ph.reviewStatus === 'pendente') out.push(badge('aguardando confirmação', 'warn'));
  if (ph.problems?.length) out.push(badge(`problema relatado (${ph.problems.length})`, 'err'));
  if (ph.external_url && !ph.path) out.push(badge('imagem externa', 'warn'));
  for (const a of ph.quality?.alerts || []) {
    if (/substituída|alternativa sugerida|página de origem/.test(a)) continue;
    out.push(badge(a.split(':')[0], 'warn'));
  }
  return out;
}

export function openParticipant(app, pid) {
  if (!isOwner(app.access)) {
    return openDrawer(root => {
      const p = app.state.participants.get(pid);
      if (!p) { root.append(h('p', null, 'Participante não encontrada.')); return; }
      const image = photoImg(app, app.state.photos.get(p.primary), { cls: '', full: true, alt: p.name });
      image.style.cssText = 'width:100%;max-height:70dvh;object-fit:contain;display:block';
      const row = app.engine.rankingRows().find(r => r.pid === pid);
      root.append(h('h1', null, p.name), image,
        row ? h('p', { class: 'muted' }, `${row.pos}º na sua avaliação · ${fmtInt(row.comps)} comparações`) : null);
    });
  }
  openDrawer((root) => {
    const draw = () => {
      clear(root);
      const s = app.state;
      const p = s.participants.get(pid);
      if (!p) { root.append(h('p', null, 'Participante não encontrada.')); return; }
      const settings = evalSettings(s);
      const m = app.engine.model;
      const rows = app.engine.rankingRows();
      const r = rows.find((x) => x.pid === pid);
      const ph = p.primary ? s.photos.get(p.primary) : null;
      const issues = eligibilityIssues(s, p, settings, null);
      const z = Z_OF_LEVEL[settings.level] || 1.645;
      root.append(
        h('h1', null, p.name, p.status === 'excluida' ? h('span', { class: 'badge err', style: { marginLeft: '8px' } }, 'excluída') : null),
        h('p', { class: 'muted' }, [p.code != null ? `Código ${p.code}` : null, p.meta?.pais, p.meta?.atuacao, p.meta?.epoca_sugerida ? `época sugerida: ${p.meta.epoca_sugerida}` : null].filter(Boolean).join(' · ')),
        issues.length ? h('div', { class: 'notice warn' }, 'Fora dos confrontos agora: ', issues.join('; '), '.') : null,
      );
      // regra de congelamento: a decisão manual fica nas configurações desta avaliação
      if (isOwner(app.access) && p.status !== 'excluida' && s.activeEval) {
        const fz = frozenInfo(s).get(pid);
        const ov = (settings.freezeOverrides || {})[pid];
        const setOverride = async (value, msg) => {
          const all = { ...(settings.freezeOverrides || {}) };
          if (value) all[pid] = value; else delete all[pid];
          try { await app.setEvalSettings({ freezeOverrides: all }); toast(msg); } catch (e) { toast(e.message, { type: 'err' }); }
        };
        const texto = fz ? 'Congelada: continua no ranking e no cálculo, sem novos confrontos.'
          : ov?.mode === 'liberada' ? 'Descongelada manualmente: a regra conta só os votos feitos depois da liberação.'
            : settings.freezeEnabled ? `Regra das derrotas: congela com ${settings.freezeMargin} derrotas a mais que vitórias e até ${settings.freezeMaxWins} vitórias.`
              : 'Regra das derrotas desligada nesta avaliação.';
        root.append(h('div', { class: 'row', style: { gap: '6px', margin: '6px 0', alignItems: 'center' } },
          h('span', { class: 'help' }, texto),
          fz ? h('button', { class: 'btn small', onclick: () => setOverride({ mode: 'liberada', from: s.decisionCount }, 'Participante descongelada. Ela volta aos confrontos e a contagem da regra recomeça agora.') }, 'Descongelar')
            : h('button', { class: 'btn small', onclick: () => setOverride({ mode: 'congelada' }, 'Participante congelada. Ela continua no ranking e sai dos novos confrontos.') }, 'Congelar'),
          ov ? h('button', { class: 'btn small', onclick: () => setOverride(null, 'A participante volta a seguir a regra automática.') }, 'Seguir a regra automática') : null));
      }
      // foto principal
      const big = photoImg(app, ph, { cls: '', full: true, alt: p.name });
      big.style.cssText = 'width:100%;max-height:52vh;object-fit:contain;background:var(--photo-bg);border-radius:12px;display:block;cursor:zoom-in';
      big.addEventListener('click', () => { if (big.src) window.open(big.src, '_blank'); });
      root.append(big, imageSearchControls(() => p.name).el);
      if (r && m) {
        root.append(h('div', { class: 'grid cols-3', style: { margin: '12px 0' } },
          stat('Posição estimada', `${r.pos}º`, `faixa provável ${r.lo}–${r.hi}`),
          stat('Índice de preferência', fmtInt(r.R), `±${fmtInt(z * r.sdR)} (escala Elo)`),
          stat('Chance de 1º lugar', fmtPct(r.p1, 1), `top ${m.topK}: ${fmtPct(r.pTop)} · estimativas do modelo`),
          stat('Comparações válidas', r.comps, `${r.wins} vitórias · ${r.losses} derrotas`),
          stat('Faixa atual', app.engine.groupInfo(r.pos).label, h('a', { href: `#/chaveamento?p=${pid}`, onclick: closeDrawer }, 'ver caminho no chaveamento')),
          stat('Outras ocorrências', `${r.abstains} adiamentos`, `${app.engine.stats().get(pid).problems} problemas de foto`)));
      }
      // fotos
      const photosBox = h('div', { class: 'photo-grid' });
      for (const fid of p.photos) {
        const f = s.photos.get(fid);
        const isPrim = fid === p.primary;
        const card = h('div', { class: `photo-card ${isPrim ? 'primary' : ''}` }, photoImg(app, f, { cls: '' }),
          h('div', { class: 'info' },
            isPrim ? badge('principal', 'acc') : null,
            h('span', { class: 'muted' }, ORIGIN_LABEL[f.origin] || f.origin || ''),
            f.era ? h('span', null, `época: ${f.era}`) : null,
            h('span', { class: 'muted' }, `${f.orig_w || f.w || '?'}×${f.orig_h || f.h || '?'} · ${fmtDate(f.addedAt, false)}`),
            h('div', { class: 'row', style: { gap: '4px' } }, photoFlags(f)),
            f.source_url ? h('a', { href: f.source_url, target: '_blank', rel: 'noreferrer noopener', style: { fontSize: '12px' } }, 'endereço da imagem') : null,
            f.page_url ? h('a', { href: f.page_url, target: '_blank', rel: 'noreferrer noopener', style: { fontSize: '12px' } }, 'página de origem') : null,
            !isPrim ? h('button', { class: 'btn small', onclick: async () => {
              if (p.photos.length && (await app.engine.stats().get(pid)).comps && settings.photoPolicy === 'descartar') {
                const ok = await confirmDialog('Trocar a foto principal', 'Os votos feitos com a foto atual saem do cálculo desta avaliação (continuam no histórico). A participante volta para a fase de cobertura.', 'Trocar foto');
                if (!ok) return;
              }
              await app.setPrimary(pid, fid);
              if (f.reviewStatus === 'pendente') await app.confirmPhoto(fid);
              toast('Foto principal trocada.');
            } }, 'Usar como principal') : null,
            isPrim && f.reviewStatus === 'pendente' ? h('button', { class: 'btn small primary', onclick: async () => { await app.confirmPhoto(fid); toast('Foto confirmada.'); } }, 'Confirmar esta foto') : null,
            isPrim && f.problems?.length ? h('button', { class: 'btn small', onclick: async () => { await app.resolveProblems(fid, 'ok'); toast('Problema marcado como resolvido.'); } }, 'Foto está boa') : null));
        photosBox.append(card);
      }
      const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async () => {
        const file = fileIn.files[0];
        if (!file) return;
        try {
          await app.addPhoto(pid, file, { origin: 'upload' });
          toast('Foto enviada e definida como principal.');
        } catch (e) { toast(e.message, { type: 'err' }); }
      } });
      root.append(h('h2', { style: { marginTop: '16px' } }, 'Fotos'),
        h('p', { class: 'help' }, 'A foto principal aparece nos confrontos. Cada voto guarda as fotos exibidas, então dá para saber qual versão foi usada em cada escolha.'),
        photosBox,
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('button', { class: 'btn', onclick: () => fileIn.click() }, 'Enviar arquivo'),
          h('button', { class: 'btn', onclick: () => askUrl(app, pid) }, 'Usar link de imagem'),
          fileIn));
      // dados editáveis
      const era = h('input', { type: 'text', value: p.era || '', placeholder: 'ex.: 1998–2004' });
      const notes = h('textarea', null, p.notes || '');
      const name = h('input', { type: 'text', value: p.name });
      root.append(h('h2', { style: { marginTop: '16px' } }, 'Dados'),
        h('div', { class: 'form' },
          h('label', { class: 'field' }, h('span', null, 'Nome'), name),
          h('label', { class: 'field' }, h('span', null, 'Época escolhida para a foto'), era),
          h('label', { class: 'field' }, h('span', null, 'Anotações'), notes),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', onclick: async () => {
              const evs = [];
              if (name.value.trim() && name.value.trim() !== p.name) evs.push(['name', name.value.trim()]);
              if ((era.value || '') !== (p.era || '')) evs.push(['era', era.value]);
              if ((notes.value || '') !== (p.notes || '')) evs.push(['notes', notes.value]);
              for (const [f, v] of evs) await app.editParticipant(pid, f, v);
              toast(evs.length ? 'Dados salvos.' : 'Nada mudou.');
            } }, 'Salvar dados'),
            p.status === 'excluida'
              ? h('button', { class: 'btn', onclick: async () => { await app.editParticipant(pid, 'status', 'ativa'); toast('Participante reativada.'); } }, 'Reativar')
              : h('button', { class: 'btn danger', onclick: async () => {
                if (await confirmDialog('Excluir do ranking', 'A participante sai do ranking e dos confrontos. O histórico continua guardado e você pode reativar depois.', 'Excluir', 'danger')) {
                  await app.editParticipant(pid, 'status', 'excluida');
                  toast('Participante excluída do ranking.');
                }
              } }, 'Excluir do ranking'))));
      if (p.meta && Object.values(p.meta).some(Boolean)) {
        const meta = p.meta;
        root.append(h('details', { style: { marginTop: '10px' } }, h('summary', null, 'Dados da planilha'),
          h('table', { class: 'tbl' }, Object.entries({ País: meta.pais, Região: meta.regiao, Atuação: meta.atuacao, 'Época sugerida': meta.epoca_sugerida,
            Reconhecimento: meta.reconhecimento, Motivo: meta.motivo, Fonte: meta.fonte, Observação: meta.observacao, Linha: meta.linha_planilha })
            .filter(([, v]) => v != null && v !== '').map(([k, v]) => h('tr', null, h('td', { class: 'muted' }, k), h('td', null, String(v))))),
          meta.link_fonte ? h('a', { href: meta.link_fonte, target: '_blank', rel: 'noreferrer noopener' }, 'abrir a fonte') : null));
      }
      // adversárias
      const st = app.engine.stats().get(pid);
      if (st.opponents.length) {
        const tb = h('tbody');
        const posOf = new Map(rows.map((x) => [x.pid, x.pos]));
        for (const o of st.opponents.slice().reverse()) {
          const op = s.participants.get(o.opp);
          tb.append(h('tr', { class: 'clickable', onclick: () => openParticipant(app, o.opp) },
            h('td', null, photoImg(app, op?.primary ? s.photos.get(op.primary) : null, { cls: 'thumb sm' })),
            h('td', null, op?.name || '?', h('div', { class: 'muted', style: { fontSize: '12px' } }, posOf.has(o.opp) ? `${posOf.get(o.opp)}º agora` : '')),
            h('td', null, o.won ? badge('venceu', 'ok') : badge('perdeu', 'err')),
            h('td', { class: 'muted' }, fmtDate(o.at))));
        }
        root.append(h('h2', { style: { marginTop: '16px' } }, `Adversárias enfrentadas (${st.opponents.length})`), h('table', { class: 'tbl' }, tb));
      }
      if (st.deferred.size) {
        root.append(h('h2', { style: { marginTop: '16px' } }, 'Pares adiados'),
          h('p', { class: 'help' }, 'A ordem entre estas participantes continua incerta.'),
          h('ul', null, [...st.deferred].map(([o, c]) => h('li', null, `${s.participants.get(o)?.name || '?'}: ${c}×`))));
      }
      if (p.primaryHistory?.length > 1) {
        root.append(h('h2', { style: { marginTop: '16px' } }, 'Histórico da foto principal'),
          h('ul', null, p.primaryHistory.map((x) => h('li', null, `${fmtDate(x.at)}: foto ${x.photo.slice(0, 8)}`))));
      }
    };
    draw();
    const off = app.on('state', draw);
    const off2 = app.on('model', draw);
    const obs = new MutationObserver(() => { if (!root.isConnected) { off(); off2(); obs.disconnect(); } });
    obs.observe(document.body, { childList: true });
  });
}

function stat(label, value, sub) {
  return h('div', { class: 'card', style: { padding: '10px 12px' } }, h('div', { class: 'muted', style: { fontSize: '12px' } }, label),
    h('div', { style: { fontSize: '20px', fontWeight: 650 } }, value), sub ? h('div', { class: 'muted', style: { fontSize: '12px' } }, sub) : null);
}

function askUrl(app, pid) {
  const inp = h('input', { type: 'url', placeholder: 'https://… (endereço da imagem ou da página)' });
  const era = h('input', { type: 'text', placeholder: 'época (opcional)' });
  modal('Usar link de imagem', h('div', { class: 'form' },
    h('label', { class: 'field' }, h('span', null, 'Link'), inp),
    h('label', { class: 'field' }, h('span', null, 'Época da foto'), era),
    h('p', { class: 'help' }, 'O app tenta baixar a imagem e guardar uma cópia na sua conta. Se o link levar a uma página, a função de busca do servidor procura a imagem principal da página.')), [
    { label: 'Cancelar' },
    { label: 'Usar este link', cls: 'primary', fn: async () => {
      const url = inp.value.trim();
      if (!/^https?:\/\//.test(url)) { toast('Informe um link começando com http.', { type: 'err' }); return false; }
      toast('Buscando a imagem…', { ms: 2000 });
      try {
        const r = await app.addPhotoFromUrl(pid, url, { era: era.value || null });
        toast(r.stored ? 'Foto guardada e definida como principal.' : 'O site não permite copiar a imagem; o app vai exibir pelo link externo (fica fora do backup e precisa de conexão).', { ms: 7000 });
      } catch (e) {
        toast(e.message, { type: 'err', ms: 8000 });
        return false;
      }
    } },
  ]);
}

// ------------------------------------------------------------ tela de participantes

export function renderParticipants(app, root, query = {}) {
  let tab = query.aba || 'todas';
  const tabs = h('div', { class: 'tabs' });
  const body = h('div');
  root.append(h('h1', null, 'Participantes'), tabs, body);
  const TABS = [['todas', 'Todas'], ['revisar', 'Revisar fotos'], ['duplicidades', 'Duplicidades'], ['importar', 'Importar'], ['relatorio', 'Relatório da importação']];
  // o registro da importação fica fora do redesenho, para o progresso continuar visível
  const importLog = h('div', { class: 'help import-log', style: { marginTop: '10px', whiteSpace: 'pre-wrap' } });

  function drawTabs() {
    clear(tabs);
    const s = app.state;
    const pend = pendingPhotos(app).length;
    const dups = s.dupGroups.filter((g) => !g.decision).length;
    for (const [k, l] of TABS) {
      const extra = k === 'revisar' && pend ? ` (${pend})` : k === 'duplicidades' && dups ? ` (${dups})` : '';
      tabs.append(h('button', { class: tab === k ? 'active' : '', onclick: () => { tab = k; draw(); } }, l + extra));
    }
  }

  function draw() {
    drawTabs();
    clear(body);
    if (tab === 'todas') drawAll();
    else if (tab === 'revisar') drawReview();
    else if (tab === 'duplicidades') drawDups();
    else if (tab === 'importar') drawImport();
    else drawReport();
  }

  function drawAll() {
    const s = app.state;
    const q = h('input', { type: 'search', placeholder: 'Buscar nome ou código', style: { maxWidth: '300px', marginBottom: '10px' } });
    const list = h('div', { class: 'card', style: { padding: 0 } });
    const fill = () => {
      clear(list);
      const term = normName(q.value);
      const parts = [...s.participants.values()].sort((a, b) => (a.code ?? 1e9) - (b.code ?? 1e9));
      let n = 0;
      for (const p of parts) {
        if (term && !normName(p.name).includes(term) && String(p.code) !== q.value.trim()) continue;
        if (++n > 600) break;
        const ph = p.primary ? s.photos.get(p.primary) : null;
        list.append(h('div', { class: 'rank-item', onclick: () => openParticipant(app, p.pid) },
          h('div', { class: 'pos muted', style: { fontSize: '13px', fontWeight: 400 } }, p.code ?? ''),
          photoImg(app, ph, { cls: 'thumb' }),
          h('div', { style: { minWidth: 0 } }, h('div', { class: 'name' }, p.name), h('div', { class: 'meta' }, p.status === 'excluida' ? badge('excluída', 'err') : null, photoFlags(ph))),
          h('div')));
      }
      if (!n) list.append(h('div', { class: 'empty' }, s.participants.size ? 'Nenhuma participante encontrada.' : 'Nenhuma participante ainda. Use a aba Importar.'));
    };
    q.addEventListener('input', fill);
    body.append(q, list);
    fill();
  }

  function drawReview() {
    const s = app.state;
    const items = pendingPhotos(app);
    body.append(h('p', { class: 'help' }, 'Fotos trocadas automaticamente, com problema relatado ou com alertas da verificação. As que aguardam confirmação ou têm problema ficam fora dos confrontos até você decidir.'));
    if (!items.length) { body.append(h('div', { class: 'empty' }, 'Nenhuma foto aguardando revisão.')); return; }
    const grid = h('div', { class: 'grid cols-2' });
    for (const { p, ph, why, blocking } of items) {
      const alts = p.photos.filter((f) => f !== p.primary).map((f) => s.photos.get(f));
      grid.append(h('div', { class: 'card' },
        h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h3', null, p.name), blocking ? badge('fora dos confrontos', 'err') : badge('só alerta')),
        h('div', { class: 'row', style: { alignItems: 'flex-start', flexWrap: 'nowrap' } },
          photoImg(app, ph, { cls: 'thumb lg' }),
          alts.length ? h('div', { class: 'col', style: { alignItems: 'center' } }, photoImg(app, alts[0], { cls: 'thumb lg' }), h('small', { class: 'muted' }, 'alternativa')) : null,
          h('div', { class: 'col', style: { minWidth: 0 } }, h('small', null, why.join('; ')),
            h('div', { class: 'row' },
              ph?.reviewStatus === 'pendente' ? h('button', { class: 'btn small primary', onclick: () => app.confirmPhoto(ph.photo) }, 'Confirmar foto') : null,
              ph?.problems?.length ? h('button', { class: 'btn small', onclick: () => app.resolveProblems(ph.photo, 'ok') }, 'Foto está boa') : null,
              alts.length ? h('button', { class: 'btn small', onclick: async () => { await app.setPrimary(p.pid, alts[0].photo); if (alts[0].reviewStatus === 'pendente') await app.confirmPhoto(alts[0].photo); } }, 'Usar alternativa') : null,
              h('button', { class: 'btn small', onclick: () => openParticipant(app, p.pid) }, 'Trocar foto'))))));
    }
    body.append(grid);
  }

  function drawDups() {
    const s = app.state;
    body.append(h('p', { class: 'help' }, 'Registros com nome igual ou muito parecido, mesma URL ou mesma imagem. Nomes iguais podem ser pessoas diferentes: decida em cada caso. Enquanto não houver decisão, as participantes do grupo não se enfrentam.'));
    if (!s.dupGroups.length) { body.append(h('div', { class: 'empty' }, 'Nenhuma possível duplicidade encontrada.')); return; }
    for (const g of s.dupGroups) {
      const parts = g.pids.map((pid) => s.participants.get(pid)).filter(Boolean);
      body.append(h('div', { class: 'card', style: { marginBottom: '10px' } },
        h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h3', null, g.tipos.join(', ')),
          g.decision ? badge(g.decision === 'mesma' ? 'mesma pessoa' : 'pessoas diferentes', 'ok') : badge('aguardando decisão', 'warn')),
        h('div', { class: 'row' }, parts.map((p) => h('div', { class: 'col', style: { alignItems: 'center', width: '110px' } },
          photoImg(app, p.primary ? s.photos.get(p.primary) : null, { cls: 'thumb lg' }), h('small', null, p.name), h('small', { class: 'muted' }, `código ${p.code ?? '–'}`),
          !g.decision ? h('button', { class: 'btn small', onclick: () => app.dupDecision(g, 'mesma', p.pid) }, 'Manter esta') : null))),
        h('div', { class: 'row', style: { marginTop: '8px' } },
          !g.decision ? h('button', { class: 'btn small primary', onclick: () => app.dupDecision(g, 'diferentes') }, 'São pessoas diferentes') : null,
          g.decision ? h('button', { class: 'btn small', onclick: () => app.dupDecision(g, null) }, 'Desfazer decisão') : null)));
    }
  }

  function drawImport() {
    const zipIn = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
    const xlsIn = h('input', { type: 'file', accept: '.xlsx,.xls,.csv', hidden: true });
    const log = importLog;
    const progress = (msg) => { log.textContent = msg; };
    zipIn.onchange = async () => {
      const f = zipIn.files[0];
      if (!f) return;
      try {
        const r = await restoreBackup(app, f, progress);
        progress(`Concluído: ${r.newEvents} registros novos, ${r.images} fotos guardadas neste aparelho.` + (r.missing ? ` ${r.missing} imagens externas não estavam no pacote.` : '') + (app.remote?.uid ? ' O envio das fotos para a conta continua em segundo plano.' : ''));
        toast('Pacote importado.');
      } catch (e) { progress('Erro: ' + e.message); toast(e.message, { type: 'err' }); }
    };
    xlsIn.onchange = async () => {
      const f = xlsIn.files[0];
      if (!f) return;
      try {
        const r = await importSpreadsheet(app, f, progress);
        progress(r.summary);
        toast('Planilha importada.');
      } catch (e) { progress('Erro: ' + e.message); toast(e.message, { type: 'err' }); }
    };
    body.append(
      h('div', { class: 'grid cols-2' },
        h('div', { class: 'card' }, h('h2', null, 'Pacote inicial ou backup (.zip)'),
          h('p', null, 'Use o arquivo pacote_inicial.zip gerado pelo importador (504 participantes, fotos verificadas e relatório) ou um backup feito pelo app. Registros já existentes são ignorados pelo identificador, então importar duas vezes não duplica nada.'),
          h('button', { class: 'btn primary', onclick: () => zipIn.click() }, 'Escolher arquivo .zip'), zipIn),
        h('div', { class: 'card' }, h('h2', null, 'Planilha (.xlsx)'),
          h('p', null, 'Colunas reconhecidas: id, nome, foto_url, foto_fonte_url, epoca, observacao. O app tenta guardar uma cópia de cada foto; links que levam a páginas precisam da função de busca do servidor.'),
          h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => xlsIn.click() }, 'Escolher planilha'), h('a', { class: 'btn ghost', href: 'planilha_modelo.xlsx', download: '' }, 'Baixar planilha modelo')), xlsIn)),
      log);
  }

  function drawReport() {
    const s = app.state;
    if (!s.importReports.length) { body.append(h('div', { class: 'empty' }, 'Nenhuma importação registrada.')); return; }
    for (const r of s.importReports) {
      body.append(h('div', { class: 'card', style: { marginBottom: '10px' } },
        h('h2', null, r.arquivo || 'Importação'), h('p', { class: 'muted' }, fmtDate(r.ev.at)),
        h('table', { class: 'tbl' },
          h('tr', null, h('td', null, 'Registros lidos'), h('td', { class: 'num' }, r.registros)),
          h('tr', null, h('td', null, 'Fotos abertas direto do link'), h('td', { class: 'num' }, r.fotos_ok)),
          h('tr', null, h('td', null, 'Links corrigidos (página ou proxy trocado pela imagem)'), h('td', { class: 'num' }, r.fotos_corrigidas)),
          h('tr', null, h('td', null, 'Fotos substituídas automaticamente (aguardam confirmação)'), h('td', { class: 'num' }, r.fotos_substituidas)),
          h('tr', null, h('td', null, 'Sem foto válida'), h('td', { class: 'num' }, r.fotos_falharam)),
          h('tr', null, h('td', null, 'Registros incompletos ou com id repetido'), h('td', { class: 'num' }, (r.problemas_registro || []).length)),
          h('tr', null, h('td', null, 'Grupos de possível duplicidade'), h('td', { class: 'num' }, (r.duplicidades || []).length))),
        (r.problemas_registro || []).length ? h('ul', null, r.problemas_registro.map((x) => h('li', null, `linha ${x.linha}: ${x.problema}`))) : null));
    }
  }

  const off = app.on('state', () => { if (tab === 'importar') drawTabs(); else draw(); });
  draw();
  return () => off();
}

export function pendingPhotos(app) {
  const s = app.state;
  const out = [];
  for (const p of s.participants.values()) {
    if (p.status === 'excluida') continue;
    const ph = p.primary ? s.photos.get(p.primary) : null;
    const why = [];
    let blocking = false;
    if (!ph) { why.push('sem foto principal'); blocking = true; }
    else {
      if (ph.reviewStatus === 'pendente') { why.push('foto escolhida pelo importador: confirme ou troque'); blocking = true; }
      if (ph.problems.length) { why.push('problema relatado: ' + ph.problems.map((x) => x.problem).join(', ')); blocking = true; }
      for (const a of ph.quality?.alerts || []) if (!/substituída/.test(a)) why.push(a);
      if (p.primaryConflict) { why.push('troca de foto em conflito entre aparelhos'); blocking = true; }
    }
    if (why.length) out.push({ p, ph, why, blocking });
  }
  out.sort((a, b) => (b.blocking - a.blocking) || ((a.p.code ?? 0) - (b.p.code ?? 0)));
  return out;
}
