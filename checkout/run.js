/**
 * Valida o checkout contra a API real (zero build — fetch nativo do Node 18+).
 *
 *   COMANDO_API_KEY=cmd_live_... node checkout/run.js
 *   # opcionais: COMANDO_BASE_URL, COMANDO_COMPANY_ID, ou a chave como argv[2]
 *
 * Faz um pedido completo (cliente → fatura → cobrança), mostra o resultado e
 * limpa o que dá (cancela a fatura, exclui o cliente quando possível).
 */

import { CATALOG, makeApi, placeOrder, cartTotal } from "./checkout.js";

const apiKey = process.env.COMANDO_API_KEY || process.argv[2];
const baseUrl = process.env.COMANDO_BASE_URL || undefined;
const companyId = process.env.COMANDO_COMPANY_ID || undefined;

if (!apiKey) {
  console.error("Informe a chave: COMANDO_API_KEY=cmd_live_... node checkout/run.js");
  process.exit(2);
}

const ICON = { run: "··", ok: "✅", sim: "🟡", fail: "❌" };
const api = makeApi(apiKey, baseUrl, companyId);

const cart = [
  { ...CATALOG[0], qty: 2 }, // consultoria x2
  { ...CATALOG[2], qty: 1 }, // suporte
];

console.log(`Carrinho: ${cart.map((l) => `${l.qty}× ${l.name}`).join(", ")} — total R$ ${cartTotal(cart).toFixed(2)}\n`);

try {
  const order = await placeOrder(api, {
    customer: { name: "[CHECKOUT] Cliente Demo", email: "demo@example.com", document: "12345678000195" },
    cart,
    method: "pix",
    log: ({ status, detail }) => console.log(`${ICON[status] || "··"} ${detail}`),
  });

  console.log("\n— Resultado —");
  console.log(`Fatura:   ${order.invoice.id} (R$ ${order.total.toFixed(2)})`);
  console.log(`Cobrança: ${order.charge.id} · ${order.charge.method} · ${order.charge.status}${order.simulated ? " (SIMULADO)" : ` · ${order.charge.provider}`}`);
  if (order.charge.pix?.qr_code) console.log(`Pix:      ${order.charge.pix.qr_code.slice(0, 48)}…`);

  // Limpeza best-effort
  console.log("\n— Limpeza —");
  const tryDo = async (label, fn) => { try { await fn(); console.log(`✅ ${label}`); } catch (e) { console.log(`⏭️  ${label} pulado (${e.status || "erro"})`); } };
  await tryDo("fatura cancelada", () => api.invoices.cancel(order.invoice.id));
  await tryDo("cliente excluído", () => api.customers.delete(order.customer.id));

  console.log(`\n${order.simulated ? "🟡 Fluxo OK em modo simulação (empresa sem integração bancária)." : "✅ Fluxo OK com cobrança real."}`);
  process.exit(0);
} catch (e) {
  console.error(`\n❌ Falhou: ${e.message}`);
  process.exit(1);
}
