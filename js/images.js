// Cache local de fotos (IndexedDB) com download do armazenamento central quando falta.

export class Images {
  constructor({ db, remote, getPhoto }) {
    this.db = db;
    this.remote = remote;
    this.getPhoto = getPhoto;
    this.urls = new Map();
    this.local = new Set();
    this.inflight = new Map();
    this.failed = new Map();
  }

  async init() {
    this.local = await this.db.blobKeys();
  }

  has(path) {
    return this.local.has(path);
  }

  // URL exibível para um caminho do armazenamento (ou URL externa como último recurso).
  async url(path, externalUrl = null) {
    if (!path && externalUrl) return externalUrl;
    if (this.urls.has(path)) return this.urls.get(path);
    if (this.inflight.has(path)) return this.inflight.get(path);
    const p = (async () => {
      let blob = await this.db.getBlob(path);
      if (!blob && this.remote?.uid && navigator.onLine) {
        try {
          blob = await this.remote.downloadBlob(path);
          await this.db.putBlob(path, blob, { uploaded: 1 });
          this.local.add(path);
        } catch (e) {
          this.failed.set(path, e.message || String(e));
          blob = null;
        }
      }
      if (!blob) return externalUrl || null;
      const u = URL.createObjectURL(blob);
      this.urls.set(path, u);
      this.local.add(path);
      return u;
    })().finally(() => this.inflight.delete(path));
    this.inflight.set(path, p);
    return p;
  }

  async save(path, blob, { uploaded = 0 } = {}) {
    await this.db.putBlob(path, blob, { uploaded });
    this.local.add(path);
    if (this.urls.has(path)) {
      URL.revokeObjectURL(this.urls.get(path));
      this.urls.delete(path);
    }
  }

  // Baixa fotos que faltam neste aparelho (uso sem conexão). onProgress(feitas, total, falhas)
  async ensure(paths, onProgress, concurrency = 6) {
    const todo = paths.filter((p) => p && !this.local.has(p));
    let done = 0, fails = 0, k = 0;
    const total = todo.length;
    const worker = async () => {
      while (k < todo.length) {
        const path = todo[k++];
        try {
          const blob = await this.remote.downloadBlob(path);
          await this.db.putBlob(path, blob, { uploaded: 1 });
          this.local.add(path);
        } catch (e) {
          fails++;
          this.failed.set(path, e.message || String(e));
        }
        done++;
        onProgress?.(done, total, fails);
      }
    };
    if (!this.remote?.uid) return { total, done: 0, fails: total };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { total, done, fails };
  }

  prefetch(paths) {
    for (const p of paths) if (p && !this.local.has(p) && !this.urls.has(p)) this.url(p).catch(() => {});
  }
}

// Redimensiona uma imagem do aparelho para JPEG (máx. `max` px no lado maior), sem cortar.
export async function normalizeImage(blob, max = 1200, quality = 0.86) {
  const bmp = await createImageBitmap(blob).catch(() => null);
  let w, h, src;
  if (bmp) { w = bmp.width; h = bmp.height; src = bmp; } else {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Arquivo não é uma imagem válida.'));
      im.src = URL.createObjectURL(blob);
    });
    w = img.naturalWidth; h = img.naturalHeight; src = img;
  }
  const scale = Math.min(1, max / Math.max(w, h));
  const cw = Math.round(w * scale), ch = Math.round(h * scale);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(src, 0, 0, cw, ch);
  const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  return { blob: out, w: cw, h: ch, origW: w, origH: h };
}
