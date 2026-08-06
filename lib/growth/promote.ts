/**
 * Promoção de empresa prospectada para o CRM (EPIC-14).
 *
 * Toda empresa importada vira TRÊS coisas, nesta ordem:
 *   1. `growth_companies` — o registro de prospecção, com os dados cadastrais
 *   2. `contacts`         — a pessoa/empresa do outro lado, para o Inbox achar
 *   3. `crm_leads`        — o card no Kanban, para a triagem humana
 *
 * Por que as três e não só a primeira: prospecção que não chega no funil é uma
 * lista morta. O operador trabalha no Kanban; se o lead não está lá, ele não
 * existe na prática.
 */
import { midpoint } from "@/lib/kanban/fractional-indexing";
import { ETIQUETAS_CANONICAS, etiquetasPara } from "@/lib/growth/etiquetas";
import type { createAdminClient } from "@/lib/supabase/admin";

/** O client é injetado para o chamador controlar a transação lógica do lote. */
type Admin = ReturnType<typeof createAdminClient>;

const PIPELINE_SLUG = "prospeccao";

/**
 * Etapas de TRIAGEM, não de venda.
 *
 * O funil padrão da instalação é de e-commerce ("Carrinho abandonado",
 * "Aguardando pagamento") — jogar empresa prospectada ali seria absurdo e
 * poluiria o funil que o operador usa para vender de verdade. Prospecção tem
 * ciclo próprio: primeiro se decide se vale falar, depois se fala.
 */
const ETAPAS = [
  { name: "A triar", slug: "a-triar", position: 1000, is_won: false, is_lost: false },
  { name: "Vale contato", slug: "vale-contato", position: 2000, is_won: false, is_lost: false },
  { name: "Contactado", slug: "contactado", position: 3000, is_won: false, is_lost: false },
  { name: "Respondeu", slug: "respondeu", position: 4000, is_won: true, is_lost: false },
  { name: "Descartado", slug: "descartado", position: 5000, is_won: false, is_lost: true },
];

export interface FunilProspeccao {
  pipelineId: string;
  primeiraEtapaId: string;
}

/**
 * Cria (ou encontra) o funil de prospecção da organização. Idempotente: chamar
 * em toda importação é seguro e evita um passo de configuração antes do
 * primeiro uso.
 */
export async function garantirFunilProspeccao(
  admin: Admin,
  orgId: string,
): Promise<FunilProspeccao> {
  const { data: existente } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("slug", PIPELINE_SLUG)
    .maybeSingle();

  let pipelineId = existente?.id as string | undefined;

  if (!pipelineId) {
    const { data: criado, error } = await admin
      .from("crm_pipelines")
      .insert({
        organization_id: orgId,
        name: "Prospecção",
        slug: PIPELINE_SLUG,
        description: "Empresas descobertas pela prospecção, aguardando triagem.",
        is_default: false,
        // Declara quais etiquetas viram marcador VISÍVEL no card. Sem isto a
        // tag existe mas só aparece no tooltip, e a triagem continua cega.
        settings: { canonical_tags: [...ETIQUETAS_CANONICAS] },
        // O vocabulário do funil muda o texto da UI inteira. Aqui não são
        // "Pedidos" nem "Clientes" — são empresas que ainda não sabem que
        // existimos.
        vocabulary: {
          lead: "Empresa",
          lead_plural: "Empresas",
          deal: "Oportunidade",
          deal_plural: "Oportunidades",
          won: "Respondeu",
          lost: "Descartado",
          stage: "Etapa",
          stage_plural: "Etapas",
        },
      })
      .select("id")
      .single();

    // Corrida entre duas importações simultâneas: a segunda relê em vez de
    // falhar.
    if (error) {
      const { data: relido } = await admin
        .from("crm_pipelines")
        .select("id")
        .eq("organization_id", orgId)
        .eq("slug", PIPELINE_SLUG)
        .maybeSingle();
      if (!relido) throw new Error(`nao_criou_funil: ${error.message}`);
      pipelineId = relido.id as string;
    } else {
      pipelineId = criado.id as string;
    }
  }

  const { data: etapas } = await admin
    .from("crm_stages")
    .select("id, position")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .order("position", { ascending: true });

  if (!etapas?.length) {
    await admin.from("crm_stages").insert(
      ETAPAS.map((e) => ({
        organization_id: orgId,
        pipeline_id: pipelineId,
        name: e.name,
        slug: e.slug,
        position: e.position,
        is_won: e.is_won,
        is_lost: e.is_lost,
      })),
    );
    const { data: novas } = await admin
      .from("crm_stages")
      .select("id, position")
      .eq("organization_id", orgId)
      .eq("pipeline_id", pipelineId)
      .order("position", { ascending: true });
    return { pipelineId, primeiraEtapaId: novas![0]!.id as string };
  }

  return { pipelineId, primeiraEtapaId: etapas[0]!.id as string };
}

/**
 * Telefone brasileiro para E.164, que é o formato que o CHECK de `contacts`
 * exige (`^\+\d{8,15}$`).
 *
 * A Kipflow devolve "3132223333" ou "(31) 3222-3333"; gravar assim quebra a
 * constraint e o contato inteiro se perde. Devolve `null` quando não dá para
 * afirmar o formato — número errado é pior que número ausente, porque alguém
 * vai mandar mensagem para ele.
 */
