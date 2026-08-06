/**
 * Cliente da API Kipflow — dados cadastrais de empresas brasileiras (EPIC-14).
 *
 * Verificado contra https://docs.kipflow.io em 2026-08-05.
 *
 * ATENÇÃO a quem for estender: o arquivo `kipflow.md` da raiz do workspace
 * descreve endpoints que NÃO EXISTEM (`/buscar-empresa-por-cnpj-ou-dominio`,
 * `/gerar-emails-de-pessoas-de-uma-empresa`, `/buscar-lugares-por-cnpj`) e
 * autenticação por Bearer. Aqueles nomes são slugs das PÁGINAS da documentação,
 * não rotas da API. Não implemente a partir dele.
 *
 * Contrato real:
 *   base   https://api.kipflow.io
 *   auth   header X-API-Key
 *   limite 5/s · 100/min · 1000/h
 *   corpo  { success, data, datasets, cost, costFormatted }
 *          { success: false, error: { code, message, details } }
 */
import { env } from "@/lib/env";

const BASE = "https://api.kipflow.io";

// 5/s é o teto duro. 220ms dá ~4,5/s — folga deliberada, porque estourar
// devolve erro e queima a execução no meio, o que custa mais que a espera.
const ESPACAMENTO_MS = 220;
const TETO_POR_MINUTO = 100;

export interface KipflowEnvelope<T> {
  success: boolean;
  data?: T;
  datasets?: string[];
  cost?: number;
  costFormatted?: string;
  error?: { code?: string; message?: string; details?: unknown };
}

export class KipflowError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "KipflowError";
  }
}

export function kipflowConfigured(): boolean {
  return env.KIPFLOW_API_KEY.trim().length > 0;
}

/**
 * Contabiliza consumo de uma execução.
 *
 * O plano é por QUOTA MENSAL DE REQUISIÇÕES, então requisição é a unidade que
 * limita — não reais. O custo é registrado junto porque a API o informa de
 * graça em `cost`, e ter o número real dispensa estimativa.
 */
export class ConsumoKipflow {
  requisicoes = 0;
  custoCents = 0;

  registrar(env_: KipflowEnvelope<unknown>): void {
    this.requisicoes++;
    if (typeof env_.cost === "number") {
      this.custoCents += Math.round(env_.cost * 100);
    }
  }
}

/** Janela deslizante simples, por processo. Serial por desenho: o pipeline é síncrono. */
class Limitador {
  private ultimaEm = 0;
  private janela: number[] = [];

  async esperar(): Promise<void> {
    const agora = Date.now();

    const desdeUltima = agora - this.ultimaEm;
    if (desdeUltima < ESPACAMENTO_MS) {
      await new Promise((r) => setTimeout(r, ESPACAMENTO_MS - desdeUltima));
    }

    this.janela = this.janela.filter((t) => Date.now() - t < 60_000);
    if (this.janela.length >= TETO_POR_MINUTO) {
      const esperaAte = this.janela[0]! + 60_000;
      const espera = Math.max(0, esperaAte - Date.now());
      await new Promise((r) => setTimeout(r, espera));
      this.janela = this.janela.filter((t) => Date.now() - t < 60_000);
    }

    this.ultimaEm = Date.now();
    this.janela.push(this.ultimaEm);
  }
}

const limitador = new Limitador();

