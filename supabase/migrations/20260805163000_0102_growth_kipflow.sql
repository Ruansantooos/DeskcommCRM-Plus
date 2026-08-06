-- =============================================================================
-- 0102 — Kipflow como fonte de descoberta (EPIC-14)
--
-- A 0100 assumiu Google Places como fonte única e cravou `place_id not null`.
-- A Kipflow identifica empresa por CNPJ e não devolve place_id — sem esta
-- migration, ou se inventa um place_id sintético (que arruína o dedup quando a
-- mesma empresa chega pelas duas fontes) ou o INSERT falha.
--
-- As duas fontes NÃO são intercambiáveis, e é por isso que ambas as chaves
-- naturais convivem: Places acha negócio com fachada e ponto físico; Kipflow
-- acha empresa com CNPJ ativo e dado cadastral rico. Recortes diferentes do
-- mercado, não a mesma lista com qualidade diferente.
-- =============================================================================

-- ---- 1. Empresa pode vir de qualquer uma das duas fontes -------------------

alter table public.growth_companies
  alter column place_id drop not null;

alter table public.growth_companies
  add column if not exists cnpj text,
  add column if not exists razao_social text,
  add column if not exists cnae text,
  add column if not exists faturamento_presumido_cents bigint,
  add column if not exists linkedin_url text,
  -- Custo REAL informado pela Kipflow no campo `cost` de cada resposta.
  -- Guardar por empresa responde "quanto custou este lead" sem estimativa —
  -- e estimativa é o que todo mundo faz porque a API normalmente não conta.
  add column if not exists descoberta_custo_cents integer;

-- Sem pelo menos uma chave natural o dedup não tem em que se apoiar, e a base
-- enche de duplicata silenciosa — que é pior que erro, porque ninguém vê.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'growth_companies_tem_chave') then
    alter table public.growth_companies
      add constraint growth_companies_tem_chave
      check (place_id is not null or cnpj is not null);
  end if;
end
$$;

-- Com place_id agora nullable, o unique precisa ser parcial. (Em Postgres
-- vários NULL não colidem, então o unique comum "funcionaria" — o índice
-- parcial existe para declarar a intenção, não para corrigir bug.)
drop index if exists growth_companies_org_place_uniq;
create unique index if not exists growth_companies_org_place_uniq
  on public.growth_companies (organization_id, place_id)
  where place_id is not null;

create unique index if not exists growth_companies_org_cnpj_uniq
  on public.growth_companies (organization_id, cnpj)
  where cnpj is not null;

alter table public.growth_companies
  drop constraint if exists growth_companies_source_check;
alter table public.growth_companies
  add constraint growth_companies_source_check
  check (source in ('maps_agent', 'kipflow_agent', 'manual', 'import'));

-- ---- 2. Decisores ----------------------------------------------------------
-- Dado NOVO que o Places nunca deu: pessoa física com cargo dentro da empresa.
-- Tabela própria porque é 1:N e — mais importante — porque pessoa física tem
-- regime de LGPD diferente de dado cadastral de PJ. Separar é o que torna a
-- anonimização em cascata alcançável sem varrer colunas soltas.

create table if not exists public.growth_decision_makers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null references public.growth_companies(id) on delete cascade,
  nome text not null,
  cargo text,
  linkedin_public_id text,
  linkedin_url text,
  email text,
  -- 'verificado' e 'padrão de domínio' são coisas diferentes: o segundo é um
  -- palpite (nome.sobrenome@dominio) com taxa de bounce alta. A UI precisa
  -- conseguir avisar ANTES de alguém disparar em cima disso.
  email_origem text,
  telefone text,
  descoberto_em timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint growth_decision_makers_email_origem_check
    check (email_origem is null or email_origem in ('verificado', 'padrao_dominio', 'desconhecido'))
);

create unique index if not exists growth_decision_makers_linkedin_uniq
  on public.growth_decision_makers (organization_id, company_id, linkedin_public_id)
  where linkedin_public_id is not null;

create index if not exists growth_decision_makers_company_idx
  on public.growth_decision_makers (company_id);

-- ---- 3. RLS + audit no padrão do módulo ------------------------------------

alter table public.growth_decision_makers enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'growth_decision_makers'
      and policyname = 'tenant_isolation_growth_decision_makers_all'
  ) then
    create policy tenant_isolation_growth_decision_makers_all
      on public.growth_decision_makers
      using (
        organization_id in (select public.fn_user_org_ids())
        or public.fn_is_platform_admin()
      )
      with check (
        organization_id in (select public.fn_user_org_ids())
        or public.fn_is_platform_admin()
      );
  end if;
end
$$;

-- Audit: é dado pessoal de terceiro. Quem inseriu, alterou e apagou precisa
-- ficar registrado — é o que sustenta responder a um pedido de exclusão.
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_growth_decision_makers_audit') then
    create trigger trg_growth_decision_makers_audit
      after insert or update or delete on public.growth_decision_makers
      for each row execute function public.fn_audit_log_row();
  end if;
end
$$;

-- ---- 4. Consumo por execução ----------------------------------------------
-- O plano é mensal por NÚMERO DE REQUISIÇÕES, não por reais. Então o que
-- precisa ser contado — e mostrado ao operador — é requisição. O custo em
-- centavos anda junto porque vem de graça na resposta.
alter table public.growth_agent_runs
  add column if not exists requisicoes_api integer not null default 0,
  add column if not exists custo_api_cents integer not null default 0;

comment on column public.growth_agent_runs.requisicoes_api is
  'Chamadas a APIs pagas nesta execução. É o teto que importa em plano por quota mensal.';

notify pgrst, 'reload schema';
