/**
 * Validação dos agentes de prospecção (EPIC-14, S-14.02).
 *
 * `params` é jsonb, mas NÃO é saco sem fundo: cada `kind` tem contrato próprio,
 * validado na escrita. Sem isto, o erro de configuração só apareceria no meio de
 * um run — depois de já ter gasto quota de API paga.
 *
 * O mesmo schema serve o servidor e o formulário (S-14.07): uma fonte, duas
 * validações. Divergir os dois é como um form aceita o que a API recusa.
 */
import { z } from "zod";

export const GROWTH_AGENT_KINDS = [
  "maps",
  "enrichment",
  "website_analyzer",
  "meta_ads",
  "score",
  "sdr",
] as const;

export type GrowthAgentKind = (typeof GROWTH_AGENT_KINDS)[number];

/** Rótulos de UI — vocabulário do módulo mora aqui, não espalhado em JSX. */
export const GROWTH_AGENT_LABELS: Record<GrowthAgentKind, { nome: string; faz: string }> = {
  maps: { nome: "Maps", faz: "Descobre empresas por nicho e cidade" },
  enrichment: { nome: "Enriquecimento", faz: "Procura site, redes sociais, WhatsApp e e-mail" },
  website_analyzer: { nome: "Análise de site", faz: "Diagnostica maturidade digital do site" },
  meta_ads: { nome: "Meta Ads", faz: "Verifica se a empresa anuncia" },
  score: { nome: "Score (IA)", faz: "Pontua a empresa e sugere abordagem" },
  sdr: { nome: "SDR", faz: "Decide o que vira lead no funil" },
};

// ---------------------------------------------------------------------------
// params por kind
// ---------------------------------------------------------------------------

/**
 * Duas fontes de descoberta, dois contratos de parâmetro.
 *
 * Places busca por geografia (nicho + cidade + raio) e acha negócio com
 * fachada. Kipflow busca por cadastro (CNAE + UF + faturamento) e acha empresa
 * com CNPJ ativo. Não são a mesma busca com qualidade diferente — por isso os
 * formulários são diferentes, e não um com campos opcionais.
 */
const mapsParams = z.discriminatedUnion("fonte", [
  z.object({
    fonte: z.literal("places"),
    nicho: z.string().min(2, "Informe o nicho (ex.: clínica odontológica)."),
    cidade: z.string().min(2, "Informe a cidade."),
    raio_km: z.number().int().min(1).max(50).default(10),
    // Teto POR EXECUÇÃO, não por dia: a cadeia roda dentro de um request HTTP,
    // e cada empresa custa um fetch de site mais uma chamada de IA.
    limite_por_execucao: z.number().int().min(1).max(50).default(25),
  }),
  z.object({
    fonte: z.literal("kipflow"),
    cnae: z.array(z.string()).max(10).optional(),
    uf: z.string().length(2, "UF tem 2 letras.").optional(),
    cidade: z.string().min(2).optional(),
    faturamento_min_cents: z.number().int().min(0).optional(),
    faturamento_max_cents: z.number().int().min(0).optional(),
    datasets: z.array(z.string()).max(10).optional(),
    // A Kipflow cobra por quota mensal de requisições. Este número é o que
    // impede queimar o mês numa tarde de testes.
    limite_por_execucao: z.number().int().min(1).max(50).default(25),
  }),
]);

const enrichmentParams = z.object({
  provider: z.enum(["heuristic"]).default("heuristic"),
});

const websiteAnalyzerParams = z.object({
  probe: z.enum(["html-fetch"]).default("html-fetch"),
  respeitar_robots: z.literal(true).default(true),
});

const metaAdsParams = z.object({
  recheck_horas: z.number().int().min(1).max(720).default(24),
});

const scoreParams = z.object({
  provider_model: z.string().min(3, 'Formato "provider/model".'),
  prompt: z.string().optional(),
  barrier_timeout_min: z.number().int().min(1).max(1440).default(30),
});

const sdrParams = z
  .object({
    // Decisão locked D-04: threshold vive aqui, na row do agente — não em
    // settings da org nem no pipeline.
    score_hot: z.number().int().min(0).max(100).default(70),
    score_cold: z.number().int().min(0).max(100).default(40),
    pipeline_id: z.string().uuid("Escolha o funil de destino."),
    stage_id: z.string().uuid("Escolha a etapa de destino."),
    review_days: z.number().int().min(1).max(365).default(60),
  })
  .refine((p) => p.score_cold < p.score_hot, {
    message: "O limite de lead frio precisa ser menor que o de lead quente.",
    path: ["score_cold"],
  });

const PARAMS_BY_KIND = {
  maps: mapsParams,
  enrichment: enrichmentParams,
  website_analyzer: websiteAnalyzerParams,
  meta_ads: metaAdsParams,
  score: scoreParams,
  sdr: sdrParams,
} as const;

export function paramsSchemaFor(kind: GrowthAgentKind) {
  return PARAMS_BY_KIND[kind];
}

// ---------------------------------------------------------------------------
// corpo das requisições
// ---------------------------------------------------------------------------

const baseFields = {
  name: z.string().min(2).max(80),
  schedule_cron: z.string().max(120).nullable().optional(),
  is_active: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
};

/** Discriminated union: `params` é validado conforme o `kind` declarado. */
export const growthAgentCreateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("maps"), ...baseFields, params: mapsParams }),
  z.object({ kind: z.literal("enrichment"), ...baseFields, params: enrichmentParams }),
  z.object({ kind: z.literal("website_analyzer"), ...baseFields, params: websiteAnalyzerParams }),
  z.object({ kind: z.literal("meta_ads"), ...baseFields, params: metaAdsParams }),
  z.object({ kind: z.literal("score"), ...baseFields, params: scoreParams }),
  z.object({ kind: z.literal("sdr"), ...baseFields, params: sdrParams }),
]);

export type GrowthAgentCreate = z.infer<typeof growthAgentCreateSchema>;

/** PATCH não deixa trocar `kind`: mudaria o contrato de `params` embaixo. */
export const growthAgentUpdateSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  schedule_cron: z.string().max(120).nullable().optional(),
  is_active: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Providers externos por kind, e a env que os habilita.
 *
 * Ausência de env NÃO é erro de código — é o estado normal de um primeiro
 * deploy. A API responde 422 nomeando a variável, e a UI mostra o agente como
 * "não configurado" em vez de um botão que leva a erro.
 */
export const REQUIRED_ENV_BY_KIND: Partial<Record<GrowthAgentKind, string>> = {
  meta_ads: "META_AD_LIBRARY_TOKEN",
};

/**
 * Para o agente de busca a env depende da FONTE escolhida, não do kind — por
 * isso ele fica fora do mapa acima. Um agente Kipflow não deve aparecer como
 * "não configurado" só porque falta a chave do Google.
 */
export const ENV_BY_FONTE: Record<string, string> = {
  places: "GOOGLE_PLACES_API_KEY",
  kipflow: "KIPFLOW_API_KEY",
};

export const FONTE_LABELS: Record<string, { nome: string; acha: string }> = {
  places: {
    nome: "Google Maps",
    acha: "Negócio com fachada e ponto físico — a clínica da esquina, a loja do bairro. Busca por nicho e região.",
  },
  kipflow: {
    nome: "Kipflow",
    acha: "Empresa com CNPJ ativo e cadastro completo — sócios, faturamento presumido, LinkedIn. Busca por CNAE, estado e porte.",
  },
};
