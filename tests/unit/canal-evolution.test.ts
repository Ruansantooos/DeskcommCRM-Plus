import { describe, expect, it } from "vitest";

import { evolutionAdapter } from "@/lib/channels/adapters/evolution";
import { capabilitiesOf } from "@/lib/channels/capabilities";

describe("adapter Evolution", () => {
  it("resolve telefone a partir de wa_identity, sem + e sem sufixo", () => {
    expect(
      evolutionAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: "phone:+553199887766",
      }),
    ).toBe("553199887766");
  });

  it("cai para phone_number quando não há wa_identity", () => {
    expect(
      evolutionAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "+55 (31) 99988-7766",
        waIdentity: null,
      }),
      // 13 dígitos: DDI 55 + DDD 31 + celular de 9 dígitos.
    ).toBe("5531999887766");
  });

  it("recusa identidade lid: não é endereçável neste canal", () => {
    expect(
      evolutionAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: "lid:123456789",
      }),
    ).toBeNull();
  });

  it("entrega o JID do grupo como veio", () => {
    expect(
      evolutionAdapter.resolveRecipient({
        isGroup: true,
        groupChatId: "12036304@g.us",
        phoneNumber: null,
        waIdentity: null,
      }),
    ).toBe("12036304@g.us");
  });

  it("sem contato endereçável devolve null em vez de string vazia", () => {
    expect(
      evolutionAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: null,
      }),
    ).toBeNull();
  });

  /**
   * A guarda que mais importa: Evolution é WhatsApp NÃO-OFICIAL. Se alguém
   * copiar o perfil do meta_cloud aqui, o throttle/warm-up/cap desarma e o
   * número do dono queima sem aviso.
   */
  it("declara risco de banimento, como o WAHA", () => {
    expect(capabilitiesOf("evolution").banRisk).toBe(true);
    expect(capabilitiesOf("evolution").requiresTemplates).toBe(false);
    expect(capabilitiesOf("evolution").costPerMessage).toBe(false);
  });

  it("reconhece o eco do próprio envio nas formas que o canal usa", () => {
    const formas = evolutionAdapter.echoExternalIds!({
      externalId: "ABC123",
      recipient: "553199887766",
    });
    expect(formas).toContain("ABC123");
    expect(formas).toContain("553199887766@s.whatsapp.net_ABC123");
  });
});
