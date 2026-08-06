#!/bin/sh
# Agenda os crons do DeskcommCRM a partir de FORA da Vercel.
#
# Por que existe: o plano Hobby da Vercel permite 2 cron jobs, e só uma vez por
# dia — o sistema precisa de 11, quatro deles a cada minuto. Em vez de amarrar o
# produto a um plano pago, o agendamento sai de casa: qualquer máquina com cron
# (a mesma VPS que já roda o WAHA, por exemplo) bate nos endpoints.
#
# É o mesmo desenho do serviço `scheduler` do docker-compose.prod.yml — só que
# apontando para uma URL pública em vez da rede interna.
#
# Uso na VPS:
#   export APP_URL=https://seu-app.vercel.app
#   export INTERNAL_SECRET=<o mesmo do .env da Vercel>
#   ./scripts/cron-externo.sh instalar    # escreve no crontab
#   ./scripts/cron-externo.sh agora       # roda uma vez, para testar
set -eu

: "${APP_URL:?defina APP_URL (ex.: https://seu-app.vercel.app)}"
: "${INTERNAL_SECRET:?defina INTERNAL_SECRET (o mesmo valor do .env da Vercel)}"

bater() {
  # -f faz o curl falhar em 4xx/5xx: 401 silencioso é o modo de falha que este
  # script existe para tornar visível.
  curl -fsS -m "$2" -H "Authorization: Bearer $INTERNAL_SECRET" \
    "$APP_URL/api/v1/cron/$1" >/dev/null 2>&1 \
    || echo "[cron-externo] FALHOU: $1"
}

agora() {
  bater agent-dispatcher 25
  bater followup-flow-worker 25
  bater event-log-drain 45
  bater routing-worker 25
  bater snooze-watcher 25
  bater attendant-heartbeat 25
  bater "storage-redaction?limit=50" 25
  bater contact-avatars 60
  bater risk-watcher 60
  echo "[cron-externo] ciclo concluído"
}

instalar() {
  AQUI="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  TMP=$(mktemp)
  crontab -l 2>/dev/null | grep -v 'cron-externo.sh' > "$TMP" || true
  cat >> "$TMP" <<EOF
* * * * * APP_URL=$APP_URL INTERNAL_SECRET=$INTERNAL_SECRET $AQUI minuto
*/5 * * * * APP_URL=$APP_URL INTERNAL_SECRET=$INTERNAL_SECRET $AQUI cinco
*/15 * * * * APP_URL=$APP_URL INTERNAL_SECRET=$INTERNAL_SECRET $AQUI quinze
0 12 * * * APP_URL=$APP_URL INTERNAL_SECRET=$INTERNAL_SECRET $AQUI diario
EOF
  crontab "$TMP" && rm -f "$TMP"
  echo "crontab instalado. Confira com: crontab -l"
}

case "${1:-agora}" in
  minuto)  bater agent-dispatcher 25; bater followup-flow-worker 25
           bater event-log-drain 45;  bater routing-worker 25 ;;
  cinco)   bater "storage-redaction?limit=50" 25; bater snooze-watcher 25
           bater attendant-heartbeat 25 ;;
  quinze)  bater risk-watcher 60; bater contact-avatars 60 ;;
  diario)  bater lgpd-sla-watcher 60; bater kb-conversations-batch 120 ;;
  agora)   agora ;;
  instalar) instalar ;;
  *) echo "uso: $0 [agora|instalar|minuto|cinco|quinze|diario]"; exit 1 ;;
esac
