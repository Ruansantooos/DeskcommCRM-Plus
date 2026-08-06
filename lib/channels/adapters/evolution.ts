/**
 * Adapter do Evolution API (WhatsApp não-oficial, self-host).
 *
 * Existe para quem já roda Evolution não precisar subir um WAHA só para usar o
 * CRM. É tradutor de formato e NADA MAIS: janela de 24h, cap diário, horário
 * comercial, throttle e retry continuam na cadeia `before_send`. Um `if` de
 * negócio aqui dentro é exatamente o defeito que
 * `docs/doctrine/restricao-de-canal.md` existe para evitar.
 *
 * Contrato do Evolution v2 (o que este arquivo assume):
 *   POST {base}/message/sendText/{instance}   header `apikey`
 *        body { number, text }
 *   POST {base}/message/sendMedia/{instance}
 *        body { number, mediatype, media, caption?, fileName? }
 *   resposta: { key: { id, remoteJid, fromMe }, ... }
 */
import { env } from "@/lib/env";
import type {
  ChannelAdapter,
  OutboundEnvelope,
  OutboundKind,
  RecipientInput,
} from "@/lib/channels/types";

const TIMEOUT_MS = 20_000;

function base(): string | null {
  const u = env.EVOLUTION_API_URL.trim().replace(/\/+$/, "");
  return u.length > 0 ? u : null;
}

function chave(): string | null {
  const k = env.EVOLUTION_API_KEY.trim();
  return k.length > 0 ? k : null;
}

/**
 * Endereço do Evolution: dígitos puros com DDI, sem `+` e sem sufixo de JID.
 * A API aceita tanto `5531999999999` quanto o JID completo; usar só os dígitos
 * evita depender de qual variante a versão instalada normaliza.
 */
function soDigitos(valor: string): string {
  return valor.replace(/\D/g, "");
}

/** `image` | `video` | `document` — o vocabulário do Evolution para mídia. */
function mediatypeDe(kind: OutboundKind): "image" | "video" | "document" | "audio" | null {
  switch (kind) {
    case "image":
      return "image";
    case "video":
      return "video";
    // Nota de áudio e áudio comum são o mesmo `audio` no vocabulário de saída
    // (ver OutboundKind); o Evolution converte no servidor de qualquer forma.
    case "audio":
      return "audio";
    case "document":
      return "document";
    default:
      return null;
  }
}

async function postar(caminho: string, corpo: unknown): Promise<Response> {
  const url = `${base()}${caminho}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        // Header, nunca query string: chave em URL vaza em log de proxy.
        apikey: chave() ?? "",
        "content-type": "application/json",
      },
      body: JSON.stringify(corpo),
    });
  } finally {
    clearTimeout(timer);
  }
}

/** `{ key: { id } }` é a forma documentada; as demais são tolerância a versão. */
function extrairId(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const j = json as Record<string, unknown>;

  const key = j.key as { id?: unknown } | undefined;
  if (typeof key?.id === "string" && key.id) return key.id;
  if (typeof j.id === "string" && j.id) return j.id;

  const msg = j.message as { key?: { id?: unknown } } | undefined;
  if (typeof msg?.key?.id === "string" && msg.key.id) return msg.key.id;

  return null;
}

export const evolutionAdapter: ChannelAdapter = {
  provider: "evolution",

  resolveRecipient(input: RecipientInput): string | null {
    if (input.isGroup) {
      // Grupo no Evolution é o próprio JID `...@g.us`, entregue como veio.
      return input.groupChatId ?? null;
    }

    // `wa_identity` no formato 'phone:+E164' é a fonte preferida (migration
    // 0027); `lid:` não é endereçável neste canal.
    const ident = input.waIdentity;
    if (ident?.startsWith("phone:")) {
      const d = soDigitos(ident.slice(6));
      return d.length >= 10 ? d : null;
    }

    if (input.phoneNumber) {
      const d = soDigitos(input.phoneNumber);
      return d.length >= 10 ? d : null;
    }

    return null;
  },

  isConfigured(): boolean {
    return base() !== null && chave() !== null;
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    // Sem env configurada é NOOP, não exceção — mesmo contrato do WAHA: a UI
    // mostra o canal como não conectado em vez de estourar no meio do envio.
    if (!this.isConfigured()) return { externalId: null };

    const instancia = encodeURIComponent(envelope.sessionRef);
    const media = envelope.media;
    const mediatype = media ? mediatypeDe(envelope.kind) : null;

    const res =
      media && mediatype
        ? await postar(`/message/sendMedia/${instancia}`, {
            number: envelope.to,
            mediatype,
            media: media.url,
            ...(media.caption ? { caption: media.caption } : {}),
            ...(media.filename ? { fileName: media.filename } : {}),
          })
        : await postar(`/message/sendText/${instancia}`, {
            number: envelope.to,
            text: envelope.body ?? "",
          });

    if (!res.ok) {
      const detalhe = await res.text().catch(() => "");
      throw new Error(`evolution_http_${res.status}: ${detalhe.slice(0, 200)}`);
    }

    const json: unknown = await res.json().catch(() => null);
    return { externalId: extrairId(json) };
  },

  codes: {
    notConfigured: "evolution_not_configured",
    sendFailed: "evolution_send_failed",
    unknownError: "evolution_unknown_error",
  },

  /**
   * O Evolution devolve o id "cru" no envio e, no webhook do eco, às vezes o
   * mesmo id prefixado pelo JID do destinatário. Comparar as duas strings
   * direto nunca casaria, e o eco viraria mensagem duplicada na conversa.
   */
  echoExternalIds({ externalId, recipient }): string[] {
    const digitos = soDigitos(recipient);
    return [
      externalId,
      `${digitos}@s.whatsapp.net_${externalId}`,
      `true_${digitos}@s.whatsapp.net_${externalId}`,
    ];
  },
};
