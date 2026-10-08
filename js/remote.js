// Adaptador do Supabase: autenticação, tabela de eventos, armazenamento de fotos e função de busca de imagem.
import { assertWritableEvents, isGuest } from './access.js';

export const TABLE = 'eventos';
export const BUCKET = 'fotos';

export class SessionExpiredError extends Error {
  constructor(original = null) {
    super('Sessão expirada. Entre novamente.');
    this.name = 'SessionExpiredError';
    this.original = original;
  }
}

export class Remote {
  constructor({ url, anonKey }) {
    if (!globalThis.supabase?.createClient) throw new Error('Biblioteca do Supabase não carregada.');
    this.url = url.replace(/\/+$/, '');
    this.client = globalThis.supabase.createClient(this.url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'rp-auth', detectSessionInUrl: true },
    });
    this.user = null;
    this.access = null;
    this.catalogOwner = null;
  }

  async session() {
    const { data, error } = await this.client.auth.getSession();
    if (error) throw traduzErro(error);
    this.user = data.session?.user || null;
    return data.session;
  }

  async refreshSession() {
    const { data, error } = await this.client.auth.refreshSession();
    if (error) throw traduzErro(error);
    if (!data.session) throw new SessionExpiredError();
    this.user = data.session.user;
    return data.session;
  }

  onAuthChange(cb) {
    return this.client.auth.onAuthStateChange((event, session) => {
      this.user = session?.user || null;
      cb(event, session);
    });
  }

  async signIn(email, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw traduzErro(error);
    this.user = data.user;
    return data;
  }

  async signUp(email, password) {
    const { data, error } = await this.client.auth.signUp({ email, password });
    if (error) throw traduzErro(error);
    this.user = data.user;
    return data;
  }

  async signOut() {
    await this.client.auth.signOut();
    this.user = null;
  }

  async updatePassword(password) {
    const { error } = await this.client.auth.updateUser({ password });
    if (error) throw traduzErro(error);
  }

  async resetPassword(email, redirectTo) {
    const { error } = await this.client.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw traduzErro(error);
  }

  get uid() {
    return this.user?.id || null;
  }

  // Envio idempotente: (dono, id) é a chave primária; repetições são ignoradas pelo banco.
  async pushEvents(evs) {
    if (this.access) assertWritableEvents(this.access, evs, this.uid);
    const rows = evs.map((e) => ({
      id: e.id, type: e.type, eval: e.eval ?? null, data: e.data ?? {}, device: e.device ?? '',
      session: e.session ?? null, at: e.at,
    }));
    // a chave é (owner, id); o dono vem da sessão (gatilho no banco)
    // Revisões podem apontar para um voto criado offline no mesmo lote.
    const groups = isGuest(this.access) ? [rows.filter(e => e.type !== 'revise'), rows.filter(e => e.type === 'revise')] : [rows];
    for (const group of groups) {
      if (!group.length) continue;
      const { error } = await this.client.from(TABLE).upsert(group, { onConflict: 'owner,id', ignoreDuplicates: true });
      if (error) throw traduzErro(error);
    }
  }

  eventScope(query) {
    return isGuest(this.access) ? query.or(`owner.eq.${this.uid},owner.eq.${this.access.host_id}`) : query.eq('owner', this.uid);
  }

  async pullEvents(sinceSeq, limit = 1000) {
    const { data, error } = await this.eventScope(this.client
      .from(TABLE)
      .select('id,owner,seq,type,eval,data,device,session,at'))
      .gt('seq', sinceSeq)
      .order('seq', { ascending: true })
      .limit(limit);
    if (error) throw traduzErro(error);
    return data || [];
  }

  async remoteIds() {
    const ids = new Set();
    let since = 0;
    for (;;) {
      const { data, error } = await this.eventScope(this.client.from(TABLE).select('id,seq')).gt('seq', since).order('seq').limit(1000);
      if (error) throw traduzErro(error);
      if (!data.length) break;
      for (const r of data) ids.add(r.id);
      since = data[data.length - 1].seq;
      if (data.length < 1000) break;
    }
    return ids;
  }

  objectPath(path, write = false) {
    return `${write ? this.uid : this.catalogOwner || this.uid}/${path}`;
  }

  async uploadBlob(path, blob) {
    const { error } = await this.client.storage.from(BUCKET).upload(this.objectPath(path, true), blob, {
      upsert: true, contentType: blob.type || 'image/jpeg', cacheControl: '31536000',
    });
    if (error) throw traduzErro(error);
  }

  async downloadBlob(path) {
    const { data, error } = await this.client.storage.from(BUCKET).download(this.objectPath(path));
    if (error) throw traduzErro(error);
    return data;
  }

  // Edge Function opcional que busca uma imagem por link (evita bloqueio de CORS no navegador).
  async fetchImageViaFunction(url) {
    const { data: s } = await this.client.auth.getSession();
    const token = s.session?.access_token;
    const r = await fetch(`${this.url}/functions/v1/buscar-imagem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url }),
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = (await r.json()).erro || msg; } catch { /* resposta sem JSON */ }
      throw new Error(msg);
    }
    return { blob: await r.blob(), finalUrl: r.headers.get('x-url-final') || url };
  }

  async check() {
    const { error } = await this.client.from(TABLE).select('id', { head: true, count: 'exact' }).limit(1);
    if (error) throw traduzErro(error);
    return true;
  }

  async getAccess() {
    const read = () => this.client.from('ranking_accounts').select('*').eq('user_id', this.uid).maybeSingle();
    let { data, error } = await read();
    // O servidor pode recusar um token que o relógio do aparelho ainda considera válido.
    // Renova uma vez e refaz a consulta com o token recebido do servidor.
    if (/JWT expired/i.test(error?.message || '')) {
      await this.refreshSession();
      ({ data, error } = await read());
    }
    if (error) throw traduzErro(error);
    if (!data) throw new Error('Seu perfil de acesso ainda não está disponível.');
    this.access = data;
    this.catalogOwner = data.role === 'guest' ? data.host_id : null;
    return data;
  }

  async listAccessRequests() {
    const { data, error } = await this.client.from('ranking_accounts').select('*').eq('host_id', this.uid).order('created_at', { ascending: false });
    if (error) throw traduzErro(error);
    return data || [];
  }

  async reviewAccess(user, approve) {
    const { data, error } = await this.client.rpc('review_ranking_access', { p_user: user, p_approve: approve });
    if (error) throw traduzErro(error);
    return data;
  }

  async guestEvents(user) {
    const events = [];
    let since = 0;
    for (;;) {
      const { data, error } = await this.client.rpc('ranking_guest_events', { p_user: user, p_since: since, p_limit: 1000 });
      if (error) throw traduzErro(error);
      if (!data?.length) break;
      events.push(...data); since = data.at(-1).seq;
      if (data.length < 1000) break;
    }
    return events;
  }

  async correlationAccounts() {
    const { data, error } = await this.client.rpc('ranking_correlation_accounts');
    if (error) throw traduzErro(error);
    return data || [];
  }

  async correlationEvents(user) {
    const events = [];
    let since = 0;
    for (;;) {
      const { data, error } = await this.client.rpc('ranking_correlation_events', { p_user: user, p_since: since, p_limit: 1000 });
      if (error) throw traduzErro(error);
      if (!data?.length) break;
      events.push(...data); since = data.at(-1).seq;
      if (data.length < 1000) break;
    }
    return events;
  }

  async requestAccess({ email, password, name }, registrationKey) {
    const response = await fetch(`${this.url}/functions/v1/solicitar-acesso`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: registrationKey, Authorization: `Bearer ${registrationKey}` },
      body: JSON.stringify({ email, password, name }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Não foi possível concluir o cadastro.');
    return data;
  }
}

function traduzErro(error) {
  const m = String(error?.message || error);
  if (['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired'].includes(error?.code)
      || error?.name === 'AuthSessionMissingError'
      || /JWT expired|Invalid Refresh Token|Refresh Token Not Found|Auth session missing/i.test(m)) {
    return new SessionExpiredError(m);
  }
  const map = [
    [/Invalid login credentials/i, 'E-mail ou senha incorretos.'],
    [/Email not confirmed/i, 'Confirme o e-mail antes de entrar (veja a mensagem enviada pelo Supabase).'],
    [/User already registered/i, 'Já existe uma conta com este e-mail. Use "Entrar".'],
    [/Signups not allowed/i, 'Novos cadastros estão desativados neste projeto.'],
    [/Password should be at least/i, 'A senha precisa ter pelo menos 6 caracteres.'],
    [/relation .* does not exist|Could not find the table/i, 'A tabela "eventos" não existe. Rode o arquivo supabase/schema.sql no SQL Editor.'],
    [/Bucket not found/i, 'O bucket "fotos" não existe. Rode o arquivo supabase/schema.sql no SQL Editor.'],
    [/Failed to fetch|NetworkError|Load failed/i, 'Sem conexão com o servidor.'],
    [/row-level security/i, 'Acesso negado pelas regras de segurança do banco.'],
  ];
  for (const [re, msg] of map) if (re.test(m)) return Object.assign(new Error(msg), { original: m });
  return error instanceof Error ? error : new Error(m);
}
