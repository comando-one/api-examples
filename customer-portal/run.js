/**
 * Portal do cliente — validação via CLI contra a API real (Node 18+, zero build).
 *
 *   COMANDO_API_KEY=cmd_live_... node customer-portal/run.js
 *   # opcionais: COMANDO_BASE_URL, COMANDO_COMPANY_ID, ou a chave como argv[2]
 *   # busca por documento/nome: passe como argv[3] ou COMANDO_QUERY
 *
 * Read-only: acha um cliente, lista suas faturas, abre a 1ª e mostra o Pix.
 * Não cria nem altera nada.
 */

import { makeApi, runPortalDemo, fmtMoney, fmtDate, isOpenInvoice } from "./portal.js";

const apiKey = process.env.COMANDO_API_KEY || process.argv[2];
const baseUrl = process.env.COMANDO_BASE_URL || undefined;
const companyId = process.env.COMANDO_COMPANY_ID || undefined;
const query = process.env.COMANDO_QUERY || process.argv[3] || undefined;

if (!apiKey) {
  console.error("Informe a chave: COMANDO_API_KEY=cmd_live_... node customer-portal/run.js [query]");
  process.exit(2);
}

const ICON = { run: "··", ok: "✅", sim: "🟡", fail: "❌", skip: "⏭️ " };
const api = makeApi(apiKey, baseUrl, companyId);

try {
  const r = await runPortalDemo(api, {
    query,
    log: ({ status, detail }) => console.log(`${ICON[status] || "··"} ${detail}`),
  });

  if (!r.customer) {
    console.log("\n🟡 Empresa de teste sem clientes — cadastre um cliente para ver o portal.");
    process.exit(0);
  }

  console.log("\n— Faturas do cliente —");
  if (!r.invoices.length) {
    console.log("(nenhuma fatura)");
  } else {
    for (const inv of r.invoices.slice(0, 10)) {
      const flag = isOpenInvoice(inv) ? "🟠 em aberto" : "🟢 quitada/cancelada";
      console.log(`  • ${inv.title || inv.id} — ${fmtMoney(inv.amount)} · venc. ${fmtDate(inv.due_date)} · ${flag}`);
    }
    if (r.invoices.length > 10) console.log(`  … +${r.invoices.length - 10} fatura(s)`);
  }

  if (r.firstInvoice) {
    const items = r.firstInvoice.invoice_items || r.firstInvoice.items || [];
    console.log("\n— Fatura aberta em detalhe —");
    console.log(`Fatura ${r.firstInvoice.id} · ${fmtMoney(r.firstInvoice.amount)}`);
    for (const it of items) console.log(`  - ${it.quantity ?? 1}× ${it.name} (${fmtMoney(it.unit_price)})`);
    const pix = r.charges.find((c) => c.pix?.qr_code);
    if (pix) console.log(`Pix copia-e-cola: ${pix.pix.qr_code.slice(0, 48)}…`);
  }

  console.log("\n✅ Portal OK — fluxo de consulta do pagador validado.");
  process.exit(0);
} catch (e) {
  console.error(`\n❌ Falhou: ${e.message}`);
  process.exit(1);
}
