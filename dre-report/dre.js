/**
 * Mini DRE — demonstrativo financeiro a partir do ledger (read-only).
 *
 * Puxa o razão financeiro (finance/ledger) de um período inteiro (paginação
 * automática via listAll), separa entradas × saídas, agrupa por origem e calcula
 * o resultado. Também lê os catálogos de naturezas e centros de custo.
 *
 * Reutilizável no navegador (index.html) e no Node (run.js).
 *
 * Endpoints: finance.ledger, finance.natures, lookups.costCenters.
 * Scopes: finance:read (e expenses:read/finance:read p/ cost-centers).
 */

import { ComandoApi, ComandoApiError } from "../_shared/comando-api.js";

export function makeApi(apiKey, baseUrl, companyId) {
  return new ComandoApi({ apiKey, baseUrl: baseUrl || undefined, companyId: companyId || undefined });
}

export function isoDate(daysAhead = 0) {
  return new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
}

export function fmtMoney(n) {
  const v = Number(n || 0);
  return (v < 0 ? "-R$ " : "R$ ") + Math.abs(v).toFixed(2).replace(".", ",");
}

const ORIGIN_LABEL = {
  payment: "Recebimentos",
  expense: "Despesas",
  supplier_payment: "Pagamentos a fornecedor",
  financial_movement: "Movimentos manuais",
};
export function originLabel(o) { return ORIGIN_LABEL[o] || o || "Outros"; }

/**
 * Pagina o ledger inteiro do período e monta o demonstrativo.
 * @param {ComandoApi} api
 * @param {{ startDate:string, endDate:string, log?:Function }} opts
 * @returns {{ entradas, saidas, resultado, count, byOrigin, natures, costCenters, period }}
 */
export async function runDre(api, { startDate, endDate, log = () => {} }) {
  const period = { startDate: startDate || isoDate(-30), endDate: endDate || isoDate() };

  // Catálogos (não bloqueiam o relatório se faltarem scopes)
  log({ step: "catalog", status: "run", detail: "Lendo naturezas e centros de custo…" });
  const [naturesR, ccR] = await Promise.all([
    api.finance.natures({ per_page: 100 }).catch(() => ({ data: [] })),
    api.lookups.costCenters({ per_page: 100 }).catch(() => ({ data: [] })),
  ]);
  const natures = naturesR.data || [];
  const costCenters = ccR.data || [];
  log({ step: "catalog", status: "ok", detail: `${natures.length} natureza(s) · ${costCenters.length} centro(s) de custo` });

  // Ledger paginado (listAll itera ?page= sozinho)
  log({ step: "ledger", status: "run", detail: `Carregando ledger ${period.startDate} → ${period.endDate}…` });
  let rows = [];
  try {
    // listAll pagina /finance/ledger sozinho (itera ?page= até cobrir meta.total).
    rows = await api.listAll("/finance/ledger", { start_date: period.startDate, end_date: period.endDate, direction: "all" });
  } catch (err) {
    if (err instanceof ComandoApiError) throw new Error(`Ledger falhou (${err.status}): ${err.body?.error ?? ""}`);
    throw err;
  }

  let entradas = 0, saidas = 0;
  const byOrigin = {};
  for (const r of rows) {
    const dir = (r.direction || "").toLowerCase();
    const amount = Math.abs(Number(r.amount ?? r.signed_amount ?? 0));
    if (dir === "entrada") entradas += amount; else if (dir === "saida") saidas += amount;
    const key = r.origin || "outros";
    byOrigin[key] = byOrigin[key] || { origin: key, entrada: 0, saida: 0, count: 0 };
    byOrigin[key][dir === "entrada" ? "entrada" : "saida"] += amount;
    byOrigin[key].count++;
  }
  const resultado = entradas - saidas;
  log({ step: "ledger", status: "ok", detail: `${rows.length} lançamento(s) · entradas ${fmtMoney(entradas)} · saídas ${fmtMoney(saidas)}` });
  log({ step: "result", status: resultado >= 0 ? "ok" : "sim", detail: `Resultado do período: ${fmtMoney(resultado)}` });

  return {
    entradas, saidas, resultado, count: rows.length,
    byOrigin: Object.values(byOrigin).sort((a, b) => (b.entrada + b.saida) - (a.entrada + a.saida)),
    natures, costCenters, period,
  };
}
