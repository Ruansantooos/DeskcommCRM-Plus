/**
 * Enriquecimento + análise de site por fetch e parse de HTML (EPIC-14).
 *
 * Decisões locked do PRD: sem headless browser (D-01) e sem provedor pago
 * (D-02). Um GET, um parse, nada renderizado.
 *
 * Consequência assumida e NÃO negociável: como nada é renderizado, performance
 * real e responsividade não são medidas — os campos ficam `null`. Preencher com
 * heurística inventada alimentaria o Score IA com número falso, e número falso
 * vira lead falso vira vendedor ligando para quem não devia.
 */
import { env } from "@/lib/env";

export interface SiteFindings {
  /** enriquecimento */
  instagram_url: string | null;
  facebook_url: string | null;
  linkedin_url: string | null;
  whatsapp: string | null;
  email: string | null;
  /** análise */
  has_https: boolean | null;
  cms: string | null;
  has_ga4: boolean | null;
  has_pixel: boolean | null;
  seo_score: number | null;
  has_blog: boolean | null;
  has_contact_form: boolean | null;
  analysis_status: "completed" | "failed" | "disallowed";
  failure_reason: string | null;
}

function vazio(status: SiteFindings["analysis_status"], motivo: string | null): SiteFindings {
  return {
    instagram_url: null,
    facebook_url: null,
    linkedin_url: null,
    whatsapp: null,
    email: null,
    has_https: null,
    cms: null,
    has_ga4: null,
    has_pixel: null,
    seo_score: null,
    has_blog: null,
    has_contact_form: null,
    analysis_status: status,
    failure_reason: motivo,
  };
}

function timeoutMs(): number {
  const n = Number(env.GROWTH_HTTP_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

async function buscar(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs());
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      // Declarar-se é doutrina: quem roda isto numa VPS responde pelo tráfego.
      headers: { "user-agent": env.GROWTH_USER_AGENT, accept: "text/html,*/*" },
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * robots.txt antes da página. Site que proíbe recebe `disallowed` — que é
 * diferente de `failed`, e o operador precisa conseguir distinguir "o site
 * caiu" de "o site não quer ser lido".
 */
async function permitido(base: URL): Promise<boolean> {
  try {
    const res = await buscar(new URL("/robots.txt", base).toString());
    if (!res.ok) return true; // sem robots.txt = sem proibição
    const txt = (await res.text()).slice(0, 20_000);

    // Parser deliberadamente simples: só o grupo User-agent: * e seus Disallow.
    let noGrupoCoringa = false;
    for (const linha of txt.split("\n")) {
      const l = linha.trim().toLowerCase();
      if (l.startsWith("user-agent:")) {
        noGrupoCoringa = l.slice(11).trim() === "*";
        continue;
      }
      if (noGrupoCoringa && l.startsWith("disallow:")) {
        const caminho = l.slice(9).trim();
        if (caminho === "/") return false;
      }
    }
    return true;
  } catch {
    return true; // robots inacessível não é proibição
  }
}

function absolutizar(href: string, base: URL): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export async function analisarSite(websiteUrl: string): Promise<SiteFindings> {
  let base: URL;
  try {
    base = new URL(websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`);
  } catch {
    return vazio("failed", "url_invalida");
  }

  if (!(await permitido(base))) return vazio("disallowed", "robots_txt");

  let html: string;
  let finalUrl: URL;
  try {
    const res = await buscar(base.toString());
    if (!res.ok) return vazio("failed", `http_${res.status}`);
    finalUrl = new URL(res.url || base.toString());
    // Teto de tamanho: página gigante não pode estourar a memória do worker.
    html = (await res.text()).slice(0, 1_500_000);
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? "timeout" : "erro_rede";
    return vazio("failed", msg);
  }

  const baixo = html.toLowerCase();

  const acharPrimeiro = (re: RegExp): string | null => {
    const m = html.match(re);
    return m ? (absolutizar(m[0], finalUrl) ?? null) : null;
  };

  const email = html.match(/mailto:([^"'?\s>]+@[^"'?\s>]+)/i)?.[1] ?? null;
  const zap = html.match(/(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?(\+?\d{8,15})/i)?.[1] ?? null;

  const cms = baixo.includes("/wp-content/") || baixo.includes('name="generator" content="wordpress')
    ? "wordpress"
    : baixo.includes("cdn.shopify.com")
      ? "shopify"
      : baixo.includes("wix.com") || baixo.includes("_wixcssineachbundle")
        ? "wix"
        : baixo.includes("squarespace")
          ? "squarespace"
          : baixo.includes("webflow")
            ? "webflow"
            : null;

  // SEO "básico" e declaradamente simples: presença dos três sinais que todo
  // site deveria ter. Não é auditoria de SEO, e o nome do campo não promete isso.
  const temTitle = /<title[^>]*>\s*\S/i.test(html);
  const temDescription = /<meta[^>]+name=["']description["'][^>]+content=["']\s*\S/i.test(html);
  const temH1 = /<h1[^>]*>\s*\S/i.test(html);
  const seo = Math.round(((Number(temTitle) + Number(temDescription) + Number(temH1)) / 3) * 100);

  return {
    instagram_url: acharPrimeiro(/https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9._-]+/i),
    facebook_url: acharPrimeiro(/https?:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9._-]+/i),
    linkedin_url: acharPrimeiro(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/[A-Za-z0-9._-]+/i),
    whatsapp: zap,
    email,
    has_https: finalUrl.protocol === "https:",
    cms,
    has_ga4: /gtag\(|googletagmanager\.com\/gtag\/js|G-[A-Z0-9]{8,}/.test(html),
    has_pixel: /connect\.facebook\.net|fbq\(/.test(html),
    seo_score: seo,
    has_blog: /href=["'][^"']*\/blog/i.test(html),
    has_contact_form: /<form[\s>]/i.test(html),
    analysis_status: "completed",
    failure_reason: null,
  };
}
