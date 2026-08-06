---
epic_id: EPIC-14-growth-agents
epic_name: Growth Agents Module (Prospecção automatizada → funil existente)
priority: P1
estimated_waves: 13
estimated_total_points: 41
depends_on: [EPIC-00, EPIC-01, EPIC-04, EPIC-06, EPIC-13]
exposes_contracts:
  - "db.growth_companies"
  - "db.growth_enrichment"
  - "db.growth_website_analysis"
  - "db.growth_ads_analysis"
  - "db.growth_scores"
  - "db.growth_agents"
  - "db.growth_agent_runs"
  - "db.growth_sdr_decisions"
  - "api.* /api/v1/growth/agents"
  - "api.POST /api/v1/growth/agents/:id:run"
  - "api.GET /api/v1/growth/agents/:id/runs"
  - "api.GET /api/v1/growth/companies"
  - "api.GET /api/v1/growth/companies/:id"
  - "api.GET /api/v1/growth/approvals"
  - "api.POST /api/v1/growth/approvals/:id:approve"
  - "api.POST /api/v1/growth/approvals/:id:reject"
  - "lib.growth.pipeline.runAgent"
  - "lib.growth.providers.EnrichmentProvider"
  - "lib.growth.providers.WebsiteProbe"
status: pending
created_at: 2026-08-05
owner: Ruan
prd: pdr.md (v1.1, validado contra main @ 687716a)
---

# EPIC-14 — Growth Agents Module

> **Para o epic-executor**: leia este arquivo inteiro antes de qualquer wave. As stories estão em ordem de dependência. Cada story = 1 wave. Não pular ordem mesmo que pareça independente — `Deps:` é lei.
>
> **Documento canônico**: o PRD `pdr.md` v1.1. A §12 dele tem quatro decisões **locked** — este epic as implementa, não as revisita.
>
> **Decisões locked (não revisitar)**:
> 1. **Website Analyzer é `fetch` + parse de HTML**, sem headless browser e sem PageSpeed no MVP. `performance_score` e `is_mobile_friendly` ficam **`null`** — não inventar heurística para preenchê-los.
> 2. **Enriquecimento é heurística própria** (Places + regex no HTML), atrás da interface `EnrichmentProvider`. Nenhum provedor pago no MVP.
> 3. **`growth_agents` não tem versionamento.** `params jsonb` editado direto. A auditoria vem de `growth_agent_runs.params_snapshot`, não de uma tabela de versões.
> 4. **Threshold do SDR vive em `growth_agents.params`** (`score_hot`, `score_cold`), não em settings da org nem no pipeline.
> 5. **(2026-08-05) Execução é síncrona e sob demanda — não há cron, dispatcher nem barreira de convergência.** O botão "Executar agora" roda a cadeia inteira numa requisição. Rever só quando houver volume que justifique.
> 6. **(2026-08-05) Nenhuma mensagem sai sem aprovação humana.** O pipeline termina numa fila de aprovação; um humano lê, edita e aprova, e só então o envio acontece.
> 7. **(2026-08-05) O envio reusa `lib/automation/`** — `send-whatsapp.ts` + `throttle.ts`. É **proibido** implementar envio, espaçamento, jitter, janela de horário ou limite diário novos neste módulo.

## 0. Mudança de rumo registrada (2026-08-05)

A primeira versão deste epic (13 stories) desenhava o módulo como um pipeline assíncrono espelhando o EPIC-13: cron dispara, workers drenam `event_log`, uma barreira de convergência decide quando o Score pode rodar. O dono redirecionou: **"o agente não precisa executar, vamos usar API para extrair os leads, fazer a análise e depois o agente mandar msg"**.

O que isso elimina — e é ganho real, não perda:

| Removido | Por que sai |
|---|---|
| `worker.growth-dispatcher` + cron de 1 min | Não há o que drenar: a cadeia roda inteira dentro do request |
| Barreira de convergência (`lib/growth/barrier.ts`) | Era a peça mais arriscada do epic. Existia só porque Website e Ads corriam em paralelo de forma assíncrona; em fluxo síncrono a ordem é a ordem do código |
| 7 eventos `growth.*` em `event_log` | Evento sem consumer é anti-pattern 3 do CLAUDE.md. Sem workers, não há consumer |
| `endpoint.internal /api/internal/growth/run` | Ponto de corte para isolar scraping em outro processo — sem valor enquanto é síncrono |
| `growth_agent_runs.status='queued'` como estado de fila | Continua existindo para o registro do run, mas nasce `running` e termina no mesmo request |

O que **entra** no lugar:

| Adicionado | Por quê |
|---|---|
| Fila de aprovação humana (`growth_sdr_decisions.approval_status`) | Decisão locked 6. Mensagem fria no WhatsApp para empresa que nunca te procurou é o vetor de banimento que a doutrina anti-ban existe para evitar. O throttle protege o ritmo, não protege de denúncia por spam |
| Reuso de `lib/automation/send-whatsapp.ts` | A máquina de saída já existe e já está provada em produção: contato bloqueado, telefone ausente, `withinSendWindow()`, `checkDailyLimit()`, `AUTOMATED_SEND_SPACING_MS`, `jitterMs()`. Reimplementar seria recriar o risco que ela já resolve |

**Nota de honestidade sobre o custo do síncrono:** um run de 50 empresas faz 50 fetches de site e 50 chamadas de IA dentro de uma requisição HTTP. Isso estoura timeout de serverless muito antes de 50. Por isso o `limite_diario` do MVP é também um **limite por execução**, e a UI diz isso: executar processa um lote, não a cidade inteira. Quando o volume exigir mais, o caminho de volta ao assíncrono está descrito aqui — mas ele não será reintroduzido por antecipação.
>
> **Relação com o EPIC-13**: este epic **espelha o padrão** (agente = row configurável, dispatcher drenando `event_log`, runs com trace, realtime), mas **não estende as tabelas dele**. `ai_agents` é agente que conversa com cliente; `growth_agents` é agente que sai procurando empresa. Contratos diferentes, ciclos de vida diferentes, telas diferentes. Compartilham `event_log`, `ai_budgets` e o AI Gateway — nada mais.
>
> **Posicionamento**: o módulo **alimenta** o funil que já existe. Ele não cria um CRM paralelo, não cria um kanban próprio, não cria uma tabela de contato própria. Lead qualificado vira row em `crm_leads` com `source='growth_agent'` e aparece no kanban do EPIC-04.
>
> **Anti-patterns proibidos** (PR rejeitado):
> - Trigger Postgres fazendo HTTP — toda chamada externa sai de worker, nunca de trigger (regra 9 do CLAUDE.md)
> - Service role em handler sem filtrar `organization_id` manualmente, resolvido de fonte confiável
> - `import { GoogleGenerativeAI }` ou SDK de provider direto — o Score IA vai por AI Gateway com string `"provider/model"`
> - Chamar API externa paga sem checar `params.limite_diario` e `ai_budgets` antes
> - Ponteiro para tabela tenant-aware dentro de `jsonb` (anti-pattern 6) — FK de verdade
> - `console.log` no worker de scraping "só para debugar"
> - Preencher campo de medição não medida com valor plausível (ver decisão locked 1)

## 1. Objetivo

Entregar o **módulo de prospecção automatizada** do DeskcommCRM: cada tenant configura N agentes (Maps, Enriquecimento, Website Analyzer, Meta Ads, Score, SDR) que descobrem empresas por nicho + cidade, enriquecem com presença digital, diagnosticam maturidade, pontuam via IA e decidem sozinhos o que vira lead quente no funil existente. Tudo configurável por UI, sem código, isolado por tenant, e sem nenhuma infra nova além da que o self-hoster já sobe.

## 2. Resultado esperado (Definition of Done do Epic)

