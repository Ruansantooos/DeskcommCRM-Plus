/**
 * Etiquetas dos leads de prospecção (EPIC-14).
 *
 * 107 cards iguais no Kanban não dizem nada. A pergunta que quem tria faz
 * primeiro não é "qual o nicho" nem "quanto fatura" — é **dá para falar com
 * essa empresa, e por onde?**. Uma empresa perfeita e inalcançável vale menos
 * que uma mediana com WhatsApp.
 *
 * Por isso a etiqueta CANÔNICA (a que aparece no card, via
 * `crm_pipelines.settings.canonical_tags`) é o canal. As demais servem ao
 * filtro da FilterBar, que já existe e lê `crm_leads.tags`.
 */

export interface SinaisDoLead {
  whatsapp: string | null;
  email: string | null;
  instagram: string | null;
  facebook: string | null;
  site: string | null;
  cnae: string | null;
  faixaFuncionarios?: string | null;
}

/**
 * Ordem = prioridade. Só a PRIMEIRA que o lead tiver vira o marcador do card,
 * então a lista precisa ir do canal mais acionável ao menos:
 * WhatsApp fala hoje; Instagram exige DM e espera; sem canal é trabalho manual.
 */
export const ETIQUETAS_CANONICAS = [
  "whatsapp",
  "instagram",
  "email",
  "so-site",
  "sem-canal",
] as const;

/** CNAE -> nicho legível. O código bruto não diz nada para quem tria. */
function nichoDoCnae(cnae: string | null): string | null {
  if (!cnae) return null;
  const c = cnae.toLowerCase();
  if (c.includes("9602501") || c.includes("cabeleireiro")) return "salao";
  if (c.includes("9602502") || c.includes("estetica")) return "estetica";
  if (c.includes("barbear")) return "barbearia";
  return null;
}

export function etiquetasPara(s: SinaisDoLead, nomeEmpresa?: string): string[] {
  const tags: string[] = [];

  // --- canal (a canônica sai daqui) ---
  if (s.whatsapp) tags.push("whatsapp");
  if (s.instagram) tags.push("instagram");
  if (s.email) tags.push("email");
  if (!s.whatsapp && !s.instagram && !s.email) {
    tags.push(s.site ? "so-site" : "sem-canal");
  }

  // --- gancho de venda ---
  // "sem site" não é defeito de cadastro, é a dor que o produto resolve — e é a
  // única etiqueta que também é argumento comercial.
  if (!s.site) tags.push("sem-site");

  // --- nicho ---
  // O nome comercial costuma ser mais honesto que o CNAE: muita barbearia está
  // cadastrada como "cabeleireiro" na Receita.
  const porNome = nomeEmpresa && /barbear|barber/i.test(nomeEmpresa) ? "barbearia" : null;
  const nicho = porNome ?? nichoDoCnae(s.cnae);
  if (nicho) tags.push(nicho);

  // --- porte operacional ---
  if (s.faixaFuncionarios && /^(06|10|20|50|100|250|500)/.test(s.faixaFuncionarios)) {
    tags.push("equipe-grande");
  }

  return tags;
}
