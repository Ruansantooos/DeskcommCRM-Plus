import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { fonteConfigurada } from "@/lib/growth/providers/discovery";
import { BuscaManual } from "./_components/BuscaManual";

export const dynamic = "force-dynamic";

export default async function GrowthSearchPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  // A tela precisa saber, ANTES de desenhar o formulário, quais fontes estão
  // configuradas — para não oferecer uma busca que vai voltar 422.
  const fontes = {
    places: fonteConfigurada("places"),
    kipflow: fonteConfigurada("kipflow"),
  };

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Buscar empresas</h1>
        <p className="text-sm text-muted-foreground">
          Diga o que procura. Tudo o que a busca encontrar entra direto no Kanban, na etapa
          &ldquo;A triar&rdquo; — a requisição já foi paga, então nada se perde.
        </p>
      </header>

      <BuscaManual fontes={fontes} />
    </div>
  );
}
