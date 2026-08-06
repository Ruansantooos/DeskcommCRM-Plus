"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Buildings, MagnifyingGlass, Sliders } from "@phosphor-icons/react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FONTE_LABELS } from "@/lib/growth/schemas";
import { PRESETS, TOM_CLASSES, type PresetBusca } from "@/lib/growth/presets";

type Fonte = "places" | "kipflow";

interface StatusFonte {
  configured: boolean;
  missingEnv: string | null;
}

interface Achado {
  place_id: string | null;
  cnpj: string | null;
  name: string;
  razao_social: string | null;
  address: string | null;
  city: string | null;
  phone: string | null;
  website: string | null;
  category: string | null;
  cnae: string | null;
  faturamento_presumido_cents: number | null;
  linkedin_url: string | null;
  lat: number | null;
  lng: number | null;
  source: "maps_agent" | "kipflow_agent";
  ja_conhecida: boolean;
}

interface Meta {
  total?: number;
  novas?: number;
  requisicoes?: number;
  custo_cents?: number;
}

export function BuscaManual({ fontes }: { fontes: Record<Fonte, StatusFonte> }) {
  const router = useRouter();

  const [fonte, setFonte] = useState<Fonte>(fontes.kipflow.configured ? "kipflow" : "places");
  const [avancado, setAvancado] = useState(false);
  const [buscando, setBuscando] = useState(false);
  const [achados, setAchados] = useState<Achado[] | null>(null);
  const [meta, setMeta] = useState<Meta>({});
  const [presetAtivo, setPresetAtivo] = useState<string | null>(null);

  const [f, setF] = useState({
    nicho: "",
    cidade: "Belo Horizonte",
    raio_km: "10",
    cnae: "",
    uf: "MG",
    limite: "25",
  });

  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }));

  async function executar(body: Record<string, unknown>, preset: string | null) {
    setBuscando(true);
    setAchados(null);
    setPresetAtivo(preset);
    try {
      const res = await fetch("/api/v1/growth/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error?.message ?? "A busca falhou.");
        return;
      }

      let lista = json.data as Achado[];
      const posFiltro = PRESETS.find((p) => p.id === preset)?.posFiltro;
      // A Kipflow não tem operador de negação: "sem site" é corte local.
      if (posFiltro === "sem_site") lista = lista.filter((a) => !a.website);

      setAchados(lista);
      setMeta({ ...(json.meta ?? {}), total: lista.length });

      const novas = (json.meta?.novas as number | undefined) ?? 0;
      const repetidas = (json.meta?.ja_conhecidas as number | undefined) ?? 0;
      if (novas > 0) {
        toast.success(
          `${novas} empresa(s) no Kanban, em "A triar"${repetidas ? ` · ${repetidas} já conhecida(s)` : ""}.`,
        );
        router.refresh();
      } else if (repetidas > 0) {
        toast.info(`Nada novo: as ${repetidas} encontradas já estavam na sua base.`);
      }
    } catch {
      toast.error("Falha de rede.");
    } finally {
      setBuscando(false);
    }
  }

  function rodarPreset(p: PresetBusca) {
    if (!fontes.kipflow.configured) {
      toast.error(`Estes perfis usam a Kipflow, que precisa da variável ${fontes.kipflow.missingEnv}.`);
      return;
    }
    setFonte("kipflow");
    executar(
      {
        fonte: "kipflow",
        cnae: p.filtros.cnae,
        uf: f.uf,
        cidade: f.cidade,
        faixas_faturamento: p.filtros.faixas_faturamento,
        faixas_funcionarios: p.filtros.faixas_funcionarios,
        perfil_bairro: p.filtros.perfil_bairro,
        somente_matriz: p.filtros.somente_matriz,
        // Preset com corte local pede lote maior: parte do resultado é
        // descartada depois, então buscar 25 devolveria bem menos que 25.
        limite: p.posFiltro ? 50 : Number(f.limite),
      },
      p.id,
    );
  }

  function buscarManual() {
    executar(
      fonte === "places"
        ? {
            fonte: "places",
            nicho: f.nicho,
            cidade: f.cidade,
            raio_km: Number(f.raio_km),
            limite: Number(f.limite),
          }
        : {
            fonte: "kipflow",
            ...(f.cnae.trim()
              ? { cnae: f.cnae.split(",").map((s) => s.trim()).filter(Boolean) }
              : {}),
            ...(f.uf.trim() ? { uf: f.uf.trim().toUpperCase() } : {}),
            ...(f.cidade.trim() ? { cidade: f.cidade.trim() } : {}),
            limite: Number(f.limite),
          },
      null,
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {/* ---- Perfis prontos ---------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Perfis de cliente ideal</h2>
            <p className="text-sm text-text-muted">
              Buscas prontas para salão, estética e cabeleireiro. Um clique.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={f.cidade}
              onChange={(e) => set("cidade", e.target.value)}
              className="h-9 w-44 rounded-full"
              aria-label="Cidade dos perfis"
            />
            <Input
              value={f.uf}
              onChange={(e) => set("uf", e.target.value)}
              maxLength={2}
              className="h-9 w-16 rounded-full text-center uppercase"
              aria-label="UF"
            />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => rodarPreset(p)}
              disabled={buscando}
              className={`group flex flex-col gap-3 rounded-2xl border p-5 text-left transition-all disabled:opacity-60 ${TOM_CLASSES[p.tom]} ${
                presetAtivo === p.id ? "ring-2 ring-accent ring-offset-2 ring-offset-bg" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-base font-semibold leading-tight">{p.nome}</span>
                <span className="shrink-0 rounded-full bg-surface/70 px-2.5 py-1 text-xs font-medium">
                  {p.medido}
                </span>
              </div>
              <p className="text-sm leading-relaxed text-text-muted">{p.hipotese}</p>
              <span className="mt-auto inline-flex items-center gap-1.5 pt-1 text-sm font-medium">
                Buscar
                <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* ---- Busca livre -------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setAvancado((v) => !v)}
          className="flex w-fit items-center gap-2 text-sm font-medium text-text-muted transition-colors hover:text-text"
        >
          <Sliders size={16} />
          {avancado ? "Ocultar busca livre" : "Busca livre (outro nicho ou cidade)"}
        </button>

        {avancado ? (
          <div className="flex flex-col gap-4 rounded-2xl border bg-surface p-5">
            <div className="flex flex-wrap gap-2">
              {(["kipflow", "places"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => fontes[k].configured && setFonte(k)}
                  disabled={!fontes[k].configured}
                  title={fontes[k].configured ? undefined : `Falta ${fontes[k].missingEnv}`}
                  className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${
                    fonte === k ? "border-accent bg-accent-100 font-medium" : "hover:bg-surface-elevated"
                  } ${!fontes[k].configured ? "cursor-not-allowed opacity-50" : ""}`}
                >
                  {FONTE_LABELS[k]?.nome}
                </button>
              ))}
            </div>

            <p className="text-sm text-text-muted">{FONTE_LABELS[fonte]?.acha}</p>

            {!fontes[fonte].configured ? (
              <p className="rounded-xl bg-surface-elevated px-4 py-3 text-sm text-text-muted">
                Falta a variável <code className="font-mono">{fontes[fonte].missingEnv}</code> no{" "}
                <code className="font-mono">.env</code>. Configure e reinicie para habilitar.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-4">
                {fonte === "places" ? (
                  <div className="grid gap-1.5 sm:col-span-2">
                    <Label htmlFor="b-nicho">O que procurar</Label>
                    <Input
                      id="b-nicho"
                      value={f.nicho}
                      onChange={(e) => set("nicho", e.target.value)}
                      placeholder="salão de beleza"
                      onKeyDown={(e) => e.key === "Enter" && buscarManual()}
                    />
                  </div>
                ) : (
                  <div className="grid gap-1.5 sm:col-span-2">
                    <Label htmlFor="b-cnae">CNAE</Label>
                    <Input
                      id="b-cnae"
                      value={f.cnae}
                      onChange={(e) => set("cnae", e.target.value)}
                      placeholder="9602-5/01"
                      onKeyDown={(e) => e.key === "Enter" && buscarManual()}
                    />
                  </div>
                )}
                <div className="grid gap-1.5">
                  <Label htmlFor="b-limite">Máx. resultados</Label>
                  <Input
                    id="b-limite"
                    type="number"
                    value={f.limite}
                    onChange={(e) => set("limite", e.target.value)}
                  />
                </div>
                <div className="flex items-end">
                  <Button onClick={buscarManual} disabled={buscando} className="w-full">
                    <MagnifyingGlass size={16} />
                    Buscar
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </section>

      {/* ---- Resultado ---------------------------------------------------- */}
      {buscando ? (
        <div className="rounded-2xl border border-dashed p-12 text-center text-sm text-text-muted">
          Consultando a base…
        </div>
      ) : achados !== null ? (
        achados.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed p-12 text-center">
            <Buildings size={36} className="text-text-subtle" weight="duotone" />
            <p className="text-sm text-text-muted">
              Nenhuma empresa com esses critérios. Tente outra cidade ou afrouxe o perfil.
            </p>
          </div>
        ) : (
          <section className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-text-muted">
                <strong className="text-text">{meta.total}</strong> encontrada(s) ·{" "}
                <strong className="text-text">{meta.novas}</strong> nova(s)
                {meta.requisicoes ? ` · ${meta.requisicoes} requisição(ões)` : ""}
                {meta.custo_cents ? ` · R$ ${(meta.custo_cents / 100).toFixed(2)}` : ""}
              </p>
              <Button asChild variant="secondary">
                <Link href="/app/kanban">Abrir o Kanban</Link>
              </Button>
            </div>

            <div className="overflow-hidden rounded-2xl border bg-surface">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="bg-surface-elevated text-left text-xs uppercase tracking-wide text-text-muted">
                    <tr>
                      <th className="px-4 py-3 font-medium">Empresa</th>
                      <th className="px-4 py-3 font-medium">Cidade</th>
                      <th className="px-4 py-3 font-medium">Telefone</th>
                      <th className="px-4 py-3 font-medium">Site</th>
                    </tr>
                  </thead>
                  <tbody>
                    {achados.map((a, i) => (
                      <tr
                        key={a.place_id ?? a.cnpj ?? i}
                        className="border-t transition-colors hover:bg-surface-elevated/50"
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium">{a.name}</div>
                          <div className="flex items-center gap-2 text-xs text-text-muted">
                            {a.cnpj ? <span className="font-mono">{a.cnpj}</span> : null}
                            {a.ja_conhecida ? (
                              <Badge variant="outline">já conhecida</Badge>
                            ) : (
                              <Badge>nova · foi para o Kanban</Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-text-muted">{a.city ?? "—"}</td>
                        <td className="px-4 py-3 text-text-muted">{a.phone ?? "—"}</td>
                        <td className="max-w-[220px] truncate px-4 py-3 text-text-muted">
                          {a.website ?? (
                            <span className="text-accent-600">sem site</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )
      ) : null}
    </div>
  );
}
