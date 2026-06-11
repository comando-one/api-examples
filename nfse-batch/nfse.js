/**
 * Emissor de NFS-e em lote — descobre faturas pagas sem nota e emite.
 *
 * Não cria faturas: opera sobre as existentes. Lista as faturas pagas, cruza com
 * o histórico de NFS-e para achar as que ainda não têm nota, e (opcionalmente)
 * emite. Sem configuração fiscal na empresa, a emissão retorna 422 → PULADO.
 *
 * Reutilizável no navegador (index.html) e no Node (run.js).
 *
 * Endpoints: invoices.list({payment_status:"pago"}), nfse.list, nfse.emit, nfse.get.
 * Scopes: invoices:read, nfse:read, nfse:emitir.
 */

import { ComandoApi, ComandoApiError } from "../_shared/comando-api.js";

export function makeApi(apiKey, baseUrl, companyId) {
  return new ComandoApi({ apiKey, baseUrl: baseUrl || undefined, companyId: companyId || undefined, autoIdempotency: true });
}

export function fmtMoney(n) {
  return "R$ " + Number(n || 0).toFixed(2).replace(".", ",");
}

/** Faturas pagas (GET /invoices?payment_status=pago). */
export async function listPaidInvoices(api, params = {}) {
  const r = await api.invoices.list({ payment_status: "pago", per_page: 100, ...params });
  return r.data || [];
}

/** Conjunto de invoice_ids que já têm NFS-e (qualquer status) no histórico. */
export async function listEmittedInvoiceIds(api) {
  try {
    const r = await api.nfse.list({ per_page: 100 });
    const set = new Set();
    for (const n of r.data || []) if (n.invoice_id) set.add(n.invoice_id);
    return set;
  } catch (err) {
    if (err instanceof ComandoApiError && (err.status === 403 || err.status === 404)) return new Set();
    throw err;
  }
}

/** Cruza pagas × emitidas → retorna as faturas pendentes de nota. */
export async function getPendingInvoices(api, { log = () => {} } = {}) {
  log({ step: "scan", status: "run", detail: "Listando faturas pagas…" });
  const paid = await listPaidInvoices(api);
  log({ step: "scan", status: "ok", detail: `${paid.length} fatura(s) paga(s)` });

  log({ step: "cross", status: "run", detail: "Cruzando com histórico de NFS-e…" });
  const emittedIds = await listEmittedInvoiceIds(api);
  const pending = paid.filter((inv) => !emittedIds.has(inv.id));
  log({ step: "cross", status: "ok", detail: `${emittedIds.size} já com nota · ${pending.length} pendente(s)` });

  return { paid, pending, emittedIds };
}

/**
 * Emite a NFS-e de uma fatura, tratando 422 (sem config fiscal) como PULADO.
 * @returns {{ invoiceId, ok:boolean, skipped:boolean, status?:string, reason?:string }}
 */
export async function emitOne(api, invoiceId) {
  try {
    const r = await api.nfse.emit(invoiceId);
    return { invoiceId, ok: true, skipped: false, status: r.status, numero: r.numero_nfse, historyId: r.history_id };
  } catch (err) {
    if (err instanceof ComandoApiError && err.status === 422) {
      return { invoiceId, ok: false, skipped: true, reason: err.body?.error ?? "NFS-e não configurada para esta empresa." };
    }
    if (err instanceof ComandoApiError) {
      return { invoiceId, ok: false, skipped: false, reason: `${err.status} ${err.body?.error ?? ""}` };
    }
    throw err;
  }
}

/** Consulta o status de um registro de NFS-e (GET /nfse/:id). */
export async function pollNfse(api, historyId) {
  return await api.nfse.get(historyId);
}

/**
 * Fluxo da CLI: lista pendentes e, se emit=true, emite até `max` notas (uma a
 * uma, tratando 422 como pulado).
 * @returns {{ paid, pending, emittedIds, results }}
 */
export async function runNfseBatch(api, { emit = true, max = 3, log = () => {} } = {}) {
  const { paid, pending, emittedIds } = await getPendingInvoices(api, { log });
  const results = [];
  if (emit && pending.length) {
    const targets = pending.slice(0, max);
    log({ step: "emit", status: "run", detail: `Emitindo ${targets.length} de ${pending.length} pendente(s)…` });
    for (const inv of targets) {
      const r = await emitOne(api, inv.id);
      results.push(r);
      log({
        step: "emit",
        status: r.ok ? "ok" : r.skipped ? "skip" : "fail",
        detail: r.ok ? `Fatura ${inv.id} → nota ${r.numero || r.status}` : `Fatura ${inv.id} → ${r.skipped ? "pulado" : "erro"}: ${r.reason}`,
      });
    }
  } else if (emit) {
    log({ step: "emit", status: "ok", detail: "Nada a emitir — todas as pagas já têm nota." });
  }
  return { paid, pending, emittedIds, results };
}
