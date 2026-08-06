/**
 * Score IA da prospecção (EPIC-14).
 *
 * Usa módulo de provider direto com a credencial BYOK do tenant — o MESMO
 * caminho de `lib/ai/runtime/agent.ts`, e pelo mesmo motivo documentado lá: o
 * Vercel AI Gateway autentica o CHAMADOR com `AI_GATEWAY_API_KEY` e não aceita
 * a chave do tenant como substituta. Rotear por ele aqui falharia com
 * "Unauthenticated" em toda instalação que usa BYOK, que é o desenho do produto.
 *
 * Saída validada por Zod. Modelo que devolve JSON malformado é retentado uma
 * vez e depois falha — NUNCA se grava score parcial ou inventado: o verdict do
 * SDR sai daqui, e score falso vira lead falso vira mensagem para quem não devia.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type LanguageModel } from "ai";
import { z } from "zod";

import { loadCredential } from "@/lib/ai/credentials";

export const scoreOutputSchema = z.object({
  score: z.number().int().min(0).max(100),
  problems: z.array(z.string()).max(10),
  opportunities: z.array(z.string()).max(10),
  suggested_message: z.string().min(10).max(1200),
  next_action: z.string().max(200),
});

export type ScoreOutput = z.infer<typeof scoreOutputSchema>;

export interface ScoreInput {
  nome: string;
  cidade: string | null;
  categoria: string | null;
  site: string | null;
  /** null = não medido; false = medido e ausente. O modelo precisa distinguir. */
  temHttps: boolean | null;
  cms: string | null;
  temGa4: boolean | null;
  temPixel: boolean | null;
  seoScore: number | null;
  temBlog: boolean | null;
  temFormulario: boolean | null;
  instagram: string | null;
  statusAnalise: string | null;
}

function buildModel(provider: string, apiKey: string, modelId: string): LanguageModel {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId);
    default:
      throw new Error(`unsupported_provider: ${provider}`);
  }
}

const PROMPT_PADRAO = `Você analisa a presença digital de uma empresa e avalia o potencial dela como cliente de um serviço de marketing digital e automação de atendimento.

Responda SOMENTE com JSON válido, sem markdown, no formato:
{"score": 0-100, "problems": ["..."], "opportunities": ["..."], "suggested_message": "...", "next_action": "..."}

Critério do score: quanto MAIOR a carência digital combinada com sinais de que a empresa tem dinheiro e movimento, MAIOR o score. Empresa com site impecável e tudo instalado tem score BAIXO (não precisa de nós).

Regras para "suggested_message":
- Primeira mensagem de WhatsApp, em português do Brasil, no máximo 400 caracteres.
- Tom de gente, não de robô. Sem "Prezados", sem emoji em excesso, sem promessa de resultado.
- Cite UM problema concreto que você observou no diagnóstico. Nada genérico.
- Termine com uma pergunta simples e de baixo compromisso.

IMPORTANTE: campos marcados como "não medido" NÃO significam ausência. Não afirme que a empresa não tem algo que você não mediu.`;

function descrever(v: boolean | null, sim: string, nao: string): string {
  if (v === null) return "não medido";
  return v ? sim : nao;
}

export function montarPayload(input: ScoreInput): string {
  return [
    `Empresa: ${input.nome}`,
    `Cidade: ${input.cidade ?? "desconhecida"}`,
    `Categoria: ${input.categoria ?? "desconhecida"}`,
    `Site: ${input.site ?? "NÃO POSSUI SITE"}`,
    input.statusAnalise && input.statusAnalise !== "completed"
      ? `Análise do site: não concluída (${input.statusAnalise}) — trate os itens abaixo como não medidos`
      : null,
    `HTTPS: ${descrever(input.temHttps, "sim", "não")}`,
    `Plataforma do site: ${input.cms ?? "não identificada"}`,
    `Google Analytics 4: ${descrever(input.temGa4, "instalado", "ausente")}`,
    `Meta Pixel: ${descrever(input.temPixel, "instalado", "ausente")}`,
    `SEO básico (título/descrição/H1): ${input.seoScore === null ? "não medido" : `${input.seoScore}/100`}`,
    `Blog: ${descrever(input.temBlog, "sim", "não")}`,
    `Formulário de contato: ${descrever(input.temFormulario, "sim", "não")}`,
    `Instagram: ${input.instagram ?? "não encontrado"}`,
    "",
    "Desempenho e responsividade NÃO foram medidos nesta versão — não comente sobre eles.",
  ]
    .filter(Boolean)
    .join("\n");
}

function extrairJson(texto: string): unknown {
  // Modelos costumam embrulhar em ```json apesar da instrução.
  const limpo = texto.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const inicio = limpo.indexOf("{");
  const fim = limpo.lastIndexOf("}");
  if (inicio < 0 || fim < inicio) throw new Error("sem_json_na_resposta");
  return JSON.parse(limpo.slice(inicio, fim + 1));
}

export async function pontuar(opts: {
  credentialId: string;
  organizationId: string;
  modelId: string;
  promptCustomizado?: string;
  input: ScoreInput;
}): Promise<{ output: ScoreOutput; modelUsed: string }> {
  const cred = await loadCredential(opts.credentialId, opts.organizationId);
  const model = buildModel(cred.provider, cred.apiKey, opts.modelId);
  const system = opts.promptCustomizado?.trim() || PROMPT_PADRAO;
  const payload = montarPayload(opts.input);

  let ultimoErro: unknown;
  // Uma retentativa. Mais que isso vira dinheiro queimado num modelo que
  // claramente não está seguindo o formato.
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const res = await generateText({
        model,
        system,
        prompt: payload,
        temperature: tentativa === 0 ? 0.4 : 0.1,
      });
      const parsed = scoreOutputSchema.parse(extrairJson(res.text));
      return { output: parsed, modelUsed: `${cred.provider}/${opts.modelId}` };
    } catch (e) {
      ultimoErro = e;
    }
  }

  throw new Error(
    `score_invalido: ${ultimoErro instanceof Error ? ultimoErro.message : String(ultimoErro)}`,
  );
}
