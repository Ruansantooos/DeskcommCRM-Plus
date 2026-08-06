import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { GROWTH_AGENT_COLUMNS, providerStatusFor, type GrowthAgentRow } from "@/lib/growth/agents";
import { GrowthAgentsList } from "./_components/GrowthAgentsList";

export const dynamic = "force-dynamic";

export default async function GrowthAgentsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  const admin = createAdminClient();
  // Service role bypassa RLS — o filtro por organização é manual e vem da org
  // ativa resolvida do cookie validado, nunca de parâmetro de request.
  const { data } = await admin
    .from("growth_agents")
    .select(GROWTH_AGENT_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  const agents = (data ?? []) as GrowthAgentRow[];

  const { data: runs } = await admin
    .from("growth_agent_runs")
    .select("agent_id, status, started_at")
    .eq("organization_id", activeOrg.orgId)
    .in("status", ["queued", "running"]);

  const activeByAgent = new Map((runs ?? []).map((r) => [r.agent_id as string, r]));

  const enriched = agents.map((a) => ({
    ...a,
    provider: providerStatusFor(a.kind, a.params),
    active_run: activeByAgent.get(a.id) ?? null,
  }));

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agentes de prospecção</h1>
          <p className="text-sm text-muted-foreground">
            Eles saem procurando empresas por nicho e cidade, e entregam o lead qualificado no
            seu funil.
          </p>
        </div>
      </header>

      <GrowthAgentsList initialData={enriched} canWrite />
    </div>
  );
}
