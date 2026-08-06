-- =============================================================================
-- 0105 — Engine GOWS do WAHA
--
-- O CHECK aceitava só NOWEB e WEBJS, os dois engines que existiam quando a
-- tabela nasceu. O WAHA 2026.7.2 traz o GOWS (implementação em Go, mais leve
-- que o WEBJS por não subir Chromium) e instalações reais já rodam com ele —
-- medido numa instância em produção: `{"engine":"GOWS","tier":"CORE"}`.
--
-- Sem esta migration, quem roda GOWS não consegue sequer CRIAR a sessão: o
-- INSERT em channel_sessions é barrado antes de qualquer envio, e a mensagem
-- de erro (23514) não explica que o engine é o problema.
--
-- O valor não é decorativo: `lib/waha/message-id.ts` decide como interpretar o
-- id da mensagem a partir dele.
-- =============================================================================

alter table public.channel_sessions
  drop constraint if exists channel_sessions_engine_check;

alter table public.channel_sessions
  add constraint channel_sessions_engine_check
  check (engine in ('NOWEB', 'WEBJS', 'GOWS'));

comment on column public.channel_sessions.engine is
  'Engine do WAHA: NOWEB (padrão do kit), WEBJS (Chromium, suporta stickers '
  'animados) ou GOWS (Go, mais leve). Determina como o id da mensagem é lido.';

notify pgrst, 'reload schema';
