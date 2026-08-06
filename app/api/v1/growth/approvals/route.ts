/**
 * GET /api/v1/growth/approvals — a fila de mensagens esperando aprovação humana.
 *
 * Decisão locked 6 do EPIC-14: nenhuma mensagem de prospecção sai sem alguém
 * ler. Esta rota é o "alguém ler" — devolve a empresa, o canal, o rascunho e o
 * porquê da decisão, que é o que permite julgar em segundos em vez de abrir
 * cada card.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { sessaoDisponivel } from "@/lib/growth/envio";

export const dynamic = "force-dynamic";

const LIMITE_PADRAO = 25;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "growth_approvals" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const admin = createAdminClient();

  const status = req.nextUrl.searchParams.get("status") ?? "pending";
  const rawLimit = Number(req.nextUrl.searchParams.get("limit") ?? LIMITE_PADRAO);
  const limite = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : LIMITE_PADRAO;

  const { data, error } = await admin
    .from("growth_sdr_decisions")
    .select(
      "id, company_id, verdict, score_at_decision, reasoning, approval_status, message_draft, message_final, sent_at, send_error, decided_at",
    )
    .eq("organization_id", org.orgId)
    .eq("approval_status", status)
    .order("decided_at", { ascending: false })
    .limit(limite);

  if (error) return fail("internal_error", "Erro ao ler a fila.", 500, { requestId });

  const decisoes = data ?? [];
  const ids = decisoes.map((d) => d.company_id as string);

  // Empresa e canais em duas queries, não N — a fila abre com 25 itens e uma
  // consulta por item seria 50 idas ao banco na tela mais usada do fluxo.
  const [{ data: empresas }, { data: canais }] = await Promise.all([
    ids.length
      ? admin.from("growth_companies").select("id, name, city, cnpj").in("id", ids)
      : Promise.resolve({ data: [] as never[] }),
    ids.length
      ? admin
          .from("growth_enrichment")
          .select("company_id, whatsapp, email, instagram_url, website_url")
          .in("company_id", ids)
      : Promise.resolve({ data: [] as never[] }),
  ]);

  const porEmpresa = new Map((empresas ?? []).map((e) => [e.id as string, e]));
  const porCanal = new Map((canais ?? []).map((c) => [c.company_id as string, c]));

  // O contato é o que o envio precisa; sem ele o item é inaprovável e a UI
  // precisa saber disso ANTES de o usuário clicar.
  const { data: leads } = ids.length
    ? await admin
        .from("crm_leads")
        .select("source_company_id, contact_id")
        .eq("organization_id", org.orgId)
        .in("source_company_id", ids)
    : { data: [] as never[] };

  const contatoDe = new Map(
    (leads ?? []).map((l) => [l.source_company_id as string, l.contact_id as string | null]),
  );

  const sessao = await sessaoDisponivel(admin, org.orgId);

  const itens = decisoes.map((d) => {
    const emp = porEmpresa.get(d.company_id as string);
    const can = porCanal.get(d.company_id as string);
    return {
      ...d,
      empresa: emp?.name ?? "(empresa removida)",
      cidade: emp?.city ?? null,
      cnpj: emp?.cnpj ?? null,
      whatsapp: can?.whatsapp ?? null,
      instagram: can?.instagram_url ?? null,
      email: can?.email ?? null,
      site: can?.website_url ?? null,
      contact_id: contatoDe.get(d.company_id as string) ?? null,
    };
  });

  return ok(itens, {
    requestId,
    meta: {
      total: itens.length,
      // Sem WhatsApp conectado nada sai. A tela mostra isso no topo em vez de
      // deixar o usuário aprovar 20 mensagens e só então descobrir.
      whatsapp_conectado: sessao !== null,
    },
  });
}
