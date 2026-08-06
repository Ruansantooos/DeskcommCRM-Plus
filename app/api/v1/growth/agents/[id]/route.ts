/**
 * GET    /api/v1/growth/agents/:id — detalhe.
 * PATCH  /api/v1/growth/agents/:id — edita nome/params/agendamento (manager+).
 * DELETE /api/v1/growth/agents/:id — remove (admin). Runs vão junto por cascade.
 *
 * Recurso de outra org responde 404, não 403: 403 confirmaria que o id existe.
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
import { growthAgentUpdateSchema, paramsSchemaFor } from "@/lib/growth/schemas";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function loadAgent(id: string, orgId: string): Promise<GrowthAgentRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("growth_agents")
    .select(GROWTH_AGENT_COLUMNS)
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  return (data as GrowthAgentRow | null) ?? null;
}

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "growth_agents" });
  if (!authz.ok) return authz.response;

  const agent = await loadAgent(id, authz.org.orgId);
  if (!agent) return fail("not_found", "Agente não encontrado.", 404, { requestId });

  return ok({ ...agent, provider: providerStatusFor(agent.kind, agent.params) }, { requestId });
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "growth_agents" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const agent = await loadAgent(id, org.orgId);
  if (!agent) return fail("not_found", "Agente não encontrado.", 404, { requestId });

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = growthAgentUpdateSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // `kind` não muda por PATCH — mudaria o contrato de `params` embaixo do
  // agente. Os params novos são validados contra o kind JÁ gravado.
  const patch: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.schedule_cron !== undefined) patch.schedule_cron = parsed.data.schedule_cron;
  if (parsed.data.is_active !== undefined) patch.is_active = parsed.data.is_active;
  if (parsed.data.priority !== undefined) patch.priority = parsed.data.priority;

  if (parsed.data.params !== undefined) {
    const paramsParsed = paramsSchemaFor(agent.kind).safeParse(parsed.data.params);
    if (!paramsParsed.success) {
      return fail("validation_failed", "Parâmetros inválidos para este tipo de agente.", 422, {
        requestId,
        details: paramsParsed.error.flatten(),
      });
    }
    patch.params = paramsParsed.data;
  }

  if (Object.keys(patch).length === 0) {
    return fail("invalid_request", "Nada para atualizar.", 400, { requestId });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("growth_agents")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select(GROWTH_AGENT_COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("state_conflict", "Já existe um agente desse tipo com esse nome.", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Erro ao atualizar agente.", 500, { requestId });
  }

  await audit({
    action: "growth_agent.updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "growth_agents",
    resourceId: id,
    requestId,
    metadata: { fields: Object.keys(patch) },
  });

  return ok({ ...data, provider: providerStatusFor(agent.kind, agent.params) }, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "growth_agents" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const agent = await loadAgent(id, org.orgId);
  if (!agent) return fail("not_found", "Agente não encontrado.", 404, { requestId });

  const admin = createAdminClient();
  const { error } = await admin
    .from("growth_agents")
    .delete()
    .eq("id", id)
    .eq("organization_id", org.orgId);

  if (error) return fail("internal_error", "Erro ao remover agente.", 500, { requestId });

  await audit({
    action: "growth_agent.deleted",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "growth_agents",
    resourceId: id,
    requestId,
    metadata: { kind: agent.kind, name: agent.name },
  });

  return ok({ id }, { requestId });
}
