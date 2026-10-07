// Backup restaurável (.zip) e importação de planilha.
//
// Conteúdo do backup:
//   manifest.json  formato, data, contagens, fotos incluídas e fotos externas que ficaram de fora
//   events.json    todos os eventos (participantes, fotos, votos, correções, configurações) com seus ids
//   fotos/*.jpg    fotos e miniaturas guardadas
// Restaurar grava os eventos pelo id (repetidos são ignorados) e as fotos no aparelho; com conta
// conectada, tudo é enviado ao servidor pela fila de sincronização.

import { loadScript } from './ui/common.js';
import { uuidv5, NS_URL, normName, stamp } from './util.js';

const FORMAT = 'ranking-preferencia-backup';

async function fflateLib() {
  if (!globalThis.fflate) await loadScript('vendor/fflate.min.js');
  return globalThis.fflate;
}

async function xlsxLib() {
  if (!globalThis.XLSX) await loadScript('vendor/xlsx.mini.min.js');
  return globalThis.XLSX;
}

export async function createBackup(app, onProgress = () => {}) {
  const fflate = await fflateLib();
  const events = (await app.db.allEvents()).map(({ pending, sentAt, ...e }) => e);
  const files = {};
  const images = [];
  const missing = [];
  const photos = [...app.state.photos.values()];
  let k = 0;
  for (const ph of photos) {
    k++;
    if (k % 20 === 0) onProgress(`Reunindo fotos: ${k} de ${photos.length}`);
    if (!ph.path) {
      missing.push({ photo: ph.photo, pid: ph.pid, name: app.state.participants.get(ph.pid)?.name, reason: 'imagem externa (só o link foi guardado)', external_url: ph.external_url });
      continue;
    }
    let ok = true;
    for (const path of [ph.path, ph.thumb].filter(Boolean)) {
      let blob = await app.db.getBlob(path);
      if (!blob && app.remote?.uid && navigator.onLine) {
        try { blob = await app.remote.downloadBlob(path); await app.db.putBlob(path, blob, { uploaded: 1 }); } catch { blob = null; }
      }
      if (!blob) { ok = false; continue; }
      files[path] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
    }
    if (ok) images.push({ photo: ph.photo, file: ph.path, thumb: ph.thumb });
    else missing.push({ photo: ph.photo, pid: ph.pid, name: app.state.participants.get(ph.pid)?.name, reason: 'arquivo não encontrado neste aparelho nem no servidor' });
  }
  const manifest = {
    format: FORMAT, version: 1, created_at: new Date().toISOString(), app_version: app.version,
    device: app.device, account: app.uid ? 'conta conectada' : 'modo local',
    counts: { events: events.length, images: images.length, missing_images: missing.length,
      participants: app.state.participants.size, decisions: [...app.state.decisionsById.values()].length },
    images, missing_images: missing,
  };
  const enc = new TextEncoder();
  files['manifest.json'] = [enc.encode(JSON.stringify(manifest, null, 1)), { level: 6 }];
  files['events.json'] = [enc.encode(JSON.stringify(events)), { level: 6 }];
  onProgress('Compactando…');
  const data = await new Promise((resolve, reject) => fflate.zip(files, { level: 0 }, (err, out) => (err ? reject(err) : resolve(out))));
  return { blob: new Blob([data], { type: 'application/zip' }), manifest, filename: `backup_ranking_${stamp()}.zip` };
}

export async function restoreBackup(app, file, onProgress = () => {}) {
  const fflate = await fflateLib();
  onProgress('Lendo o arquivo…');
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise((resolve, reject) => fflate.unzip(buf, (err, out) => (err ? reject(err) : resolve(out))));
  const dec = new TextDecoder();
  if (!entries['manifest.json'] || !entries['events.json']) throw new Error('O arquivo não é um backup do app (faltam manifest.json e events.json).');
  const manifest = JSON.parse(dec.decode(entries['manifest.json']));
  if (manifest.format !== FORMAT) throw new Error('Formato de backup desconhecido.');
  const events = JSON.parse(dec.decode(entries['events.json']));
  for (const e of events) {
    if (!e.id || !e.type || !e.at) throw new Error('Backup com evento inválido.');
    delete e.seq;
    delete e.owner;
    delete e.received_at;
  }
  onProgress(`Gravando ${events.length} registros…`);
  const before = app.events.length;
  await app.addEvents(events);
  const newEvents = app.events.length - before;
  const imgs = Object.keys(entries).filter((k) => k.startsWith('fotos/') && /\.(jpe?g|png|webp)$/i.test(k));
  let n = 0;
  for (const path of imgs) {
    if (!app.images.has(path)) {
      await app.images.save(path, new Blob([entries[path]], { type: 'image/jpeg' }), { uploaded: 0 });
    }
    n++;
    if (n % 50 === 0) onProgress(`Guardando fotos: ${n} de ${imgs.length}`);
  }
  // garante uma avaliação ativa
  if (!app.state.activeEval) await app.newEvaluation('Avaliação 1');
  app.sync.schedule(300);
  app.emit('state');
  return { newEvents, images: imgs.length, missing: (manifest.missing_images || []).length, manifest };
}

