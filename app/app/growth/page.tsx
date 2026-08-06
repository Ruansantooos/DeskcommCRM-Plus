import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Binoculars, ChatCircleDots, InstagramLogo } from "@phosphor-icons/react/dist/ssr";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Painel da prospecção.
 *
 * O número que importa aqui NÃO é "quantas empresas descobri" — é "com quantas
 * eu consigo falar". Uma base de mil empresas mudas vale menos que cinquenta
 * com WhatsApp, e um painel que mostra só o total esconde exatamente isso.
 * Por isso o alcance é o card grande e o total é o pequeno.
 */
export default async function GrowthOverviewPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  if (ROLE_RANK[org.role] < ROLE_RANK.manager) redirect("/403");

  const admin = createAdminClient();

  const [{ count: empresas }, { data: enriq }, { data: etapas }, { data: runs }] =
    await Promise.all([
      admin
        .from("growth_companies")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.orgId),
      admin
        .from("growth_enrichment")
        .select("whatsapp, email, instagram_url, facebook_url, website_url")
        .eq("organization_id", org.orgId),
      admin
        .from("crm_stages")
        .select("name, position, crm_pipelines!inner(slug)")
        .eq("organization_id", org.orgId)
        .eq("crm_pipelines.slug", "prospeccao")
        .order("position", { ascending: true }),
      admin
        .from("growth_agent_runs")
        .select("requisicoes_api, custo_api_cents")
        .eq("organization_id", org.orgId),
    ]);

  const e = enriq ?? [];
  const comWhatsapp = e.filter((x) => x.whatsapp).length;
  const comInstagram = e.filter((x) => x.instagram_url).length;
  const comEmail = e.filter((x) => x.email).length;
  const comSite = e.filter((x) => x.website_url).length;
  const comAlgumCanal = e.filter(
    (x) => x.whatsapp || x.instagram_url || x.email || x.facebook_url,
  ).length;

  const total = empresas ?? 0;
  const mudas = total - comAlgumCanal;
  const pctAlcance = total > 0 ? Math.round((comAlgumCanal / total) * 100) : 0;

  const custo = (runs ?? []).reduce((s, r) => s + (r.custo_api_cents ?? 0), 0);

  // Contagem por etapa numa query só — o board pode ter centenas de cards e
  // uma consulta por coluna viraria N+1 na tela mais visitada do módulo.
  const { data: cards } = await admin
    .from("crm_leads")
    .select("stage_id, crm_stages!inner(name, position, crm_pipelines!inner(slug))")
    .eq("organization_id", org.orgId)
    .eq("crm_stages.crm_pipelines.slug", "prospeccao");

  const porEtapa = new Map<string, number>();
  for (const c of cards ?? []) {
    const nome = (c as unknown as { crm_stages: { name: string } }).crm_stages.name;
    porEtapa.set(nome, (porEtapa.get(nome) ?? 0) + 1);
  }

  return (
    <div className="flex h-full flex-col gap-8 p-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Prospecção</h1>
        <p className="mt-1 text-sm text-text-muted">
          O que a busca encontrou e com quantas dessas empresas você consegue falar.
        </p>
      </header>

      {/* Três números, na ordem que decide o dia: quem dá para abordar hoje,
          por onde, e quanto ainda está fora de alcance. */}
      <section className="grid gap-4 md:grid-cols-3">
        <Cartao
          tom="bg-accent-100 border-accent-300"
          rotulo="Dá para abordar"
          valor={comAlgumCanal}
          nota={`${pctAlcance}% das ${total} descobertas`}
          icone={<ChatCircleDots size={22} weight="duotone" />}
        />
        <Cartao
          tom="bg-warning-bg border-warning/30"
          rotulo="Com WhatsApp"
          valor={comWhatsapp}
          nota="canal direto, sem intermediário"
          icone={<ChatCircleDots size={22} weight="duotone" />}
        />
        <Cartao
          tom="bg-info-bg border-info/30"
          rotulo="Com Instagram"
          valor={comInstagram}
          nota="exige DM e espera resposta"
          icone={<InstagramLogo size={22} weight="duotone" />}
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        {/* Funil */}
        <div className="rounded-2xl border bg-surface p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">No funil</h2>
            <Link
              href="/app/kanban"
              className="inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-text"
            >
              Abrir Kanban <ArrowRight size={14} />
            </Link>
          </div>

          {(etapas ?? []).length === 0 ? (
            <p className="text-sm text-text-muted">
              O funil de prospecção nasce na primeira busca.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {(etapas ?? []).map((s) => {
                const n = porEtapa.get(s.name as string) ?? 0;
                const maior = Math.max(1, ...[...porEtapa.values()]);
                return (
                  <li key={s.name as string} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 truncate text-sm">{s.name as string}</span>
                    {/* Barra proporcional: a leitura é comparativa, não absoluta —
                        onde a fila está entupida importa mais que o número exato. */}
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-elevated">
                      <div
                        className="h-full rounded-full bg-accent-400"
                        style={{ width: `${(n / maior) * 100}%` }}
                      />
                    </div>
                    <span className="w-10 shrink-0 text-right text-sm font-medium">{n}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Alcance */}
        <div className="rounded-2xl border bg-surface p-5">
          <h2 className="mb-4 font-semibold">Canais encontrados</h2>
          <dl className="flex flex-col gap-3 text-sm">
            <Linha rotulo="WhatsApp" valor={comWhatsapp} total={total} />
            <Linha rotulo="Instagram" valor={comInstagram} total={total} />
            <Linha rotulo="E-mail" valor={comEmail} total={total} />
            <Linha rotulo="Site" valor={comSite} total={total} />
          </dl>

          {mudas > 0 ? (
            <p className="mt-4 rounded-xl bg-surface-elevated px-4 py-3 text-xs leading-relaxed text-text-muted">
              <strong className="text-text">{mudas}</strong> empresas ainda sem nenhum canal. A
              base cadastral não traz contato de comércio local — o caminho é o analisador de
              site, e o Google Maps para quem não tem site.
            </p>
          ) : null}

          {custo > 0 ? (
            <p className="mt-3 text-xs text-text-subtle">
              Gasto em APIs até agora: R$ {(custo / 100).toFixed(2)}
            </p>
          ) : null}
        </div>
      </section>

      <Link
        href="/app/growth/search"
        className="inline-flex w-fit items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover"
      >
        <Binoculars size={16} weight="duotone" />
        Buscar mais empresas
      </Link>
    </div>
  );
}

function Cartao({
  tom,
  rotulo,
  valor,
  nota,
  icone,
}: {
  tom: string;
  rotulo: string;
  valor: number;
  nota: string;
  icone: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-2 rounded-2xl border p-5 ${tom}`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{rotulo}</span>
        <span className="text-text-muted">{icone}</span>
      </div>
      <span className="text-4xl font-semibold tabular-nums tracking-tight">{valor}</span>
      <span className="text-xs text-text-muted">{nota}</span>
    </div>
  );
}

function Linha({ rotulo, valor, total }: { rotulo: string; valor: number; total: number }) {
  const pct = total > 0 ? Math.round((valor / total) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <dt className="w-20 shrink-0 text-text-muted">{rotulo}</dt>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-elevated">
        <div className="h-full rounded-full bg-accent-300" style={{ width: `${pct}%` }} />
      </div>
      <dd className="w-16 shrink-0 text-right tabular-nums">
        {valor} <span className="text-text-subtle">· {pct}%</span>
      </dd>
    </div>
  );
}
