export const CATALOG_TYPES = new Set(['participant_created', 'photo_added', 'photo_primary', 'photo_review', 'dup_review']);
export const GUEST_EVENT_TYPES = new Set(['vote', 'audit', 'abstain', 'revise']);
export const GUEST_ROUTES = new Set(['votar', 'ranking', 'progresso', 'historico', 'metodo', 'correlacao']);

export function isCatalogEvent(event) {
  return CATALOG_TYPES.has(event.type) || event.type === 'participant_edit' && ['name', 'status', 'era'].includes(event.data?.field);
}
export function isGuest(access) { return access?.role === 'guest'; }
export function isOwner(access) { return access?.role === 'owner'; }
export function canUseRoute(access, route) {
  return isOwner(access) || isGuest(access) && GUEST_ROUTES.has(route);
}
export function assertWritableEvents(access, events, uid) {
  if (isOwner(access)) return;
  if (!isGuest(access)) throw new Error('Seu acesso aguarda aprovação.');
  if (events.some(e => !GUEST_EVENT_TYPES.has(e.type) || e.eval !== access.evaluation_id || e.owner && e.owner !== uid)) {
    throw new Error('Seu acesso permite votar e corrigir suas escolhas. A edição do catálogo e das configurações fica com o administrador.');
  }
}
