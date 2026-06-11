/**
 * Receiver de webhooks do Comando.One (zero dependências, Node 18+).
 *
 * - POST /webhook  → recebe os eventos (charge.*, payout.*), valida a assinatura
 *   HMAC-SHA256 do header `x-signature` e guarda em memória.
 * - GET  /events   → JSON das últimas entregas (para a tela fazer polling).
 * - GET  /         → painel ao vivo (atualiza sozinho).
 *
 * Uso:
 *   COMANDO_WEBHOOK_SECRET=whsec_... node webhook-receiver/server.js
 *   # porta padrão 8090 (ou PORT=...)
 *
 * Para receber de verdade, a API precisa alcançar este servidor por uma URL
 * https pública. Em dev, exponha com um túnel, por exemplo:
 *   cloudflared tunnel --url http://localhost:8090
 *   # ou: ngrok http 8090
 * e registre a URL (…/webhook) no checkout ou via PUT /v1/webhooks/payments.
 */

import { createServer } from "node:http";
import { verifyWebhookSignature } from "../_shared/webhook.js";

const PORT = Number(process.env.PORT || 8090);
const SECRET = process.env.COMANDO_WEBHOOK_SECRET || "";
const events = []; // mais recentes primeiro

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

const PAGE = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"/>
<title>Webhook Receiver — Comando.One</title>
<style>
 body{margin:0;background:#0b1120;color:#e2e8f0;font:14px/1.5 ui-sans-serif,system-ui}
 .wrap{max-width:820px;margin:0 auto;padding:28px 20px}
 h1{font-size:20px} .muted{color:#94a3b8}
 .ev{background:#111827;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:12px;margin:10px 0}
 .ok{color:#34d399} .bad{color:#f87171} code{color:#93c5fd;word-break:break-all}
 pre{background:#0b1120;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:10px;overflow:auto;font-size:12px}
</style></head><body><div class="wrap">
 <h1>🪝 Webhook Receiver</h1>
 <p class="muted">Recebe em <code>POST /webhook</code> e valida a assinatura HMAC. Atualiza a cada 2s.</p>
 <div id="list" class="muted">Aguardando eventos…</div>
</div>
<script>
 async function tick(){
   const r = await fetch("/events"); const evs = await r.json();
   document.getElementById("list").innerHTML = evs.length ? evs.map(e =>
     '<div class="ev"><div><strong>'+(e.event||"?")+'</strong> · <span class="'+(e.valid?"ok":"bad")+'">'+
     (e.valid?"assinatura OK":"assinatura INVÁLIDA")+'</span> · <span class="muted">'+e.received_at+'</span></div>'+
     '<pre>'+e.body+'</pre></div>').join("") : '<p class="muted">Nenhum evento ainda.</p>';
 }
 tick(); setInterval(tick, 2000);
</script></body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") return send(res, 204, "");
  if (req.method === "GET" && url.pathname === "/") return send(res, 200, PAGE, "text/html; charset=utf-8");
  if (req.method === "GET" && url.pathname === "/events") return send(res, 200, events.slice(0, 20));

  if (req.method === "POST" && url.pathname === "/webhook") {
    const raw = await readBody(req);
    const signature = req.headers["x-signature"] || "";
    const valid = SECRET ? await verifyWebhookSignature(SECRET, raw, signature) : null;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* ignore */ }
    const entry = {
      event: parsed?.event ?? "?",
      valid,                       // true/false, ou null se não há secret configurado
      received_at: new Date().toISOString(),
      body: raw.slice(0, 2000),
    };
    events.unshift(entry);
    const icon = valid === false ? "❌ assinatura inválida" : valid === true ? "✅ assinatura ok" : "⚠️ sem secret";
    console.log(`[${entry.received_at}] ${entry.event} — ${icon}`);
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`Webhook receiver ouvindo em http://localhost:${PORT}`);
  console.log(SECRET ? "Validando assinatura HMAC (COMANDO_WEBHOOK_SECRET definido)." : "⚠️ Sem COMANDO_WEBHOOK_SECRET — assinatura não será validada.");
  console.log("Exponha com um túnel (cloudflared/ngrok) e registre a URL …/webhook.");
});
