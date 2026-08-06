/**
 * POST /api/v1/growth/approvals/:id — aprova (e envia) ou rejeita.
 *
 * Body: `{ "acao": "aprovar", "mensagem": "..." }` ou `{ "acao": "rejeitar" }`.
 *
 * A mensagem final vem do BODY, não do rascunho: o humano pode ter editado, e
 * enviar o rascunho quando ele editou seria ignorar exatamente a revisão que
 * justifica este gate existir.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { enviarMensagemAprovada } from "@/lib/growth/envio";

export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("acao", [
  z.object({
    acao: z.literal("aprovar"),
    // Teto de 900: mensagem fria longa não é lida e aumenta chance de denúncia.
    mensagem: z.string().min(10, "Mensagem muito curta.").max(900),
  }),
  z.object({ acao: z.literal("rejeitar"), motivo: z.string().max(300).optional() }),
]);

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "growth_approvals" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();

  const { data: decisao } = await admin
    .from("growth_sdr_decisions")
    .select("id, company_id, approval_status")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();

  if (!decisao) return fail("not_found", "Item não encontrado.", 404, { requestId });

  // Só o que está esperando pode ser decidido. Reenviar o que já saiu é o
  // acidente clássico do duplo-clique, e no WhatsApp custa reputação.
  if (decisao.approval_status !== "pending") {
    return fail(
      "invalid_state",
      `Este item já está como "${decisao.approval_status}".`,
      409,
      { requestId },
    );
  }

  // ---- rejeitar -----------------------------------------------------------
  if (parsed.data.acao === "rejeitar") {
    await admin
      .from("growth_sdr_decisions")
      .update({
        approval_status: "rejected",
        approved_by_user_id: user.id,
        approved_at: new Date().toISOString(),
      })
      .eq("id", id);

    await audit({
      action: "growth_agent.updated",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "growth_sdr_decisions",
      resourceId: id,
      requestId,
      metadata: { acao: "rejeitado", motivo: parsed.data.motivo ?? null },
    });

    return ok({ id, approval_status: "rejected" }, { requestId });
  }

  // ---- aprovar e enviar ---------------------------------------------------
  const { data: lead } = await admin
    .from("crm_leads")
    .select("contact_id")
    .eq("organization_id", org.orgId)
    .eq("source_company_id", decisao.company_id)
    .maybeSingle();

  const contactId = lead?.contact_id as string | null | undefined;
  if (!contactId) {
    return fail("invalid_state", "Este lead não tem contato associado.", 409, { requestId });
  }

  const envio = await enviarMensagemAprovada(admin, {
    orgId: org.orgId,
    contactId,
    texto: parsed.data.mensagem,
    requestId,
    userId: user.id,
  });

  if (!envio.ok) {
    // Falha de envio NÃO consome a aprovação: o item volta para a fila para ser
    // reenviado quando a causa (janela, limite, sessão) passar. Marcar como
    // 'failed' aqui esconderia o lead até alguém investigar manualmente.
    await admin
      .from("growth_sdr_decisions")
      .update({ send_error: `${envio.motivo}: ${envio.detalhe}`.slice(0, 400) })
      .eq("id", id);

    return fail("upstream_unavailable", envio.detalhe, 409, {
      requestId,
      details: { motivo: envio.motivo, adiar_ate: envio.adiarAte ?? null },
    });
  }

  await admin
    .from("growth_sdr_decisions")
    .update({
      approval_status: "sent",
      message_final: parsed.data.mensagem,
      approved_by_user_id: user.id,
      approved_at: new Date().toISOString(),
      sent_at: new Date().toISOString(),
      send_error: null,
    })
    .eq("id", id);

  // O card sai de "A triar" e vai para "Contactado": o Kanban precisa refletir
  // o que aconteceu, senão o operador reabordaria a mesma empresa.
  const { data: etapa } = await admin
    .from("crm_stages")
    .select("id, crm_pipelines!inner(slug)")
    .eq("organization_id", org.orgId)
    .eq("crm_pipelines.slug", "prospeccao")
    .eq("slug", "contactado")
    .maybeSingle();

  if (etapa?.id) {
    await admin
      .from("crm_leads")
      .update({ stage_id: etapa.id, last_activity_at: new Date().toISOString() })
      .eq("organization_id", org.orgId)
      .eq("source_company_id", decisao.company_id);
  }

  await audit({
    action: "growth_agent.updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "growth_sdr_decisions",
    resourceId: id,
    requestId,
    metadata: { acao: "aprovado_e_enviado", message_id: envio.messageId },
  });

  return ok(
    { id, approval_status: "sent", message_id: envio.messageId, conversation_id: envio.conversationId },
    { requestId },
  );
}