// Importação de planilha (.xlsx/.csv) com as colunas da planilha modelo.
export async function importSpreadsheet(app, file, onProgress = () => {}) {
  const XLSX = await xlsxLib();
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  let rows = null;
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, raw: true });
    const hi = aoa.findIndex((r) => r && r.some((c) => normName(String(c ?? '')) === 'nome'));
    if (hi >= 0) {
      const hdr = aoa[hi].map((c) => normName(String(c ?? '')).replace(/ /g, '_'));
      rows = aoa.slice(hi + 1).filter((r) => r && r.some((c) => c != null && String(c).trim() !== ''))
        .map((r) => Object.fromEntries(hdr.map((k, i) => [k, r[i]])));
      break;
    }
  }
  if (!rows) throw new Error('Nenhuma aba com a coluna "nome" foi encontrada.');
  const evs = [];
  const report = { lidos: rows.length, novos: 0, existentes: 0, incompletos: [], fotos_ok: 0, fotos_externas: 0, fotos_falharam: [] };
  const toPhoto = [];
  const seenCodes = new Set();
  for (const [k, r] of rows.entries()) {
    const name = String(r.nome ?? '').trim();
    const code = r.id ?? r.codigo ?? null;
    if (!name) { report.incompletos.push(`linha ${k + 1}: sem nome`); continue; }
    if (code != null && seenCodes.has(String(code))) report.incompletos.push(`linha ${k + 1}: id ${code} repetido`);
    if (code != null) seenCodes.add(String(code));
    const pid = await uuidv5(`participante/${code ?? ''}/${normName(name)}`, NS_URL);
    if (app.state.participants.has(pid)) { report.existentes++; continue; }
    const fotoUrl = String(r.foto_url ?? '').trim();
    if (!fotoUrl) report.incompletos.push(`linha ${k + 1} (${name}): sem foto_url`);
    evs.push(app.newEvent('participant_created', {
      pid, code: code != null && !Number.isNaN(Number(code)) ? Number(code) : code, name,
      meta: { pais: r.pais_vinculo ?? r.pais ?? null, atuacao: r.atuacao ?? null, epoca_sugerida: r.epoca ?? null,
        observacao: r.observacao ?? null, foto_fonte_url: r.foto_fonte_url ?? null, linha_planilha: k + 1 },
      flags: [], import: file.name,
    }));
    report.novos++;
    if (fotoUrl) toPhoto.push({ pid, url: fotoUrl, era: r.epoca ?? null, page: r.foto_fonte_url ?? null, name });
  }
  if (evs.length) await app.addEvents(evs);
  let i = 0;
  for (const t of toPhoto) {
    i++;
    onProgress(`Buscando fotos: ${i} de ${toPhoto.length} (${t.name})`);
    try {
      const r = await app.addPhotoFromUrl(t.pid, t.url, { era: t.era, page_url: t.page });
      if (r.stored) report.fotos_ok++; else report.fotos_externas++;
    } catch (e) {
      report.fotos_falharam.push(`${t.name}: ${e.message}`);
    }
  }
  if (!app.state.activeEval) await app.newEvaluation('Avaliação 1');
  await app.addEvents([app.newEvent('import_report', {
    arquivo: file.name, registros: report.lidos, fotos_ok: report.fotos_ok, fotos_corrigidas: 0,
    fotos_substituidas: 0, fotos_falharam: report.fotos_falharam.length,
    problemas_registro: report.incompletos.map((x) => ({ problema: x })), duplicidades: [],
  })]);
  const summary = [
    `${report.lidos} linhas lidas; ${report.novos} participantes novas; ${report.existentes} já existiam.`,
    `${report.fotos_ok} fotos guardadas; ${report.fotos_externas} exibidas por link externo; ${report.fotos_falharam.length} sem foto.`,
    report.incompletos.length ? 'Pendências: ' + report.incompletos.join('; ') : '',
    report.fotos_falharam.length ? 'Sem foto: ' + report.fotos_falharam.join('; ') : '',
  ].filter(Boolean).join('\n');
  return { report, summary };
}

export { xlsxLib };
