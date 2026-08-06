/**
 * POST /api/v1/growth/agents/:id/pause — alterna pausado/ativo (manager+).
 *
 * Body: `{ "active": false }` para pausar, `{ "active": true }` para retomar.
 * Omitir o campo alterna o estado atual.
 *
 * Pausar NÃO cancela run em andamento e NÃO apaga histórico: o agente para de
 * ser agendado, o resto sobrevive. É o que "pausar sem perder histórico" quer
 * dizer no PRD.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { GROWTH_AGENT_COLUMNS, type GrowthAgentRow } from "@/lib/growth/agents";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ active: z.boolean().optional() });

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "growth_agents" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  // Body vazio é legítimo aqui (significa "alterne").
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campo `active` inválido.", 422, { requestId });
  }

  const admin = createAdminClient();
  const { data: agentData } = await admin
    .from("growth_agents")
    .select(GROWTH_AGENT_COLUMNS)
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();

  const agent = agentData as GrowthAgentRow | null;
  if (!agent) return fail("not_found", "Agente não encontrado.", 404, { requestId });

  const next = parsed.data.active ?? !agent.is_active;

  const { data, error } = await admin
    .from("growth_agents")
    .update({ is_active: next })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select(GROWTH_AGENT_COLUMNS)
    .single();

  if (error) return fail("internal_error", "Erro ao alterar o estado do agente.", 500, { requestId });

  await audit({
    action: next ? "growth_agent.resumed" : "growth_agent.paused",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "growth_agents",
    resourceId: id,
    requestId,
    metadata: { kind: agent.kind },
  });

  return ok(data, { requestId });
}
