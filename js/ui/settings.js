import { h, clear, fmtInt, fmtDate, downloadBlob } from '../util.js';
import { section, toast, modal, confirmDialog, loadScript, badge, applyTheme } from './common.js';
import { evalSettings } from '../store.js';
import { DEFAULT_EVAL_SETTINGS, SETTINGS_HELP } from '../settings.js';
import { createBackup, restoreBackup } from '../backup.js';
import { exportCsv, exportXlsx } from '../export.js';

export function renderSettings(app, root) {
  const body = h('div', { class: 'col', style: { gap: '12px' } });
  root.append(h('h1', null, 'Configurações'), body);
  // registro de backup/restauração fora do redesenho, para o progresso continuar visível
  const dataLog = h('div', { class: 'help data-log', style: { whiteSpace: 'pre-wrap' } });

  function draw() {
    clear(body);
    body.append(votingSection(), evalSection(), deviceSection(), accountSection(), dataSection(),
      h('p', { class: 'help' }, `Versão ${app.version} · `, h('a', { href: '#/metodo' }, 'Como o ranking é calculado')));
  }

  function votingSection() {
    const p = app.state.prefs;
    const chk = (key, label, help) => {
      const c = h('input', { type: 'checkbox', checked: !!p[key], onchange: () => app.setPrefs({ [key]: c.checked }) });
      return h('label', { class: 'check' }, c, h('span', null, label, help ? h('div', { class: 'help' }, help) : null));
    };
    const layout = h('select', { onchange: () => app.setPrefs({ layout: layout.value }) },
      h('option', { value: 'auto', selected: p.layout === 'auto' }, 'Comparação lado a lado (tela cheia adapta à orientação)'),
      h('option', { value: 'lado', selected: p.layout === 'lado' }, 'Sempre lado a lado'),
      h('option', { value: 'pilha', selected: p.layout === 'pilha' }, 'Sempre uma acima da outra'));
    return section('Votação',
      chk('showNames', 'Mostrar nomes durante o voto', 'Desligado por padrão, para a escolha depender só da foto.'),
      chk('showScores', 'Mostrar números no motivo do par', 'Desligado por padrão. Pontuações nunca aparecem sobre as fotos.'),
      chk('showReason', 'Mostrar o motivo de cada par abaixo das fotos'),
      h('label', { class: 'field', style: { maxWidth: '420px' } }, h('span', null, 'Disposição das fotos'), layout),
      h('p', { class: 'help' }, 'Estas preferências valem em todos os seus aparelhos.'));
  }

  function evalSection() {
    const s = app.state;
    const ev = s.evals.get(s.activeEval);
    if (!ev) return section('Avaliação', h('p', null, 'Nenhuma avaliação ativa.'));
    const cur = evalSettings(s);
    const inputs = {};
    const num = (key, label, attrs = {}) => {
      inputs[key] = h('input', { type: 'number', value: cur[key], step: attrs.step || 'any', min: attrs.min, max: attrs.max });
      return h('label', { class: 'field' }, h('span', null, label), inputs[key], SETTINGS_HELP[key] ? h('span', { class: 'help' }, SETTINGS_HELP[key]) : null);
    };
    const sel = (key, label, opts) => {
      inputs[key] = h('select', null, opts.map(([v, l]) => h('option', { value: v, selected: String(cur[key]) === String(v) }, l)));
      return h('label', { class: 'field' }, h('span', null, label), inputs[key], SETTINGS_HELP[key] ? h('span', { class: 'help' }, SETTINGS_HELP[key]) : null);
    };
    const groups = h('input', { type: 'text', value: cur.groups.join(', ') });
    const m = app.engine.model;
    const form = h('div', { class: 'form wide' },
      sel('sigmaMode', 'Desvio padrão do prior (σ)', [['auto', 'Automático (estimado pelos votos)'], ['fixo', 'Fixo']]),
      num('sigma', 'σ fixo / inicial', { min: 0.1, max: 10, step: 0.1 }),
      num('budget', 'Orçamento de escolhas válidas', { min: 100, step: 100 }),
      num('coverageMin', 'Comparações na fase de cobertura', { min: 1, max: 20, step: 1 }),
      sel('coverageMode', 'Pareamento na cobertura', [['aleatorio', 'Aleatório (adversárias variadas)'], ['suico', 'Suíço a partir da 3ª rodada']]),
      sel('photoPolicy', 'Ao trocar a foto principal', [['descartar', 'Votos da foto anterior saem do cálculo'], ['manter', 'Votos anteriores continuam valendo']]),
      sel('countAudits', 'Votos de auditoria no cálculo', [['false', 'Não contam (só consistência)'], ['true', 'Contam como votos']]),
      sel('includePendingPhotos', 'Fotos aguardando confirmação', [['false', 'Ficam fora dos confrontos'], ['true', 'Entram nos confrontos']]),
      sel('freezeEnabled', 'Congelar quem acumula derrotas', [['true', 'Sim: sai dos novos confrontos'], ['false', 'Não']]),
      num('freezeMargin', 'Derrotas a mais que vitórias para congelar', { min: 1, max: 50, step: 1 }),
      num('freezeMaxWins', 'Congelar só com até (vitórias)', { min: 0, max: 100, step: 1 }),
      num('wTop', 'Peso da disputa pelo 1º lugar', { min: 0, max: 20, step: 0.5 }),
      num('wUnder', 'Peso das pouco avaliadas', { min: 0, max: 20, step: 0.5 }),
      num('wCross', 'Peso dos confrontos entre faixas', { min: 0, max: 20, step: 0.1 }),
      h('label', { class: 'field' }, h('span', null, 'Limites das faixas (posições)'), groups, h('span', { class: 'help' }, 'Ex.: 10, 25, 50, 100, 200, 350 formam as faixas Top 10, 11–25, 26–50…')),
      num('stageSize', 'Escolhas por etapa no chaveamento', { min: 50, step: 50 }),
      sel('level', 'Nível das faixas de incerteza', [['0.8', '80%'], ['0.9', '90%'], ['0.95', '95%']]),
      num('mcSamples', 'Amostras de Monte Carlo', { min: 200, max: 5000, step: 100 }),
      num('closeThreshold', 'Ordem incerta abaixo de (chance)', { min: 0.5, max: 0.99, step: 0.05 }),
      num('auditGap', 'Distância mínima da auditoria (confrontos)', { min: 5, step: 5 }),
      sel('reviewAuto', 'Etapa de revisão do 1º lugar', [['true', 'Automática perto do fim do orçamento'], ['false', 'Só quando eu pedir']]),
      num('reviewFrom', 'Início da etapa de revisão (fração do orçamento)', { min: 0.1, max: 1, step: 0.05 }),
      num('reviewShare', 'Pares da revisão durante a etapa (fração)', { min: 0.1, max: 1, step: 0.05 }));
    const save = h('button', { class: 'btn primary', onclick: async () => {
      const vals = {};
      for (const [k, el] of Object.entries(inputs)) {
        let v = el.value;
        if (typeof DEFAULT_EVAL_SETTINGS[k] === 'number') v = Number(v);
        if (typeof DEFAULT_EVAL_SETTINGS[k] === 'boolean') v = v === 'true';
        if (typeof v === 'number' && !Number.isFinite(v)) { toast(`Valor inválido em ${k}.`, { type: 'err' }); return; }
        vals[k] = v;
      }
      const g = groups.value.split(/[,; ]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
      if (!g.length) { toast('Informe ao menos um limite de faixa.', { type: 'err' }); return; }
      vals.groups = [...new Set(g)];
      if (vals.sigma <= 0) { toast('σ precisa ser maior que zero.', { type: 'err' }); return; }
      if (!(vals.freezeMargin >= 1) || !(vals.freezeMaxWins >= 0)) { toast('Use números inteiros positivos na regra de congelamento.', { type: 'err' }); return; }
      await app.setEvalSettings(vals);
      toast('Configurações da avaliação salvas. O ranking será recalculado.');
    } }, 'Salvar configurações da avaliação');
    const reset = h('button', { class: 'btn', onclick: async () => {
      if (await confirmDialog('Restaurar padrões', 'Voltar todas as configurações desta avaliação aos valores padrão?', 'Restaurar')) {
        await app.setEvalSettings({ ...DEFAULT_EVAL_SETTINGS });
      }
    } }, 'Restaurar padrões');
    const hist = ev.settingsHistory.length
      ? h('details', null, h('summary', null, `Histórico de alterações (${ev.settingsHistory.length})`),
        h('ul', { class: 'help' }, ev.settingsHistory.map((x) => h('li', null, `${fmtDate(x.at)} · ${x.device === app.device.id ? 'este aparelho' : 'outro aparelho'}`))))
      : null;
    return section(`Avaliação: ${ev.name}`,
      ev.settingsConflict ? h('div', { class: 'notice err' }, 'Configurações alteradas em dois aparelhos ao mesmo tempo. O app está usando a alteração mais recente; salve de novo para confirmar.') : null,
      m ? h('p', { class: 'help' }, `σ em uso: ${m.sigmaUsed?.toFixed(2) ?? '–'} (${m.sigmaSource === 'auto' ? `estimado com ${fmtInt(m.sigmaVotes)} escolhas` : m.sigmaSource === 'inicial' ? 'valor inicial, até 300 escolhas' : 'fixo'}).`) : null,
      form, h('div', { class: 'row', style: { marginTop: '10px' } }, save, reset), hist);
  }

  function deviceSection() {
    const name = h('input', { type: 'text', value: app.device.name });
    const theme = h('select', { onchange: () => { localStorage.setItem('rp-theme', theme.value); applyTheme(); } },
      ['auto', 'light', 'dark'].map((v) => h('option', { value: v, selected: (localStorage.getItem('rp-theme') || 'auto') === v }, { auto: 'Automático', light: 'Claro', dark: 'Escuro' }[v])));
    const auto = h('input', { type: 'checkbox', checked: localStorage.getItem('rp-autodownload') !== 'nao', onchange: () => localStorage.setItem('rp-autodownload', auto.checked ? 'sim' : 'nao') });
    const dl = h('div', { class: 'help' });
    const space = h('div', { class: 'help' }, 'Calculando espaço usado…');
    app.db.blobStats().then((st) => { space.textContent = `${fmtInt(st.count)} imagens guardadas neste aparelho (${(st.bytes / 1048576).toFixed(1)} MB).`; });
    const showDl = () => {
      const d = app.download;
      dl.textContent = d.total ? `${d.running ? 'Baixando' : 'Último download'}: ${fmtInt(d.done)} de ${fmtInt(d.total)} fotos${d.fails ? ` · ${d.fails} falharam` : ''}.` : '';
    };
    showDl();
    const off = app.on('download', showDl);
    const box = section('Este aparelho',
      h('div', { class: 'form' },
        h('label', { class: 'field' }, h('span', null, 'Nome do aparelho'), name,
          h('button', { class: 'btn small', style: { justifySelf: 'start' }, onclick: () => { app.device.name = name.value.trim() || app.device.name; localStorage.setItem('rp-device', JSON.stringify(app.device)); toast('Nome salvo.'); } }, 'Salvar nome')),
        h('label', { class: 'field' }, h('span', null, 'Tema'), theme),
        h('label', { class: 'check' }, auto, h('span', null, 'Baixar todas as fotos automaticamente (cerca de 70 MB para 500 participantes)', h('div', { class: 'help' }, 'Com as fotos no aparelho, a votação fica rápida e funciona sem conexão.')))),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn', disabled: !app.remote?.uid, onclick: () => app.autoDownloadImages(true) }, 'Baixar todas as fotos agora')),
      dl, space,
      h('p', { class: 'help' }, `Identificador do aparelho: ${app.device.id.slice(0, 8)}`));
    const obs = new MutationObserver(() => { if (!box.isConnected) { off(); obs.disconnect(); } });
    obs.observe(document.body, { childList: true, subtree: true });
    return box;
  }

  function accountSection() {
    const s = app.syncStatus;
    const cfg = app.config;
    const box = section('Conta e sincronização',
      h('p', null, app.remote.user?.email ? `Conectado como ${app.remote.user.email}.` : 'Sem sessão ativa (modo sem conexão).'),
      h('p', { class: 'help' }, `Projeto: ${cfg.url}`),
      h('p', null, `Pendências de envio: ${fmtInt(s.pendingEvents || 0)} registros, ${fmtInt(s.pendingImages || 0)} fotos. Última sincronização: ${s.lastSync ? fmtDate(s.lastSync) : '–'}.`),
      s.lastError ? h('div', { class: 'notice err' }, s.lastError) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => app.sync.syncNow().then(() => toast('Sincronização concluída.')) }, 'Sincronizar agora'),
        h('button', { class: 'btn', onclick: async () => {
          toast('Conferindo todos os registros…');
          try {
            const r = await app.sync.verifyAll();
            toast(`Conferência concluída: ${fmtInt(r.local)} registros neste aparelho, ${fmtInt(r.remote)} no servidor, ${r.missing} reenviados.`, { ms: 7000 });
          } catch (e) { toast(e.message, { type: 'err' }); }
        } }, 'Conferir sincronização completa'),
        h('button', { class: 'btn', onclick: () => connectDevice(app) }, 'Conectar outro aparelho'),
        h('button', { class: 'btn', onclick: () => changePassword(app) }, 'Trocar senha'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (s.pendingEvents && !(await confirmDialog('Sair', `Há ${s.pendingEvents} registros ainda não enviados. Eles continuam guardados neste aparelho e vão ser enviados quando você entrar de novo. Sair mesmo assim?`, 'Sair'))) return;
          await app.remote.signOut();
          location.reload();
        } }, 'Sair')));
    return box;
  }

  function dataSection() {
    const restoreIn = h('input', { type: 'file', accept: '.zip', hidden: true });
    const log = dataLog;
    restoreIn.onchange = async () => {
      const f = restoreIn.files[0];
      if (!f) return;
      try {
        const r = await restoreBackup(app, f, (m) => { log.textContent = m; });
        log.textContent = `Backup restaurado: ${fmtInt(r.newEvents)} registros novos, ${fmtInt(r.images)} fotos.${r.missing ? ` ${r.missing} imagens externas não estavam no backup.` : ''}`;
      } catch (e) { log.textContent = 'Erro: ' + e.message; toast(e.message, { type: 'err' }); }
    };
    return section('Dados',
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => exportCsv(app) }, 'Exportar ranking (CSV)'),
        h('button', { class: 'btn', onclick: () => exportXlsx(app).catch((e) => toast(e.message, { type: 'err' })) }, 'Exportar ranking (XLSX)')),
      h('p', { class: 'help', style: { marginTop: '10px' } }, 'O backup reúne participantes, fotos guardadas, votos, correções, configurações e todos os identificadores. Ele informa quais imagens externas ficaram de fora.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            const r = await createBackup(app, (m) => { log.textContent = m; });
            downloadBlob(r.blob, r.filename);
            const miss = r.manifest.missing_images;
            log.textContent = `Backup criado: ${fmtInt(r.manifest.counts.events)} registros e ${fmtInt(r.manifest.counts.images)} fotos.` + (miss.length ? ` Imagens não incluídas: ${miss.map((x) => `${x.name || x.photo} (${x.reason})`).join('; ')}.` : ' Todas as imagens foram incluídas.');
          } catch (e) { log.textContent = 'Erro: ' + e.message; }
        } }, 'Criar backup (.zip)'),
        h('button', { class: 'btn', onclick: () => restoreIn.click() }, 'Restaurar backup'), restoreIn),
      log);
  }

  const off = app.on('state', () => { if (!document.activeElement || !body.contains(document.activeElement)) draw(); });
  const off2 = app.on('sync', () => {});
  draw();
  return () => { off(); off2(); };
}

