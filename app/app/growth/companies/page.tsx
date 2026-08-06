import { redirect } from "next/navigation";
import { Buildings } from "@phosphor-icons/react/dist/ssr";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";

export const dynamic = "force-dynamic";

interface CompanyRow {
  id: string;
  name: string;
  city: string | null;
  category: string | null;
  phone: string | null;
  created_at: string;
}

export default async function GrowthCompaniesPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const admin = createAdminClient();
  const { data } = await admin
    .from("growth_companies")
    .select("id, name, city, category, phone, created_at")
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false })
    .limit(100);

  const companies = (data ?? []) as CompanyRow[];

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Empresas descobertas</h1>
        <p className="text-sm text-muted-foreground">
          O que os agentes de prospecção encontraram. Daqui saem os leads que entram no funil.
        </p>
      </header>

      {companies.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 border-dashed p-12 text-center">
          <Buildings size={40} className="text-muted-foreground" weight="duotone" />
          <div>
            <h2 className="font-medium">Nenhuma empresa descoberta ainda</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Crie um agente de prospecção e execute — as empresas encontradas aparecem aqui,
              com contato e diagnóstico.
            </p>
          </div>
        </Card>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">Empresa</th>
                <th className="pb-2 font-medium">Cidade</th>
                <th className="pb-2 font-medium">Categoria</th>
                <th className="pb-2 font-medium">Telefone</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id} className="border-b last:border-0">
                  <td className="py-2 font-medium">{c.name}</td>
                  {/* "—" é ausência de dado coletado; a tela de detalhe é que
                      distingue "não encontrado" de "ainda não analisado". */}
                  <td className="py-2 text-muted-foreground">{c.city ?? "—"}</td>
                  <td className="py-2 text-muted-foreground">{c.category ?? "—"}</td>
                  <td className="py-2 text-muted-foreground">{c.phone ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
