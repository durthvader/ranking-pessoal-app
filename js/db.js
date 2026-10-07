// Armazenamento local em IndexedDB: eventos (com fila de envio), imagens e metadados.
// Um banco por conta (ou "local"), para não misturar dados de contas diferentes no mesmo aparelho.

const VERSION = 1;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transação cancelada'));
  });
}

export class LocalDB {
  static async open(name) {
    const r = indexedDB.open(name, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('events')) {
        const s = db.createObjectStore('events', { keyPath: 'id' });
        s.createIndex('pending', 'pending');
      }
      if (!db.objectStoreNames.contains('blobs')) {
        const s = db.createObjectStore('blobs', { keyPath: 'path' });
        s.createIndex('uploaded', 'uploaded');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
    };
    const db = await req(r);
    const inst = new LocalDB();
    inst.db = db;
    inst.name = name;
    return inst;
  }

  // Grava eventos novos ou atualiza os existentes sem perder o número de sequência do servidor.
  async putEvents(evs, { remote = false } = {}) {
    const tx = this.db.transaction('events', 'readwrite');
    const st = tx.objectStore('events');
    const added = [];
    for (const ev of evs) {
      const cur = await req(st.get(ev.id));
      if (cur) {
        if (remote && (cur.pending || cur.seq == null)) {
          cur.seq = ev.seq;
          cur.pending = 0;
          st.put(cur);
        }
        continue;
      }
      const row = { ...ev, pending: remote ? 0 : 1 };
      if (remote) row.seq = ev.seq;
      st.put(row);
      added.push(row);
    }
    await txDone(tx);
    return added;
  }

  async allEvents() {
    const tx = this.db.transaction('events', 'readonly');
    return req(tx.objectStore('events').getAll());
  }

  async pendingEvents(limit = 200) {
    const tx = this.db.transaction('events', 'readonly');
    const idx = tx.objectStore('events').index('pending');
    return req(idx.getAll(IDBKeyRange.only(1), limit));
  }

  async countPending() {
    const tx = this.db.transaction('events', 'readonly');
    return req(tx.objectStore('events').index('pending').count(IDBKeyRange.only(1)));
  }

  async markSent(ids) {
    const tx = this.db.transaction('events', 'readwrite');
    const st = tx.objectStore('events');
    for (const id of ids) {
      const cur = await req(st.get(id));
      if (cur && cur.pending) {
        cur.pending = 0;
        cur.sentAt = new Date().toISOString();
        st.put(cur);
      }
    }
    await txDone(tx);
  }

  async getMeta(k, def = null) {
    const tx = this.db.transaction('meta', 'readonly');
    const r = await req(tx.objectStore('meta').get(k));
    return r ? r.v : def;
  }

  async setMeta(k, v) {
    const tx = this.db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ k, v });
    await txDone(tx);
  }

  async putBlob(path, blob, { uploaded = 0 } = {}) {
    const tx = this.db.transaction('blobs', 'readwrite');
    const st = tx.objectStore('blobs');
    const cur = await req(st.get(path));
    st.put({ path, blob, size: blob.size, mime: blob.type, uploaded: cur?.uploaded ? 1 : uploaded, savedAt: Date.now() });
    await txDone(tx);
  }

  async getBlob(path) {
    const tx = this.db.transaction('blobs', 'readonly');
    const r = await req(tx.objectStore('blobs').get(path));
    return r ? r.blob : null;
  }

  async blobKeys() {
    const tx = this.db.transaction('blobs', 'readonly');
    const keys = await req(tx.objectStore('blobs').getAllKeys());
    return new Set(keys);
  }

  async pendingBlobs(limit = 50) {
    const tx = this.db.transaction('blobs', 'readonly');
    return req(tx.objectStore('blobs').index('uploaded').getAll(IDBKeyRange.only(0), limit));
  }

  async countPendingBlobs() {
    const tx = this.db.transaction('blobs', 'readonly');
    return req(tx.objectStore('blobs').index('uploaded').count(IDBKeyRange.only(0)));
  }

  async markBlobUploaded(path) {
    const tx = this.db.transaction('blobs', 'readwrite');
    const st = tx.objectStore('blobs');
    const cur = await req(st.get(path));
    if (cur) { cur.uploaded = 1; st.put(cur); }
    await txDone(tx);
  }

  async blobStats() {
    const tx = this.db.transaction('blobs', 'readonly');
    const st = tx.objectStore('blobs');
    let count = 0, bytes = 0;
    await new Promise((resolve, reject) => {
      const c = st.openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return resolve();
        count++;
        bytes += cur.value.size || 0;
        cur.continue();
      };
      c.onerror = () => reject(c.error);
    });
    return { count, bytes };
  }

  async clearAll() {
    const tx = this.db.transaction(['events', 'blobs', 'meta'], 'readwrite');
    tx.objectStore('events').clear();
    tx.objectStore('blobs').clear();
    tx.objectStore('meta').clear();
    await txDone(tx);
  }
}
