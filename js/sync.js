// Sincronização entre o aparelho e o banco central.
//
// Envio: a fila persistente (eventos com pending=1 no IndexedDB) vai em lotes; o banco ignora ids
// repetidos, então reenviar após falha não duplica votos.
// Recebimento: busca eventos com seq maior que o último visto, com uma janela de sobreposição
// para não perder inserções concorrentes; eventos já conhecidos são ignorados pelo id.

import { sleep } from './util.js';

const OVERLAP = 50;

export class Sync {
  constructor({ db, remote, onRemoteEvents, onStatus }) {
    this.db = db;
    this.remote = remote;
    this.onRemoteEvents = onRemoteEvents;
    this.onStatus = onStatus;
    this.status = {
      mode: remote ? 'conta' : 'local', online: navigator.onLine, syncing: false, pendingEvents: 0,
      pendingImages: 0, lastSync: null, lastError: null, lastPushed: 0, lastPulled: 0,
    };
    this.timer = null;
    this.running = null;
    this.backoff = 0;
  }

  async refreshCounts() {
    this.status.pendingEvents = await this.db.countPending();
    this.status.pendingImages = this.remote ? await this.db.countPendingBlobs() : 0;
    this.emit();
  }

  emit() {
    this.onStatus?.({ ...this.status });
  }

  start() {
    window.addEventListener('online', () => { this.status.online = true; this.emit(); this.schedule(200); });
    window.addEventListener('offline', () => { this.status.online = false; this.emit(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.schedule(300); });
    setInterval(() => { if (document.visibilityState === 'visible') this.schedule(0); }, 30000);
    this.refreshCounts();
    this.schedule(100);
  }

  schedule(ms = 1500) {
    if (!this.remote) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.syncNow().catch(() => {}), ms);
  }

  async syncNow({ full = false } = {}) {
    if (!this.remote) { await this.refreshCounts(); return; }
    if (this.running) return this.running;
    this.running = this._sync(full).finally(() => { this.running = null; });
    return this.running;
  }

  async _sync(full) {
    if (!navigator.onLine) {
      this.status.online = false;
      await this.refreshCounts();
      return;
    }
    if (!this.remote.uid) {
      // sessão ausente (app aberto sem conexão): tenta renovar com o token guardado
      try { await this.remote.session(); } catch { /* sem sessão */ }
      if (!this.remote.uid) {
        this.status.lastError = 'Sessão expirada: entre de novo para sincronizar (Configurações → Sair e entrar).';
        await this.refreshCounts();
        return;
      }
    }
    this.status.syncing = true;
    this.status.lastError = null;
    this.emit();
    try {
      // 1. envia a fila
      let pushed = 0;
      for (;;) {
        const batch = await this.db.pendingEvents(200, { decisionsFirst: this.remote.access?.role === 'guest' });
        if (!batch.length) break;
        await this.remote.pushEvents(batch);
        await this.db.markSent(batch.map((e) => e.id));
        pushed += batch.length;
        if (batch.length < 200) break;
      }
      // 2. recebe novidades
      let since = full ? 0 : Math.max(0, (await this.db.getMeta('lastSeq', 0)) - OVERLAP);
      let maxSeq = await this.db.getMeta('lastSeq', 0);
      const novos = [];
      for (;;) {
        const rows = await this.remote.pullEvents(since, 1000);
        if (!rows.length) break;
        const added = await this.db.putEvents(rows, { remote: true });
        novos.push(...added);
        since = rows[rows.length - 1].seq;
        maxSeq = Math.max(maxSeq, since);
        if (rows.length < 1000) break;
      }
      await this.db.setMeta('lastSeq', maxSeq);
      // 3. envia imagens guardadas só neste aparelho
      await this.pushImages();
      this.status.lastSync = new Date().toISOString();
      this.status.lastPushed = pushed;
      this.status.lastPulled = novos.length;
      this.backoff = 0;
      if (novos.length || pushed) await this.onRemoteEvents?.(novos);
    } catch (e) {
      this.status.lastError = e.message || String(e);
      this.backoff = Math.min(6, this.backoff + 1);
      this.schedule(2000 * 2 ** this.backoff);
    } finally {
      this.status.syncing = false;
      await this.refreshCounts();
    }
  }

  async pushImages() {
    for (let round = 0; round < 100; round++) {
      const batch = await this.db.pendingBlobs(6);
      if (!batch.length) return;
      await Promise.all(batch.map(async (b) => {
        await this.remote.uploadBlob(b.path, b.blob);
        await this.db.markBlobUploaded(b.path);
      }));
      this.status.pendingImages = await this.db.countPendingBlobs();
      this.emit();
      await sleep(10);
    }
  }

  // Confere se todos os eventos locais estão no servidor (reenvia os que faltarem).
  async verifyAll() {
    if (!this.remote) return { missing: 0 };
    const ids = await this.remote.remoteIds();
    const local = await this.db.allEvents();
    const missing = local.filter((e) => !ids.has(e.id) && (!this.remote.access || this.remote.access.role !== 'guest' || e.owner === this.remote.uid));
    if (missing.length) {
      for (let k = 0; k < missing.length; k += 200) await this.remote.pushEvents(missing.slice(k, k + 200));
    }
    await this.syncNow({ full: true });
    return { missing: missing.length, remote: ids.size, local: local.length };
  }
}