- [ ] Tenant cria agente Maps pela UI com nicho + cidade + raio + limite diário; salva e ele aparece com status e próxima execução
- [ ] Execução manual ("Executar agora") e execução por cron produzem o mesmo resultado; duas disparadas simultâneas no mesmo agente resultam em **1** run (partial unique index)
- [ ] Agente Maps descobre empresas via Google Places, e re-rodar o mesmo agente na mesma cidade **não cria duplicata** (`unique (organization_id, place_id)`)
- [ ] Limite diário é respeitado: agente com `limite_diario=50` para em 50 e o run fecha `completed` com `stop_reason='daily_limit'`, não `failed`
- [ ] Empresa nova enfileira enriquecimento automaticamente via `event_log`; sem cron manual, sem clique
- [ ] Enriquecimento acha site/redes/WhatsApp/e-mail quando existem; quando não existem, grava `null` e **o pipeline segue** (não trava, não falha)
- [ ] Website Analyzer roda sem browser: site fora do ar, com timeout ou bloqueando bot marca `analysis_status='failed'` e o pipeline continua para o Score
- [ ] `robots.txt` é respeitado — site que proíbe crawling recebe `analysis_status='disallowed'` e nunca é buscado
- [ ] Meta Ads Agent responde se a empresa anuncia; API da Meta indisponível marca `status='unavailable'` sem derrubar o pipeline
- [ ] Score IA recebe o payload agregado, chama o modelo via AI Gateway com a chave BYO do tenant, e retorna JSON estruturado validado por Zod; resposta malformada do modelo é retry bounded, depois `failed` — nunca grava score inventado
- [ ] Score respeita `ai_budgets`: org com budget estourado não dispara chamada de IA (mesmo guard do EPIC-06)
- [ ] SDR decide com base em `params.score_hot`/`score_cold`; lead quente cria row em `crm_leads` com `source='growth_agent'` e `source_company_id` preenchido, aparece no kanban existente, e registra atividade em `crm_lead_activities`
- [ ] Decisão do SDR é auditável: `growth_sdr_decisions` guarda o raciocínio resumido, não só o veredito
- [ ] Lead frio arquiva com `review_after` no futuro e **não** polui o kanban
- [ ] Mesma empresa processada duas vezes pelo SDR gera **1** lead, não 2 (`unique (organization_id, company_id)`)
- [ ] UI: grupo "Prospecção" no sidebar com 3 telas, todas registradas em `lib/navigation/registry.ts` (o teste de completude de navegação passa)
- [ ] Runs aparecem em realtime na tela, no padrão do EPIC-13
- [ ] Cross-tenant isolation auditado: tenant A não vê empresas/enriquecimento/scores/agentes/runs de tenant B (RLS + filtro programático nos handlers com admin client)
- [ ] Schema saiu como migration versionada **+ apêndice idempotente no `baseline.sql`** + linha no MANIFEST — clone atualiza com `update.sh` sem quebrar
- [ ] Envs novas em `.env.example` **e** `lib/env.ts`; **ausência delas degrada com mensagem clara na UI**, não com stack trace (é o estado real de um primeiro deploy)
- [ ] Jornada provada pela tela em ambiente fresco estilo VPS, com evidência visual (doutrina de QA Visual)

## 3. Pré-requisitos

- Epics completos: `EPIC-00` (foundation, `event_log`, `fn_user_org_ids`), `EPIC-01` (auth/RBAC/audit), `EPIC-04` (pipelines/stages/leads/activities), `EPIC-06` (AI Gateway + `ai_budgets`), `EPIC-13` (padrão de dispatcher e runs — referência de implementação)
- Migrations `0001-0099` aplicadas. **Próxima livre: `0100`** — reconferir com `ls supabase/migrations/` antes de escrever, o repo anda rápido
- Variáveis de env novas:
  - `GOOGLE_PLACES_API_KEY` — chave da Places API. **Opcional**: ausente ⇒ agente Maps aparece na UI como "não configurado" com link para a doc, e nunca é agendado
  - `META_AD_LIBRARY_TOKEN` — token da Ad Library. **Opcional**: ausente ⇒ agente Meta Ads fica `unavailable`, pipeline segue sem ele
  - `GROWTH_HTTP_TIMEOUT_MS` — timeout de fetch do Website Analyzer (default `8000`)
  - `GROWTH_USER_AGENT` — UA declarado no scraping (default `DeskcommCRM-GrowthBot/1.0 (+<APP_URL>)`). **Declarar-se é doutrina**, não cortesia
  - `INTERNAL_SECRET`, `AI_GATEWAY_API_KEY` — já existentes, reutilizados
- Nenhum pacote npm novo obrigatório. O parse de HTML usa regex + `URL` nativo; **não** adicionar cheerio/jsdom sem justificar em ADR (peso de bundle no worker)
- Upstash Redis configurado (throttle de API externa)
- Dev server em `localhost:3001`; Playwright MCP conectado para QA

## 4. Architecture Contracts

### 4.1 Contracts consumidos (de epics anteriores)

| Contract ID | Tipo | Origem | Como usar |
|---|---|---|---|
| `auth.user-session` | session | EPIC-01 | Guard das rotas `/app/growth/*` |
| `db.organizations` | db_table | EPIC-00 | FK em todas as tabelas novas |
| `db.fn_user_org_ids` | db_function | EPIC-00 | Base de toda policy RLS deste epic |
| `db.fn_audit_log_row` | db_function | EPIC-01 | Trigger de audit nas tabelas mutáveis |
| `db.event_log` | db_table | EPIC-00 | Barramento do pipeline inteiro (7 eventos novos) |
| `db.ai_budgets` | db_table | EPIC-06 | Guard de custo antes de qualquer chamada de IA |
| `db.crm_pipelines` / `crm_stages` | db_table | EPIC-04 | Destino do lead promovido pelo SDR |
| `db.crm_leads` | db_table | EPIC-04 | **Estendida** com `source_company_id` |
| `db.crm_lead_activities` | db_table | EPIC-04 | Diagnóstico do SDR vira atividade na timeline |
| `lib.ai.budget.check` | shared_lib | EPIC-06 | `getBudgetStatus()` antes do Score |
| `lib.api.wrappers` | shared_lib | EPIC-00 | `ok()` / `fail()` em todo endpoint novo |
| `lib.api.errors` | shared_lib | EPIC-00 | Códigos canônicos; novos códigos registrados lá, não inline |
| `lib.supabase.{server,admin}` | shared_lib | EPIC-00 | Clients canônicos |
| `lib.navigation.registry` | shared_lib | EPIC-01 | Grupo `prospeccao` + 3 destinos |
| `worker.event-log-drain` | worker | EPIC-00 | Padrão de drain a espelhar |
| `realtime.org-{org_id}` | realtime_channel | EPIC-01 | Broadcast de estado de run |

### 4.2 Contracts expostos

| Contract ID | Tipo | Wave | Descrição |
|---|---|---|---|
| `db.growth_companies` | db_table | S-14.01 | Empresa descoberta, dedup por `place_id` |
| `db.growth_enrichment` | db_table | S-14.01 | 1:1 com company — presença digital |
| `db.growth_website_analysis` | db_table | S-14.01 | 1:1 — diagnóstico do site |
| `db.growth_ads_analysis` | db_table | S-14.01 | 1:N — histórico de checagens de anúncio |
| `db.growth_scores` | db_table | S-14.01 | 1:N — histórico de pontuação |
| `db.growth_agents` | db_table | S-14.01 | Config do agente por tenant (`params jsonb`) |
| `db.growth_agent_runs` | db_table | S-14.01 | Log de execução + `params_snapshot` + `trace` |
| `db.growth_sdr_decisions` | db_table | S-14.01 | Decisão auditável do SDR, 1 por company |
| `lib.growth.providers.EnrichmentProvider` | shared_lib | S-14.05 | Interface + impl `heuristic` |
| `lib.growth.providers.WebsiteProbe` | shared_lib | S-14.09 | Interface + impl `html-fetch` |
| `api.* /api/v1/growth/agents` | api_route | S-14.02 | CRUD de agentes |
| `api.POST /api/v1/growth/agents/:id:run` | api_route | S-14.02 | Execução manual |
| `api.POST /api/v1/growth/agents/:id:pause` | api_route | S-14.02 | Pausa/retoma sem perder histórico |
| `api.GET /api/v1/growth/agents/:id/runs` | api_route | S-14.02 | Histórico paginado por cursor |
| `api.GET /api/v1/growth/companies` | api_route | S-14.06 | Lista/filtro de empresas |
| `api.GET /api/v1/growth/companies/:id` | api_route | S-14.06 | Detalhe agregado |
| `worker.growth-dispatcher` | worker | S-14.03 | Cron que drena os eventos `growth.*` |
| `endpoint.internal /api/internal/growth/run` | internal_endpoint | S-14.03 | Executa um agente, isolável em processo próprio |
| `event.growth.company_discovered` | domain_event | S-14.04 | Maps emite |
| `event.growth.enrichment_completed` | domain_event | S-14.05 | Enriquecimento emite |
| `event.growth.website_analyzed` | domain_event | S-14.09 | Analyzer emite |
| `event.growth.ads_checked` | domain_event | S-14.10 | Meta Ads emite |
| `event.growth.ready_for_score` | domain_event | S-14.03 | Barreira de convergência emite |
| `event.growth.scored` | domain_event | S-14.11 | Score emite |
| `event.growth.lead_promoted` | domain_event | S-14.12 | SDR emite ao criar lead |
| `realtime.growth_agent_runs-{org_id}` | realtime_channel | S-14.13 | Tela de execuções subscreve |
| `hook.useGrowthAgents` | react_hook | S-14.07 | Lista + mutations |
| `hook.useGrowthCompanies` | react_hook | S-14.08 | Lista + filtros |
| `ui.<GrowthAgentCard>` | react_component | S-14.07 | Card com status, fila, próxima execução |

