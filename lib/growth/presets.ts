/**
 * Perfis de cliente ideal — buscas prontas de um clique (EPIC-14).
 *
 * Cada preset é uma hipótese de venda, não um filtro genérico. Os números ao
 * lado foram MEDIDOS contra a base da Kipflow em Belo Horizonte (2026-08-05) e
 * existem para o operador saber o tamanho do mercado antes de gastar quota.
 *
 * Por que presets e não só campos soltos: a diferença entre uma busca que traz
 * 18.000 empresas e uma que traz 44 está em saber QUAIS quatro filtros combinar.
 * Isso é conhecimento de vendas, não de software — e é o que o produto entrega.
 */

export interface PresetBusca {
  id: string;
  nome: string;
  /** O argumento de venda, em uma frase. Aparece no card. */
  hipotese: string;
  /** Tom pastel do card. Mapeado nos tokens do design system, não em hex solto. */
  tom: "sage" | "ambar" | "azul";
  medido: string;
  filtros: {
    cnae: string[];
    faixas_faturamento?: string[];
    faixas_funcionarios?: string[];
    perfil_bairro?: "BAIXO" | "MEDIO" | "ALTO";
    somente_matriz?: boolean;
  };
  /** Filtro aplicado no RESULTADO, porque a API não tem operador de negação. */
  posFiltro?: "sem_site";
}

/** CNAEs de beleza e estética — o nicho do produto (site, automação, sistema). */
const CNAE_BELEZA = ["9602-5/01", "9602-5/02"];

/** Faixas com verba real para contratar site e automação. */
const FATURA_COM_VERBA = ["360K A 1M", "1M A 2M", "2M A 4,8M", "4,8M A 10M"];

export const PRESETS: PresetBusca[] = [
  {
    id: "sem-presenca",
    nome: "Tem verba, não tem site",
    hipotese:
      "Fatura acima de R$ 360 mil e não aparece na internet. A carência é exatamente o que você vende.",
    tom: "sage",
    medido: "661 em BH",
    filtros: {
      cnae: CNAE_BELEZA,
      faixas_faturamento: FATURA_COM_VERBA,
      somente_matriz: true,
    },
    // A Kipflow não aceita `$not` — medido, responde "not an applicable
    // filter". Então o corte de "sem site" acontece sobre o resultado. É por
    // isso que os filtros de verba vêm primeiro: eles reduzem 26 mil para ~350
    // ANTES de pagar pelo dataset de presença online.
    posFiltro: "sem_site",
  },
  {
    id: "equipe-grande",
    nome: "Equipe grande, gestão no caderno",
    hipotese:
      "Seis ou mais pessoas atendendo sem sistema de agendamento. O caos operacional já dói.",
    tom: "ambar",
    medido: "44 em BH",
    filtros: {
      cnae: CNAE_BELEZA,
      faixas_faturamento: FATURA_COM_VERBA,
      faixas_funcionarios: ["06 A 09", "10 A 19", "20 A 49", "50 A 99"],
      somente_matriz: true,
    },
  },
  {
    id: "bairro-nobre",
    nome: "Bairro nobre, ticket alto",
    hipotese:
      "Opera em região de alto poder aquisitivo. Cliente que cobra caro aceita investir na própria marca.",
    tom: "azul",
    medido: "72 em BH",
    filtros: {
      cnae: CNAE_BELEZA,
      faixas_faturamento: FATURA_COM_VERBA,
      perfil_bairro: "ALTO",
      somente_matriz: true,
    },
  },
];

/** Classes por tom. Só tokens do design system — nada de hex solto. */
/**
 * Um tom por preset, e eles precisam ser DISTINGUÍVEIS.
 *
 * A primeira versão usava sage/success/danger. Medido na tela: no Sage, o verde
 * de sucesso é quase o próprio accent e o vermelho é dessaturado a 12% — os três
 * cards saíram praticamente da mesma cor, o que anula o propósito de codificar
 * por cor. Âmbar e azul abrem o espectro de verdade.
 */
export const TOM_CLASSES: Record<PresetBusca["tom"], string> = {
  sage: "bg-accent-100 border-accent-300 hover:border-accent-500",
  ambar: "bg-warning-bg border-warning/30 hover:border-warning/60",
  azul: "bg-info-bg border-info/30 hover:border-info/60",
};
