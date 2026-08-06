# Deploy na Vercel (app) + VPS (só WAHA)

Desenho para quem já tem o WAHA rodando numa VPS e quer o app fora dela.
Faz sentido em VPS pequena: o app e os 11 crons saem de cima do servidor e
sobra CPU para o WAHA, que é o único componente sem alternativa serverless.

| Componente | Onde | Por quê |
|---|---|---|
| App Next.js | Vercel | plataforma nativa; escala sozinho |
| 11 crons | Vercel Cron | paridade 1:1 com o `scheduler` do `docker-compose.prod.yml` |
| WAHA | VPS | container COM ESTADO: segura a sessão do WhatsApp aberta. Não existe em serverless |
| Postgres | Supabase | já é externo |
| Redis | Upstash | REST, serverless-friendly |

## 1. A armadilha que faz os 11 crons falharem em silêncio

Os endpoints `/api/v1/cron/*` exigem `Authorization: Bearer <INTERNAL_CRON_SECRET>`
(com fallback para `INTERNAL_SECRET`). O Vercel Cron manda
`Authorization: Bearer $CRON_SECRET` — **outro nome de variável**.

Se os valores não forem iguais, todo cron responde 401 e nada processa:
mensagem chega no WhatsApp e o agente nunca responde, sem erro na tela.

**Defina as três com o MESMO valor** nas env vars do projeto Vercel:

```
INTERNAL_SECRET      = <mesmo segredo>
INTERNAL_CRON_SECRET = <mesmo segredo>
CRON_SECRET          = <mesmo segredo>
```

## 2. Os dois lados precisam se enxergar

O app na Vercel chama o WAHA, e o WAHA chama de volta o app:

```
WAHA_API_BASE_URL     = https://waha.seudominio.com     (a VPS, vista da Vercel)
WAHA_WEBHOOK_BASE_URL = https://seu-app.vercel.app      (a Vercel, vista da VPS)
```

**O WAHA precisa estar publicamente acessível — e isso é uma superfície de
ataque real.** Quem alcança o WAHA com a API key controla o seu WhatsApp:
lê conversas, envia em seu nome. Mínimos não negociáveis:

- HTTPS na frente (Caddy/nginx), nunca `http://` puro na internet
- `WAHA_API_KEY` longa e aleatória (o container recebe o **hash SHA512**, o app o plaintext)
- firewall permitindo só as faixas da Vercel, se possível
- `WAHA_HMAC_SECRET` definido e `WAHA_WEBHOOK_REQUIRE_SIGNATURE=true` (exige WAHA Plus)

## 3. Limite de tempo de execução

`maxDuration` no plano Hobby é **60s**; a rota de execução de prospecção pede
300s. Um lote de 25 empresas faz 25 fetches de site + 25 chamadas de IA e
estoura.

- **Plano Pro**: funciona como está.
- **Hobby**: reduza `limite_por_execucao` do agente para ~8 empresas. O
  resultado é o mesmo, em mais execuções.

## 4. Variáveis mínimas no projeto Vercel

Supabase (3), os três segredos da §1, `WAHA_*` da §2, as chaves de
criptografia (`CPF_ENCRYPTION_KEY`, `WAHA_BYO_ENCRYPTION_KEY`,
`AI_CRED_AES_KEY`), Upstash (2) e — para a prospecção — `KIPFLOW_API_KEY`.

## 5. Depois de subir

Confira que os crons estão vivos: **Vercel → Project → Cron Jobs**. Todos
devem mostrar execução recente com 200. Um 401 aqui é a §1.
