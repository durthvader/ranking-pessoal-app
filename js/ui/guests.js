import { h, clear, fmtDate } from '../util.js';
import { toast, confirmDialog } from './common.js';
import { isOwner } from '../access.js';

export function renderGuests(app, root) {
  if (!isOwner(app.access)) return;
  const body = h('div'), refresh = h('button', { class: 'btn', onclick: () => load() }, 'Atualizar pedidos');
  root.append(h('h1', null, 'Convidados'),
    h('p', null, 'Envie o endereço do site. Seu amigo escolhe “Solicitar acesso”, cadastra e-mail e senha e aguarda sua aprovação.'),
    h('p', { class: 'help' }, 'Convidados usam o mesmo catálogo e têm votos e ranking próprios. Eles não podem alterar fotos, informações ou configurações. A correlação fica disponível no seu painel.'), refresh, body);
  let disposed = false;
  function draw() {
    if (disposed) return;
    clear(body);
    const requests = app.accessRequests || [];
    if (!requests.length) { body.append(h('div', { class: 'empty' }, 'Nenhuma solicitação recebida.')); return; }
    for (const request of requests) {
      const labels = { pending: 'Aguardando aprovação', guest: 'Acesso autorizado', rejected: 'Acesso recusado' };
      const actions = h('div', { class: 'row' });
      if (request.role !== 'guest') actions.append(h('button', { class: 'btn primary', onclick: () => review(request, true) }, request.evaluation_id ? 'Autorizar novamente' : 'Aprovar acesso'));
      if (request.role !== 'rejected') actions.append(h('button', { class: 'btn', onclick: () => review(request, false) }, request.role === 'guest' ? 'Revogar acesso' : 'Recusar'));
      if (request.evaluation_id) actions.append(h('a', { class: 'btn', href: `#/correlacao?convidado=${encodeURIComponent(request.user_id)}` }, 'Ver correlação'));
      body.append(h('div', { class: 'card guest-request' }, h('h2', null, request.display_name || request.email),
        h('p', null, request.email), h('p', { class: 'muted' }, `${labels[request.role] || request.role} · ${fmtDate(request.created_at)}`), actions));
    }
  }
  async function review(request, approve) {
    if (!approve && !await confirmDialog('Recusar acesso', `Retirar o acesso de ${request.display_name || request.email}? As escolhas já feitas continuam guardadas.`, 'Recusar')) return;
    refresh.disabled = true;
    try { await app.remote.reviewAccess(request.user_id, approve); await load(); toast(approve ? 'Acesso autorizado. A avaliação do convidado é independente.' : 'Acesso recusado.'); }
    catch (error) { toast(error.message, { type: 'err' }); }
    finally { refresh.disabled = false; }
  }
  async function load() {
    refresh.disabled = true;
    try { app.accessRequests = await app.remote.listAccessRequests(); draw(); }
    catch (error) { if (!disposed) { clear(body); body.append(h('div', { class: 'notice err' }, error.message)); } }
    finally { refresh.disabled = false; }
  }
  const off = app.on('accessRequests', draw);
  load();
  return () => { disposed = true; off(); };
}
