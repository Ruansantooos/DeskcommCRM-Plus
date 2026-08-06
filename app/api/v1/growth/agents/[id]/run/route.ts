/**
 * POST /api/v1/growth/agents/:id/run — enfileira uma execução manual (manager+).
 *
 * Três recusas deliberadas, todas ANTES de gastar qualquer quota:
 *   - agente pausado        → 409
 *   - provider sem env      → 422 nomeando a variável que falta
 *   - já existe run ativo   → 409 growth_agent_busy
 *
 * A checagem de run ativo é dupla: consulta antes (para a UI receber uma
 * resposta limpa) e captura do 23505 depois (porque entre a consulta e o
 * INSERT o cron pode ter disparado). O índice parcial é a verdade; a consulta
 * é só cortesia.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  GROWTH_AGENT_COLUMNS,
  GROWTH_RUN_COLUMNS,
  hasActiveRun,
  providerStatusFor,
  type GrowthAgentRow,
} from "@/lib/growth/agents";
import { runGrowthAgent } from "@/lib/growth/pipeline";

// A cadeia inteira roda dentro do request: Places + N fetches de site + N
// chamadas de IA. Por isso o limite por execução é baixo e a UI diz isso.
export const maxDuration = 300;

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "growth_agents" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const admin = createAdminClient();
  const { data: agentData } = await admin
    .from("growth_agents")
    .select(GROWTH_AGENT_COLUMNS)
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();

  const agent = agentData as GrowthAgentRow | null;
  if (!agent) return fail("not_found", "Agente não encontrado.", 404, { requestId });

  if (!agent.is_active) {
    return fail("state_conflict", "Este agente está pausado. Retome antes de executar.", 409, {
      requestId,
    });
  }

  const provider = providerStatusFor(agent.kind, agent.params);
  if (!provider.configured) {
    return fail(
      "growth_provider_not_configured",
      `Este agente precisa da variável ${provider.missingEnv}, que não está configurada nesta instalação.`,
      422,
      { requestId, details: { missing_env: provider.missingEnv } },
    );
  }

  if (await hasActiveRun(id, org.orgId)) {
    return fail("growth_agent_busy", "Este agente já tem uma execução em andamento.", 409, {
      requestId,
    });
  }

  const { data, error } = await admin
    .from("growth_agent_runs")
    .insert({
      organization_id: org.orgId,
      agent_id: id,
      // Nasce 'running': a execução é síncrona, não há fila entre pedir e rodar.
      status: "running",
      started_at: new Date().toISOString(),
      // Carimba a config vigente: é o que responde depois "com que parâmetros
      // este run rodou" sem existir versionamento de agente (PRD D-03).
      params_snapshot: agent.params,
    })
    .select(GROWTH_RUN_COLUMNS)
    .single();

  if (error) {
    // Corrida perdida entre a consulta de run ativo e este INSERT.
    if (error.code === "23505") {
      return fail("growth_agent_busy", "Este agente já tem uma execução em andamento.", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Erro ao registrar execução.", 500, { requestId });
  }

  await audit({
    action: "growth_agent.run_requested",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "growth_agent_runs",
    resourceId: data.id,
    requestId,
    metadata: { agent_id: id, kind: agent.kind, trigger: "manual" },
  });

  // A partir daqui NADA pode escapar sem fechar o run: o índice parcial que
  // impede execuções simultâneas usa `status in ('queued','running')`, então um
  // run pendurado em 'running' trava o agente para sempre.
  try {
    const resultado = await runGrowthAgent(agent, data.id);

    const { data: fechado } = await admin
      .from("growth_agent_runs")
      .update({
        status: "completed",
        items_total: resultado.descobertas + resultado.duplicadas,
        items_processed: resultado.descobertas,
        stop_reason: resultado.stopReason,
        trace: resultado as unknown as Record<string, unknown>,
        // Quota é o teto que importa em plano mensal por requisições; o custo
        // anda junto porque a Kipflow o informa de graça em cada resposta.
        requisicoes_api: resultado.requisicoes,
        custo_api_cents: resultado.custoCents,
        finished_at: new Date().toISOString(),
      })
      .eq("id", data.id)
      .select(GROWTH_RUN_COLUMNS)
      .single();

    return ok(fechado ?? data, { status: 201, requestId });
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : "erro desconhecido";

    await admin
      .from("growth_agent_runs")
      .update({
        status: "failed",
        error: mensagem.slice(0, 500),
        finished_at: new Date().toISOString(),
      })
      .eq("id", data.id);

    return fail("internal_error", `A execução falhou: ${mensagem.slice(0, 200)}`, 500, {
      requestId,
    });
  }
}
