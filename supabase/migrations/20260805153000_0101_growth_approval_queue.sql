-- =============================================================================
-- 0101 — Fila de aprovação humana da prospecção (EPIC-14)
--
-- Decisão de produto de 2026-08-05: NENHUMA mensagem de prospecção sai sem um
-- humano ler e aprovar. Mensagem fria no WhatsApp para empresa que nunca
-- procurou a gente é o vetor de banimento que toda a doutrina anti-ban do
-- CLAUDE.md existe para evitar — e o throttle protege o ritmo, não protege de
-- denúncia por spam. Quem denuncia é o destinatário.
--
-- Forward-fix sobre a 0100 (que já foi para o baseline): a 0100 modelava o SDR
-- decidindo e promovendo direto ao funil. Estas colunas inserem o gate humano
-- entre a decisão e o envio.
--
-- O envio em si NÃO é modelado aqui: reusa `lib/automation/send-whatsapp.ts`,
-- que já tem janela de horário, limite diário por sessão, espaçamento e jitter.
-- =============================================================================

alter table public.growth_sdr_decisions
  -- 'not_applicable' é o estado dos verdicts 'cold'/'manual_review': eles não
  -- geram mensagem, então não podem ficar eternamente 'pending' poluindo a fila.
  add column if not exists approval_status text not null default 'pending',
  -- O que a IA sugeriu. Preservado mesmo depois de editado, para dar para
  -- comparar sugestão e versão final — é assim que se calibra o prompt.
  add column if not exists message_draft text,
  -- O que o humano de fato aprovou. NULL enquanto não aprovado.
  add column if not exists message_final text,
  add column if not exists approved_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists sent_at timestamptz,
  add column if not exists send_error text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'growth_sdr_decisions_approval_status_check'
  ) then
    alter table public.growth_sdr_decisions
      add constraint growth_sdr_decisions_approval_status_check
      check (approval_status in ('pending', 'approved', 'rejected', 'sent', 'failed', 'not_applicable'));
  end if;
end
$$;

-- A fila é sempre lida pelo mesmo recorte: o que está esperando gente olhar.
-- Índice parcial porque 'sent' e 'rejected' acumulam para sempre e nunca são
-- consultados por esta tela.
create index if not exists growth_sdr_decisions_fila_idx
  on public.growth_sdr_decisions (organization_id, decided_at desc)
  where approval_status = 'pending';

comment on column public.growth_sdr_decisions.approval_status is
  'Gate humano obrigatório antes do envio. pending -> approved -> sent, ou rejected. '
  'cold/manual_review nascem not_applicable (não geram mensagem).';

notify pgrst, 'reload schema';
