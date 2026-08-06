/**
 * POST /api/v1/growth/companies/import — grava as empresas escolhidas na busca
 * avulsa.
 *
 * Segundo passo explícito do fluxo manual: o operador viu, escolheu, e só
 * então a base é tocada. Duplicata não é erro — é a guarda de unicidade
 * fazendo o trabalho dela, e volta contada em vez de derrubar a importação.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { garantirFunilProspeccao, promoverParaFunil } from "@/lib/growth/promote";

export const dynamic = "force-dynamic";

const empresaSchema = z
  .object({
    place_id: z.string().nullable().optional(),
    cnpj: z.string().nullable().optional(),
    name: z.string().min(1),
    razao_social: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    website: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    cnae: z.string().nullable().optional(),
    faturamento_presumido_cents: z.number().int().nullable().optional(),
    linkedin_url: z.string().nullable().optional(),
    lat: z.number().nullable().optional(),
    lng: z.number().nullable().optional(),
    source: z.enum(["maps_agent", "kipflow_agent", "manual", "import"]),
  })
  // Espelha o CHECK do banco. Barrar aqui devolve mensagem legível em vez de um
  // 23514 cru vindo do Postgres.
  .refine((e) => !!e.place_id || !!e.cnpj, {
    message: "Empresa sem place_id nem CNPJ não pode ser importada.",
  });

const bodySchema = z.object({ empresas: z.array(empresaSchema).min(1).max(50) });

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "growth_companies" });
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
    return fail("validation_failed", "Empresas inválidas.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();

  // Funil de triagem criado sob demanda: importar é o primeiro uso do módulo, e
  // exigir configuração de funil antes disso seria uma porta fechada.
  const funil = await garantirFunilProspeccao(admin, org.orgId);

  let importadas = 0;
  let duplicadas = 0;
  let promovidas = 0;
  const erros: string[] = [];
  const ids: string[] = [];

  for (const e of parsed.data.empresas) {
    const { data, error } = await admin
      .from("growth_companies")
      .insert({
        // organization_id vem do JWT do chamador, NUNCA do body — service role
        // bypassa RLS, então este é o único ponto que garante o isolamento.
        organization_id: org.orgId,
        place_id: e.place_id ?? null,
        cnpj: e.cnpj ?? null,
        name: e.name,
        razao_social: e.razao_social ?? null,
        address: e.address ?? null,
        city: e.city ?? null,
        phone: e.phone ?? null,
        category: e.category ?? null,
        cnae: e.cnae ?? null,
        faturamento_presumido_cents: e.faturamento_presumido_cents ?? null,
        linkedin_url: e.linkedin_url ?? null,
        lat: e.lat ?? null,
        lng: e.lng ?? null,
        source: e.source,
      })
      .select("id")
      .single();

    if (error) {
      if (error.code === "23505") {
        duplicadas++;
        continue;
      }
      return fail("internal_error", `Erro ao importar ${e.name}.`, 500, { requestId });
    }

    importadas++;
    ids.push(data.id);

    await admin.from("growth_enrichment").insert({
      organization_id: org.orgId,
      company_id: data.id,
      website_url: e.website ?? null,
      status: "pending",
    });

    // Contato + card no Kanban. Falha aqui NÃO desfaz a importação: a empresa
    // já está gravada e é recuperável, enquanto abortar o lote inteiro por um
    // telefone malformado perderia as outras 40.
    try {
      await promoverParaFunil(admin, org.orgId, funil, {
        companyId: data.id,
        nome: e.name,
        telefone: e.phone ?? null,
        email: null,
        cidade: e.city ?? null,
        cnpj: e.cnpj ?? null,
        site: e.website ?? null,
      });
      promovidas++;
    } catch (err) {
      erros.push(`${e.name}: ${err instanceof Error ? err.message.slice(0, 80) : "erro"}`);
    }
  }

  await audit({
    action: "growth_agent.created",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "growth_companies",
    requestId,
    metadata: { origem: "busca_manual", importadas, duplicadas, promovidas },
  });

  return ok(
    { importadas, duplicadas, promovidas, pipeline_id: funil.pipelineId, erros, ids },
    { status: 201, requestId },
  );
}
