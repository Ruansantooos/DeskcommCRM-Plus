"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle, InstagramLogo, WarningCircle, WhatsappLogo, XCircle } from "@phosphor-icons/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export interface ItemFila {
  id: string;
  empresa: string;
  cidade: string | null;
  porque: string;
  rascunho: string;
  whatsapp: string | null;
  instagram: string | null;
  email: string | null;
  erroAnterior: string | null;
}

/** Teto do servidor. Espelhado aqui para o contador avisar ANTES do 422. */
const MAX = 900;

export function FilaAprovacao({
  itens,
  whatsappConectado,
}: {
  itens: ItemFila[];
  whatsappConectado: boolean;
}) {
  const router = useRouter();
  const [textos, setTextos] = useState<Record<string, string>>(
    Object.fromEntries(itens.map((i) => [i.id, i.rascunho])),
  );
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [resolvidos, setResolvidos] = useState<Set<string>>(new Set());

  async function decidir(item: ItemFila, acao: "aprovar" | "rejeitar") {
    setOcupado(item.id);
    try {
      const res = await fetch(`/api/v1/growth/approvals/${item.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          acao === "aprovar" ? { acao, mensagem: textos[item.id] ?? "" } : { acao },
        ),
      });
      const json = await res.json();

      if (!res.ok) {
        // A mensagem do servidor explica a causa real (janela, limite, sessão).
        toast.error(json?.error?.message ?? "Não foi possível concluir.");
        return;
      }

      setResolvidos((s) => new Set(s).add(item.id));
      toast.success(
        acao === "aprovar" ? `Mensagem enviada para ${item.empresa}.` : "Descartado.",
      );
      router.refresh();
    } catch {
      toast.error("Falha de rede.");
    } finally {
      setOcupado(null);
    }
  }

  const restantes = itens.filter((i) => !resolvidos.has(i.id));

  if (restantes.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed p-12 text-center">
        <CheckCircle size={36} weight="duotone" className="text-accent-500" />
        <p className="font-medium">Fila vazia</p>
        <p className="max-w-md text-sm text-text-muted">
          Nada esperando aprovação. Novas mensagens aparecem aqui quando a prospecção encontrar
          empresas com canal de contato.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Sem WhatsApp conectado nada sai. Avisar ANTES é o que evita o usuário
          revisar vinte mensagens e só então descobrir. */}
      {!whatsappConectado ? (
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-bg p-4">
          <WarningCircle size={20} weight="duotone" className="mt-0.5 shrink-0" />
          <p className="text-sm">
            <strong>Nenhum WhatsApp conectado.</strong> Você pode revisar e editar, mas o envio vai
            falhar até conectar um número em <em>Canais → Conexões</em>.
          </p>
        </div>
      ) : null}

      <p className="text-sm text-text-muted">
        {restantes.length} mensagem(ns) esperando revisão.
      </p>

      {restantes.map((item) => {
        const texto = textos[item.id] ?? "";
        const excedeu = texto.length > MAX;
        const semWhatsapp = !item.whatsapp;

        return (
          <article key={item.id} className="flex flex-col gap-3 rounded-2xl border bg-surface p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="font-semibold">{item.empresa}</h2>
                {item.cidade ? (
                  <p className="text-xs text-text-muted">{item.cidade}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {item.whatsapp ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2.5 py-1">
                    <WhatsappLogo size={13} weight="fill" /> {item.whatsapp}
                  </span>
                ) : null}
                {item.instagram ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-info-bg px-2.5 py-1">
                    <InstagramLogo size={13} weight="fill" />
                    {item.instagram.replace(/^https?:\/\/(www\.)?instagram\.com\//, "@")}
                  </span>
                ) : null}
              </div>
            </div>

            {/* O porquê da decisão. Sem ele a fila vira caixa-preta e o operador
                aprova no automático — que é o oposto do gate existir. */}
            <p className="rounded-xl bg-surface-elevated px-4 py-2.5 text-xs leading-relaxed text-text-muted">
              {item.porque}
            </p>

            {item.erroAnterior ? (
              <p className="rounded-xl border border-warning/30 bg-warning-bg px-4 py-2.5 text-xs">
                Tentativa anterior falhou: {item.erroAnterior}
              </p>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <Textarea
                value={texto}
                onChange={(e) => setTextos((t) => ({ ...t, [item.id]: e.target.value }))}
                rows={4}
                className="resize-y"
                aria-label={`Mensagem para ${item.empresa}`}
              />
              <div className="flex items-center justify-between text-xs">
                <span className={excedeu ? "text-destructive" : "text-text-subtle"}>
                  {texto.length}/{MAX}
                </span>
                {semWhatsapp ? (
                  <span className="text-text-muted">
                    Sem telefone — o envio automático não alcança. Fale pelo Instagram.
                  </span>
                ) : null}
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={ocupado === item.id || excedeu || texto.trim().length < 10 || semWhatsapp}
                onClick={() => decidir(item, "aprovar")}
              >
                <CheckCircle size={15} weight="bold" />
                {ocupado === item.id ? "Enviando…" : "Aprovar e enviar"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={ocupado === item.id}
                onClick={() => decidir(item, "rejeitar")}
              >
                <XCircle size={15} /> Descartar
              </Button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
