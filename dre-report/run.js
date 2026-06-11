/**
 * Mini DRE — validação via CLI (Node 18+, read-only).
 *
 *   COMANDO_API_KEY=cmd_live_... node dre-report/run.js [start] [end]
 *   # datas YYYY-MM-DD opcionais; default = últimos 30 dias
 *   # opcionais: COMANDO_BASE_URL, COMANDO_COMPANY_ID
 *
 * Pagina o ledger do período, separa entradas × saídas e mostra o resultado.
 */

import { makeApi, runDre, fmtMoney, originLabel, isoDate } from "./dre.js";

const apiKey = process.env.COMANDO_API_KEY || process.argv[2];
const baseUrl = process.env.COMANDO_BASE_URL || undefined;
const companyId = process.env.COMANDO_COMPANY_ID || undefined;
const startDate = process.env.COMANDO_START || process.argv[3] || isoDate(-30);
const endDate = process.env.COMANDO_END || process.argv[4] || isoDate();

if (!apiKey) {
  console.error("Informe a chave: COMANDO_API_KEY=cmd_live_... node dre-report/run.js [start] [end]");
  process.exit(2);
}

const ICON = { run: "··", ok: "✅", sim: "🟡", fail: "❌", skip: "⏭️ " };
const api = makeApi(apiKey, baseUrl, companyId);

try {
  const dre = await runDre(api, {
    startDate, endDate,
    log: ({ status, detail }) => console.log(`${ICON[status] || "··"} ${detail}`),
  });

  console.log(`\n— DRE ${dre.period.startDate} → ${dre.period.endDate} —`);
  console.log(`  Entradas:  ${fmtMoney(dre.entradas)}`);
  console.log(`  Saídas:    ${fmtMoney(dre.saidas)}`);
  console.log(`  ${dre.resultado >= 0 ? "Lucro" : "Prejuízo"}:    ${fmtMoney(dre.resultado)}`);

  if (dre.byOrigin.length) {
    console.log("\n— Por origem —");
    for (const o of dre.byOrigin) {
      console.log(`  ${originLabel(o.origin).padEnd(26)} entra ${fmtMoney(o.entrada).padStart(14)} · sai ${fmtMoney(o.saida).padStart(14)} (${o.count})`);
    }
  } else {
    console.log("\n(sem lançamentos no período — cadastre recebimentos/despesas ou amplie o período)");
  }

  console.log("\n✅ Mini DRE OK — ledger paginado e consolidado.");
  process.exit(0);
} catch (e) {
  console.error(`\n❌ Falhou: ${e.message}`);
  process.exit(1);
}
