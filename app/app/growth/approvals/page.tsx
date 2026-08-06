import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { sessaoDisponivel } from "@/lib/growth/envio";
import { FilaAprovacao, type ItemFila } from "./_components/FilaAprovacao";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  if (ROLE_RANK[org.role] < ROLE_RANK.manager) redirect("/403");

  const admin = createAdminClient();

  const { data: decisoes } = await admin
    .from("growth_sdr_decisions")
    .select("id, company_id, reasoning, message_draft, send_error, decided_at")
    .eq("organization_id", org.orgId)
    .eq("approval_status", "pending")
    .order("decided_at", { ascending: false })
    .limit(50);

  const ids = (decisoes ?? []).map((d) => d.company_id as string);

  const [{ data: empresas }, { data: canais }] = await Promise.all([
    ids.length
      ? admin.from("growth_companies").select("id, name, city").in("id", ids)
      : Promise.resolve({ data: [] as never[] }),
    ids.length
      ? admin
          .from("growth_enrichment")
          .select("company_id, whatsapp, instagram_url, email, website_url")
          .in("company_id", ids)
      : Promise.resolve({ data: [] as never[] }),
  ]);

  const emp = new Map((empresas ?? []).map((e) => [e.id as string, e]));
  const can = new Map((canais ?? []).map((c) => [c.company_id as string, c]));

  const itens: ItemFila[] = (decisoes ?? []).map((d) => ({
    id: d.id as string,
    empresa: (emp.get(d.company_id as string)?.name as string) ?? "(removida)",
    cidade: (emp.get(d.company_id as string)?.city as string) ?? null,
    porque: d.reasoning as string,
    rascunho: (d.message_draft as string) ?? "",
    whatsapp: (can.get(d.company_id as string)?.whatsapp as string) ?? null,
    instagram: (can.get(d.company_id as string)?.instagram_url as string) ?? null,
    email: (can.get(d.company_id as string)?.email as string) ?? null,
    erroAnterior: (d.send_error as string) ?? null,
  }));

  const sessao = await sessaoDisponivel(admin, org.orgId);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Aprovar mensagens</h1>
        <p className="mt-1 text-sm text-text-muted">
          Nenhuma mensagem de prospecção sai sem você ler. Edite o que quiser antes de aprovar.
        </p>
      </header>

      <FilaAprovacao itens={itens} whatsappConectado={sessao !== null} />
    </div>
  );
}
