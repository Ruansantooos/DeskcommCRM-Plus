/**
 * Leitura/escrita compartilhada dos agentes de prospecção (EPIC-14).
 *
 * Vive fora das rotas porque o worker (S-14.03) precisa exatamente das mesmas
 * operações — duplicar a query no worker é como as duas metades divergem.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { ENV_BY_FONTE, REQUIRED_ENV_BY_KIND, type GrowthAgentKind } from "@/lib/growth/schemas";

export const GROWTH_AGENT_COLUMNS =
  "id, organization_id, kind, name, params, schedule_cron, is_active, priority, created_by_user_id, created_at, updated_at";

export const GROWTH_RUN_COLUMNS =
  "id, organization_id, agent_id, status, items_total, items_processed, stop_reason, error, trace, params_snapshot, started_at, finished_at, created_at";

export interface GrowthAgentRow {
  id: string;
  organization_id: string;
  kind: GrowthAgentKind;
  name: string;
  params: Record<string, unknown>;
  schedule_cron: string | null;
  is_active: boolean;
  priority: number;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Provider externo está configurado para este kind?
 *
 * Chamado antes de agendar ou disparar. A resposta "não" é informação de
 * produto (a UI mostra o estado e qual variável falta), não uma exceção.
 */
export function providerStatusFor(
  kind: GrowthAgentKind,
  params?: Record<string, unknown>,
): { configured: boolean; missingEnv: string | null } {
  // Para o agente de busca a env depende da FONTE, não do kind: um agente
  // Kipflow não pode aparecer como "não configurado" por falta da chave do
  // Google. Agente antigo sem `fonte` é lido como places — era a única que havia.
  const required =
    kind === "maps"
      ? (ENV_BY_FONTE[(params?.fonte as string) ?? "places"] ?? null)
      : (REQUIRED_ENV_BY_KIND[kind] ?? null);

  if (!required) return { configured: true, missingEnv: null };

  const value = (env as unknown as Record<string, string | undefined>)[required] ?? "";
  return value.trim().length > 0
    ? { configured: true, missingEnv: null }
    : { configured: false, missingEnv: required };
}

/** Existe run em andamento? Espelha o índice parcial, para responder antes do 23505. */
export async function hasActiveRun(agentId: string, orgId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("growth_agent_runs")
    .select("id")
    .eq("agent_id", agentId)
    // Service role bypassa RLS: o filtro de org é manual e obrigatório, sempre
    // vindo do JWT do chamador — nunca do body.
    .eq("organization_id", orgId)
    .in("status", ["queued", "running"])
    .limit(1);

  return (data?.length ?? 0) > 0;
}
