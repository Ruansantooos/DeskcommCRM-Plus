"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FONTE_LABELS, growthAgentCreateSchema } from "@/lib/growth/schemas";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Fonte = "places" | "kipflow";

/**
 * A validação usa o MESMO schema Zod do servidor: um contrato, duas checagens.
 * Duplicar as regras aqui é como o form passa a aceitar o que a API recusa.
 */
export function NewGrowthAgentDialog({ open, onOpenChange }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [erros, setErros] = useState<Record<string, string[]>>({});
  const [fonte, setFonte] = useState<Fonte | null>(null);
  const [form, setForm] = useState({
    name: "",
    // places
    nicho: "",
    cidade: "",
    raio_km: "10",
    // kipflow
    cnae: "",
    uf: "",
    faturamento_min: "",
    faturamento_max: "",
    // comum
    limite: "25",
  });

  function set(campo: keyof typeof form, valor: string) {
    setForm((f) => ({ ...f, [campo]: valor }));
  }

  function fechar() {
    onOpenChange(false);
    setFonte(null);
    setErros({});
  }

  async function submit() {
    if (!fonte) return;
    setErros({});

    const params =
      fonte === "places"
        ? {
            fonte: "places" as const,
            nicho: form.nicho,
            cidade: form.cidade,
            raio_km: Number(form.raio_km),
            limite_por_execucao: Number(form.limite),
          }
        : {
            fonte: "kipflow" as const,
            ...(form.cnae.trim()
              ? { cnae: form.cnae.split(",").map((s) => s.trim()).filter(Boolean) }
              : {}),
            ...(form.uf.trim() ? { uf: form.uf.trim().toUpperCase() } : {}),
            ...(form.cidade.trim() ? { cidade: form.cidade.trim() } : {}),
            ...(form.faturamento_min
              ? { faturamento_min_cents: Math.round(Number(form.faturamento_min) * 100) }
              : {}),
            ...(form.faturamento_max
              ? { faturamento_max_cents: Math.round(Number(form.faturamento_max) * 100) }
              : {}),
            limite_por_execucao: Number(form.limite),
          };

    const parsed = growthAgentCreateSchema.safeParse({
      kind: "maps",
      name: form.name,
      params,
    });

    if (!parsed.success) {
      setErros(
        Object.fromEntries(
          parsed.error.issues.map((i) => [
            String(i.path[i.path.length - 1] ?? "form"),
            [i.message],
          ]),
        ),
      );
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/v1/growth/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error?.message ?? "Não foi possível criar o agente.");
        return;
      }
      toast.success("Agente criado.");
      fechar();
      setForm({
        name: "",
        nicho: "",
        cidade: "",
        raio_km: "10",
        cnae: "",
        uf: "",
        faturamento_min: "",
        faturamento_max: "",
        limite: "25",
      });
      router.refresh();
    } catch {
      toast.error("Falha de rede.");
    } finally {
      setSaving(false);
    }
  }

  const erro = (campo: string) => erros[campo]?.[0];

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : fechar())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Novo agente de prospecção</DialogTitle>
          <DialogDescription>
            {fonte
              ? FONTE_LABELS[fonte]?.acha
              : "Primeiro, de onde as empresas devem vir. As duas fontes acham mercados diferentes — não é a mesma lista com qualidade diferente."}
          </DialogDescription>
        </DialogHeader>

        {/* Passo 1: a fonte. É escolha estrutural, não preferência — por isso
            vem antes de qualquer campo, e os campos mudam conforme ela. */}
        {!fonte ? (
          <div className="grid gap-3 py-2">
            {(["places", "kipflow"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFonte(f)}
                className="rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-accent"
              >
                <span className="font-medium">{FONTE_LABELS[f]?.nome}</span>
                <p className="mt-1 text-sm text-muted-foreground">{FONTE_LABELS[f]?.acha}</p>
              </button>
            ))}
          </div>
        ) : (
          <div className="grid gap-4 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ga-name">Nome do agente</Label>
              <Input
                id="ga-name"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder={fonte === "places" ? "Clínicas de BH" : "E-commerces MG médio porte"}
              />
              {erro("name") ? <p className="text-xs text-destructive">{erro("name")}</p> : null}
            </div>

            {fonte === "places" ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="ga-nicho">Nicho</Label>
                  <Input
                    id="ga-nicho"
                    value={form.nicho}
                    onChange={(e) => set("nicho", e.target.value)}
                    placeholder="clínica odontológica"
                  />
                  {erro("nicho") ? (
                    <p className="text-xs text-destructive">{erro("nicho")}</p>
                  ) : null}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="ga-cidade">Cidade</Label>
                    <Input
                      id="ga-cidade"
                      value={form.cidade}
                      onChange={(e) => set("cidade", e.target.value)}
                      placeholder="Belo Horizonte"
                    />
                    {erro("cidade") ? (
                      <p className="text-xs text-destructive">{erro("cidade")}</p>
                    ) : null}
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ga-raio">Raio (km)</Label>
                    <Input
                      id="ga-raio"
                      type="number"
                      value={form.raio_km}
                      onChange={(e) => set("raio_km", e.target.value)}
                    />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="ga-cnae">CNAE (separe por vírgula)</Label>
                  <Input
                    id="ga-cnae"
                    value={form.cnae}
                    onChange={(e) => set("cnae", e.target.value)}
                    placeholder="4781400, 4771701"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="ga-uf">UF</Label>
                    <Input
                      id="ga-uf"
                      maxLength={2}
                      value={form.uf}
                      onChange={(e) => set("uf", e.target.value)}
                      placeholder="MG"
                    />
                    {erro("uf") ? <p className="text-xs text-destructive">{erro("uf")}</p> : null}
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ga-cidade-k">Cidade (opcional)</Label>
                    <Input
                      id="ga-cidade-k"
                      value={form.cidade}
                      onChange={(e) => set("cidade", e.target.value)}
                      placeholder="Belo Horizonte"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="ga-fat-min">Faturamento mín. (R$)</Label>
                    <Input
                      id="ga-fat-min"
                      type="number"
                      value={form.faturamento_min}
                      onChange={(e) => set("faturamento_min", e.target.value)}
                      placeholder="500000"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ga-fat-max">Faturamento máx. (R$)</Label>
                    <Input
                      id="ga-fat-max"
                      type="number"
                      value={form.faturamento_max}
                      onChange={(e) => set("faturamento_max", e.target.value)}
                      placeholder="5000000"
                    />
                  </div>
                </div>
              </>
            )}

            <div className="grid gap-1.5">
              <Label htmlFor="ga-limite">Empresas por execução</Label>
              <Input
                id="ga-limite"
                type="number"
                value={form.limite}
                onChange={(e) => set("limite", e.target.value)}
              />
              {erro("limite_por_execucao") ? (
                <p className="text-xs text-destructive">{erro("limite_por_execucao")}</p>
              ) : null}
            </div>

            <p className="text-xs text-muted-foreground">
              {fonte === "kipflow"
                ? "O plano da Kipflow é por quota mensal de requisições, e cada empresa consome mais de uma. Este número existe para você não queimar o mês numa tarde de testes."
                : "Cada empresa custa uma busca no Places, um acesso ao site e uma chamada de IA — tudo dentro de uma execução. Por isso o lote é pequeno."}
            </p>
          </div>
        )}

        <DialogFooter>
          {fonte ? (
            <Button variant="ghost" onClick={() => setFonte(null)} disabled={saving}>
              Voltar
            </Button>
          ) : null}
          <Button variant="ghost" onClick={fechar} disabled={saving}>
            Cancelar
          </Button>
          {fonte ? (
            <Button onClick={submit} disabled={saving}>
              {saving ? "Criando…" : "Criar agente"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