## 5. Stories (em ordem de dependência)

> Wave 1 = S-14.01. **Fase MVP = S-14.01 a S-14.08** (o módulo já entrega valor aqui: descobre, enriquece e mostra). **Fase 2 = S-14.09 a S-14.11** (diagnóstico + score). **Fase 3 = S-14.12 a S-14.13** (decisão automática). Parar depois de qualquer fase deixa o sistema coerente — isso é de propósito.

---

### S-14.01 — Schema + RLS + audit + apêndice do baseline

**Points**: 4 | **Priority**: P0 | **Deps**: (none) | **Refs**: PRD §6

#### Contexto

Fundação. Oito tabelas novas e uma coluna em `crm_leads`. Sem RLS aqui, o vazamento cross-tenant é garantido e o gate `invariants` do CI bloqueia — corretamente.

Esta é uma migration de projeto open-source: o artefato que o self-hoster realmente aplica é o `baseline.sql`, não a cadeia de `migrations/`. Migration que não vira apêndice idempotente no baseline **não chega ao clone**. Os dois artefatos andam juntos, sempre.

Duas guardas de concorrência nascem aqui, não depois: uma execução em andamento por agente, e uma decisão de SDR por empresa. Ambas são partial unique index — a mesma técnica do `ai_agent_runs_one_running_per_conv` do EPIC-13, que já provou funcionar sob cron + manual simultâneos.

#### Files to create

- `supabase/migrations/<timestamp>_0100_growth_agents_module.sql` — migration completa

#### Files to modify

- `supabase/baseline.sql` — apêndice idempotente `-- ---- growth agents module (migration 0100) ----` no fim
- `supabase/migrations/MANIFEST.md` — linha na tabela "Applied" com o QUÊ/PORQUÊ
- `lib/database.types.ts` — regenerar após aplicar

#### Implementation steps (sequential)

1. `create table if not exists growth_companies` — `id, organization_id, place_id text not null, name, address, phone, category, city, lat numeric, lng numeric, source text not null default 'maps_agent', created_at, updated_at`. `unique (organization_id, place_id)`.
2. `growth_enrichment` — 1:1 (`unique (company_id)`): `website_url, instagram_url, facebook_url, linkedin_url, whatsapp, email, provider text not null default 'heuristic', status text check (status in ('pending','completed','failed')), enriched_at`.
3. `growth_website_analysis` — 1:1: `has_https bool, cms text, has_ga4 bool, has_pixel bool, seo_score int, performance_score int, is_mobile_friendly bool, has_blog bool, has_contact_form bool, analysis_status text check (analysis_status in ('pending','completed','failed','disallowed')), failure_reason text, analyzed_at`. **`performance_score` e `is_mobile_friendly` são nullable e ficam null no MVP** — comentário SQL explicando por quê, para ninguém "completar" depois.
4. `growth_ads_analysis` — 1:N: `platform text not null default 'meta' check (...), is_advertising bool, active_creatives_count int, active_since date, landing_page_url text, status text check (status in ('completed','unavailable','failed')), checked_at`.
5. `growth_scores` — 1:N: `score int check (score between 0 and 100), problems jsonb not null default '[]', opportunities jsonb not null default '[]', suggested_message text, next_action text, model_used text, scored_at`.
6. `growth_agents` — `kind text not null check (kind in ('maps','enrichment','website_analyzer','meta_ads','score','sdr'))`, `name, params jsonb not null default '{}', schedule_cron text, is_active bool not null default true, priority int not null default 0, created_by_user_id, created_at, updated_at`. `unique (organization_id, kind, name)`.
7. `growth_agent_runs` — `agent_id, status text check (status in ('queued','running','completed','failed'))`, `items_total int, items_processed int, stop_reason text, error text, trace jsonb not null default '{}'`, **`params_snapshot jsonb not null default '{}'`** (decisão locked 3 — é isto que substitui versionamento), `started_at, finished_at`.
   - `create unique index if not exists growth_agent_runs_one_running_per_agent on growth_agent_runs (agent_id) where status in ('queued','running')`.
8. `growth_sdr_decisions` — `company_id, verdict text check (verdict in ('hot','cold','manual_review')), score_at_decision int, reasoning text not null, lead_id uuid references crm_leads(id) on delete set null, review_after date, decided_at`. `unique (organization_id, company_id)`.
9. `alter table crm_leads add column if not exists source_company_id uuid references growth_companies(id) on delete set null` + index parcial `where source_company_id is not null`.
10. RLS `tenant_isolation_<tabela>_all` via `fn_user_org_ids()` nas 8 tabelas. Audit trigger `trg_<tabela>_audit` via `fn_audit_log_row()` nas mutáveis.
11. Espelhar **tudo** no apêndice do `baseline.sql`, idempotente e auto-curativo (`if not exists` em tudo; se algum dia entrar constraint sobre dado existente, deduplicar **antes** de criá-la).
12. Validar o baseline num Postgres descartável `pgvector/pgvector:pg17`: `install` fresh com `ON_ERROR_STOP=1` **e** `update` re-aplicando sem a flag. Os dois têm que passar.

#### Acceptance Criteria

```gherkin
Given a fresh database
When migration 0100 is applied
Then the 8 growth_* tables exist with RLS enabled
And crm_leads has column source_company_id
And audit triggers exist on the mutable growth_* tables
```

```gherkin
Given organization A and organization B both have growth_companies rows
When a user from org A selects from growth_companies
Then only org A rows are returned
And the same holds for enrichment, website_analysis, ads_analysis, scores, agents, runs and sdr_decisions
```

```gherkin
Given a growth_agent already has a run with status 'running'
When a second run row is inserted for the same agent with status 'queued'
Then the insert fails with unique violation 23505
```

```gherkin
Given a growth_companies row exists for (org A, place_id X)
When another insert is attempted for the same (org A, place_id X)
Then it fails with 23505
And an insert for (org B, place_id X) succeeds
```

