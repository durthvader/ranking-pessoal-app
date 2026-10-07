// Endereço do banco central (Supabase, projeto Tatooine) e chave pública.
// A chave publishable é pública por definição: quem protege os dados é o login e as regras de
// segurança (RLS) de schema.sql e guest_access.sql. O cadastro passa pela função
// solicitar-acesso e só libera o catálogo após a aprovação do administrador.
window.RP_CONFIG = {
  supabaseUrl: 'https://oylehasbhftiyrmdbwgl.supabase.co',
  supabaseAnonKey: 'sb_publishable_ghikzkjLgugVsQbT8a9dFg_3HwqbLKt',
  registrationKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95bGVoYXNiaGZ0aXlybWRid2dsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzNjM5NTMsImV4cCI6MjEwNjkzOTk1M30.zXQ4-T8lGRU_w2TTKakahcG1J35ohXJAwgOBxOr8Ck0",
};
