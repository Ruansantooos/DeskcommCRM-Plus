-- =============================================================================
-- 0103 — Todas as redes sociais como canal de contato (EPIC-14)
--
-- Dois defeitos que esta migration endereça:
--
-- 1. `growth_enrichment` só tinha instagram/facebook/linkedin. A Kipflow também
--    devolve twitter, e para comércio local a rede social costuma ser o ÚNICO
--    canal — mais do que o site, que 66% não têm.
--
-- 2. Guardar só o "melhor" candidato descarta informação. Medido num retorno
--    real: a SOCILA LTDA veio com 22 URLs de Instagram, das quais 21 eram de
--    terceiros e 1 era a correta. O casamento automático por nome acerta a
--    maioria, mas quando não acha nada devolve NULL — e aí a lista inteira se
--    perdia, inclusive quando um humano reconheceria o perfil de imediato.
--
-- Agora: as colunas guardam o canal escolhido (o que a automação usa), e
-- `redes_candidatas` guarda tudo o que a fonte devolveu (o que o humano revisa
-- na triagem). Nada do que foi pago é descartado.
-- =============================================================================

alter table public.growth_enrichment
  add column if not exists twitter_url text,
  -- Formato: { "instagram": ["url", ...], "facebook": [...], "twitter": [...] }
  -- Só as que a fonte devolveu; ausência de chave = a fonte não trouxe aquela rede.
  add column if not exists redes_candidatas jsonb not null default '{}'::jsonb;

comment on column public.growth_enrichment.redes_candidatas is
  'Todas as URLs de rede social que a fonte devolveu, inclusive as descartadas '
  'pelo casamento por nome. Existe porque a base traz perfis de terceiros '
  'misturados (caso real: 22 instagrams, 1 correto) e o humano da triagem '
  'reconhece o certo quando a heurística não acha.';

-- Índice parcial para a tela de triagem responder "quem tem algum canal?" sem
-- varrer a tabela inteira. Empresa sem canal nenhum é o caso mais comum e não
-- interessa a essa consulta.
create index if not exists growth_enrichment_com_canal_idx
  on public.growth_enrichment (organization_id)
  where instagram_url is not null
     or facebook_url is not null
     or whatsapp is not null
     or email is not null;

notify pgrst, 'reload schema';