```gherkin
Given a database that already has the growth module applied
When baseline.sql is re-applied in update mode without ON_ERROR_STOP
Then it completes without error and without duplicating any object
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | db | 8 tabelas criadas com RLS | `list_tables` mostra as tabelas com `rls_enabled: true` |
| t2 | rls | Isolamento cross-tenant nas 8 tabelas | Novo arquivo em `tests/invariants/`, 2 orgs, verifica conjunto vazio |
| t3 | db | Partial unique index de run em andamento | INSERT duplicado → `23505` |
| t4 | db | Dedup por `place_id` é por org, não global | 2 INSERTs mesma org falha; org diferente passa |
| t5 | db | Baseline install + update | `scripts/test-db.sh` (é o gate do CI) |
| t6 | db | `source_company_id` sobrevive ao delete da company | delete company → lead permanece, coluna vira null |

#### Decisões a registrar

- `growth_*` é prefixo reservado do módulo. Tabela de prospecção nasce com ele.
- `params_snapshot` no run é o substituto deliberado do versionamento de agente (PRD D-03).
- `performance_score`/`is_mobile_friendly` nullable **por design**, com comentário SQL. Não são dívida.

#### Definition of Done

- [ ] `pnpm test:db` verde localmente (não só no CI)
- [ ] Migration + apêndice do baseline + linha no MANIFEST — os três
- [ ] `lib/database.types.ts` regenerado
- [ ] Typecheck e lint zerados
- [ ] Commit `feat(EPIC-14): schema do módulo de growth agents [wave 1]`

---

### S-14.02 — API REST de agentes (CRUD + run + pause + runs)

**Points**: 3 | **Priority**: P0 | **Deps**: S-14.01 | **Refs**: PRD §8

#### Contexto

A camada que a UI vai consumir e que um integrador externo pode chamar. Segue as convenções fechadas do repo: `ok()`/`fail()`, snake_case, cursor opaco, `X-Request-Id`, RBAC (viewer lê; manager/admin escrevem), audit em toda mutação.

`POST :run` aceita `Idempotency-Key` — sem isso, um duplo-clique na UI ou um retry de rede vira dois runs, e a guarda de banco transforma o segundo em erro 500 feio em vez de no-op silencioso.

#### Files to create

- `app/api/v1/growth/agents/route.ts` — GET lista, POST cria
- `app/api/v1/growth/agents/[id]/route.ts` — GET, PATCH, DELETE
- `app/api/v1/growth/agents/[id]/run/route.ts` — POST dispara
- `app/api/v1/growth/agents/[id]/pause/route.ts` — POST pausa/retoma
- `app/api/v1/growth/agents/[id]/runs/route.ts` — GET paginado
- `lib/growth/schemas.ts` — Zod por `kind` (params do Maps ≠ params do SDR)
- `lib/growth/agents.ts` — helpers de leitura/escrita compartilhados com o worker

#### Files to modify

- `lib/api/errors.ts` — códigos novos: `growth_agent_busy`, `growth_provider_not_configured`, `growth_daily_limit_reached`

#### Implementation steps (sequential)

1. `lib/growth/schemas.ts`: um discriminated union Zod sobre `kind`. `maps` exige `nicho`, `cidade`, `raio_km`, `limite_diario`; `sdr` exige `score_hot`, `score_cold`, `pipeline_id`, `stage_id`; e assim por diante. **Params inválidos são rejeitados na escrita**, não descobertos no meio de um run.
2. CRUD com `getUser()` + `requireRole()`. Org vem do JWT, **nunca do body**.
3. `POST :run`: valida agente ativo, valida que o provider está configurado (env presente), insere `growth_agent_runs` com `status='queued'` e `params_snapshot` copiado dos params atuais. Captura `23505` do partial index → `fail('growth_agent_busy', 409)`.
4. `POST :pause`: alterna `is_active`. Pausar **não** cancela run em andamento nem apaga histórico.
5. `GET runs`: cursor base64+HMAC, `ORDER BY started_at DESC`.
6. Audit em POST/PATCH/DELETE/:run/:pause.

#### Acceptance Criteria

```gherkin
Given I am a manager of org A
When I POST /api/v1/growth/agents with kind=maps and valid params
Then I get 201 with the created agent
And an api_audit_log entry is recorded
```

```gherkin
Given I am a viewer
When I POST /api/v1/growth/agents
Then I get 403
And a GET on the same collection returns 200
```

```gherkin
Given an agent already has a run in status 'running'
When I POST /api/v1/growth/agents/:id/run
Then I get 409 with error code growth_agent_busy
```

```gherkin
Given GOOGLE_PLACES_API_KEY is not set
When I POST /api/v1/growth/agents/:id/run on a maps agent
Then I get 422 with error code growth_provider_not_configured
And the message names the missing env var
```

```gherkin
Given an agent of org A exists
When a user of org B requests it by id
Then I get 404, not 403
```

```gherkin
Given I POST :run twice with the same Idempotency-Key
When the second request arrives
Then it returns the same run id as the first, with 200
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | CRUD completo | Vitest com admin client mockado |
| t2 | api | Zod rejeita params fora do contrato do kind | POST `kind=maps` sem `cidade` → 422 |
| t3 | rbac | viewer read-only | Teste por papel nos 4 roles |
| t4 | api | 409 em agente ocupado | Sequência run→run |
| t5 | rls | Agente de outra org é 404 | Teste de invariante |
| t6 | api | Idempotency-Key | Dois POSTs, mesmo run id |

#### Definition of Done

- [ ] ACs cobertos por teste unitário
- [ ] Códigos de erro em `lib/api/errors.ts`, não string solta
- [ ] Audit emitido em toda mutação
- [ ] Commit `feat(EPIC-14): api rest de agentes de prospecção [wave 2]`

---

### S-14.03 — Pipeline síncrono `runAgent()`

**Points**: 4 | **Priority**: P0 | **Deps**: S-14.02 | **Refs**: decisões locked 5, 6, 7

#### Contexto

Substitui o orquestrador assíncrono que a v1 deste epic desenhava (ver §0). A cadeia inteira — descobrir, enriquecer, pontuar, decidir — roda dentro de uma função, chamada pelo endpoint `:run`. Sem fila, sem barreira, sem evento.

O que **não** muda por ser síncrono: o run continua sendo registrado em `growth_agent_runs` com `params_snapshot`, a guarda de concorrência continua valendo (o índice parcial impede dois runs do mesmo agente), e cada etapa continua degradando sozinha — site fora do ar não derruba o lote.

O ponto de atenção é o **tempo de requisição**: 50 empresas = 50 fetches + 50 chamadas de IA. O `limite_diario` funciona como limite por execução, e o run fecha `completed` com `stop_reason='batch_limit'` ao atingi-lo. Isso é resultado normal, não falha.

#### Files to create

- `lib/growth/pipeline.ts` — `runAgent(agentId, orgId)`, a cadeia inteira
- `lib/growth/providers/places.ts` — cliente Google Places
- `lib/growth/providers/enrichment.ts` + `enrichment-heuristic.ts`
- `lib/growth/providers/website-probe.ts` + `website-probe-html.ts`
- `lib/growth/score.ts` — chamada de IA via AI Gateway, saída validada por Zod

#### Implementation steps (sequential)

1. `runAgent` marca o run `running`, carimba `params_snapshot`.
2. Places: busca, dedup por `place_id` (23505 = já conheço, segue).
3. Para cada empresa nova: enriquecimento → análise de site (se houver site) → score.
4. Score respeita `ai_budgets` **antes** da chamada; org sem saldo encerra o run com motivo claro.
5. Verdict do SDR pelos thresholds em `params`; grava `growth_sdr_decisions` com `reasoning` e `approval_status='pending'`.
6. Qualquer exceção fecha o run `failed` com o erro — **nunca deixa run pendurado em `running`**, senão o agente fica travado para sempre pela própria guarda de concorrência.

#### Acceptance Criteria

```gherkin
Given a maps agent with limite_diario 5
When I run it
Then at most 5 companies are processed
And the run ends completed with stop_reason batch_limit
```

```gherkin
Given one company site times out mid-batch
When the run continues
Then that company is recorded with the failure and the remaining ones still process
```

```gherkin
Given the pipeline throws unexpectedly
When the request ends
Then the run is failed with the error recorded and the agent is free to run again
```

```gherkin
Given the organization ai_budget is disabled
When the score step is reached
Then no model call is made and the run reports the budget as the cause
```

#### Definition of Done

- [ ] Run nunca fica preso em `running` — provado matando o processo no meio
- [ ] Commit `feat(EPIC-14): pipeline síncrono de prospecção [wave 3]`

---

### S-14.04 — Agente Maps (Google Places)

**Points**: 3 | **Priority**: P0 | **Deps**: S-14.03 | **Refs**: PRD RF-M

#### Contexto

Primeiro agente de verdade e a porta de entrada do funil. Duas coisas importam mais que a busca em si: **não duplicar** (garantido no banco, mas o agente tem que tratar o `23505` como "já conheço", não como erro) e **não estourar orçamento** (Places cobra por request; `limite_diario` é obrigatório, não sugestão).

A resposta do Places já traz `website` e `formatted_phone_number` no field mask certo. Aproveitar isso aqui economiza uma rodada inteira de enriquecimento por empresa — é a decisão D-02 do PRD funcionando na prática.

