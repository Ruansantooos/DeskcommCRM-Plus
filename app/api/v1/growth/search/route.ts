/**
 * POST /api/v1/growth/search — busca avulsa que GRAVA tudo o que encontra.
 *
 * A primeira versão devolvia o resultado sem persistir, para o operador
 * escolher o que importar. Estava errado: a requisição já foi paga e já
 * consumiu quota do plano mensal. Descartar o resultado joga fora dado
 * comprado, e um contato perdido não volta — a mesma busca amanhã custa de novo.
 *
 * Agora tudo o que a fonte devolve vira empresa + contato + card em "A triar".
 * A triagem acontece no Kanban, que é onde o operador trabalha, e não numa
 * lista de checkboxes antes de gravar. A etapa "A triar" existe exatamente
 * para isso.
 *
 * Duplicata continua sendo no-op: o índice único por (org, place_id) e por
 * (org, cnpj) garante que rebuscar a mesma cidade não polui a base.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  descobrir,
  fonteConfigurada,
  type EmpresaDescoberta,
} from "@/lib/growth/providers/discovery";
import { garantirFunilProspeccao, promoverParaFunil } from "@/lib/growth/promote";
import { audit } from "@/lib/audit";
import { KipflowError } from "@/lib/growth/providers/kipflow";
import { PlacesError } from "@/lib/growth/providers/places";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z.discriminatedUnion("fonte", [
  z.object({
    fonte: z.literal("places"),
    nicho: z.string().min(2, "Informe o que procurar."),
    cidade: z.string().min(2, "Informe a cidade."),
    raio_km: z.number().int().min(1).max(50).optional(),
    limite: z.number().int().min(1).max(50).optional(),
  }),
  z.object({
    fonte: z.literal("kipflow"),
    cnae: z.array(z.string()).max(10).optional(),
    uf: z.string().length(2).optional(),
    cidade: z.string().min(2).optional(),
    faixas_faturamento: z.array(z.string()).max(9).optional(),
    faixas_funcionarios: z.array(z.string()).max(9).optional(),
    porte: z.string().optional(),
    perfil_bairro: z.enum(["BAIXO", "MEDIO", "ALTO"]).optional(),
    optante_simples: z.boolean().optional(),
    somente_matriz: z.boolean().optional(),
    limite: z.number().int().min(1).max(50).optional(),
  }),
]);

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "growth_search" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

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
  const input = parsed.data;

  const status = fonteConfigurada(input.fonte);
  if (!status.configured) {
    return fail(
      "growth_provider_not_configured",
      `Esta busca precisa da variável ${status.missingEnv}, que não está configurada nesta instalação.`,
      422,
      { requestId, details: { missing_env: status.missingEnv } },
    );
  }

  let resultado;
  try {
    resultado =
      input.fonte === "places"
        ? await descobrir({
            fonte: "places",
            nicho: input.nicho,
            cidade: input.cidade,
            raio_km: input.raio_km,
            limite_por_execucao: input.limite ?? 25,
          })
        : await descobrir({
            fonte: "kipflow",
            cnae: input.cnae,
            uf: input.uf,
            cidade: input.cidade,
            faixas_faturamento: input.faixas_faturamento,
            faixas_funcionarios: input.faixas_funcionarios,
            porte: input.porte,
            perfil_bairro: input.perfil_bairro,
            optante_simples: input.optante_simples,
            somente_matriz: input.somente_matriz,
            limite_por_execucao: input.limite ?? 25,
          });
  } catch (e) {
    if (e instanceof PlacesError || e instanceof KipflowError) {
      return fail("upstream_unavailable", `A fonte respondeu: ${e.message}`, 502, { requestId });
    }
    return fail("internal_error", "Falha na busca.", 500, { requestId });
  }

  // ---- grava tudo ---------------------------------------------------------
  const admin = createAdminClient();
  const funil = await garantirFunilProspeccao(admin, org.orgId);

  let gravadas = 0;
  let jaConhecidas = 0;
  const falhas: string[] = [];
  const retorno: (EmpresaDescoberta & { ja_conhecida: boolean })[] = [];

  for (const e of resultado.empresas) {
    const { data, error } = await admin
      .from("growth_companies")
      .insert({
        // Do JWT, nunca do body — service role bypassa RLS.
        organization_id: org.orgId,
        place_id: e.place_id,
        cnpj: e.cnpj,
        name: e.name,
        razao_social: e.razao_social,
        address: e.address,
        city: e.city,
        phone: e.phone,
        category: e.category,
        cnae: e.cnae,
        faturamento_presumido_cents: e.faturamento_presumido_cents,
        linkedin_url: e.linkedin_url,
        lat: e.lat,
        lng: e.lng,
        source: e.source,
      })
      .select("id")
      .single();

    if (error) {
      // 23505 = já conhecemos. Rebuscar a mesma cidade não duplica nada.
      if (error.code === "23505") {
        jaConhecidas++;
        retorno.push({ ...e, ja_conhecida: true });
      } else {
        falhas.push(`${e.name}: ${error.message.slice(0, 70)}`);
      }
      continue;
    }

    gravadas++;
    retorno.push({ ...e, ja_conhecida: false });

    await admin.from("growth_enrichment").insert({
      organization_id: org.orgId,
      company_id: data.id,
      website_url: e.website,
      status: "pending",
    });

    // Falha ao promover não desfaz a gravação: a empresa está salva e
    // recuperável, e perder as outras 40 por causa de uma seria pior.
    try {
      await promoverParaFunil(admin, org.orgId, funil, {
        companyId: data.id,
        nome: e.name,
        telefone: e.phone,
        email: null,
        cidade: e.city,
        cnpj: e.cnpj,
        site: e.website,
      });
    } catch (err) {
      falhas.push(`${e.name}: ${err instanceof Error ? err.message.slice(0, 70) : "erro"}`);
    }
  }

  await audit({
    action: "growth_agent.created",
    actorUserId: authz.user.id,
    organizationId: org.orgId,
    resourceType: "growth_companies",
    requestId,
    metadata: { origem: "busca", fonte: input.fonte, gravadas, jaConhecidas },
  });

  return ok(retorno, {
    requestId,
    meta: {
      total: retorno.length,
      novas: gravadas,
      ja_conhecidas: jaConhecidas,
      requisicoes: resultado.requisicoes,
      custo_cents: resultado.custoCents,
      pipeline_id: funil.pipelineId,
      falhas,
    },
  });
}