async function chamar<T>(
  caminho: string,
  init: { method: "GET" | "POST"; query?: Record<string, string>; body?: unknown },
  consumo?: ConsumoKipflow,
): Promise<KipflowEnvelope<T>> {
  const chave = env.KIPFLOW_API_KEY.trim();
  if (!chave) throw new KipflowError("KIPFLOW_API_KEY ausente.", 0, "not_configured");

  await limitador.esperar();

  const url = new URL(BASE + caminho);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    method: init.method,
    headers: {
      // Header, nunca query string: chave em URL vaza em log de proxy e CDN.
      "X-API-Key": chave,
      "content-type": "application/json",
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  let envelope: KipflowEnvelope<T>;
  try {
    envelope = (await res.json()) as KipflowEnvelope<T>;
  } catch {
    throw new KipflowError(`Resposta ilegível (HTTP ${res.status}).`, res.status);
  }

  // A requisição é contada mesmo em erro: ela consumiu quota. Só o custo é que
  // pode não ter sido debitado — e como a doc não é explícita sobre isso, o
  // contador de custo confia no campo `cost`, que vem ausente quando não houve
  // cobrança. Contar a requisição e não o custo é o lado seguro de errar.
  consumo?.registrar(envelope);

  if (!res.ok || envelope.success === false) {
    throw new KipflowError(
      envelope.error?.message ?? `Kipflow respondeu ${res.status}.`,
      res.status,
      envelope.error?.code ?? null,
    );
  }

  return envelope;
}

// ---------------------------------------------------------------------------
// Empresas
// ---------------------------------------------------------------------------

export const KIPFLOW_DATASETS = [
  "basic",
  "complete",
  "address",
  "online_presence",
  "partners",
  "debts",
  "ecommerce",
] as const;

/** Custos medidos contra a API em 2026-08-05, por empresa retornada. */
export const CUSTO_POR_DATASET_CENTS: Record<string, number> = {
  basic: 2,
  address: 5,
  online_presence: 5,
  partners: 5,
  complete: 22,
  debts: 5,
  ecommerce: 0,
};

export interface EmpresaKipflow {
  cnpj: string | null;
  razao_social: string | null;
  nome_fantasia: string | null;
  cnae: string | null;
  porte: string | null;
  faturamento_presumido_cents: number | null;
  faixa_funcionarios: string | null;
  endereco: string | null;
  cidade: string | null;
  uf: string | null;
  telefone: string | null;
  /** O telefone escolhido tem WhatsApp segundo a base da Kipflow. */
  telefone_tem_whatsapp: boolean;
  email: string | null;
  site: string | null;
  instagram_url: string | null;
  facebook_url: string | null;
  twitter_url: string | null;
  linkedin_url: string | null;
  /** Tudo o que a fonte devolveu, inclusive o que o casamento por nome descartou. */
  redes_candidatas: Record<string, string[]>;
  lat: number | null;
  lng: number | null;
}

interface SiteDto {
  site?: string;
  confiabilidade?: number;
  pertence_contador?: boolean;
}
interface TelefoneDto {
  telefone_completo?: string;
  whatsapp?: boolean;
  pertence_contador?: boolean;
  validado_discador?: boolean;
  score_original?: number;
}
interface EmailDto {
  email?: string;
  pertence_contador?: boolean;
}

/**
 * `pertence_contador` é o campo mais importante desta integração e o mais fácil
 * de ignorar.
 *
 * A Receita recebe, para muita empresa pequena, o telefone/e-mail/site do
 * ESCRITÓRIO DE CONTABILIDADE que abriu o CNPJ. Contatar esse número é falar
 * com o contador sobre o cliente dele — desperdício garantido e uma péssima
 * primeira impressão. A Kipflow marca isso; descartar é obrigatório, não
 * refinamento.
 */
function melhorSite(sites: unknown): string | null {
  if (!Array.isArray(sites)) return null;
  const candidatos = (sites as SiteDto[])
    .filter((s) => s?.site && !s.pertence_contador)
    // `confiabilidade` é score da própria Kipflow — o primeiro da lista nem
    // sempre é o melhor.
    .sort((a, b) => (b.confiabilidade ?? 0) - (a.confiabilidade ?? 0));
  return candidatos[0]?.site?.trim() ?? null;
}

function melhorTelefone(tels: unknown): { numero: string | null; whatsapp: boolean } {
  if (!Array.isArray(tels)) return { numero: null, whatsapp: false };
  const candidatos = (tels as TelefoneDto[])
    .filter((t) => t?.telefone_completo && !t.pertence_contador)
    // Prioridade: tem WhatsApp > validado no discador > score bruto. O canal
    // primário do produto é WhatsApp, então um número que o tem vale mais que
    // um fixo com score alto.
    .sort((a, b) => {
      const peso = (t: TelefoneDto) =>
        (t.whatsapp ? 100 : 0) + (t.validado_discador ? 50 : 0) + (t.score_original ?? 0);
      return peso(b) - peso(a);
    });
  const escolhido = candidatos[0];
  return {
    numero: escolhido?.telefone_completo?.trim() ?? null,
    whatsapp: escolhido?.whatsapp === true,
  };
}

function melhorEmail(emails: unknown): string | null {
  if (!Array.isArray(emails)) return null;
  const c = (emails as EmailDto[]).find((e) => e?.email && !e.pertence_contador);
  return c?.email?.trim() ?? null;
}

/** Só letras e dígitos, sem acento — para comparar nome com handle. */
function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Escolhe a rede social que realmente pertence à empresa.
 *
 * NUNCA pegar o primeiro item do array. Medido num retorno real: a SOCILA LTDA
 * (salão em BH) veio com 22 URLs de Instagram, entre elas
 * `LaGranPollaMundialista`, `finance_br` e `teachercasals` — perfis de terceiros,
 * provavelmente raspados de alguma página compartilhada. O handle correto
 * (`socilasalao`) estava em 22º lugar.
 *
 * Pegar o primeiro gravaria o perfil errado como contato da empresa, e alguém
 * mandaria mensagem para um desconhecido. Por isso: casa o handle contra o nome
 * da empresa, e devolve `null` quando nenhum casa. Ausência é melhor que erro —
 * o analisador de site ainda pode achar o certo depois.
 */
function todasUrls(lista: unknown): string[] {
  if (!Array.isArray(lista)) return [];
  return (lista as { url?: string }[])
    .map((x) => x?.url?.trim())
    .filter((u): u is string => !!u);
}

function melhorRede(lista: unknown, nomes: (string | null)[]): string | null {
  if (!Array.isArray(lista) || lista.length === 0) return null;

  const urls = (lista as { url?: string }[])
    .map((x) => x?.url?.trim())
    .filter((u): u is string => !!u);

  if (urls.length === 0) return null;
  // Array de um item só: não há com o que comparar, e a chance de ser de
  // terceiro é baixa (o ruído aparece justamente quando são muitos).
  if (urls.length === 1) return urls[0]!;

  // Palavras que aparecem em toda razão social e não identificam ninguém.
  // Sem isto, "ltda" casaria com qualquer handle que contivesse a sequência.
  const GENERICAS = new Set([
    "ltda", "eireli", "sociedade", "empresaria", "limitada", "simples",
    "individual", "comercio", "servicos", "brasil", "grupo", "empresa",
  ]);

  // Tokenizar ANTES de normalizar: normalizar a razão social inteira colaria
  // as palavras ("SOCILA LTDA" -> "socilaltda") e nenhum token casaria com o
  // handle real (`socilasalao`).
  const tokens = nomes
    .filter((n): n is string => !!n)
    .flatMap((n) => n.split(/[\s.,&/-]+/))
    .map(normalizar)
    .filter((t) => t.length >= 4 && !GENERICAS.has(t));

  if (tokens.length === 0) return null;

  for (const url of urls) {
    const handle = normalizar(url.split("/").pop() ?? "");
    if (!handle) continue;
    if (tokens.some((t) => handle.includes(t) || t.includes(handle))) return url;
  }

  return null;
}

/**
 * Normaliza `CompanyDto` para o nosso modelo.
 *
 * Nomes de campo confirmados contra a API real (2026-08-05), não inferidos:
 * `cnpj` vem como number em alguns retornos e string em outros — daí o String().
 * `lon`, não `lng`. `uf` vem por extenso ("MINAS GERAIS"), não a sigla.
 */
function normalizarEmpresa(raw: Record<string, unknown>): EmpresaKipflow {
  const texto = (k: string): string | null => {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
    return null;
  };
  const numero = (k: string): number | null => {
    const v = raw[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  const faturamento = numero("faturamento");
  const tel = melhorTelefone(raw.telefones);
  // Nomes usados para casar handle de rede social com a empresa.
  const nomes = [texto("nome_fantasia"), texto("razao_social")];

  return {
    cnpj: texto("cnpj")?.replace(/\D/g, "").padStart(14, "0") ?? null,
    razao_social: texto("razao_social"),
    nome_fantasia: texto("nome_fantasia"),
    cnae: texto("cnae_principal_desc_subclasse") ?? texto("cnae_principal_desc_classe"),
    porte: texto("porte"),
    faturamento_presumido_cents: faturamento === null ? null : Math.round(faturamento * 100),
    faixa_funcionarios: texto("faixa_funcionarios_grupo"),
    endereco: texto("endereco"),
    cidade: texto("municipio"),
    uf: texto("uf"),
    telefone: tel.numero,
    telefone_tem_whatsapp: tel.whatsapp,
    email: melhorEmail(raw.emails),
    site: melhorSite(raw.sites),
    instagram_url: melhorRede(raw.instagram, nomes),
    facebook_url: melhorRede(raw.facebook, nomes),
    twitter_url: melhorRede(raw.twitter, nomes),
    linkedin_url: texto("linkedin_url"),
    // Guardar as candidatas é o que impede a lista inteira de se perder quando
    // o casamento automático não acha nada — o humano da triagem reconhece.
    redes_candidatas: Object.fromEntries(
      (["instagram", "facebook", "twitter"] as const)
        .map((k) => [k, todasUrls(raw[k])] as const)
        .filter(([, urls]) => urls.length > 0),
    ),
    lat: numero("lat"),
    lng: numero("lon"),
  };
}

/** `GET /companies/v1/search` — empresa por CNPJ. */
export async function buscarEmpresaPorCnpj(
  cnpj: string,
  datasets?: string[],
  consumo?: ConsumoKipflow,
): Promise<EmpresaKipflow | null> {
  const env_ = await chamar<Record<string, unknown>>(
    "/companies/v1/search",
    {
      method: "GET",
      query: {
        cnpj: cnpj.replace(/\D/g, ""),
        ...(datasets?.length ? { datasets: datasets.join(",") } : {}),
      },
    },
    consumo,
  );
  return env_.data ? normalizarEmpresa(env_.data) : null;
}

export interface FiltrosEmpresa {
  /** Subclasse CNAE no formato numérico da Kipflow: 6911-7/01 vira 6911701. */
  cnaeSubclasse?: number;
  /** Classe CNAE: 6911-7 vira 69117. Mais abrangente que a subclasse. */
  cnaeClasse?: number;
  /** Por extenso e MAIÚSCULO: "MINAS GERAIS", não "MG". */
  uf?: string;
  municipio?: string;
  /**
   * Faixas de faturamento, valores EXATOS da base — ver FAIXAS_FATURAMENTO.
   *
   * A API documenta os operadores `$gt` e `$lt`, mas eles NÃO funcionam:
   * medido em 2026-08-05, `{"faturamento":{"$gt":500000}}` responde
   * "unknown operator $gt". Só igualdade, `$in` e `$or` funcionam de fato.
   * Por isso o filtro é por faixa, não por número.
   */
  faixasFaturamento?: string[];
  /** Idem, ver FAIXAS_FUNCIONARIOS. */
  faixasFuncionarios?: string[];
  porte?: string;
  /** BAIXO | MEDIO | ALTO — poder aquisitivo da região da empresa. */
  perfilBairro?: string;
  /** `false` filtra quem NÃO é optante: proxy de empresa maior. */
  optanteSimples?: boolean;
  /** Só matriz — evita listar 40 filiais da mesma rede como leads distintos. */
  somenteMatriz?: boolean;
  limite: number;
  datasets?: string[];
}

/** Valores exatos aceitos pelo filtro, confirmados contra a base. */
export const FAIXAS_FATURAMENTO = [
  "0 A 81K",
  "81K A 360K",
  "360K A 1M",
  "1M A 2M",
  "2M A 4,8M",
  "4,8M A 10M",
  "10M A 30M",
  "30M A 40M",
  "40M A 50M",
] as const;

export const FAIXAS_FUNCIONARIOS = [
  "1",
  "02 A 05",
  "06 A 09",
  "10 A 19",
  "20 A 49",
  "50 A 99",
  "100 A 249",
  "250 A 499",
  "500 OU MAIS",
] as const;

export const PORTES = ["MICRO EMPRESA", "PEQUENO PORTE", "DEMAIS"] as const;

/** `6911-7/01` -> 6911701 · `6911-7` -> 69117. Aceita já-numérico. */
export function cnaeParaNumero(cnae: string): number | null {
  const digitos = cnae.replace(/\D/g, "");
  if (!digitos) return null;
  const n = Number(digitos);
  return Number.isFinite(n) ? n : null;
}

/**
 * `POST /companies/v1/search` — a busca que alimenta a descoberta.
 *
 * Corpo CONFIRMADO contra a API real em 2026-08-05. As propriedades levam `$`
 * (`$filter`, `$page`, `$size`) e o filtro é sintaxe estilo MongoDB — sem o
 * cifrão a API responde "property X should not exist", que foi exatamente onde
 * a primeira implementação (escrita por leitura da doc) quebrou.
 *
 * `situacao_cadastral: ATIVA` entra sempre: empresa baixada não é lead.
 */
export async function buscarEmpresasComFiltros(
  filtros: FiltrosEmpresa,
  consumo?: ConsumoKipflow,
): Promise<EmpresaKipflow[]> {
  const condicoes: Record<string, unknown>[] = [{ situacao_cadastral: "ATIVA" }];

  if (filtros.cnaeSubclasse) condicoes.push({ cnae_principal_subclasse: filtros.cnaeSubclasse });
  else if (filtros.cnaeClasse) condicoes.push({ cnae_principal_classe: filtros.cnaeClasse });
  if (filtros.uf) condicoes.push({ uf: filtros.uf.toUpperCase() });
  if (filtros.municipio) condicoes.push({ municipio: filtros.municipio.toUpperCase() });
  if (filtros.somenteMatriz) condicoes.push({ matriz: true });
  if (filtros.porte) condicoes.push({ porte: filtros.porte });
  if (filtros.perfilBairro) {
    condicoes.push({ perfil_socioeconomico_bairro_desc: filtros.perfilBairro });
  }
  if (filtros.optanteSimples !== undefined) {
    condicoes.push({ opcao_pelo_simples: filtros.optanteSimples });
  }
  // `$in` funciona; `$gt`/`$lt` não (ver comentário em FiltrosEmpresa).
  if (filtros.faixasFaturamento?.length) {
    condicoes.push({ faixa_faturamento_grupo: { $in: filtros.faixasFaturamento } });
  }
  if (filtros.faixasFuncionarios?.length) {
    condicoes.push({ faixa_funcionarios_grupo: { $in: filtros.faixasFuncionarios } });
  }

  const env_ = await chamar<unknown>(
    "/companies/v1/search",
    {
      method: "POST",
      body: {
        $filter: { $and: condicoes },
        $page: 0,
        // Teto de 50 por página é da própria API.
        $size: Math.min(filtros.limite, 50),
        datasets: filtros.datasets?.length ? filtros.datasets : ["basic", "address"],
      },
    },
    consumo,
  );

  const lista = Array.isArray(env_.data) ? (env_.data as unknown[]) : [];

  return lista
    .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
    .map(normalizarEmpresa)
    // Sem CNPJ não há chave natural para o dedup desta fonte.
    .filter((e) => e.cnpj !== null);
}

/** Exposto só para teste: são funções puras e o custo de errar nelas é gravar o contato errado. */
export const __testing = { melhorRede, melhorSite, melhorTelefone, melhorEmail };
