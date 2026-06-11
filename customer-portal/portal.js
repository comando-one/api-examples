/**
 * Portal do cliente (lado pagador) — demo read-only da API pública.
 *
 * Mostra como um portal externo (sem login no Comando) deixaria o próprio
 * cliente consultar suas faturas em aberto e o Pix/boleto de cada uma, a partir
 * de um documento (CPF/CNPJ) ou nome.
 *
 * Reutilizável no navegador (index.html) e no Node (run.js).
 *
 * Fluxo:
 *   1. busca o cliente            → customers.list({ search })
 *   2. lista as faturas dele      → customers.invoices(id)
 *   3. abre uma fatura            → invoices.get(id)  (itens + parcelas)
 *   4. mostra as cobranças/Pix    → charges.list({ customer_id, invoice_id })
 *
 * Scopes necessários: customers:read, invoices:read, charges:read.
 */

import { ComandoApi, ComandoApiError } from "../_shared/comando-api.js";

/** Cria o client do SDK (read-only — sem idempotência). */
export function makeApi(apiKey, baseUrl, companyId) {
  return new ComandoApi({ apiKey, baseUrl: baseUrl || undefined, companyId: companyId || undefined });
}

/** Busca clientes por documento/nome (GET /customers?search=). */
export async function searchCustomers(api, query, params = {}) {
  const r = await api.customers.list({ search: query || undefined, per_page: 20, ...params });
  return { customers: r.data || [], total: r.meta?.total ?? (r.data?.length || 0) };
}

/** Faturas de um cliente (GET /customers/:id/invoices). */
export async function getCustomerInvoices(api, customerId, params = {}) {
  const r = await api.customers.invoices(customerId, { per_page: 50, ...params });
  return { invoices: r.data || [], total: r.meta?.total ?? (r.data?.length || 0) };
}

/** Detalhe da fatura com itens + parcelas (GET /invoices/:id). */
export async function getInvoiceDetail(api, invoiceId) {
  return await api.invoices.get(invoiceId);
}

/** Cobranças (Pix/boleto) de uma fatura (GET /charges?customer_id=&invoice_id=). */
export async function getInvoiceCharges(api, { customerId, invoiceId }) {
  try {
    const r = await api.charges.list({ customer_id: customerId || undefined, invoice_id: invoiceId || undefined, per_page: 20 });
    return r.data || [];
  } catch (err) {
    // Sem scope charges:read → o portal ainda funciona, só não mostra o Pix.
    if (err instanceof ComandoApiError && (err.status === 403 || err.status === 422)) return [];
    throw err;
  }
}

/** Considera "em aberto" tudo que não está pago/cancelado. */
export function isOpenInvoice(inv) {
  const ps = (inv.payment_status || "").toLowerCase();
  const st = (inv.status || "").toLowerCase();
  return ps !== "pago" && ps !== "cancelado" && st !== "cancelada";
}

export function fmtMoney(n) {
  return "R$ " + Number(n || 0).toFixed(2).replace(".", ",");
}

export function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

/**
 * Fluxo completo para a CLI: acha um cliente (pelo `query` ou o 1º da empresa),
 * lista as faturas, abre a 1ª e mostra as cobranças. Não altera nada.
 *
 * @returns {{ customer, invoices, openCount, firstInvoice, charges }}
 */
export async function runPortalDemo(api, { query, log = () => {} } = {}) {
  log({ step: "search", status: "run", detail: query ? `Buscando cliente "${query}"…` : "Listando clientes…" });
  const { customers, total } = await searchCustomers(api, query);
  if (!customers.length) {
    log({ step: "search", status: "fail", detail: "Nenhum cliente encontrado." });
    return { customer: null, invoices: [], openCount: 0, firstInvoice: null, charges: [] };
  }
  const customer = customers[0];
  log({ step: "search", status: "ok", detail: `${customers.length}/${total} cliente(s) — usando "${customer.name}" (${customer.id})` });

  log({ step: "invoices", status: "run", detail: "Carregando faturas do cliente…" });
  const { invoices } = await getCustomerInvoices(api, customer.id);
  const open = invoices.filter(isOpenInvoice);
  log({ step: "invoices", status: "ok", detail: `${invoices.length} fatura(s) · ${open.length} em aberto` });

  let firstInvoice = null, charges = [];
  const target = open[0] || invoices[0];
  if (target) {
    log({ step: "detail", status: "run", detail: `Abrindo fatura ${target.id}…` });
    firstInvoice = await getInvoiceDetail(api, target.id);
    const items = firstInvoice.invoice_items || firstInvoice.items || [];
    log({ step: "detail", status: "ok", detail: `Fatura ${fmtMoney(firstInvoice.amount)} · ${items.length} item(ns) · venc. ${fmtDate(firstInvoice.due_date)}` });

    log({ step: "charges", status: "run", detail: "Buscando cobranças/Pix…" });
    charges = await getInvoiceCharges(api, { customerId: customer.id, invoiceId: target.id });
    const withPix = charges.find((c) => c.pix?.qr_code);
    log({ step: "charges", status: charges.length ? "ok" : "sim", detail: charges.length ? `${charges.length} cobrança(s)${withPix ? " · Pix disponível" : ""}` : "sem cobrança gerada para esta fatura" });
  }

  return { customer, invoices, openCount: open.length, firstInvoice, charges };
}
