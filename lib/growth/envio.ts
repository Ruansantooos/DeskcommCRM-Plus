/**
 * Envio da mensagem aprovada (EPIC-14).
 *
 * NÃO implementa envio. Delega para `lib/automation`, que já resolve o que
 * importa e está provado em produção: janela de horário (7h-22h), limite diário
 * por sessão, espaçamento entre mensagens, jitter, contato bloqueado e telefone
 * ausente.
 *
 * Reimplementar qualquer uma dessas coisas aqui seria recriar o risco de
 * banimento que elas existem para evitar — e é explicitamente proibido pela
 * decisão locked 7 do epic.
 */
import {
  AUTOMATED_SEND_SPACING_MS,
  checkDailyLimit,
  jitterMs,
  nextWindowStart,
  withinSendWindow,
} from "@/lib/automation/throttle";
import { ensureConversation } from "@/lib/automation/start-conversation";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export type ResultadoEnvio =
  | { ok: true; messageId: string; conversationId: string }
  | { ok: false; motivo: string; detalhe: string; adiarAte?: string };

/**
 * Sessão de WhatsApp utilizável da organização.
 *
 * Devolve `null` quando não há nenhuma conectada — que é o estado normal de uma
 * instalação nova, e por isso é resposta de produto (a tela avisa), não exceção.
 */
export async function sessaoDisponivel(
  admin: Admin,
  orgId: string,
): Promise<{ id: string; status: string } | null> {
  const { data } = await admin
    .from("channel_sessions")
    .select("id, status")
    .eq("organization_id", orgId)
    .in("status", ["connected", "working", "WORKING"])
    .limit(1);

  return (data?.[0] as { id: string; status: string } | undefined) ?? null;
}

let ultimoEnvioEm = 0;

export async function enviarMensagemAprovada(
  admin: Admin,
  opts: {
    orgId: string;
    contactId: string;
    texto: string;
    requestId: string;
    userId: string;
  },
): Promise<ResultadoEnvio> {
  const sessao = await sessaoDisponivel(admin, opts.orgId);
  if (!sessao) {
    return {
      ok: false,
      motivo: "sem_sessao",
      detalhe:
        "Nenhum WhatsApp conectado. Conecte um número em Canais → Conexões antes de enviar.",
    };
  }

  // Janela de horário: mensagem comercial às 3h da manhã é denúncia certa, e
  // denúncia queima o número independentemente do espaçamento.
  if (!withinSendWindow()) {
    return {
      ok: false,
      motivo: "fora_da_janela",
      detalhe: "Fora do horário permitido para envio (7h às 22h).",
      adiarAte: nextWindowStart(),
    };
  }

  const limite = await checkDailyLimit(admin, opts.orgId, sessao.id);
  if (!limite.allowed) {
    return {
      ok: false,
      motivo: "limite_diario",
      detalhe: "Limite diário desta sessão foi atingido.",
      adiarAte: limite.retry_at ?? undefined,
    };
  }

  const { data: contato } = await admin
    .from("contacts")
    .select("id, phone_number, is_blocked")
    .eq("id", opts.contactId)
    .eq("organization_id", opts.orgId)
    .maybeSingle();

  const c = contato as { phone_number: string | null; is_blocked: boolean } | null;
  if (!c) return { ok: false, motivo: "sem_contato", detalhe: "Contato não encontrado." };
  if (c.is_blocked) {
    return { ok: false, motivo: "bloqueado", detalhe: "Este contato pediu para não ser contatado." };
  }
  if (!c.phone_number) {
    return {
      ok: false,
      motivo: "sem_telefone",
      detalhe: "Este contato não tem telefone. O canal conhecido é outro (Instagram, e-mail).",
    };
  }

  // Espaçamento entre envios do mesmo processo, com jitter. Cadência humana é
  // o que separa "empresa mandando mensagem" de "robô disparando lista".
  const desde = Date.now() - ultimoEnvioEm;
  const espera = AUTOMATED_SEND_SPACING_MS + jitterMs() - desde;
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));
  ultimoEnvioEm = Date.now();

  const conversationId = await ensureConversation(admin, opts.orgId, opts.contactId, sessao.id);

  // Ator do tipo "user", não "ai_agent": quem aprovou é gente, e o audit
  // precisa registrar a pessoa — foi ela que assumiu a mensagem.
  const msg = await sendMessageHandler(
    admin,
    {
      requestId: opts.requestId,
      organization_id: opts.orgId,
      actor: { type: "user", id: opts.userId },
    },
    { conversation_id: conversationId, type: "text", body: opts.texto },
  );

  return { ok: true, messageId: msg.id, conversationId };
}
