/**
 * Verificação de assinatura de webhook do Comando.One (HMAC-SHA256).
 * A API assina o corpo bruto e envia em `x-signature`. Use o `secret` mostrado
 * na criação do webhook (PUT /v1/webhooks/payments).
 *
 * Funciona no navegador e no Node 18+ (Web Crypto).
 *
 *   import { verifyWebhookSignature } from "../_shared/webhook.js";
 *   const ok = await verifyWebhookSignature(secret, rawBody, req.headers["x-signature"]);
 */

export async function hmacSha256Hex(secret, payload) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Comparação de tempo constante (evita timing attacks). */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * @param {string} secret  segredo do webhook
 * @param {string} rawBody corpo bruto recebido (string exata, sem reparsear)
 * @param {string} signatureHeader valor do header x-signature
 * @returns {Promise<boolean>}
 */
export async function verifyWebhookSignature(secret, rawBody, signatureHeader) {
  if (!secret || !rawBody || !signatureHeader) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqual(expected, String(signatureHeader).trim());
}
