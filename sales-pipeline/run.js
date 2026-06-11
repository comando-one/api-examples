/**
 * Pipeline comercial (proposta → contrato) — validação via CLI (Node 18+).
 *
 *   COMANDO_API_KEY=cmd_live_... node sales-pipeline/run.js
 *   # opcionais: COMANDO_BASE_URL, COMANDO_COMPANY_ID, ou a chave como argv[2]
 *
 * Cria cliente → proposta → envia → aceita → contrato, mostra o resultado e
 * limpa tudo (exclui contrato, proposta e cliente).
 */

import { makeApi, runSalesPipeline, cleanupSalesPipeline, fmtMoney, freqLabel } from "./sales.js";

const apiKey = process.env.COMANDO_API_KEY || process.argv[2];
const baseUrl = process.env.COMANDO_BASE_URL || undefined;
const companyId = process.env.COMANDO_COMPANY_ID || undefined;

if (!apiKey) {
  console.error("Informe a chave: COMANDO_API_KEY=cmd_live_... node sales-pipeline/run.js");
  process.exit(2);
}

const ICON = { run: "··", ok: "✅", sim: "🟡", fail: "❌", skip: "⏭️ " };
const api = makeApi(apiKey, baseUrl, companyId);

try {
  const result = await runSalesPipeline(api, {
    customer: { name: "[DEMO] Cliente Comercial", email: "comercial@example.com", document: "12345678000195" },
    amount: 1500,
    frequency: "mensal",
    validDays: 15,
    log: ({ status, detail }) => console.log(`${ICON[status] || "··"} ${detail}`),
  });

  console.log("\n— Resultado —");
  console.log(`Cliente:  ${result.customer.id}`);
  console.log(`Proposta: ${result.proposal.id} · ${fmtMoney(result.proposal.total_amount ?? 1500)} · ${result.proposal.status}`);
  console.log(`Contrato: ${result.contract.id} · ${freqLabel(result.contract.frequency)} · ${fmtMoney(result.contract.amount)} · ${result.contract.status}`);

  console.log("\n— Limpeza —");
  await cleanupSalesPipeline(api, result, ({ detail }) => console.log(`✅ ${detail}`));

  console.log("\n✅ Pipeline comercial OK — proposta → contrato validado.");
  process.exit(0);
} catch (e) {
  console.error(`\n❌ Falhou: ${e.message}`);
  process.exit(1);
}
