/**
 * Contas a pagar (repasse a fornecedor) — validação via CLI (Node 18+).
 *
 *   COMANDO_API_KEY=cmd_live_... node accounts-payable/run.js
 *   # opcionais: COMANDO_BASE_URL, COMANDO_COMPANY_ID, ou a chave como argv[2]
 *
 * Cria fornecedor → conta a pagar (parcelas) → despesa → payout Pix (ou simulação),
 * mostra o resultado e limpa tudo.
 */

import { makeApi, runPayable, cleanupPayable, fmtMoney } from "./payable.js";

const apiKey = process.env.COMANDO_API_KEY || process.argv[2];
const baseUrl = process.env.COMANDO_BASE_URL || undefined;
const companyId = process.env.COMANDO_COMPANY_ID || undefined;

if (!apiKey) {
  console.error("Informe a chave: COMANDO_API_KEY=cmd_live_... node accounts-payable/run.js");
  process.exit(2);
}

const ICON = { run: "··", ok: "✅", sim: "🟡", fail: "❌", skip: "⏭️ " };
const api = makeApi(apiKey, baseUrl, companyId);

try {
  const result = await runPayable(api, {
    supplier: { name: "[DEMO] Fornecedor Repasse", document: "98765432000110", pixKey: "fornecedor@example.com", pixKeyType: "email" },
    amount: 900,
    installments: 3,
    log: ({ status, detail }) => console.log(`${ICON[status] || "··"} ${detail}`),
  });

  console.log("\n— Resultado —");
  console.log(`Fornecedor:     ${result.supplier.id}`);
  console.log(`Conta a pagar:  ${result.purchaseInvoice.id} (${fmtMoney(result.purchaseInvoice.amount)})`);
  console.log(`Despesa:        ${result.expense.id}`);
  console.log(`Payout:         ${result.payout.id} · ${result.payout.status}${result.simulated ? " (SIMULADO)" : ` · ${result.payout.provider}`}`);

  console.log("\n— Limpeza —");
  await cleanupPayable(api, result, ({ detail }) => console.log(`✅ ${detail}`));

  console.log(`\n${result.simulated ? "🟡 Fluxo OK em modo simulação (empresa sem integração bancária)." : "✅ Fluxo OK com payout real."}`);
  process.exit(0);
} catch (e) {
  console.error(`\n❌ Falhou: ${e.message}`);
  process.exit(1);
}
