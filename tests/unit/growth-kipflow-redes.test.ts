import { describe, expect, it } from "vitest";

import { __testing } from "@/lib/growth/providers/kipflow";

/**
 * Caso REAL vindo da resposta da API (SOCILA LTDA, salão em BH): 22 URLs de
 * Instagram, quase todas de terceiros. Se o normalizador pegar a primeira, o
 * CRM grava o perfil errado e alguém manda mensagem para um desconhecido.
 */
const SOCILA_INSTAGRAM = [
  { url: "instagram.com/LaGranPollaMundialista" },
  { url: "instagram.com/afey.angelafey" },
  { url: "instagram.com/premiomaioresemelhores" },
  { url: "instagram.com/pousadapotiguar_" },
  { url: "instagram.com/denispb.ai" },
  { url: "instagram.com/finance_br" },
  { url: "instagram.com/teachercasals" },
  { url: "instagram.com/socilasalao" },
];

describe("melhorRede", () => {
  it("ignora perfis de terceiros e acha o handle que casa com o nome", () => {
    expect(__testing.melhorRede(SOCILA_INSTAGRAM, [null, "SOCILA LTDA"])).toBe(
      "instagram.com/socilasalao",
    );
  });

  it("prefere ausência a chute quando nenhum handle casa", () => {
    const alheios = [{ url: "instagram.com/finance_br" }, { url: "instagram.com/teachercasals" }];
    expect(__testing.melhorRede(alheios, ["SALAO XYZ LTDA"])).toBeNull();
  });

  it("aceita array de um item só, onde não há com o que comparar", () => {
    expect(
      __testing.melhorRede([{ url: "instagram.com/sigmaestetica" }], ["SIGMA ESTETICA LTDA"]),
    ).toBe("instagram.com/sigmaestetica");
  });

  it("casa ignorando acento e pontuação", () => {
    expect(
      __testing.melhorRede(
        [{ url: "instagram.com/outro" }, { url: "instagram.com/maisondobanho_" }],
        ["MAISON DO BANHO ESTETICA E BELEZA FEMININA LTDA"],
      ),
    ).toBe("instagram.com/maisondobanho_");
  });

  it("descarta site do contador e escolhe o de maior confiabilidade", () => {
    expect(
      __testing.melhorSite([
        { site: "contabilidade-xyz.com.br", confiabilidade: 1, pertence_contador: true },
        { site: "socila.com", confiabilidade: 0.42, pertence_contador: false },
        { site: "salaosocila.com.br", confiabilidade: 1, pertence_contador: false },
      ]),
    ).toBe("salaosocila.com.br");
  });
});
