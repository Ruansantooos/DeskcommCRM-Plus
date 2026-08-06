-- =============================================================================
-- 0100 — Growth Agents Module (EPIC-14, S-14.01)
--
-- Prospecção automatizada: agentes que descobrem empresas por nicho + cidade,
-- enriquecem, diagnosticam, pontuam e decidem o que vira lead no funil que JÁ
-- existe. Não cria um CRM paralelo — alimenta `crm_leads` do EPIC-04.
--
-- Espelha o padrão do EPIC-13 (agente = row configurável, runs com trace,
-- dispatcher drenando event_log) sem estender as tabelas dele: `ai_agents` é
-- agente que conversa com cliente; `growth_agents` é agente que sai procurando
-- empresa. Ciclos de vida e contratos diferentes.
--
-- Decisões locked do PRD (pdr.md §12) refletidas aqui:
--   D-01: analyzer é fetch+parse, sem browser -> performance_score e
--         is_mobile_friendly nascem NULL e assim ficam no MVP.
--   D-03: agentes NÃO versionam -> growth_agent_runs.params_snapshot é o que
--         garante auditoria ("com que config este run rodou").
--   D-04: threshold do SDR vive em growth_agents.params, não em tabela nova.
--
-- Idempotente: pode ser re-aplicada sem quebrar nem duplicar efeito.
-- =============================================================================

-- ---- 1. Empresas descobertas ------------------------------------------------

create table if not exists public.growth_companies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  place_id text not null,
  name text not null,
  address text,
  phone text,
  category text,
  city text,
  lat numeric,
  lng numeric,
  source text not null default 'maps_agent',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint growth_companies_source_check
    check (source in ('maps_agent', 'manual', 'import'))
);

-- Dedup é POR TENANT, não global: dois clientes podem prospectar a mesma
-- empresa sem que um enxergue o outro.
create unique index if not exists growth_companies_org_place_uniq
  on public.growth_companies (organization_id, place_id);

create index if not exists growth_companies_org_city_idx
  on public.growth_companies (organization_id, city);

-- ---- 2. Enriquecimento (1:1) ------------------------------------------------

create table if not exists public.growth_enrichment (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null references public.growth_companies(id) on delete cascade,
  website_url text,
  instagram_url text,
  facebook_url text,
  linkedin_url text,
  whatsapp text,
  email text,
  provider text not null default 'heuristic',
  status text not null default 'pending',
  enriched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint growth_enrichment_status_check
    check (status in ('pending', 'completed', 'failed'))
);

create unique index if not exists growth_enrichment_company_uniq
  on public.growth_enrichment (company_id);

-- ---- 3. Análise de site (1:1) -----------------------------------------------

create table if not exists public.growth_website_analysis (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null references public.growth_companies(id) on delete cascade,
  has_https boolean,
  cms text,
  has_ga4 boolean,
  has_pixel boolean,
  seo_score integer,
  -- ATENÇÃO (PRD D-01): o analisador do MVP faz fetch + parse de HTML, NÃO
  -- renderiza. Logo não mede performance real nem responsividade. Estas duas
  -- colunas ficam NULL de propósito e NÃO devem ser preenchidas por heurística
  -- inventada: o agente Score consome isto, e número falso vira lead falso.
  -- Elas existem desde já para receber um probe de medição real (PageSpeed,
  -- Lighthouse) sem migration nova.
  performance_score integer,
  is_mobile_friendly boolean,
  has_blog boolean,
  has_contact_form boolean,
  analysis_status text not null default 'pending',
  failure_reason text,
  analyzed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint growth_website_analysis_status_check
    check (analysis_status in ('pending', 'completed', 'failed', 'disallowed')),
  constraint growth_website_analysis_seo_range
    check (seo_score is null or seo_score between 0 and 100),
  constraint growth_website_analysis_perf_range
    check (performance_score is null or performance_score between 0 and 100)
);

create unique index if not exists growth_website_analysis_company_uniq
  on public.growth_website_analysis (company_id);

-- ---- 4. Anúncios (1:N — o histórico É o sinal) ------------------------------

create table if not exists public.growth_ads_analysis (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null references public.growth_companies(id) on delete cascade,
  platform text not null default 'meta',
  is_advertising boolean,
  active_creatives_count integer,
  active_since date,
  landing_page_url text,
  status text not null default 'completed',
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint growth_ads_analysis_platform_check
    check (platform in ('meta', 'google', 'tiktok', 'linkedin')),
  constraint growth_ads_analysis_status_check
    check (status in ('completed', 'unavailable', 'failed'))
);

create index if not exists growth_ads_analysis_company_idx
  on public.growth_ads_analysis (company_id, checked_at desc);

-- ---- 5. Scores (1:N — histórico) --------------------------------------------

create table if not exists public.growth_scores (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null references public.growth_companies(id) on delete cascade,
  score integer not null,
  problems jsonb not null default '[]'::jsonb,
  opportunities jsonb not null default '[]'::jsonb,
  suggested_message text,
  next_action text,
  model_used text,
  scored_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint growth_scores_range check (score between 0 and 100)
);

create index if not exists growth_scores_company_idx
  on public.growth_scores (company_id, scored_at desc);

-- ---- 6. Agentes -------------------------------------------------------------