#### Files to create

- `lib/growth/agents/maps.ts` — o agente
- `lib/growth/providers/places.ts` — cliente Places (fetch tipado + field mask + paginação)

#### Implementation steps (sequential)

1. Cliente Places com field mask explícito (`places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.types,places.location`). Field mask larga = conta maior.
2. Busca por `nicho` + `cidade` + `raio_km`, paginando até `limite_diario` ou fim dos resultados.
3. Para cada resultado: INSERT em `growth_companies`, captura `23505` → conta como `skipped_duplicate`, segue.
4. Empresa nova ⇒ INSERT em `event_log` `growth.company_discovered`. Empresa duplicada **não** re-enfileira (senão re-enriquece o mesmo lead todo dia).
5. Se o Places já trouxe `websiteUri`/telefone, gravar pré-preenchido em `growth_enrichment` com `status='pending'` — o enriquecimento parte daí.
6. Ao atingir `limite_diario`: fecha o run `completed` com `stop_reason='daily_limit'`. **Não é falha.**
7. Throttle Upstash entre páginas.

#### Acceptance Criteria

```gherkin
Given a maps agent configured with nicho "clínica odontológica" and cidade "Belo Horizonte"
When the agent runs
Then growth_companies rows are created with place_id, name, address and location
And each new company emits growth.company_discovered
```

```gherkin
Given the same agent runs again the next day over the same area
When it finds companies already stored
Then no duplicate rows are created
And no new growth.company_discovered events are emitted for them
And the run reports them as skipped_duplicate
```

```gherkin
Given the agent has limite_diario = 50
When the search would return 200 results
Then exactly 50 companies are processed
And the run ends with status 'completed' and stop_reason 'daily_limit'
```

```gherkin
Given the Places API returns 429
When the agent is running
Then the run ends 'failed' with the provider error recorded
And no partial company row is left without its enrichment placeholder
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | Dedup trata 23505 como skip | Mock do client com place_id repetido |
| t2 | unit | Limite diário para exatamente no limite | Fixture de 200 resultados |
| t3 | unit | Field mask não pede campo a mais | Assert na URL montada |
| t4 | unit | Duplicata não re-emite evento | Contar INSERTs em `event_log` |
| t5 | api | 429 do provider vira run failed, não exception | Mock 429 |

#### Definition of Done

- [ ] Nenhum segredo em log — chave do Places nunca em query string de log nem em breadcrumb do Sentry
- [ ] Commit `feat(EPIC-14): agente maps com dedup e limite diário [wave 4]`

---

### S-14.05 — Agente Enriquecimento (heurística + interface de provider)

**Points**: 3 | **Priority**: P0 | **Deps**: S-14.04 | **Refs**: PRD RF-E, D-02

#### Contexto

Decisão locked 2: heurística própria, atrás de interface. A interface não é over-engineering — é o que permite trocar por provedor pago sem tocar no pipeline, e o custo dela é uma assinatura de função.

Regra que não pode ser violada: **campo não encontrado é `null` e o pipeline segue**. Empresa sem site é lead válido (às vezes o melhor lead — é exatamente quem precisa de presença digital).

#### Files to create

- `lib/growth/providers/enrichment.ts` — interface `EnrichmentProvider`
- `lib/growth/providers/enrichment-heuristic.ts` — implementação default
- `lib/growth/agents/enrichment.ts` — o agente

#### Implementation steps (sequential)

1. `interface EnrichmentProvider { name: string; enrich(company): Promise<EnrichmentResult> }`.
2. Implementação `heuristic`: parte do que o Places deu; se há site, faz **um** fetch da home e extrai por regex `mailto:`, `wa.me`/`api.whatsapp.com`, e hosts de redes sociais. Normaliza tudo com `URL` nativo (link relativo, protocolo faltando, tracking param).
3. WhatsApp: normalizar para E.164 quando possível; se não der, gravar cru — dado bruto é melhor que dado descartado.
4. Salvar; campos ausentes ficam `null`; `status='completed'` mesmo com achado parcial. `failed` só quando o próprio processo falhou.
5. Emitir `growth.enrichment_completed` **sempre**, com `has_website` no payload — é o que a barreira usa para saber se a análise de site é aplicável.
6. Timeout duro (`GROWTH_HTTP_TIMEOUT_MS`) e UA declarado.

#### Acceptance Criteria

```gherkin
Given a company whose site links to instagram and has a mailto: address
When enrichment runs
Then instagram_url and email are stored normalized
And status is 'completed'
```

```gherkin
Given a company with no website at all
When enrichment runs
Then all url fields are null
And status is 'completed', not 'failed'
And growth.enrichment_completed carries has_website=false
```

```gherkin
Given the company site times out
When enrichment runs
Then whatever came from Places is still stored
And status is 'completed' with a note in the trace
```

```gherkin
Given a site with relative and protocol-less links
When enrichment parses them
Then stored URLs are absolute and valid
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | Extração de 4 redes + email + whatsapp | Fixtures de HTML real |
| t2 | unit | Sem site ⇒ completed, nulls | Company sem website |
| t3 | unit | Normalização de URL | Casos relativos/sem protocolo/com utm |
| t4 | unit | Timeout não vira exception | Fetch mockado pendurado |
| t5 | unit | Evento sempre emitido | Os 3 caminhos |

#### Decisões a registrar

- **ADR-14.2**: `EnrichmentProvider` é o ponto de extensão. Provedor pago entra como implementação nova selecionada por `params.provider`, nunca com `if` dentro do agente.

#### Definition of Done

- [ ] Commit `feat(EPIC-14): agente de enriquecimento heurístico [wave 5]`

---

### S-14.06 — API de empresas descobertas

**Points**: 2 | **Priority**: P1 | **Deps**: S-14.05

#### Contexto

O que a tela de empresas consome. Detalhe agregado em uma chamada — a UI não deve fazer 5 requests para montar um card.

#### Files to create

- `app/api/v1/growth/companies/route.ts` — lista com filtros (`city`, `has_website`, `min_score`, `enrichment_status`)
- `app/api/v1/growth/companies/[id]/route.ts` — detalhe agregado

#### Implementation steps (sequential)

1. Lista paginada por cursor, com o score mais recente por company (janela `row_number()`, não N+1).
2. Detalhe: company + enrichment + website_analysis + último ads_analysis + último score + decisão do SDR, em uma resposta.
3. RBAC: viewer lê. Filtro de `organization_id` explícito mesmo com RLS ativa (defesa em profundidade — 89 dos handlers do repo usam admin client).

#### Acceptance Criteria

```gherkin
Given org A has 120 companies
When I GET /api/v1/growth/companies
Then I get the first page with a cursor and has_more=true
And every row belongs to org A
```

```gherkin
Given a company with enrichment, website analysis, ads and score
When I GET its detail
Then all sections come in a single response
And sections that never ran are null, not absent
```

