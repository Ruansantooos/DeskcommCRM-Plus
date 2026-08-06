/**
 * GET /api/v1/growth/agents/:id/runs — histórico de execuções, mais recente
 * primeiro. Paginação por cursor de timestamp (`?before=<iso>&limit=<n>`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { GROWTH_RUN_COLUMNS } from "@/lib/growth/agents";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "growth_agent_runs" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const admin = createAdminClient();

  // Confirma que o agente é da org ANTES de listar — sem isto, um id de outra
  // org devolveria lista vazia (que já não vaza dado, mas confirma existência).
  const { data: agent } = await admin
    .from("growth_agents")
    .select("id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();

  if (!agent) return fail("not_found", "Agente não encontrado.", 404, { requestId });

  const rawLimit = Number(req.nextUrl.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const before = req.nextUrl.searchParams.get("before");

  let query = admin
    .from("growth_agent_runs")
    .select(GROWTH_RUN_COLUMNS)
    .eq("agent_id", id)
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: false })
    // Pede um a mais para saber se há próxima página sem um COUNT separado.
    .limit(limit + 1);

  if (before) {
    const parsedBefore = new Date(before);
    if (Number.isNaN(parsedBefore.getTime())) {
      return fail("invalid_cursor", "Cursor `before` inválido.", 400, { requestId });
    }
    query = query.lt("created_at", parsedBefore.toISOString());
  }

  const { data, error } = await query;
  if (error) return fail("internal_error", "Erro ao listar execuções.", 500, { requestId });

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return ok(page, {
    requestId,
    meta: {
      has_more: hasMore,
      cursor: hasMore ? (page[page.length - 1]?.created_at as string) : null,
    },
  });
}
