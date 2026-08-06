/**
 * Sobe o CRM inteiro na máquina local, alcançável pela internet.
 *
 *   node scripts/rodar-local.mjs
 *
 * Faz quatro coisas que, feitas à mão, quebram em silêncio:
 *   1. sobe o app (produção — `next dev` é lento demais para uso real)
 *   2. abre o túnel do Cloudflare
 *   3. REAPONTA o webhook do WAHA para a URL nova do túnel
 *   4. bate nos crons a cada minuto (localhost, sem passar pelo túnel)
 *
 * ESTADO: parcialmente exercitado. Os passos 1, 2 e 3 foram feitos à mão nesta
 * sessão e funcionaram (o webhook reapontado recebeu uma mensagem real de
 * WhatsApp até o banco); o script que os encadeia NÃO chegou a rodar de ponta
 * a ponta. Trate a primeira execução como teste, não como rotina pronta.
 *
 * Duas armadilhas já medidas, e que este script evita:
 *   - `next start` NÃO funciona neste repo: ele usa `output: standalone` e o
 *     próprio Next recusa. Por isso aqui é `next dev`.
 *   - resíduo de `next build` em `.next` faz o dev servir 500 no middleware.
 *     Se acontecer: apague `.next` e suba de novo.
 *
 * O passo 3 é o motivo deste script existir. A URL do `trycloudflare` muda a
 * cada reinício; se o webhook continuar no endereço antigo, a mensagem chega
 * no WhatsApp, o WAHA tenta entregar num host morto, e NADA aparece no CRM —
 * sem erro em lugar nenhum. Já aconteceu nesta sessão.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const PORTA = 3001;
const WAHA = env.WAHA_API_BASE_URL?.replace(/\/+$/, "");
const CHAVE = env.WAHA_API_KEY;
const SEGREDO = env.INTERNAL_SECRET;

const log = (m) => console.log(`[local] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function iniciar(cmd, args, nome) {
  const p = spawn(cmd, args, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.stdout.write(`[${nome}] ${d}`));
  p.stderr.on("data", (d) => process.stdout.write(`[${nome}] ${d}`));
  return p;
}

async function esperarApp() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`http://localhost:${PORTA}/login`, { signal: AbortSignal.timeout(4000) });
      if (r.status < 500) return true;
    } catch {}
    await sleep(2000);
  }
  return false;
}

/** Lê a URL do túnel da saída do cloudflared. */
function urlDoTunel(proc) {
  return new Promise((resolve) => {
    const captar = (d) => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) resolve(m[0]);
    };
    proc.stdout.on("data", captar);
    proc.stderr.on("data", captar);
    setTimeout(() => resolve(null), 90_000);
  });
}

/**
 * Aponta o webhook da sessão para a URL nova, PRESERVANDO o resto da config.
 * Sobrescrever o objeto inteiro apagaria `gows`/`ignore` e mudaria o
 * comportamento da sessão do dono sem ele pedir.
 */
async function reapontarWebhook(base, token, sessao) {
  const atual = await fetch(`${WAHA}/api/sessions/${sessao}`, {
    headers: { "X-Api-Key": CHAVE },
  }).then((r) => r.json());

  const config = { ...(atual.config ?? {}) };
  config.webhooks = [
    {
      url: `${base}/api/v1/webhooks/waha/${token}`,
      // `message.any` e não só `message`: multi-device exige, senão mensagem
      // enviada pelo próprio celular do dono vira duplicata.
      events: ["message.any", "session.status", "message.ack"],
    },
  ];

  const r = await fetch(`${WAHA}/api/sessions/${sessao}`, {
    method: "PUT",
    headers: { "X-Api-Key": CHAVE, "content-type": "application/json" },
    body: JSON.stringify({ config }),
  });
  return r.ok;
}

const CRONS = {
  minuto: ["agent-dispatcher", "followup-flow-worker", "event-log-drain", "routing-worker"],
  cinco: ["storage-redaction?limit=50", "snooze-watcher", "attendant-heartbeat"],
  quinze: ["risk-watcher", "contact-avatars"],
};

async function baterCrons(lista) {
  for (const c of lista) {
    try {
      const r = await fetch(`http://localhost:${PORTA}/api/v1/cron/${c}`, {
        headers: { authorization: `Bearer ${SEGREDO}` },
        signal: AbortSignal.timeout(45_000),
      });
      // 401 aqui é o modo de falha silencioso que este log torna visível.
      if (!r.ok) log(`cron ${c} -> HTTP ${r.status}`);
    } catch {
      log(`cron ${c} -> falhou`);
    }
  }
}

async function main() {
  if (!WAHA || !CHAVE) {
    log("WAHA_API_BASE_URL ou WAHA_API_KEY ausentes no .env.local — abortando.");
    process.exit(1);
  }

  log("subindo o app…");
  const app = iniciar("npx", ["next", "start", "-p", String(PORTA)], "app");

  if (!(await esperarApp())) {
    log("o app não respondeu. Rodou `npx next build` antes?");
    app.kill();
    process.exit(1);
  }
  log(`app de pé em http://localhost:${PORTA}`);

  log("abrindo o túnel…");
  const tunel = iniciar("cloudflared", ["tunnel", "--url", `http://localhost:${PORTA}`], "tunel");
  const base = await urlDoTunel(tunel);
  if (!base) {
    log("o túnel não devolveu URL.");
    process.exit(1);
  }
  log(`túnel: ${base}`);

  // O token vem do banco: é o webhook_path_token da sessão.
  const { Client } = await import("pg");
  const db = new Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const { rows } = await db.query(
    "select waha_session_name, webhook_path_token from channel_sessions where provider='waha' limit 1",
  );
  await db.end();

  if (!rows.length) {
    log("nenhuma channel_session cadastrada — crie uma antes.");
  } else {
    const { waha_session_name: sessao, webhook_path_token: token } = rows[0];
    const ok = await reapontarWebhook(base, token, sessao);
    log(ok ? `webhook da sessão "${sessao}" reapontado para o túnel` : "FALHOU ao reapontar o webhook");
  }

  log("crons ligados. Ctrl+C encerra tudo.");
  let tick = 0;
  setInterval(async () => {
    tick++;
    await baterCrons(CRONS.minuto);
    if (tick % 5 === 0) await baterCrons(CRONS.cinco);
    if (tick % 15 === 0) await baterCrons(CRONS.quinze);
  }, 60_000);

  const encerrar = () => {
    log("encerrando…");
    app.kill();
    tunel.kill();
    process.exit(0);
  };
  process.on("SIGINT", encerrar);
  process.on("SIGTERM", encerrar);
}

main().catch((e) => {
  console.error("[local] falhou:", e?.message ?? e);
  process.exit(1);
});