```gherkin
Given a company of org B
When a user of org A requests it
Then I get 404
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Paginação por cursor estável | Duas páginas sem sobreposição |
| t2 | api | Filtros combinados | `city` + `min_score` |
| t3 | api | Detalhe agregado sem N+1 | Contar queries |
| t4 | rls | Cross-tenant → 404 | Invariante |

#### Definition of Done

- [ ] Commit `feat(EPIC-14): api de empresas descobertas [wave 6]`

---

### S-14.07 — UI: grupo Prospecção + tela de agentes

**Points**: 4 | **Priority**: P0 | **Deps**: S-14.06 | **Refs**: PRD §9

#### Contexto

Primeira tela do módulo, e a que decide se o dono de PME entende o que comprou. Reaproveita o design system do repo (shadcn `new-york`, neutral) — **não** importar nada novo.

Cuidado de nomenclatura registrado no PRD: já existe "Agentes" no grupo IA (`/app/ai/agents`, do EPIC-13) e já existe "Radar" no grupo Atendimento. Este grupo se chama **Prospecção** e seu item se chama **Agentes de prospecção**. Dois "Agentes" no mesmo sidebar seria ambiguidade garantida.

Item 14 do DoD: tela nova precisa de porta declarada no registry, senão o CI reprova. E envs ausentes têm que degradar com mensagem clara — é o estado real do primeiro deploy do self-hoster, e é onde moram os piores bugs de primeira impressão.

#### Files to create

- `app/app/growth/layout.tsx`
- `app/app/growth/agents/page.tsx` — grid de cards
- `app/app/growth/agents/_components/GrowthAgentCard.tsx` — status, fila, próxima execução, executar/pausar
- `app/app/growth/agents/_components/GrowthAgentForm.tsx` — form por `kind`
- `hooks/useGrowthAgents.ts`

#### Files to modify

- `lib/navigation/registry.ts` — grupo `prospeccao` entre `crm` e `ia`, e os 3 destinos com `minRole`
- `tests/unit/navegacao-completude.test.ts` — se alguma rota ficar fora do sidebar, precisa de justificativa escrita

#### Implementation steps (sequential)

1. Registrar grupo e destinos. Sem hub (3 telas — a convenção documentada no próprio `registry.ts` é hub só acima de 4).
2. Cards com status derivado real: `is_active` + existe run em andamento + próxima execução calculada do `schedule_cron`. **Não** inventar "online/offline" que não corresponde a nada.
3. Form dirigido pelo Zod da S-14.02 — um schema, duas validações (cliente e servidor) a partir da mesma fonte.
4. **Estado "não configurado"**: agente cujo provider exige env ausente aparece desabilitado, com o nome da variável e o que ela faz. Nunca um botão que leva a erro.
5. Estados vazios: sem agentes, texto que explica o que é um agente de prospecção e um CTA de criação.

#### Acceptance Criteria

```gherkin
Given I am logged in as manager
When I open the sidebar
Then I see the group "Prospecção" with "Agentes de prospecção", "Empresas descobertas" and "Execuções"
And the existing "Agentes" item under "Agente de IA" is unchanged
```

```gherkin
Given no growth agents exist yet
When I open /app/growth/agents
Then I see an empty state explaining the module with a create CTA
```

```gherkin
Given GOOGLE_PLACES_API_KEY is not configured
When I open the agents screen
Then the maps agent card shows a "não configurado" state naming the env var
And the run button is disabled, not broken
```

```gherkin
Given I fill the maps agent form with nicho, cidade, raio and limite diário
When I save
Then the agent appears in the grid with its next scheduled run
```

```gherkin
Given an agent is running
When I click "Executar agora"
Then the button is disabled and I see it is already running
And no 409 error toast appears
```

```gherkin
Given I am a viewer
When I open the screen
Then I can see the cards but the create, run and pause controls are absent
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Grupo e 3 destinos no sidebar | Playwright: `getByRole("navigation")` |
| t2 | unit | Teste de completude de navegação passa | `pnpm test:unit` |
| t3 | ui | Empty state | Banco fresco |
| t4 | ui | Env ausente degrada com clareza | Subir sem a env |
| t5 | ui | Criar agente pela tela | Playwright ponta a ponta |
| t6 | ui | viewer sem controles de escrita | Login por papel |
| t7 | ui | 390px sem transbordo | `getBoundingClientRect`, medido — não a olho |

#### Definition of Done

- [ ] Provado pela tela em banco fresco estilo VPS, com evidência visual
- [ ] `t7` explícito: o repo tem achado aberto de transbordo a 390px; tela nova não entra na conta
- [ ] Commit `feat(EPIC-14): tela de agentes de prospecção [wave 7]`

---

### S-14.08 — UI: empresas descobertas + detalhe

**Points**: 3 | **Priority**: P1 | **Deps**: S-14.07

#### Contexto

Onde o resultado do módulo fica visível. Fecha a Fase MVP: parar aqui deixa um produto coerente — descobre, enriquece e mostra, com o humano decidindo o que promover.

#### Files to create

- `app/app/growth/companies/page.tsx` — lista com filtros
- `app/app/growth/companies/[id]/page.tsx` — detalhe
- `app/app/growth/companies/_components/CompanyDetail.tsx`
- `hooks/useGrowthCompanies.ts`

#### Implementation steps (sequential)

1. Lista com filtro por cidade, score, tem site, status de enriquecimento.
2. Detalhe em seções (Identificação, Presença digital, Site, Anúncios, Score). **Seção que ainda não rodou diz "ainda não analisado"; campo medido como ausente diz "não encontrado".** São coisas diferentes e o usuário precisa distinguir.
3. `performance_score` null (decisão locked 1) aparece como "não medido nesta versão" — honesto, não vazio nem inventado.
4. Ação manual "Promover a lead" para quem não quiser esperar o SDR (Fase 3 ainda não existe neste ponto).

#### Acceptance Criteria

```gherkin
Given companies were discovered and enriched
When I open /app/growth/companies
Then I see them with city, website presence and score when available
```

```gherkin
Given a company that has not been analyzed yet
When I open its detail
Then the site section says "ainda não analisado"
And a company analyzed with no contact form says "não encontrado"
```

```gherkin
Given I click "Promover a lead" on a company
When I pick a pipeline and stage
Then a crm_leads row is created with source='growth_agent' and source_company_id set
And it appears on the existing kanban
```

```gherkin
Given I already promoted that company
When I try again
Then the action is unavailable and links to the existing lead
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Lista + filtros | Playwright |
| t2 | ui | "não analisado" ≠ "não encontrado" | Duas companies em estados diferentes |
| t3 | ui | Promoção manual cria lead no kanban | Playwright cruzando as duas telas |
| t4 | ui | Promoção duplicada bloqueada | Clicar duas vezes |
| t5 | ui | 390px sem transbordo | Medido por ferramenta |

#### Definition of Done

- [ ] **Marco de Fase MVP**: jornada completa provada pela tela em ambiente fresco — criar agente → rodar → ver empresa → promover → ver no kanban
- [ ] Commit `feat(EPIC-14): tela de empresas descobertas [wave 8]`

---

### S-14.09 — Agente Website Analyzer (`html-fetch`)

**Points**: 3 | **Priority**: P1 | **Deps**: S-14.08 | **Refs**: PRD RF-W, D-01

#### Contexto

Decisão locked 1: sem browser. Um `fetch`, um parse, sem render. Isso significa que **medir performance real e responsividade está fora de escopo** — os campos ficam `null` e a UI já diz isso (S-14.08).

`robots.txt` é obrigatório, não cortesia: o produto é open-source e vai rodar na VPS de terceiros com o nome deles no User-Agent. Site que proíbe é `disallowed`, não `failed` — são coisas diferentes e o operador precisa distinguir.

#### Files to create

- `lib/growth/providers/website-probe.ts` — interface `WebsiteProbe`
- `lib/growth/providers/website-probe-html.ts` — implementação `html-fetch`
- `lib/growth/agents/website-analyzer.ts`
- `lib/growth/robots.ts` — parse e cache de `robots.txt`

#### Implementation steps (sequential)

1. Checar `robots.txt` **antes** do fetch da página. Proibido ⇒ `analysis_status='disallowed'`, emite evento terminal, encerra.
2. Fetch com timeout, limite de tamanho de resposta e no máximo 2 redirects (um redirect infinito trava o worker).
3. Extrair: HTTPS pelo protocolo final; CMS por fingerprint (`meta generator`, `/wp-content/`, `cdn.shopify`, `wix.com`, `squarespace`); GA4/Pixel por regex de script; `<title>`/`<meta description>`/H1 para `seo_score` heurístico **declaradamente simples**; `<form>` + `mailto:` para contato; link para `/blog`.
4. `performance_score` e `is_mobile_friendly` ficam `null`. **Não preencher.**
5. Falha de rede/timeout/5xx ⇒ `analysis_status='failed'` com `failure_reason`, e emite evento terminal mesmo assim — a barreira precisa saber.

#### Acceptance Criteria

```gherkin
Given a site whose robots.txt disallows our user agent
When the analyzer runs
Then analysis_status is 'disallowed'
And no request to the page itself is made
And a terminal event is still emitted
```

```gherkin
Given a WordPress site with GA4 and a contact form
When the analyzer runs
Then cms='wordpress', has_ga4=true, has_contact_form=true
And performance_score and is_mobile_friendly are null
```

```gherkin
Given the site does not respond within GROWTH_HTTP_TIMEOUT_MS
When the analyzer runs
Then analysis_status is 'failed' with a failure_reason
And the pipeline continues to the score stage
```

```gherkin
Given a site that redirects in a loop
When the analyzer runs
Then it stops after the redirect limit and does not hang the worker
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | robots.txt respeitado | Fixture com Disallow |
| t2 | unit | Fingerprint de 5 CMS | Fixtures de HTML real |
| t3 | unit | Timeout vira failed, não exception | Servidor pendurado |
| t4 | unit | Redirect loop tem limite | Receiver real com 302 em anel |
| t5 | unit | Campos não medidos permanecem null | Assert explícito |
| t6 | unit | Resposta gigante não estoura memória | Body acima do limite |

