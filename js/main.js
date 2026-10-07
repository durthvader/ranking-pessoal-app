import { LocalDB } from './db.js';
import { Remote } from './remote.js';
import { Sync } from './sync.js';
import { Images, normalizeImage } from './images.js';
import { Engine } from './engine.js';
import { materialize } from './store.js';
import { uuid, uuidv5, NS_URL, nowIso, h, clear, sha256Hex } from './util.js';
import { toast, icon, syncText, loadScript, closeDrawer, modal, applyTheme } from './ui/common.js';
import { DEFAULT_EVAL_SETTINGS } from './settings.js';
import { renderVote } from './ui/vote.js';
import { renderRanking } from './ui/ranking.js';
import { renderProgress } from './ui/progress.js';
import { renderBracket } from './ui/bracket.js';
import { renderHistory } from './ui/history.js';
import { renderParticipants, openParticipant } from './ui/participants.js';
import { renderVersions } from './ui/versions.js';
import { renderSettings } from './ui/settings.js';
import { renderMethod } from './ui/method.js';

export const APP_VERSION = '1.1.0';
const SESSION_GAP_MS = 30 * 60 * 1000;

const ROUTES = {
  votar: { title: 'Votar', render: renderVote, icon: 'votar', wide: true },
  ranking: { title: 'Ranking', render: renderRanking, icon: 'ranking' },
  progresso: { title: 'Progresso', render: renderProgress, icon: 'progresso' },
  chaveamento: { title: 'Chaveamento', render: renderBracket, icon: 'chave' },
  historico: { title: 'Histórico', render: renderHistory, icon: 'historico' },
  participantes: { title: 'Participantes', render: renderParticipants },
  versoes: { title: 'Versões', render: renderVersions },
  config: { title: 'Configurações', render: renderSettings },
  metodo: { title: 'Como funciona', render: renderMethod },
};
const TOP_NAV = ['votar', 'ranking', 'progresso', 'chaveamento', 'historico', 'participantes', 'versoes', 'config'];
const BOTTOM_NAV = ['votar', 'ranking', 'progresso', 'historico'];

function readConfig() {
  const m = location.hash.match(/^#cfg=([A-Za-z0-9_\-]+)/);
  if (m) {
    try {
      const json = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (json.u && json.k) localStorage.setItem('rp-supabase', JSON.stringify({ url: json.u, anonKey: json.k }));
    } catch { /* link inválido */ }
    history.replaceState(null, '', location.pathname + '#/votar');
  }
  // O endereço do projeto vem de config.js (publicação). O localStorage só vale para cópias
  // do app publicadas sem config.js preenchido.
  const g = window.RP_CONFIG || {};
  if (g.supabaseUrl && g.supabaseAnonKey) return { url: g.supabaseUrl, anonKey: g.supabaseAnonKey, fixed: true };
  const stored = localStorage.getItem('rp-supabase');
  if (stored) {
    try { const c = JSON.parse(stored); if (c.url && c.anonKey) return c; } catch { /* ignora */ }
  }
  return null;
}

function loadDevice() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem('rp-device') || 'null'); } catch { d = null; }
  if (!d?.id) {
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    d = { id: uuid(), name: mobile ? 'Celular' : 'Computador' };
    localStorage.setItem('rp-device', JSON.stringify(d));
  }
  return d;
}