async function connectDevice(app) {
  await loadScript('vendor/qrcode.js');
  const cfg = app.config;
  const payload = btoa(JSON.stringify({ u: cfg.url, k: cfg.anonKey })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const link = `${location.origin}${location.pathname}#cfg=${payload}`;
  const qr = globalThis.qrcode(0, 'M');
  qr.addData(link);
  qr.make();
  const box = h('div', { class: 'qr', html: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) });
  modal('Conectar outro aparelho', h('div', { class: 'col', style: { alignItems: 'center' } },
    h('p', null, 'Aponte a câmera do celular para o código. O link abre o app já ligado ao seu projeto; depois é só entrar com o mesmo e-mail e senha.'),
    box,
    h('input', { type: 'text', value: link, readonly: true, onclick: (e) => e.target.select() }),
    h('p', { class: 'help' }, 'O link contém só o endereço do projeto e a chave pública. Seus dados continuam protegidos pela senha.')), [
    { label: 'Copiar link', fn: async () => { try { await navigator.clipboard.writeText(link); toast('Link copiado.'); } catch { toast('Copie o link manualmente.'); } return false; } },
    { label: 'Fechar', cls: 'primary' },
  ]);
}

function changePassword(app) {
  const p1 = h('input', { type: 'password', autocomplete: 'new-password' });
  const p2 = h('input', { type: 'password', autocomplete: 'new-password' });
  modal('Trocar senha', h('div', { class: 'form' },
    h('label', { class: 'field' }, h('span', null, 'Nova senha'), p1),
    h('label', { class: 'field' }, h('span', null, 'Repita a nova senha'), p2)), [
    { label: 'Cancelar' },
    { label: 'Salvar', cls: 'primary', fn: async () => {
      if (p1.value.length < 8) { toast('Use pelo menos 8 caracteres.', { type: 'err' }); return false; }
      if (p1.value !== p2.value) { toast('As senhas não conferem.', { type: 'err' }); return false; }
      try { await app.remote.updatePassword(p1.value); toast('Senha alterada.'); } catch (e) { toast(e.message, { type: 'err' }); return false; }
    } },
  ]);
}

export { badge };