#### Definition of Done

- [ ] Testado contra receiver HTTP real, não só mock — o egress real é o que estressa timeout e redirect
- [ ] Commit `feat(EPIC-14): website analyzer sem browser [wave 9]`

---

### S-14.10 — Agente Meta Ads

**Points**: 2 | **Priority**: P2 | **Deps**: S-14.09 | **Refs**: PRD RF-A

#### Contexto

Sinal de intenção: empresa que começou a anunciar é empresa investindo em aquisição. O PRD já marcou a Ad Library como risco — contrato instável e rate limit. Por isso o agente é **degradável por design**: indisponível é `unavailable`, e o pipeline segue sem ele.

#### Files to create

- `lib/growth/providers/meta-ads.ts` — cliente da Ad Library
- `lib/growth/agents/meta-ads.ts`

#### Implementation steps (sequential)

1. Busca por nome e/ou domínio. Match ambíguo ⇒ gravar o candidato com confiança baixa em vez de chutar.
2. Extrair: anuncia (bool), criativos ativos, `active_since`, plataformas, landing page.
3. Token ausente, 4xx de contrato ou 429 ⇒ `status='unavailable'`, evento terminal emitido, sem retry agressivo.
4. Agendável para recheck (`schedule_cron`), guardando histórico — é 1:N de propósito, a mudança ao longo do tempo é o sinal.

#### Acceptance Criteria

```gherkin
Given META_AD_LIBRARY_TOKEN is not configured
When the pipeline reaches the ads stage
Then a row with status 'unavailable' is recorded
And growth.ads_checked is emitted so the barrier can proceed
```

```gherkin
Given a company that advertises on Facebook and Instagram
When the agent runs
Then is_advertising=true with creative count and platforms stored
```

```gherkin
Given the Ad Library returns 429
When the agent runs
Then status is 'unavailable', not 'failed'
And no immediate retry storm happens
```

```gherkin
Given the agent rechecks a company a week later
When it runs
Then a new row is appended and the previous one is preserved
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | Sem token degrada | Env ausente |
| t2 | unit | 429 vira unavailable | Mock |
| t3 | unit | Histórico acumula | Duas execuções |
| t4 | unit | Evento sempre emitido | Os 3 caminhos |

#### Definition of Done

- [ ] Commit `feat(EPIC-14): agente meta ads com degradação graciosa [wave 10]`

---

### S-14.11 — Agente Score (IA via AI Gateway)

**Points**: 4 | **Priority**: P1 | **Deps**: S-14.10 | **Refs**: PRD RF-S

#### Contexto

Onde o módulo vira inteligência em vez de coleta. Regras não negociáveis do repo: AI Gateway com string `"provider/model"` e chave BYO do tenant (nunca SDK de provider direto), e `ai_budgets` checado **antes** da chamada — o guard já existe no EPIC-06 e é para ser reutilizado, não reescrito.

Saída do modelo é validada por Zod. Modelo que devolve JSON malformado é retry bounded e depois `failed`. **Nunca** gravar score parcial ou inventado: o SDR decide em cima disso, e score falso vira lead falso vira vendedor ligando para quem não devia.

#### Files to create

- `lib/growth/agents/score.ts`
- `lib/growth/prompts/score.ts` — prompt default, sobrescritível por `params.prompt`

#### Implementation steps (sequential)

1. Montar payload agregado (Maps + enrichment + website + ads), marcando explicitamente o que não foi medido — o modelo precisa saber a diferença entre "não tem" e "não sabemos".
2. `getBudgetStatus()` antes de tudo: org `is_disabled` ⇒ run `failed` com motivo claro; `is_throttled` ⇒ adia.
3. Chamada via AI Gateway com `params.provider_model`, chave BYO do tenant.
4. Validar a resposta com Zod: `score` 0-100, `problems[]`, `opportunities[]`, `suggested_message`, `next_action`. Inválida ⇒ até 2 retries, depois `failed`.
5. Gravar em `growth_scores` com `model_used`; emitir `growth.scored`.
6. Registrar consumo no mesmo caminho de contabilidade do EPIC-06 (migration `0095` já conta llm calls).

#### Acceptance Criteria

```gherkin
Given a company with full aggregated data
When the score agent runs
Then a growth_scores row is created with score, problems, opportunities, suggested_message and next_action
And model_used records the provider/model string
And growth.scored is emitted
```

```gherkin
Given the organization's ai_budget is disabled
When the score stage is reached
Then no model call is made
And the run fails with a message naming the budget as the cause
```

```gherkin
Given the model returns malformed JSON twice
When the agent retries and fails again
Then the run is 'failed'
And no growth_scores row is written
```

```gherkin
Given a company where the website was never analyzed
When the payload is built
Then the site fields are marked as not measured, not as absent features
```

```gherkin
Given the tenant configured a custom prompt in params
When the agent runs
Then the custom prompt is used instead of the default
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | Zod rejeita saída malformada | Fixtures de resposta ruim |
| t2 | unit | Budget disabled bloqueia antes da chamada | Mock do budget; assert de zero fetch |
| t3 | unit | Retry bounded | Duas falhas e para |
| t4 | unit | Payload distingue não-medido de ausente | Assert no prompt montado |
| t5 | unit | Sem SDK de provider importado | Lint/grep no diff |

#### Decisões a registrar

- **ADR-14.3**: score nunca é gravado parcialmente. Sem JSON válido, não há score — o SDR prefere ausência a ruído.

#### Definition of Done

- [ ] Nenhum `import` de SDK de provider — só AI Gateway
- [ ] Commit `feat(EPIC-14): agente de score via ai gateway [wave 11]`

---

### S-14.12 — Agente SDR (decisão auditável + promoção ao funil)

**Points**: 4 | **Priority**: P1 | **Deps**: S-14.11 | **Refs**: PRD RF-D, D-04

#### Contexto

O agente que fecha o ciclo: transforma score em ação no CRM que já existe. Decisão locked 4: threshold em `params.score_hot` / `params.score_cold` do próprio agente.

RF-D04 é o requisito mais importante desta story: **toda decisão é auditável**. Guardar só "quente/frio" torna o módulo uma caixa-preta que ninguém confia — e sistema de prospecção que ninguém confia é sistema que o operador desliga na segunda semana. Guardar o raciocínio resumido é o que o torna corrigível.

Idempotência é obrigatória: `unique (organization_id, company_id)` em `growth_sdr_decisions` garante um lead por empresa mesmo com evento reprocessado.

#### Files to create

- `lib/growth/agents/sdr.ts`
- `lib/growth/promote.ts` — cria/atualiza `crm_leads` + atividade, reutilizável pela promoção manual da S-14.08

#### Files to modify

- `app/app/growth/companies/_components/CompanyDetail.tsx` — mostrar a decisão e o porquê

#### Implementation steps (sequential)

1. Ler último score. `>= score_hot` ⇒ `hot`; `< score_cold` ⇒ `cold`; entre ⇒ `manual_review`.
2. `hot`: criar `crm_leads` no `pipeline_id`/`stage_id` dos params, `source='growth_agent'`, `source_company_id` preenchido, `title` com nome da empresa; criar `crm_lead_activities` com o diagnóstico (usando a **constante compartilhada** de tipo de atividade, nunca string literal — a coluna é vocabulário aberto, ver CLAUDE.md); atribuir pelo caminho de atribuição já existente do CRM; emitir `growth.lead_promoted`.
3. `cold`: gravar decisão com `review_after = now() + params.review_days` (default 60). **Não** cria lead, **não** aparece no kanban.
4. `manual_review`: decisão gravada, aparece na lista filtrável, aguarda humano.
5. Toda decisão grava `reasoning` — resumo do porquê, derivado dos `problems`/`opportunities` do score.
6. Reprocessamento do mesmo evento é no-op idempotente (captura `23505` da unique).

