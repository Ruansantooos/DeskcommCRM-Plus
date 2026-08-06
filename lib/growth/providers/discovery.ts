/**
 * Descoberta de empresas — a etapa 1 do pipeline de prospecção (EPIC-14).
 *
 * Places e Kipflow são fontes IRMÃS, não uma o fallback da outra. Elas acham
 * recortes diferentes do mercado:
 *
 *   Places  — busca geográfica. Acha o negócio com fachada e ponto físico:
 *             a barbearia do bairro, a clínica da esquina. Chave: place_id.
 *   Kipflow — busca cadastral. Acha a empresa com CNPJ ativo e dado rico:
 *             o e-commerce com faturamento presumido de R$ 5M, tenha loja ou
 *             não. Chave: CNPJ.
 *
 * Tratá-las como "principal e fallback" faria o operador achar que está
 * recebendo a mesma lista com qualidade menor quando na verdade está recebendo
 * um mercado diferente. Por isso a fonte é escolha explícita do agente.
 */
import {
  ConsumoKipflow,
  buscarEmpresasComFiltros,
  cnaeParaNumero,
  kipflowConfigured,
} from "@/lib/growth/providers/kipflow";
import { placesConfigured, searchPlaces } from "@/lib/growth/providers/places";

export type FonteDescoberta = "places" | "kipflow";

/** Modelo comum. Campos que uma fonte não fornece vêm `null` — nunca inventados. */
export interface EmpresaDescoberta {
  place_id: string | null;
  cnpj: string | null;
  name: string;
  razao_social: string | null;
  address: string | null;
  city: string | null;
  phone: string | null;
  website: string | null;
  category: string | null;
  cnae: string | null;
  faturamento_presumido_cents: number | null;
  /**
   * Canais sociais. Para comércio local costumam ser o ÚNICO caminho — 66% não
   * têm site. Estes campos existiam no normalizador da Kipflow mas NÃO nesta
   * interface, então eram extraídos e descartados uma camada depois: 0 de 102
   * empresas ficaram com Instagram mesmo quando a API o devolveu.
   */
  instagram_url: string | null;
  facebook_url: string | null;
  twitter_url: string | null;
  linkedin_url: string | null;
  /** Tudo o que a fonte devolveu, inclusive o descartado pelo casamento por nome. */
  redes_candidatas: Record<string, string[]>;
  lat: number | null;
  lng: number | null;
  source: "maps_agent" | "kipflow_agent";
}

export interface ParamsPlaces {
  fonte: "places";
  nicho: string;
  cidade: string;
  raio_km?: number;
  limite_por_execucao?: number;
}

export interface ParamsKipflow {
  fonte: "kipflow";
  /** CNAE como o usuário digita: "6911-7/01". A conversão é interna. */
  cnae?: string[];
  /** Sigla ("MG") ou por extenso — normalizado aqui. */
  uf?: string;
  cidade?: string;
  faixas_faturamento?: string[];
  faixas_funcionarios?: string[];
  porte?: string;
  perfil_bairro?: string;
  optante_simples?: boolean;
  somente_matriz?: boolean;
  limite_por_execucao?: number;
  datasets?: string[];
}

/**
 * A Kipflow filtra `uf` pelo nome por extenso e em maiúsculas ("MINAS GERAIS").
 * Ninguém digita assim — e uma sigla passada direto devolve zero resultado em
 * silêncio, que é o pior modo de falha possível numa busca.
 */
const UF_POR_EXTENSO: Record<string, string> = {
  AC: "ACRE",
  AL: "ALAGOAS",
  AP: "AMAPA",
  AM: "AMAZONAS",
  BA: "BAHIA",
  CE: "CEARA",
  DF: "DISTRITO FEDERAL",
  ES: "ESPIRITO SANTO",
  GO: "GOIAS",
  MA: "MARANHAO",
  MT: "MATO GROSSO",
  MS: "MATO GROSSO DO SUL",
  MG: "MINAS GERAIS",
  PA: "PARA",
  PB: "PARAIBA",
  PR: "PARANA",
  PE: "PERNAMBUCO",
  PI: "PIAUI",
  RJ: "RIO DE JANEIRO",
  RN: "RIO GRANDE DO NORTE",
  RS: "RIO GRANDE DO SUL",
  RO: "RONDONIA",
  RR: "RORAIMA",
  SC: "SANTA CATARINA",
  SP: "SAO PAULO",
  SE: "SERGIPE",
  TO: "TOCANTINS",
};

function normalizarUf(uf: string | undefined): string | undefined {
  if (!uf) return undefined;
  const limpo = uf.trim().toUpperCase();
  return limpo.length === 2 ? (UF_POR_EXTENSO[limpo] ?? limpo) : limpo;
}

export type ParamsDescoberta = ParamsPlaces | ParamsKipflow;

export interface ResultadoDescoberta {
  empresas: EmpresaDescoberta[];
  requisicoes: number;
  custoCents: number;
}

