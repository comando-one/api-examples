/**
 * Valida o módulo de SPLIT DE PAGAMENTOS contra a API real (zero build).
 *
 *   COMANDO_API_KEY=cmd_live_... node split/run.js
 *   # opcionais: COMANDO_BASE_URL, COMANDO_COMPANY_ID, ou a chave como argv[2]
 *   # SPLIT_NO_WAIT=1  pula o polling da execução (só testa as regras)
 *   # SPLIT_KEEP=1     não limpa os dados criados ao final
 *
 * Cenário: hub de estacionamento. Cria fornecedor + regra de split 15/85, uma
 * regra POR PARCELA (recurso API-only), simula uma venda Pix e aguarda o split
 * ser calculado. Limpa tudo ao final.
 *
 * Scopes da chave: split:list, split:create, split:update, split:delete,
 *   suppliers:write, suppliers:delete, customers:write, customers:delete,
 *   invoices:create, invoices:cancel, charges:create.
 */

import {
  makeApi, setupScenario, createInstallmentRule, validateRuleScenarios, simulateSale,
  waitForExecution, summarizeExecution, teardown, fmtCents,
} from "./split.js";

const apiKey = process.env.COMANDO_API_KEY || process.argv[2];
const baseUrl = process.env.COMANDO_BASE_URL || undefined;
const companyId = process.env.COMANDO_COMPANY_ID || undefined;

if (!apiKey) {
  console.error("Informe a chave: COMANDO_API_KEY=cmd_live_... node split/run.js");
  process.exit(2);
}

const ICON = { run: "··", ok: "✅", sim: "🟡", fail: "❌", skip: "⏭️" };
const log = ({ status, detail }) => console.log(`${ICON[status] || "··"} ${detail}`);
const api = makeApi(apiKey, baseUrl, companyId);

const refs = {};
try {
  console.log("— 1. Cenário: hub de estacionamento (regra 15/85) —");
  const setup = await setupScenario(api, { platformPercent: 15, log });
  Object.assign(refs, setup);

  console.log("\n— 2. Split por parcela (recurso só via API) —");
  const inst = await createInstallmentRule(api, { supplier: setup.supplier, paymentMethod: setup.paymentMethod, log });
  refs.installmentRule = inst.rule;

  console.log("\n— 2.5. Validação de tipos de regra (fixo, combinado, parcela, fee_payer) —");
  const v = await validateRuleScenarios(api, { supplier: setup.supplier, log });
  console.log(`   ${v.ok}/${v.total} cenários de regra validados`);

  if (process.env.SPLIT_NO_WAIT) {
    console.log("\n🟡 SPLIT_NO_WAIT=1 — pulando a venda/execução. Regras testadas com sucesso.");
  } else {
    console.log("\n— 3. Venda do estacionamento (motorista paga Pix) —");
    const sale = await simulateSale(api, { amount: 20, log });
    Object.assign(refs, { customer: sale.customer, invoice: sale.invoice });

    if (sale.simulated) {
      console.log("\n🟡 Recebimento não liquidou (empresa sem integração bancária) — o split é disparado na liquidação.");
    } else {
      console.log("\n— 4. Aguardando o split ser calculado —");
      const exec = await waitForExecution(api, { invoiceId: sale.invoice.id, log });
      refs.execution = exec;
      if (exec) {
        console.log("\n— Divisão —");
        const rows = summarizeExecution(exec);
        for (const s of rows) {
          console.log(`  ${s.who.padEnd(22)} líquido ${fmtCents(s.net).padStart(12)}  (bruto ${fmtCents(s.gross)}, taxa ${fmtCents(s.fee)}) · ${s.status}${s.error ? `  — ${s.error}` : ""}`);
        }
        console.log(`  Total bruto: ${fmtCents(exec.gross_cents)} · líquido: ${fmtCents(exec.net_cents)} · status ${exec.status}`);
        if (rows.some((s) => /integra|conta banc|pendente/i.test(s.error || ""))) {
          console.log("\n🟢 Split calculado e dividido corretamente. A fatia do hub fica 'paid' (retida pela empresa);");
          console.log("   a do fornecedor fica 'released' (repasse PENDENTE) — esta empresa não tem integração bancária (Inter/C6)");
          console.log("   para enviar o Pix. Com uma integração ativa, o repasse sai automático.");
        }
      }
    }
  }

  if (!process.env.SPLIT_KEEP) {
    console.log("\n— Limpeza —");
    await teardown(api, refs, log);
  } else {
    console.log("\n🟡 SPLIT_KEEP=1 — dados mantidos.");
  }

  console.log("\n✅ Demo de split concluída.");
  process.exit(0);
} catch (e) {
  console.error(`\n❌ Falhou: ${e.message}`);
  if (!process.env.SPLIT_KEEP) { try { await teardown(api, refs, log); } catch { /* ignore */ } }
  process.exit(1);
}
