-- =============================================================================
-- 0104 — Evolution API como terceiro provedor de canal
--
-- O produto já tinha a camada de adaptadores (`lib/channels/adapters/`) desenhada
-- para não amarrar a um provedor, mas o BANCO só aceitava `waha` e `meta_cloud`.
-- Sem esta migration, o adapter existiria e nenhuma sessão poderia ser criada:
-- o CHECK barraria antes.
--
-- Evolution é WhatsApp NÃO-OFICIAL, como o WAHA — mesma exposição a banimento.
-- Isso importa porque `capabilitiesOf()` arma throttle, warm-up e cap a partir
-- do provider: tratá-lo como canal oficial desarmaria a proteção anti-ban num
-- número que pode, sim, ser banido.
-- =============================================================================

alter table public.channel_sessions
  -- Nome da instância no Evolution (equivalente ao `waha_session_name`).
  add column if not exists evolution_instance text;

-- Um provedor a mais no vocabulário fechado.
alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider in ('waha', 'meta_cloud', 'evolution'));

-- Cada provedor exige SUA referência preenchida. Sem isto daria para gravar
-- sessão Evolution sem instância — e o erro só apareceria no primeiro envio,
-- longe da causa.
alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check
  check (
    (provider = 'waha' and waha_session_name is not null)
    or (provider = 'meta_cloud' and meta_phone_number_id is not null)
    or (provider = 'evolution' and evolution_instance is not null)
  );

comment on column public.channel_sessions.evolution_instance is
  'Nome da instância no Evolution API. Só preenchido quando provider = evolution.';

notify pgrst, 'reload schema';