export function telefoneParaE164(bruto: string | null | undefined): string | null {
  if (!bruto) return null;
  const d = bruto.replace(/\D/g, "");
  if (!d) return null;

  // Já veio com código do país.
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return `+${d}`;
  // DDD + 8 (fixo) ou 9 (celular) dígitos.
  if (d.length === 10 || d.length === 11) return `+55${d}`;

  return null;
}

export interface EmpresaParaPromover {
  companyId: string;
  nome: string;
  telefone: string | null;
  email: string | null;
  cidade: string | null;
  cnpj: string | null;
  site: string | null;
  /** Canais já conhecidos na hora da promoção — viram etiqueta no card. */
  instagram?: string | null;
  facebook?: string | null;
  cnae?: string | null;
}

export interface ResultadoPromocao {
  contactId: string | null;
  leadId: string | null;
  motivo: "criado" | "lead_ja_existia";
}

/**
 * Cria contato + card no Kanban para uma empresa já gravada em
 * `growth_companies`.
 */
export async function promoverParaFunil(
  admin: Admin,
  orgId: string,
  funil: FunilProspeccao,
  empresa: EmpresaParaPromover,
): Promise<ResultadoPromocao> {
  // Uma empresa = um card. Reimportar não duplica o Kanban.
  const { data: leadExistente } = await admin
    .from("crm_leads")
    .select("id, contact_id")
    .eq("organization_id", orgId)
    .eq("source_company_id", empresa.companyId)
    .maybeSingle();

  if (leadExistente) {
    return {
      contactId: (leadExistente.contact_id as string | null) ?? null,
      leadId: leadExistente.id as string,
      motivo: "lead_ja_existia",
    };
  }

  // Etiquetar na CRIAÇÃO, não só em backfill: lead novo sem etiqueta é mais um
  // card idêntico no meio de cem, e a triagem volta a ser leitura um a um.
  const etiquetas = etiquetasPara(
    {
      whatsapp: empresa.telefone,
      email: empresa.email,
      instagram: empresa.instagram ?? null,
      facebook: empresa.facebook ?? null,
      site: empresa.site,
      cnae: empresa.cnae ?? null,
    },
    empresa.nome,
  );

  const telefone = telefoneParaE164(empresa.telefone);
  const email = empresa.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(empresa.email)
    ? empresa.email
    : null;

  // ---- contato ------------------------------------------------------------
  // Contato sem telefone e sem e-mail é legítimo aqui: os campos são nullable,
  // e a empresa existe mesmo sem canal conhecido. O canal costuma aparecer
  // depois, quando o analisador de site acha o wa.me.
  let contactId: string | null = null;

  const { data: contatoCriado, error: erroContato } = await admin
    .from("contacts")
    .insert({
      organization_id: orgId,
      name: empresa.nome,
      phone_number: telefone,
      email,
      source: "growth_agent",
      tags: etiquetas,
      source_metadata: {
        cnpj: empresa.cnpj,
        cidade: empresa.cidade,
        site: empresa.site,
        growth_company_id: empresa.companyId,
      },
    })
    .select("id")
    .single();

  if (erroContato) {
    // 23505 = já existe contato com este telefone ou e-mail na org. Reusar é o
    // comportamento certo — criar um segundo seria fragmentar o histórico da
    // mesma pessoa, que é exatamente o que o Customer 360 existe para evitar.
    if (erroContato.code === "23505") {
      const busca = admin.from("contacts").select("id").eq("organization_id", orgId).limit(1);
      const { data: achado } = telefone
        ? await busca.eq("phone_number", telefone)
        : await busca.eq("email", email!);
      contactId = (achado?.[0]?.id as string | undefined) ?? null;
    } else {
      throw new Error(`contato: ${erroContato.message}`);
    }
  } else {
    contactId = contatoCriado.id as string;
  }

  // ---- card no Kanban -----------------------------------------------------
  // Entra no topo da primeira etapa: o mais recente aparece primeiro, que é
  // como quem tria espera encontrar.
  const { data: primeiro } = await admin
    .from("crm_leads")
    .select("position_in_stage")
    .eq("organization_id", orgId)
    .eq("stage_id", funil.primeiraEtapaId)
    .order("position_in_stage", { ascending: true })
    .limit(1);

  const posicao = midpoint(null, (primeiro?.[0]?.position_in_stage as number | undefined) ?? null);

  const { data: lead, error: erroLead } = await admin
    .from("crm_leads")
    .insert({
      organization_id: orgId,
      pipeline_id: funil.pipelineId,
      stage_id: funil.primeiraEtapaId,
      contact_id: contactId,
      title: empresa.nome,
      description: [empresa.cidade, empresa.cnpj ? `CNPJ ${empresa.cnpj}` : null, empresa.site]
        .filter(Boolean)
        .join(" · "),
      status: "open",
      position_in_stage: posicao,
      source: "growth_agent",
      tags: etiquetas,
      // FK de verdade, não chave dentro de jsonb: é o que liga o card de volta
      // ao registro de prospecção com integridade referencial.
      source_company_id: empresa.companyId,
    })
    .select("id")
    .single();

  if (erroLead) throw new Error(`lead: ${erroLead.message}`);

  return { contactId, leadId: lead.id as string, motivo: "criado" };
}
