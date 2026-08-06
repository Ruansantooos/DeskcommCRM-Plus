"use client";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import { cn } from "@/lib/utils";

interface AppShellProps {
  sidebarCollapsed: boolean;
  children: ReactNode;
}

/**
 * Casca do app.
 *
 * O conteúdo vive num painel branco arredondado FLUTUANDO sobre o fundo, em vez
 * de encostar nas bordas da janela. Duas razões, nesta ordem:
 *
 *   1. Separa navegação de trabalho por geometria, não por linha divisória —
 *      a borda dura entre sidebar e conteúdo endurecia a tela inteira.
 *   2. Dá à página um limite visível. Sem ele, tabela larga e card solto
 *      pareciam soltos no vazio, e era o que fazia o app parecer painel
 *      administrativo em vez de produto.
 *
 * `min-h-0` no wrapper é o que permite o painel rolar por dentro em vez de
 * esticar a página — sem ele o flex-1 cresce e o scroll vai para o body.
 */
export function AppShell({ sidebarCollapsed, children }: AppShellProps) {
  return (
    <div className="flex h-screen w-full bg-background">
      <Sidebar collapsed={sidebarCollapsed} />
      <div
        className={cn(
          "flex h-screen min-h-0 flex-1 flex-col transition-[margin] duration-200",
          sidebarCollapsed ? "ml-16" : "ml-60",
        )}
      >
        <TopBar />
        <div className="min-h-0 flex-1 pb-3 pr-3">
          <main className="h-full overflow-auto rounded-2xl bg-surface shadow-sm">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
