/**
 * Pipeline síncrono de prospecção (EPIC-14, S-14.03).
 *
 * Uma execução = uma passada completa: descobre no Places, enriquece, analisa o
 * site, pontua com IA e decide. Termina numa DECISÃO, nunca num envio — a
 * mensagem só sai depois que um humano aprova na fila (decisão locked 6).
 *
 * Não há cron, dispatcher nem barreira de convergência: a ordem das etapas é a
 * ordem do código. Foi a simplificação que o dono pediu, e ela apagou a peça
 * mais arriscada do desenho anterior.
 *
 * Regra que vale para todas as etapas: falha de UMA empresa não derruba o lote.
 * Site fora do ar, robots proibindo, modelo devolvendo lixo — tudo isso é
 * registrado naquela empresa e o laço segue para a próxima.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getBudgetStatus } from "@/lib/ai/budget/check";
import { analisarSite } from "@/lib/growth/providers/site";
import { PlacesError } from "@/lib/growth/providers/places";
import { KipflowError } from "@/lib/growth/providers/kipflow";
import { descobrir, type FonteDescoberta } from "@/lib/growth/providers/discovery";
import { pontuar } from "@/lib/growth/score";
import type { GrowthAgentRow } from "@/lib/growth/agents";

export interface PipelineResult {
  descobertas: number;
  duplicadas: number;
  analisadas: number;
  pontuadas: number;
  decisoes: { hot: number; cold: number; manual_review: number };
  stopReason: string | null;
  erros: string[];
  /** Quota consumida. É o teto que importa em plano mensal por requisições. */
  requisicoes: number;
  /** Custo real informado pela API. 0 quando a fonte não reporta (Places). */
  custoCents: number;
}

/**
 * Params do agente. A fonte de descoberta é escolha explícita — Places e
 * Kipflow acham recortes diferentes do mercado (ver providers/discovery.ts).
 * Agente antigo, sem `fonte`, é lido como `places`: era a única que existia.
 */
type AgentParams = {
  fonte?: FonteDescoberta;
  /** places */
  nicho?: string;
  cidade?: string;
  raio_km?: number;
  /** kipflow */
  cnae?: string[];
  uf?: string;
  faixas_faturamento?: string[];
  faixas_funcionarios?: string[];
  porte?: string;
  perfil_bairro?: string;
  optante_simples?: boolean;
  somente_matriz?: boolean;
  datasets?: string[];
  /** comum */
  limite_diario?: number;
  limite_por_execucao?: number;
  /** Credencial BYOK usada na etapa de score. Ausente = pipeline para antes da IA. */
  credential_id?: string;
  model_id?: string;
  prompt?: string;
  score_hot?: number;
  score_cold?: number;
};

