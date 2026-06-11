/**
 * Emissor de NFS-e em lote — validação via CLI (Node 18+).
 *
 *   COMANDO_API_KEY=cmd_live_... node nfse-batch/run.js
 *   # só LISTA (não emite) por padrão. Para emitir: EMIT=1 ... node ...
 *   # opcionais: COMANDO_BASE_URL, COMANDO_COMPANY_ID, MAX=n
 *
 * Lista faturas pagas, cruza com o histórico de NFS-e e mostra as pendentes.
 * Com EMIT=1, tenta emitir (422 sem config fiscal = pulado).
 */

import { makeApi, runNfseBatch, getPendingInvoices, fmtMoney } from "./nfse.js";

const apiKey = process.env.COMANDO_API_KEY || process.argv[2];
const baseUrl = process.env.COMANDO_BASE_URL || undefined;
const companyId = process.env.COMANDO_COMPANY_ID || undefined;
const emit = process.env.EMIT === "1" || process.env.EMIT === "true";
const max = Number(process.env.MAX || 3);

if (!apiKey) {
  console.error("Informe a chave: COMANDO_API_KEY=cmd_live_... node nfse-batch/run.js  (EMIT=1 para emitir)");
  process.exit(2);
}

const ICON = { run: "··", ok: "✅", sim: "🟡", fail: "❌", skip: "⏭️ " };
const api = makeApi(apiKey, baseUrl, companyId);

try {
  const log = ({ status, detail }) => console.log(`${ICON[status] || "··"} ${detail}`);

  let out;
  if (emit) {
    out = await runNfseBatch(api, { emit: true, max, log });
  } else {
    out = await getPendingInvoices(api, { log });
    console.log("\n(modo somente-leitura — use EMIT=1 para emitir as pendentes)");
  }

  console.log("\n— Faturas pendentes de nota —");
  if (!out.pending.length) {
    console.log("(nenhuma — todas as pagas já têm NFS-e, ou não há faturas pagas)");
  } else {
    for (const inv of out.pending.slice(0, 10)) {
      console.log(`  • ${inv.title || inv.id} — ${fmtMoney(inv.amount)}`);
    }
    if (out.pending.length > 10) console.log(`  … +${out.pending.length - 10}`);
  }

  if (emit && out.results.length) {
    const ok = out.results.filter((r) => r.ok).length;
    const skip = out.results.filter((r) => r.skipped).length;
    const fail = out.results.filter((r) => !r.ok && !r.skipped).length;
    console.log(`\n— Emissão — ${ok} emitida(s) · ${skip} pulada(s) · ${fail} falha(s)`);
  }

  console.log("\n✅ NFS-e em lote OK — varredura e cruzamento validados.");
  process.exit(0);
} catch (e) {
  console.error(`\n❌ Falhou: ${e.message}`);
  process.exit(1);
}