create table if not exists public.growth_agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null,
  name text not null,
  params jsonb not null default '{}'::jsonb,
  schedule_cron text,
  is_active boolean not null default true,
  priority integer not null default 0,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint growth_agents_kind_check
    check (kind in ('maps', 'enrichment', 'website_analyzer', 'meta_ads', 'score', 'sdr'))
);

create unique index if not exists growth_agents_org_kind_name_uniq
  on public.growth_agents (organization_id, kind, name);

-- ---- 7. Execuções -----------------------------------------------------------

create table if not exists public.growth_agent_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_id uuid not null references public.growth_agents(id) on delete cascade,
  status text not null default 'queued',
  items_total integer not null default 0,
  items_processed integer not null default 0,
  stop_reason text,
  error text,
  trace jsonb not null default '{}'::jsonb,
  -- Substitui deliberadamente o versionamento de agente (PRD D-03): carimba a
  -- config vigente quando o run começou. É o que responde "com que parâmetros
  -- este run rodou" sem a máquina de save/publish do EPIC-13.
  params_snapshot jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  constraint growth_agent_runs_status_check
    check (status in ('queued', 'running', 'completed', 'failed'))
);

-- Guarda de concorrência: cron e clique manual disparando ao mesmo tempo não
-- podem gerar dois runs do mesmo agente. Mesma técnica do
-- ai_agent_runs_one_running_per_conv (EPIC-13), que já provou segurar.
create unique index if not exists growth_agent_runs_one_active_per_agent
  on public.growth_agent_runs (agent_id)
  where status in ('queued', 'running');

create index if not exists growth_agent_runs_agent_idx
  on public.growth_agent_runs (agent_id, started_at desc);

-- ---- 8. Decisões do SDR -----------------------------------------------------

create table if not exists public.growth_sdr_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_id uuid not null references public.growth_companies(id) on delete cascade,
  verdict text not null,
  score_at_decision integer,
  -- RF-D04: guardar só "quente/frio" faz do módulo uma caixa-preta que o
  -- operador desliga na segunda semana. O porquê é o que o torna corrigível.
  reasoning text not null,
  lead_id uuid references public.crm_leads(id) on delete set null,
  review_after date,
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint growth_sdr_decisions_verdict_check
    check (verdict in ('hot', 'cold', 'manual_review'))
);

-- Uma decisão por empresa: evento reprocessado vira no-op, não segundo lead.
create unique index if not exists growth_sdr_decisions_org_company_uniq
  on public.growth_sdr_decisions (organization_id, company_id);

-- ---- 9. Vínculo com o funil existente ---------------------------------------

-- DIRC manda "Referenciar": ponteiro para tabela tenant-aware é FK de verdade,
-- nunca uma chave dentro do source_metadata jsonb (anti-pattern 6 — sem
-- integridade referencial, sem cascade, UI lendo path solto).
alter table public.crm_leads
  add column if not exists source_company_id uuid references public.growth_companies(id) on delete set null;

create index if not exists crm_leads_source_company_idx
  on public.crm_leads (source_company_id)
  where source_company_id is not null;

-- ---- 10. updated_at ---------------------------------------------------------

-- Só as tabelas que TÊM a coluna. `growth_agent_runs` fica de fora de
-- propósito: seu ciclo de vida é explícito (started_at / finished_at) e ela não
-- tem `updated_at` — com o trigger, todo UPDATE de run falharia em
-- "record new has no field updated_at", quebrando o dispatcher inteiro.
do $$
declare
  t text;
begin
  foreach t in array array[
    'growth_companies', 'growth_enrichment', 'growth_website_analysis',
    'growth_agents'
  ] loop
    if not exists (
      select 1 from pg_trigger
      where tgname = 'trg_' || t || '_updated_at'
    ) then
      execute format(
        'create trigger trg_%1$s_updated_at before update on public.%1$s
           for each row execute function public.fn_set_updated_at()', t
      );
    end if;
  end loop;
end
$$;

-- ---- 11. RLS ----------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'growth_companies', 'growth_enrichment', 'growth_website_analysis',
    'growth_ads_analysis', 'growth_scores', 'growth_agents',
    'growth_agent_runs', 'growth_sdr_decisions'
  ] loop
    execute format('alter table public.%I enable row level security', t);

    -- Forma idêntica à das tabelas já existentes (ver tenant_isolation_contacts_all
    -- no baseline): o OR fn_is_platform_admin() não é opcional — sem ele o
    -- super-admin de plataforma fica cego para o módulo, e o /admin quebra.
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
        and policyname = 'tenant_isolation_' || t || '_all'
    ) then
      execute format(
        'create policy tenant_isolation_%1$s_all on public.%1$s
           using (
             organization_id in (select public.fn_user_org_ids())
             or public.fn_is_platform_admin()
           )
           with check (
             organization_id in (select public.fn_user_org_ids())
             or public.fn_is_platform_admin()
           )', t
      );
    end if;
  end loop;
end
$$;

-- ---- 12. Audit --------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'growth_companies', 'growth_enrichment', 'growth_website_analysis',
    'growth_agents', 'growth_sdr_decisions'
  ] loop
    if not exists (select 1 from pg_trigger where tgname = 'trg_' || t || '_audit') then
      execute format(
        'create trigger trg_%1$s_audit after insert or update or delete on public.%1$s
           for each row execute function public.fn_audit_log_row()', t
      );
    end if;
  end loop;
end
$$;

notify pgrst, 'reload schema';