export async function runGrowthAgent(
  agent: GrowthAgentRow,
  runId: string,
): Promise<PipelineResult> {
  const admin = createAdminClient();
  const orgId = agent.organization_id;
  const p = agent.params as unknown as AgentParams;

  const res: PipelineResult = {
    descobertas: 0,
    duplicadas: 0,
    analisadas: 0,
    pontuadas: 0,
    decisoes: { hot: 0, cold: 0, manual_review: 0 },
    stopReason: null,
    erros: [],
    requisicoes: 0,
    custoCents: 0,
  };

  const limite = Math.max(1, Math.min(p.limite_por_execucao ?? p.limite_diario ?? 25, 50));
  const fonte: FonteDescoberta = p.fonte ?? "places";

  // ---- 1. Descoberta ------------------------------------------------------
  let descoberta;
  try {
    descoberta =
      fonte === "kipflow"
        ? await descobrir({
            fonte: "kipflow",
            cnae: p.cnae,
            uf: p.uf,
            cidade: p.cidade,
            faixas_faturamento: p.faixas_faturamento,
            faixas_funcionarios: p.faixas_funcionarios,
            porte: p.porte,
            perfil_bairro: p.perfil_bairro,
            optante_simples: p.optante_simples,
            somente_matriz: p.somente_matriz,
            datasets: p.datasets,
            limite_por_execucao: limite,
          })
        : await descobrir({
            fonte: "places",
            nicho: p.nicho ?? "",
            cidade: p.cidade ?? "",
            raio_km: p.raio_km,
            limite_por_execucao: limite,
          });
  } catch (e) {
    if (e instanceof PlacesError) throw new Error(`places_${e.status}: ${e.message}`);
    if (e instanceof KipflowError) throw new Error(`kipflow_${e.status}: ${e.message}`);
    throw e;
  }

  const achados = descoberta.empresas;
  res.requisicoes += descoberta.requisicoes;
  res.custoCents += descoberta.custoCents;

  if (achados.length >= limite) res.stopReason = "batch_limit";

  // ---- 2. Persistência + dedup -------------------------------------------
  const novas: { id: string; nome: string; site: string | null; cidade: string | null; categoria: string | null }[] = [];

  for (const lugar of achados) {
    const { data, error } = await admin
      .from("growth_companies")
      .insert({
        organization_id: orgId,
        // Uma das duas chaves naturais vem preenchida, nunca as duas: Places dá
        // place_id, Kipflow dá CNPJ. O CHECK do banco exige pelo menos uma.
        place_id: lugar.place_id,
        cnpj: lugar.cnpj,
        name: lugar.name,
        razao_social: lugar.razao_social,
        address: lugar.address,
        phone: lugar.phone,
        category: lugar.category,
        cnae: lugar.cnae,
        faturamento_presumido_cents: lugar.faturamento_presumido_cents,
        linkedin_url: lugar.linkedin_url,
        city: lugar.city,
        lat: lugar.lat,
        lng: lugar.lng,
        source: lugar.source,
      })
      .select("id")
      .single();

    if (error) {
      // 23505 = já conheço esta empresa. Não é erro, é o dedup funcionando —
      // e ela NÃO é reprocessada, senão todo run re-enriquece a base inteira.
      if (error.code === "23505") res.duplicadas++;
      else res.erros.push(`insert ${lugar.name}: ${error.message.slice(0, 80)}`);
      continue;
    }

    res.descobertas++;
    novas.push({
      id: data.id,
      nome: lugar.name,
      site: lugar.website,
      cidade: lugar.city,
      categoria: lugar.category,
    });

    // A fonte já devolveu site e telefone na mesma chamada — o enriquecimento
    // parte daí em vez de começar do zero (PRD D-02).
    await admin.from("growth_enrichment").insert({
      organization_id: orgId,
      company_id: data.id,
      website_url: lugar.website,
      status: "pending",
    });
  }

  // ---- 3. Enriquecimento + análise do site -------------------------------
  const analisadas = new Map<string, Awaited<ReturnType<typeof analisarSite>>>();

  for (const empresa of novas) {
    if (!empresa.site) {
      // Sem site não há o que analisar. Empresa sem site é lead válido — às
      // vezes o melhor deles. Marca completed e segue.
      await admin
        .from("growth_enrichment")
        .update({ status: "completed", enriched_at: new Date().toISOString() })
        .eq("company_id", empresa.id);
      continue;
    }

    try {
      const achado = await analisarSite(empresa.site);
      analisadas.set(empresa.id, achado);

      await admin
        .from("growth_enrichment")
        .update({
          instagram_url: achado.instagram_url,
          facebook_url: achado.facebook_url,
          linkedin_url: achado.linkedin_url,
          whatsapp: achado.whatsapp,
          email: achado.email,
          status: "completed",
          enriched_at: new Date().toISOString(),
        })
        .eq("company_id", empresa.id);

      await admin.from("growth_website_analysis").insert({
        organization_id: orgId,
        company_id: empresa.id,
        has_https: achado.has_https,
        cms: achado.cms,
        has_ga4: achado.has_ga4,
        has_pixel: achado.has_pixel,
        seo_score: achado.seo_score,
        // performance_score e is_mobile_friendly ficam NULL: não renderizamos,
        // logo não medimos. Ver comentário na migration 0100.
        has_blog: achado.has_blog,
        has_contact_form: achado.has_contact_form,
        analysis_status: achado.analysis_status,
        failure_reason: achado.failure_reason,
        analyzed_at: new Date().toISOString(),
      });

      if (achado.analysis_status === "completed") res.analisadas++;
    } catch (e) {
      res.erros.push(`site ${empresa.nome}: ${e instanceof Error ? e.message.slice(0, 60) : "erro"}`);
    }
  }

  // ---- 4. Score + decisão -------------------------------------------------
  if (!p.credential_id || !p.model_id) {
    // Sem credencial de IA configurada o pipeline entrega empresas
    // enriquecidas e para. É degradação honesta, não falha: o operador vê as
    // empresas na tela e o motivo de não haver score.
    res.stopReason = res.stopReason ?? "sem_credencial_ia";
    return res;
  }

  const budget = await getBudgetStatus(orgId);
  if (budget.is_disabled) {
    res.stopReason = "orcamento_de_ia_esgotado";
    return res;
  }

  const hot = p.score_hot ?? 70;
  const cold = p.score_cold ?? 40;

  for (const empresa of novas) {
    const site = analisadas.get(empresa.id);
    try {
      const { output, modelUsed } = await pontuar({
        credentialId: p.credential_id,
        organizationId: orgId,
        modelId: p.model_id,
        promptCustomizado: p.prompt,
        input: {
          nome: empresa.nome,
          cidade: empresa.cidade,
          categoria: empresa.categoria,
          site: empresa.site,
          temHttps: site?.has_https ?? null,
          cms: site?.cms ?? null,
          temGa4: site?.has_ga4 ?? null,
          temPixel: site?.has_pixel ?? null,
          seoScore: site?.seo_score ?? null,
          temBlog: site?.has_blog ?? null,
          temFormulario: site?.has_contact_form ?? null,
          instagram: site?.instagram_url ?? null,
          statusAnalise: site?.analysis_status ?? null,
        },
      });

      await admin.from("growth_scores").insert({
        organization_id: orgId,
        company_id: empresa.id,
        score: output.score,
        problems: output.problems,
        opportunities: output.opportunities,
        suggested_message: output.suggested_message,
        next_action: output.next_action,
        model_used: modelUsed,
      });
      res.pontuadas++;

      const verdict =
        output.score >= hot ? "hot" : output.score < cold ? "cold" : "manual_review";
      res.decisoes[verdict]++;

      await admin.from("growth_sdr_decisions").insert({
        organization_id: orgId,
        company_id: empresa.id,
        verdict,
        score_at_decision: output.score,
        // RF-D04: o porquê é o que torna a decisão corrigível. Guardar só o
        // veredito faria disto uma caixa-preta que o operador desliga.
        reasoning: [
          `Score ${output.score} (quente ≥ ${hot}, frio < ${cold}).`,
          output.problems.length ? `Problemas: ${output.problems.join("; ")}.` : null,
          output.opportunities.length ? `Oportunidades: ${output.opportunities.join("; ")}.` : null,
        ]
          .filter(Boolean)
          .join(" "),
        // Só lead quente entra na fila de aprovação. Frio e revisão manual
        // nascem 'not_applicable' para não poluir a fila de quem vai trabalhar.
        approval_status: verdict === "hot" ? "pending" : "not_applicable",
        message_draft: verdict === "hot" ? output.suggested_message : null,
        review_after:
          verdict === "cold"
            ? new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10)
            : null,
      });
    } catch (e) {
      res.erros.push(`score ${empresa.nome}: ${e instanceof Error ? e.message.slice(0, 80) : "erro"}`);
    }
  }

  void runId;
  return res;
}