#### Acceptance Criteria

```gherkin
Given a company scored 85 and an SDR agent with score_hot=70
When the SDR runs
Then a crm_leads row is created with source='growth_agent' and source_company_id set
And a lead activity carries the diagnosis
And growth.lead_promoted is emitted
And the lead appears on the existing kanban
```

```gherkin
Given a company scored 25 and score_cold=40
When the SDR runs
Then no crm_leads row is created
And a decision row records verdict 'cold' with review_after about 60 days ahead
```

```gherkin
Given a company scored 55 with score_hot=70 and score_cold=40
When the SDR runs
Then the verdict is 'manual_review' and no lead is created
```

```gherkin
Given the SDR already decided on a company
When the same event is processed again
Then no second lead is created and no error surfaces
```

```gherkin
Given any SDR decision
When I open the company detail
Then I can read why it was classified that way
```

```gherkin
Given two SDR agents exist in the same org
When both process the same company
Then exactly one decision exists
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | Três faixas de threshold | Scores 85 / 55 / 25 |
| t2 | db | Idempotência da decisão | Reprocessar evento |
| t3 | ui | Lead promovido aparece no kanban | Playwright cruzando telas |
| t4 | ui | Raciocínio visível no detalhe | Playwright |
| t5 | db | Frio não polui o kanban | Query no pipeline |
| t6 | unit | Tipo de atividade vem de constante | Grep no diff |

#### Definition of Done

- [ ] Jornada Maps → kanban provada pela tela em ambiente fresco, com evidência visual
- [ ] Commit `feat(EPIC-14): agente sdr com decisão auditável [wave 12]`

---

### S-14.13 — Execuções em realtime + fechamento do epic

**Points**: 3 | **Priority**: P1 | **Deps**: S-14.12

#### Contexto

Última wave. Torna o módulo observável (item 13 do DoD — "a feature não é ilha": entrada, saída, atividade, tela e mecanismo anti-morte) e fecha as provas do epic.

#### Files to create

- `app/app/growth/runs/page.tsx` — histórico realtime
- `app/app/growth/runs/_components/RunTrace.tsx` — trace passo a passo
- `hooks/useGrowthRuns.ts` — subscribe em `realtime.growth_agent_runs-{org_id}`
- `tests/e2e/growth-pipeline.spec.ts` — jornada completa pela tela
- `docs/architecture/growth-agents.md` — mapa vivo do módulo

#### Files to modify

- `docs/testing/user-journey-map.md` — jornada nova registrada
- `docs/current-state.md` — módulo registrado no estado do projeto
- `README.md` — item de roadmap

#### Implementation steps (sequential)

1. Tela de runs com filtro por agente e status; trace expansível.
2. Realtime no padrão do EPIC-13; fallback de polling se o canal cair (anti-morte).
3. E2E: criar agente → rodar → empresa aparece → score → SDR → lead no kanban.
4. Mapa vivo com o módulo e ≥2 arestas (`event_log`, `crm_leads`).
5. Living System Checklist respondido no PR.

#### Acceptance Criteria

```gherkin
Given an agent run starts
When I am on the runs screen
Then it appears without me reloading the page
And its status updates as it progresses
```

```gherkin
Given a failed run
When I expand its trace
Then I can read which stage failed and why
```

```gherkin
Given the realtime channel drops
When I stay on the screen
Then polling takes over and the list still updates
```

```gherkin
Given a fresh VPS-style install
When I run the full E2E journey
Then a lead reaches the kanban originating from a Maps discovery
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Run aparece em realtime | Playwright com duas abas |
| t2 | ui | Trace de falha legível | Run forçado a falhar |
| t3 | ui | Fallback de polling | Derrubar o canal |
| t4 | e2e | Jornada completa | `growth-pipeline.spec.ts` em banco fresco |
| t5 | docs | Mapa vivo com ≥2 arestas | Revisão do PR |

#### Definition of Done

- [ ] E2E verde em ambiente fresco estilo VPS com evidência visual
- [ ] `docs/current-state.md` atualizado — senão o módulo nasce invisível para a próxima sessão
- [ ] Living System Checklist respondido
- [ ] Commit `feat(EPIC-14): execuções em realtime e fechamento do módulo [wave 13]`

---

## 6. Regression Suite Cumulativo (esperado ao final)

| Categoria | # de tests | Origem |
|---|---|---|
| Invariantes de banco (RLS, dedup, concorrência) | 12 | S-14.01, S-14.12 |
| Lógica pura (barreira, parsers, thresholds) | 26 | S-14.03, .05, .09, .11, .12 |
| Contratos de API | 16 | S-14.02, S-14.06 |
| Degradação de provider (env ausente, 429, timeout) | 10 | S-14.04, .09, .10, .11 |
| UI rendering + RBAC + responsividade | 14 | S-14.07, .08, .13 |
| E2E de jornada | 1 | S-14.13 |
| **Total** | **79** | |

## 7. Riscos & Mitigações específicos do epic

| Risco | Severidade | Mitigação |
|---|---|---|
| Custo descontrolado de Google Places | 🔴 Alta | `limite_diario` obrigatório no schema Zod; throttle Upstash; `stop_reason='daily_limit'` como saída normal |
| Custo descontrolado de IA no Score | 🔴 Alta | `ai_budgets` checado antes da chamada (guard do EPIC-06, reutilizado) |
| Ad Library muda contrato ou limita | 🟠 Média | `status='unavailable'` degrada sem derrubar o pipeline |
| Empresa trava no pipeline esperando etapa que nunca termina | 🟠 Média | Barreira de convergência com timeout (S-14.03), a peça mais testada do epic |
| Scraping abusivo com o nome do self-hoster | 🟠 Média | `robots.txt` obrigatório, UA declarado, timeout curto, 1 fetch por site |
| Lead duplicado no funil do cliente | 🟠 Média | `unique (organization_id, place_id)` + `unique (organization_id, company_id)` na decisão |
| LGPD: e-mail/WhatsApp de dono de PME é dado pessoal | 🟠 Média | `growth_enrichment` entra na cascata de anonimização do módulo LGPD quando a company vira contato ativo |
| Módulo nasce invisível para a próxima sessão | 🟡 Baixa | S-14.13 atualiza `current-state.md` e o mapa vivo — obrigatório, não opcional |
| Score IA alucina e vira lead falso | 🟠 Média | Zod na saída, retry bounded, nunca gravar parcial (ADR-14.3); decisão do SDR sempre auditável |

## 8. Decisões arquiteturais novas

- **ADR-14.1** — `growth.ready_for_score` é emitido pela barreira no dispatcher, não pelo último agente a terminar. Agente não conhece os irmãos.
- **ADR-14.2** — `EnrichmentProvider` e `WebsiteProbe` são pontos de extensão por interface. Provider novo é implementação nova selecionada por `params`, nunca `if` dentro do agente.
- **ADR-14.3** — Score nunca é gravado parcialmente. Sem JSON válido não há score.
- **ADR-14.4** — `growth_agents` não versiona; `growth_agent_runs.params_snapshot` cobre a auditoria. Revisitar só se o prompt do Score virar objeto de ajuste frequente.
- **ADR-14.5** — Grupo de navegação `prospeccao` é separado de `ia`. Configurar quem prospecta e configurar quem atende são atividades diferentes, e o sidebar já não pode ter dois itens "Agentes".

## 9. Anexos

- PRD: `pdr.md` v1.1 (decisões locked na §12, validação na §13)
- Padrão de referência: `docs/stories/epics/EPIC-13-ai-agents-module.md` (dispatcher, runs, realtime)
- Doutrinas aplicáveis: CLAUDE.md — migrations, QA Visual com recursos reais, DIRC, anti-patterns
- Navegação: `lib/navigation/registry.ts` e `tests/unit/navegacao-completude.test.ts`
- Orçamento de IA: `lib/ai/budget/check.ts`, migrations `0022` / `0068` / `0095`
