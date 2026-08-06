"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Binoculars, Play, Pause, Plus } from "@phosphor-icons/react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { GROWTH_AGENT_LABELS, type GrowthAgentKind } from "@/lib/growth/schemas";
import { NewGrowthAgentDialog } from "./NewGrowthAgentDialog";

export interface GrowthAgentView {
  id: string;
  kind: GrowthAgentKind;
  name: string;
  params: Record<string, unknown>;
  schedule_cron: string | null;
  is_active: boolean;
  provider: { configured: boolean; missingEnv: string | null };
  active_run: { status: string; started_at: string | null } | null;
}

interface Props {
  initialData: GrowthAgentView[];
  canWrite: boolean;
}

export function GrowthAgentsList({ initialData, canWrite }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  async function act(id: string, path: string, body?: unknown) {
    setBusy(id);
    try {
      const res = await fetch(`/api/v1/growth/agents/${id}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const json = await res.json();
      if (!res.ok) {
        // A mensagem do servidor já é escrita para o usuário final — inclusive
        // a que nomeia a env faltando. Substituí-la por texto genérico aqui
        // apagaria a única pista acionável.
        toast.error(json?.error?.message ?? "Não foi possível concluir.");
        return;
      }
      router.refresh();
    } catch {
      toast.error("Falha de rede.");
    } finally {
      setBusy(null);
    }
  }

  if (initialData.length === 0) {
    return (
      <>
        <Card className="flex flex-col items-center gap-3 border-dashed p-12 text-center">
          <Binoculars size={40} className="text-muted-foreground" weight="duotone" />
          <div>
            <h2 className="font-medium">Nenhum agente de prospecção ainda</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Um agente de prospecção procura empresas por nicho e cidade, descobre site e
              contato, e coloca as boas no seu funil — sem você procurar uma a uma.
            </p>
          </div>
          {canWrite ? (
            <Button onClick={() => setDialogOpen(true)} className="mt-2">
              <Plus size={16} /> Criar primeiro agente
            </Button>
          ) : null}
        </Card>
        <NewGrowthAgentDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      </>
    );
  }

  return (
    <>
      {canWrite ? (
        <div className="flex justify-end">
          <Button onClick={() => setDialogOpen(true)} size="sm">
            <Plus size={16} /> Novo agente
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {initialData.map((agent) => {
          const label = GROWTH_AGENT_LABELS[agent.kind];
          const rodando = agent.active_run !== null;
          const bloqueado = !agent.provider.configured;

          return (
            <Card key={agent.id} className="flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate font-medium">{agent.name}</h3>
                  <p className="text-xs text-muted-foreground">{label.nome}</p>
                </div>
                {/* O estado vem de fato observável, não de um "online" decorativo:
                    ou há run em andamento, ou o agente está pausado, ou falta env. */}
                {bloqueado ? (
                  <Badge variant="outline">não configurado</Badge>
                ) : rodando ? (
                  <Badge>executando</Badge>
                ) : agent.is_active ? (
                  <Badge variant="secondary">ativo</Badge>
                ) : (
                  <Badge variant="outline">pausado</Badge>
                )}
              </div>

              <p className="text-sm text-muted-foreground">{label.faz}</p>

              {bloqueado ? (
                <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  Falta a variável <code className="font-mono">{agent.provider.missingEnv}</code>{" "}
                  nesta instalação. Configure no <code className="font-mono">.env</code> e
                  reinicie para habilitar.
                </p>
              ) : null}

              {agent.kind === "maps" && typeof agent.params.cidade === "string" ? (
                <dl className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
                  <dt>Cidade</dt>
                  <dd className="text-right text-foreground">{String(agent.params.cidade)}</dd>
                  <dt>Nicho</dt>
                  <dd className="truncate text-right text-foreground">
                    {String(agent.params.nicho ?? "—")}
                  </dd>
                  <dt>Limite/dia</dt>
                  <dd className="text-right text-foreground">
                    {String(agent.params.limite_diario ?? "—")}
                  </dd>
                </dl>
              ) : null}

              {canWrite ? (
                <div className="mt-auto flex gap-2 pt-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="flex-1"
                    // Desabilitar aqui é o que evita o usuário clicar e tomar
                    // 409/422 — a regra do servidor continua valendo, esta é a
                    // sua projeção honesta na tela.
                    disabled={busy === agent.id || rodando || bloqueado || !agent.is_active}
                    onClick={() => act(agent.id, "run")}
                  >
                    <Play size={14} />
                    {rodando ? "Em execução" : "Executar agora"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === agent.id}
                    onClick={() => act(agent.id, "pause", { active: !agent.is_active })}
                    aria-label={agent.is_active ? "Pausar agente" : "Retomar agente"}
                  >
                    {agent.is_active ? <Pause size={14} /> : <Play size={14} />}
                  </Button>
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      <NewGrowthAgentDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
