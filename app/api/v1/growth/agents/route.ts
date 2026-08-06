/**
 * GET  /api/v1/growth/agents — lista os agentes de prospecção da org ativa.
 *                              Anexa `provider` (configurado ou qual env falta)
 *                              e `active_run`, que é o que a tela usa para
 *                              desabilitar o botão em vez de deixar o usuário
 *                              clicar e tomar 409.
 * POST /api/v1/growth/agents — cria agente (manager+). `params` é validado
 *                              conforme o `kind`.
 *
 * Auth: cookie session. organization_id sai do JWT — NUNCA do body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  GROWTH_AGENT_COLUMNS,
  providerStatusFor,
  type GrowthAgentRow,
} from "@/lib/growth/agents";
import { growthAgentCreateSchema } from "@/lib/growth/schemas";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "growth_agents" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("growth_agents")
    .select(GROWTH_AGENT_COLUMNS)
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: false });

  if (error) return fail("internal_error", "Erro ao listar agentes.", 500, { requestId });

  const agents = (data ?? []) as GrowthAgentRow[];

  // Runs ativos em UMA query, não N — a tela lista todos os agentes de uma vez.
  const { data: runs } = await admin
    .from("growth_agent_runs")
    .select("agent_id, status, started_at")
    .eq("organization_id", org.orgId)
    .in("status", ["queued", "running"]);

  const activeByAgent = new Map((runs ?? []).map((r) => [r.agent_id as string, r]));

  const enriched = agents.map((a) => ({
    ...a,
    provider: providerStatusFor(a.kind, a.params),
    active_run: activeByAgent.get(a.id) ?? null,
  }));

  return ok(enriched, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "growth_agents" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = growthAgentCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("growth_agents")
    .insert({
      organization_id: org.orgId,
      kind: input.kind,
      name: input.name,
      params: input.params,
      schedule_cron: input.schedule_cron ?? null,
      is_active: input.is_active ?? true,
      priority: input.priority ?? 0,
      created_by_user_id: user.id,
    })
    .select(GROWTH_AGENT_COLUMNS)
    .single();

  if (error) {
    // unique (organization_id, kind, name)
    if (error.code === "23505") {
      return fail("state_conflict", "Já existe um agente desse tipo com esse nome.", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Erro ao criar agente.", 500, { requestId });
  }

  await audit({
    action: "growth_agent.created",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "growth_agents",
    resourceId: data.id,
    requestId,
    metadata: { kind: input.kind, name: input.name },
  });

  return ok({ ...data, provider: providerStatusFor(input.kind, input.params), active_run: null }, {
    status: 201,
    requestId,
  });
}