export function fonteConfigurada(fonte: FonteDescoberta): {
  configured: boolean;
  missingEnv: string | null;
} {
  if (fonte === "kipflow") {
    return kipflowConfigured()
      ? { configured: true, missingEnv: null }
      : { configured: false, missingEnv: "KIPFLOW_API_KEY" };
  }
  return placesConfigured()
    ? { configured: true, missingEnv: null }
    : { configured: false, missingEnv: "GOOGLE_PLACES_API_KEY" };
}

export async function descobrir(params: ParamsDescoberta): Promise<ResultadoDescoberta> {
  // Teto por execução, não por dia: a cadeia roda dentro de um request, e o
  // plano da Kipflow é quota mensal — queimar o mês numa tarde de testes é o
  // acidente que este número evita.
  const limite = Math.max(1, Math.min(params.limite_por_execucao ?? 25, 50));

  if (params.fonte === "places") {
    const achados = await searchPlaces({
      nicho: params.nicho,
      cidade: params.cidade,
      raioKm: params.raio_km ?? 10,
      limite,
    });

    return {
      // O Places não devolve CNPJ nem dado cadastral. Fica `null` — a ausência
      // é informação real, e o Score sabe distinguir "não tem" de "não medido".
      empresas: achados.map((p) => ({
        place_id: p.place_id,
        cnpj: null,
        name: p.name,
        razao_social: null,
        address: p.address,
        // A cidade vem do parâmetro buscado: o Places devolve endereço
        // formatado, e extrair cidade dele por regex erraria fora do padrão.
        city: params.cidade,
        phone: p.phone,
        website: p.website,
        category: p.category,
        cnae: null,
        faturamento_presumido_cents: null,
        // O Places não devolve rede social como campo próprio. Fica null — e
        // é o analisador de site que costuma achá-las no HTML.
        instagram_url: null,
        facebook_url: null,
        twitter_url: null,
        linkedin_url: null,
        redes_candidatas: {},
        lat: p.lat,
        lng: p.lng,
        source: "maps_agent" as const,
      })),
      // O Places cobra, mas não informa o custo na resposta — só dá para contar
      // requisição. Custo fica 0 em vez de uma estimativa inventada.
      requisicoes: 1,
      custoCents: 0,
    };
  }

  const consumo = new ConsumoKipflow();

  // O usuário digita "6911-7/01"; a API espera 6911701. Converter aqui e não na
  // UI mantém o formato humano na tela e o formato da API no adapter.
  const codigos = (params.cnae ?? [])
    .map((c) => cnaeParaNumero(c))
    .filter((n): n is number => n !== null);

  const achados = await buscarEmpresasComFiltros(
    {
      // 7 dígitos = subclasse (mais específico), 5 = classe (mais abrangente).
      ...(codigos[0] && String(codigos[0]).length >= 7
        ? { cnaeSubclasse: codigos[0] }
        : codigos[0]
          ? { cnaeClasse: codigos[0] }
          : {}),
      uf: normalizarUf(params.uf),
      municipio: params.cidade,
      faixasFaturamento: params.faixas_faturamento,
      faixasFuncionarios: params.faixas_funcionarios,
      porte: params.porte,
      perfilBairro: params.perfil_bairro,
      optanteSimples: params.optante_simples,
      somenteMatriz: params.somente_matriz,
      limite,
      // MEDIDO contra a API em 2026-08-05, amostra de 5 escritórios de
      // advocacia em BH (CNAE 6911-7/01):
      //
      //   basic+address+online_presence  R$ 0,60 / 5 empresas  (R$ 0,12 cada)
      //   + complete                     R$ 1,70 / 5 empresas  (R$ 0,34 cada)
      //
      // O que `complete` acrescentou: faturamento em 5/5.
      // O que NÃO acrescentou: telefone em 0/5 e e-mail em 0/5.
      //
      // Ou seja: a Kipflow frequentemente NÃO tem o telefone da empresa. O
      // canal de contato vem do site (o analisador acha `wa.me` e `mailto:`),
      // e é por isso que `online_presence` é obrigatório aqui e `complete` é
      // opt-in — pagar 2,8x por faturamento presumido é decisão do operador,
      // não default silencioso.
      datasets: params.datasets ?? ["basic", "address", "online_presence"],
    },
    consumo,
  );

  return {
    empresas: achados.map((e) => ({
      place_id: null,
      cnpj: e.cnpj,
      name: e.nome_fantasia ?? e.razao_social ?? "(sem nome)",
      razao_social: e.razao_social,
      address: e.endereco,
      city: e.cidade ?? params.cidade ?? null,
      phone: e.telefone,
      website: e.site,
      category: e.cnae,
      cnae: e.cnae,
      faturamento_presumido_cents: e.faturamento_presumido_cents,
      instagram_url: e.instagram_url,
      facebook_url: e.facebook_url,
      twitter_url: e.twitter_url,
      linkedin_url: e.linkedin_url,
      redes_candidatas: e.redes_candidatas,
      lat: e.lat,
      lng: e.lng,
      source: "kipflow_agent" as const,
    })),
    requisicoes: consumo.requisicoes,
    custoCents: consumo.custoCents,
  };
}