class App {
  constructor() {
    this.root = document.getElementById('app');
    this.listeners = new Map();
    this.device = loadDevice();
    this.remote = null;
    this.syncStatus = { mode: 'conta', online: navigator.onLine, pendingEvents: 0, pendingImages: 0 };
    this.cleanup = null;
    this.version = APP_VERSION;
    this.download = { running: false, done: 0, total: 0, fails: 0 };
  }

  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt).add(fn);
    return () => this.listeners.get(evt)?.delete(fn);
  }

  emit(evt, payload) {
    for (const fn of this.listeners.get(evt) || []) {
      try { fn(payload); } catch (e) { console.error(e); }
    }
  }

  // ------------------------------------------------------------ inicialização
  async boot() {
    applyTheme();
    this.registerSW();
    this.config = readConfig();
    if (!this.config) return this.showWelcome();
    {
      try {
        await loadScript('vendor/supabase.js');
        this.remote = new Remote(this.config);
        this.remote.onAuthChange((event) => {
          if (event === 'SIGNED_OUT' && !this.signingOutOffline) location.reload();
          if (event === 'PASSWORD_RECOVERY') this.passwordRecovery();
        });
      } catch (e) {
        if (!localStorage.getItem('rp-last-uid')) return this.showWelcome(e.message);
      }
      let session = null;
      try { session = this.remote ? await this.remote.session() : null; } catch { session = null; }
      if (!session) {
        const last = localStorage.getItem('rp-last-uid');
        // sem conexão (ou sessão vencida sem rede): abre os dados guardados neste aparelho;
        // a sincronização volta quando houver conexão e sessão válida
        if (last && (!navigator.onLine || !this.remote)) this.offlineUid = last;
        else return this.showLogin();
      }
    }
    await this.openData();
  }

  registerSW() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Nova versão do app disponível.', { ms: 15000, action: { label: 'Atualizar', fn: () => location.reload() } });
          }
        });
      });
    }).catch(() => {});
  }

  get uid() {
    return this.remote?.uid || this.offlineUid || null;
  }

  async openData() {
    const uid = this.uid;
    if (uid) localStorage.setItem('rp-last-uid', uid);
    this.db = await LocalDB.open(`rp_${uid}`);
    const remoteForSync = this.remote || null;
    this.images = new Images({ db: this.db, remote: remoteForSync, getPhoto: (id) => this.state?.photos.get(id) });
    await this.images.init();
    this.events = await this.db.allEvents();
    this.state = materialize(this.events);
    this.touchSession(false);
    this.engine = new Engine(this);
    this.engine.start();
    this.engine.on(() => this.emit('model'));
    this.sync = new Sync({
      db: this.db,
      remote: remoteForSync,
      onRemoteEvents: async () => {
        this.events = await this.db.allEvents();
        this.recompute();
        this.autoDownloadImages();
      },
      onStatus: (s) => { this.syncStatus = s; this.renderSyncPill(); this.emit('sync', s); },
    });

    this.renderShell();
    window.addEventListener('hashchange', () => this.route());
    this.route();
    this.sync.start();
    this.engine.refresh();
    setTimeout(() => this.autoDownloadImages(), 4000);
    window.addEventListener('beforeunload', (e) => {
      if (this.syncStatus.mode === 'conta' && this.syncStatus.pendingEvents && navigator.onLine) {
        this.sync.syncNow();
      }
    });
  }

  recompute() {
    this.state = materialize(this.events);
    this.engine.cache.clear();
    this.emit('state');
    this.engine.refresh();
  }

  touchSession(activity = true) {
    const now = Date.now();
    let s = null;
    try { s = JSON.parse(localStorage.getItem('rp-session') || 'null'); } catch { s = null; }
    if (!s || now - s.last > SESSION_GAP_MS) s = { id: uuid(), start: now, last: now };
    if (activity) s.last = now;
    localStorage.setItem('rp-session', JSON.stringify(s));
    this.sessionId = s.id;
  }

  newEvent(type, data, { evalId = null } = {}) {
    this.touchSession();
    return { id: uuid(), type, eval: evalId, data, device: this.device.id, session: this.sessionId, at: nowIso() };
  }

  async addEvents(evs) {
    const added = await this.db.putEvents(evs);
    if (added.length) {
      this.events.push(...added);
      this.recompute();
    }
    this.sync.schedule(800);
    this.sync.refreshCounts();
    return added;
  }

  get activeEval() {
    return this.state.activeEval;
  }

  // ------------------------------------------------------------ ações
  async revise(targetId, state, why = 'correcao', prev = null) {
    const ev = this.newEvent('revise', { target: targetId, state, prev: prev || this.state.headIds(`r:${targetId}`), why },
      { evalId: this.state.decisionsById.get(targetId)?.eval ?? this.activeEval });
    await this.addEvents([ev]);
    return ev;
  }

  async editParticipant(pid, field, value) {
    const ev = this.newEvent('participant_edit', { pid, field, value, prev: this.state.headIds(`pe:${pid}:${field}`) });
    await this.addEvents([ev]);
  }

  async setPrimary(pid, photo, prev = null) {
    const ev = this.newEvent('photo_primary', { pid, photo, prev: prev || this.state.headIds(`pp:${pid}`) });
    await this.addEvents([ev]);
  }

  async confirmPhoto(photo, status = 'confirmada') {
    const ev = this.newEvent('photo_review', { photo, status, prev: this.state.headIds(`pr:${photo}`) });
    await this.addEvents([ev]);
  }

  async resolveProblems(photo, action = 'ok', note = '') {
    const ph = this.state.photos.get(photo);
    if (!ph?.problems.length) return;
    const ev = this.newEvent('photo_resolve', { photo, reports: ph.problems.map((r) => r.id), action, note });
    await this.addEvents([ev]);
  }

  async setPrefs(values) {
    const ev = this.newEvent('prefs', { values: { ...this.state.prefs, ...values }, prev: this.state.headIds('prefs') });
    await this.addEvents([ev]);
  }

  async setEvalSettings(values, evalId = this.activeEval) {
    const cur = this.state.evals.get(evalId)?.settings || DEFAULT_EVAL_SETTINGS;
    const ev = this.newEvent('eval_settings', { values: { ...cur, ...values }, prev: this.state.headIds(`es:${evalId}`) }, { evalId });
    await this.addEvents([ev]);
  }

  async dupDecision(group, decision, keep = null) {
    const evs = [this.newEvent('dup_review', { key: group.key, pids: group.pids, decision, keep, prev: this.state.headIds(`dup:${group.key}`) })];
    if (decision === 'mesma' && keep) {
      for (const pid of group.pids) {
        if (pid === keep) continue;
        if (this.state.participants.get(pid)?.status !== 'excluida') {
          evs.push(this.newEvent('participant_edit', { pid, field: 'status', value: 'excluida', prev: this.state.headIds(`pe:${pid}:status`) }));
        }
      }
    }
    await this.addEvents(evs);
  }

  async newEvaluation(name, settings = {}) {
    const id = uuid();
    const seed = Math.floor(Math.random() * 2_000_000_000);
    const evs = [];
    for (const e of this.state.evals.values()) {
      if (e.status === 'ativa') evs.push(this.newEvent('eval_status', { status: 'encerrada', snapshot: null, prev: this.state.headIds(`est:${e.id}`) }, { evalId: e.id }));
    }
    evs.push(this.newEvent('eval_created', { name, seed, settings: { ...DEFAULT_EVAL_SETTINGS, ...settings } }, { evalId: id }));
    await this.addEvents(evs);
    return id;
  }

  // Grava uma foto vinda do aparelho ou de um link. Retorna o id da foto.
  async addPhoto(pid, blob, meta = {}) {
    const norm = await normalizeImage(blob, 1200, 0.86);
    const mini = await normalizeImage(norm.blob, 320, 0.8);
    const sha = await sha256Hex(norm.blob);
    const photo = await uuidv5('foto/' + sha, NS_URL);
    const path = `fotos/${photo}.jpg`, thumb = `fotos/${photo}_mini.jpg`;
    await this.images.save(path, norm.blob, { uploaded: 0 });
    await this.images.save(thumb, mini.blob, { uploaded: 0 });
    const evs = [];
    if (!this.state.photos.has(photo)) {
      evs.push(this.newEvent('photo_added', {
        photo, pid, path, thumb, w: norm.w, h: norm.h, orig_w: norm.origW, orig_h: norm.origH, bytes: norm.blob.size,
        sha256: sha, origin: meta.origin || 'upload', source_url: meta.source_url || null, page_url: meta.page_url || null,
        era: meta.era || null, quality: { alerts: norm.origW < 300 || norm.origH < 300 ? ['resolução baixa'] : [] },
      }));
    }
    if (meta.makePrimary !== false) {
      evs.push(this.newEvent('photo_primary', { pid, photo, prev: this.state.headIds(`pp:${pid}`) }));
    }
    await this.addEvents(evs);
    return photo;
  }

  async addPhotoFromUrl(pid, url, meta = {}) {
    let blob = null, finalUrl = url, how = '';
    if (this.remote?.uid && navigator.onLine) {
      try {
        const r = await this.remote.fetchImageViaFunction(url);
        blob = r.blob; finalUrl = r.finalUrl; how = 'função';
      } catch (e) { how = 'função indisponível: ' + e.message; }
    }
    if (!blob) {
      try {
        const r = await fetch(url, { mode: 'cors', referrerPolicy: 'no-referrer' });
        const ct = r.headers.get('content-type') || '';
        if (r.ok && ct.startsWith('image/')) blob = await r.blob();
      } catch { /* bloqueado por CORS */ }
    }
    if (blob) {
      const photo = await this.addPhoto(pid, blob, { ...meta, origin: 'link', source_url: finalUrl });
      return { photo, stored: true };
    }
    // último recurso: guarda só o endereço externo
    const dims = await new Promise((resolve) => {
      const im = new Image();
      im.referrerPolicy = 'no-referrer';
      im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => resolve(null);
      im.src = url;
    });
    if (!dims) throw new Error('O link não abriu uma imagem. Se ele leva a uma página, abra a página, copie o endereço da própria foto ou baixe a foto e use "Enviar arquivo".');
    const photo = await uuidv5('externa/' + url, NS_URL);
    const evs = [];
    if (!this.state.photos.has(photo)) {
      evs.push(this.newEvent('photo_added', {
        photo, pid, path: null, thumb: null, external_url: url, w: dims.w, h: dims.h, orig_w: dims.w, orig_h: dims.h,
        origin: 'link_externo', source_url: url, quality: { alerts: ['imagem externa: fica fora do backup e pode não abrir sem conexão'] },
      }));
    }
    if (meta.makePrimary !== false) evs.push(this.newEvent('photo_primary', { pid, photo, prev: this.state.headIds(`pp:${pid}`) }));
    await this.addEvents(evs);
    return { photo, stored: false, how };
  }

  // Baixa as fotos que faltam para usar sem conexão.
  async autoDownloadImages(force = false) {
    if (!this.remote?.uid || this.download.running || !navigator.onLine) return;
    if (!force && localStorage.getItem('rp-autodownload') === 'nao') return;
    if (!force && navigator.connection?.saveData) return;
    const paths = [];
    for (const p of this.state.participants.values()) {
      if (p.status === 'excluida' || !p.primary) continue;
      const ph = this.state.photos.get(p.primary);
      if (ph?.path) paths.push(ph.path);
      if (ph?.thumb) paths.push(ph.thumb);
    }
    const missing = paths.filter((x) => !this.images.has(x));
    if (!missing.length) return;
    this.download = { running: true, done: 0, total: missing.length, fails: 0 };
    this.emit('download', this.download);
    await this.images.ensure(missing, (done, total, fails) => {
      this.download = { running: true, done, total, fails };
      this.emit('download', this.download);
    }, 4);
    this.download.running = false;
    this.emit('download', this.download);
  }

  // ------------------------------------------------------------ telas
  renderShell() {
    clear(this.root);
    this.pill = h('button', { class: 'syncpill', title: 'Situação da sincronização', onclick: () => this.showSyncInfo() },
      h('span', { class: 'dot' }), h('span', { class: 'txt' }, '…'));
    this.topnav = h('nav', { class: 'topnav', 'aria-label': 'Seções' },
      TOP_NAV.map((k) => h('a', { href: `#/${k}`, 'data-route': k }, ROUTES[k].title)));
    const brand = h('div', { class: 'brand' }, icon('logo'), h('span', { class: 'full' }, 'Ranking pessoal'));
    const top = h('header', { class: 'topbar' }, brand, this.topnav, h('div', { class: 'spacer' }), this.pill);
    this.main = h('main', { id: 'main' });
    const more = h('a', { href: '#', 'data-route': 'mais', onclick: (e) => { e.preventDefault(); this.showMore(); } }, icon('mais'), 'Mais');
    this.bottomnav = h('nav', { class: 'bottomnav', 'aria-label': 'Seções' },
      BOTTOM_NAV.map((k) => h('a', { href: `#/${k}`, 'data-route': k }, icon(ROUTES[k].icon), ROUTES[k].title)), more);
    this.root.append(top, this.main, this.bottomnav);
    this.renderSyncPill();
  }

  showMore() {
    const items = ['chaveamento', 'participantes', 'versoes', 'config', 'metodo'];
    const body = h('div', { class: 'col' }, items.map((k) => h('a', { class: 'btn', href: `#/${k}`, style: { justifyContent: 'flex-start' }, onclick: () => dlg.close() }, ROUTES[k].title)));
    const dlg = modal('Mais seções', body, [{ label: 'Fechar' }]);
  }

  renderSyncPill() {
    if (!this.pill) return;
    const s = this.syncStatus;
    const t = syncText(s);
    this.pill.className = `syncpill ${t.cls}`;
    this.pill.querySelector('.txt').textContent = t.text;
  }

  showSyncInfo() {
    const s = this.syncStatus;
    const lines = [];
    {
      lines.push(h('p', null, s.online ? 'Conectado ao banco central.' : 'Sem conexão. As escolhas aguardam na fila deste aparelho e são enviadas quando a conexão voltar.'));
      lines.push(h('p', null, `Escolhas e alterações aguardando envio: ${s.pendingEvents || 0}.`));
      lines.push(h('p', null, `Fotos aguardando envio: ${s.pendingImages || 0}.`));
      lines.push(h('p', null, `Última sincronização: ${s.lastSync ? new Date(s.lastSync).toLocaleString('pt-BR') : 'ainda não feita nesta sessão'}.`));
      if (s.lastError) lines.push(h('p', { class: 'notice err' }, 'Último erro: ' + s.lastError));
    }
    modal('Sincronização', h('div', null, lines), [
      { label: 'Fechar' },
      { label: 'Sincronizar agora', cls: 'primary', fn: () => { this.sync.syncNow(); } },
    ].filter(Boolean));
  }

  route() {
    const hash = location.hash.replace(/^#\/?/, '');
    let [name, ...rest] = hash.split('/');
    let query = {};
    if (name.includes('?')) {
      const [n, q] = name.split('?');
      name = n;
      query = Object.fromEntries(new URLSearchParams(q));
    }
    if (name === 'participante' && rest[0]) {
      if (!this.currentRoute) this.go('ranking');
      openParticipant(this, decodeURIComponent(rest[0]));
      return;
    }
    if (!ROUTES[name]) name = 'votar';
    closeDrawer();
    // avisos e ampliações abertos pertencem à tela anterior
    for (const el of document.querySelectorAll('.overlay, .zoomview')) el.remove();
    if (this.cleanup) { try { this.cleanup(); } catch (e) { console.error(e); } }
    this.cleanup = null;
    this.currentRoute = name;
    for (const a of this.root.querySelectorAll('[data-route]')) a.classList.toggle('active', a.dataset.route === name);
    clear(this.main);
    const route = ROUTES[name];
    document.title = `${route.title} · Ranking pessoal`;
    const el = h('div', { class: `view ${route.wide ? 'wide' : ''}` });
    if (name === 'votar') el.className = '';
    this.main.append(el);
    try {
      this.cleanup = route.render(this, el, query) || null;
    } catch (e) {
      console.error(e);
      el.append(h('div', { class: 'notice err' }, 'Erro ao abrir esta tela: ' + e.message));
    }
    window.scrollTo(0, 0);
  }

  go(name) {
    location.hash = `#/${name}`;
  }

  // ------------------------------------------------------------ boas-vindas e login
  showWelcome(errorMsg = null) {
    clear(this.root);
    const url = h('input', { type: 'url', placeholder: 'https://xxxx.supabase.co', autocomplete: 'off' });
    const key = h('input', { type: 'text', placeholder: 'chave pública (publishable ou anon)', autocomplete: 'off' });
    const box = h('div', { class: 'login' },
      h('div', { class: 'card' },
        h('div', { class: 'brand', style: { marginBottom: '10px' } }, icon('logo'), 'Ranking pessoal'),
        h('p', null, 'Este app monta o seu ranking de preferência visual a partir de escolhas entre duas fotos. Os dados ficam no seu projeto do Supabase e sincronizam entre os aparelhos.'),
        errorMsg ? h('div', { class: 'notice err' }, errorMsg) : null,
        h('p', { class: 'help' }, 'Esta cópia do app foi publicada sem o endereço do projeto. Informe abaixo (Supabase → Project Settings → API) ou abra o link de conexão gerado em Configurações no outro aparelho.'),
        h('div', { class: 'form' },
          h('label', { class: 'field' }, h('span', null, 'URL do projeto'), url),
          h('label', { class: 'field' }, h('span', null, 'Chave pública'), key),
          h('button', { class: 'btn primary', onclick: () => {
            const u = url.value.trim(), k = key.value.trim();
            if (!/^https?:\/\/.+/.test(u) || k.length < 20) { toast('Confira a URL e a chave.', { type: 'err' }); return; }
            localStorage.setItem('rp-supabase', JSON.stringify({ url: u, anonKey: k }));
            location.reload();
          } }, 'Conectar'))));
    this.root.append(box);
  }

  showLogin(msg = null) {
    clear(this.root);
    const email = h('input', { type: 'email', autocomplete: 'username', placeholder: 'seu e-mail' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'senha' });
    const err = h('div', { class: 'notice err', hidden: true });
    const busy = async (fn) => {
      err.hidden = true;
      try { await fn(); } catch (e) { err.textContent = e.message; err.hidden = false; }
    };
    const box = h('div', { class: 'login' },
      h('div', { class: 'card' },
        h('div', { class: 'brand', style: { marginBottom: '10px' } }, icon('logo'), 'Ranking pessoal'),
        h('h1', null, 'Entrar'),
        msg ? h('div', { class: 'notice' }, msg) : null,
        err,
        h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); busy(async () => { await this.remote.signIn(email.value.trim(), pass.value); location.reload(); }); } },
          h('label', { class: 'field' }, h('span', null, 'E-mail'), email),
          h('label', { class: 'field' }, h('span', null, 'Senha'), pass),
          h('button', { class: 'btn primary', type: 'submit' }, 'Entrar')),
        h('div', { class: 'row', style: { marginTop: '12px' } },
          // projeto pessoal publicado: o cadastro fica desligado no Supabase, então não há botão de criar conta
          this.config?.fixed ? null : h('button', { class: 'btn small', onclick: () => busy(async () => {
            if (pass.value.length < 8) throw new Error('Use uma senha com pelo menos 8 caracteres.');
            const r = await this.remote.signUp(email.value.trim(), pass.value);
            if (r.session) location.reload();
            else { err.className = 'notice'; err.textContent = 'Conta criada. Se o projeto pedir confirmação, abra o e-mail enviado pelo Supabase e depois entre aqui.'; err.hidden = false; }
          }) }, 'Criar conta'),
          h('button', { class: 'btn small', onclick: () => busy(async () => {
            if (!email.value.trim()) throw new Error('Digite o e-mail para receber o link.');
            await this.remote.resetPassword(email.value.trim(), location.origin + location.pathname);
            err.className = 'notice'; err.textContent = 'Enviamos um link para redefinir a senha.'; err.hidden = false;
          }) }, 'Esqueci a senha'),
          !this.config?.fixed ? h('button', { class: 'btn small ghost', onclick: () => { localStorage.removeItem('rp-supabase'); location.reload(); } }, 'Trocar projeto') : null)));
    this.root.append(box);
    email.focus();
  }

  passwordRecovery() {
    const pass = h('input', { type: 'password', autocomplete: 'new-password' });
    modal('Nova senha', h('label', { class: 'field' }, h('span', null, 'Digite a nova senha'), pass), [
      { label: 'Cancelar' },
      { label: 'Salvar', cls: 'primary', fn: async () => {
        try { await this.remote.updatePassword(pass.value); toast('Senha alterada.'); } catch (e) { toast(e.message, { type: 'err' }); return false; }
      } },
    ]);
  }
}

const app = new App();
window.__app = app;
app.boot().catch((e) => {
  console.error(e);
  document.getElementById('app').innerHTML = '';
  document.getElementById('app').append(h('div', { class: 'view' }, h('div', { class: 'notice err' }, 'Não foi possível iniciar o app: ' + e.message)));
});
