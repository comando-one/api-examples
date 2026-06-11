/**
 * Contas a pagar — Repasse a fornecedor (o "checkout" do lado da saída).
 *
 * Demonstra o fluxo de pagamento a fornecedor via API: cadastra fornecedor + chave
 * Pix, lança uma conta a pagar (NF) com parcelas, registra a despesa e tenta o
 * payout (Pix). Sem integração bancária, o payout cai em modo SIMULAÇÃO (igual ao
 * checkout de recebimento).
 *
 * Reutilizável no navegador (index.html) e no Node (run.js).
 *
 * Fluxo:
 *   1. fornecedor + forma de pagamento → suppliers.create + suppliers.paymentMethods.create
 *   2. conta a pagar com parcelas      → purchaseInvoices.create({ charges: [...] })
 *   3. despesa vinculada               → expenses.create
 *   4. payout Pix                      → payouts.create  (422 → simulação)
 *
 * Scopes: suppliers:write, purchase_invoices:create, expenses:write, payouts:create
 *         (e :read/:cancel/:delete para limpeza). bank_accounts:read p/ achar conta.
 */

import { ComandoApi, ComandoApiError } from "../_shared/comando-api.js";

export function makeApi(apiKey, baseUrl, companyId) {
  return new ComandoApi({ apiKey, baseUrl: baseUrl || undefined, companyId: companyId || undefined, autoIdempotency: true });
}

export function isoDate(daysAhead = 0) {
  return new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
}

export function fmtMoney(n) {
  return "R$ " + Number(n || 0).toFixed(2).replace(".", ",");
}

/**
 * Executa o fluxo completo de contas a pagar + repasse.
 * @param {ComandoApi} api
 * @param {{ supplier:{name,document?,pixKey?,pixKeyType?}, amount:number,
 *           installments?:number, log?:Function }} opts
 * @returns {{ supplier, paymentMethod, purchaseInvoice, expense, payout, simulated, reason }}
 */
export async function runPayable(api, { supplier, amount, installments = 1, log = () => {} }) {
  if (!supplier?.name) throw new Error("Informe o nome do fornecedor.");
  if (!amount || amount <= 0) throw new Error("Informe um valor (amount) positivo.");

  const type = supplier.type
    || ((supplier.document || "").replace(/\D/g, "").length > 11 ? "juridica" : "fisica");
  const pixKey = supplier.pixKey || "fornecedor@example.com";
  const pixKeyType = supplier.pixKeyType || "email";

  // 1. Fornecedor + forma de pagamento (Pix)
  log({ step: "supplier", status: "run", detail: "Criando fornecedor + chave Pix…" });
  const idemKey = supplier.document ? `payable-sup-${supplier.document}` : undefined;
  const sup = await api.suppliers.create(
    { name: supplier.name, type, document: supplier.document || null },
    idemKey ? { idempotencyKey: idemKey } : {},
  );
  const pm = await api.suppliers.paymentMethods.create(sup.id, {
    type: "pix", pix_key: pixKey, pix_key_type: pixKeyType, is_default: true,
  });
  log({ step: "supplier", status: "ok", detail: `Fornecedor ${sup.id} · forma ${pm.id}` });

  // 2. Conta a pagar com parcelas
  log({ step: "purchase", status: "run", detail: `Lançando conta a pagar em ${installments}x…` });
  const per = Math.round((amount / installments) * 100) / 100;
  const charges = Array.from({ length: installments }, (_, i) => ({
    due_date: isoDate(7 + i * 30),
    amount: i === installments - 1 ? Math.round((amount - per * (installments - 1)) * 100) / 100 : per,
    sequence: i + 1,
  }));
  const pi = await api.purchaseInvoices.create({
    supplier_id: sup.id,
    invoice_number: `[DEMO] NF-${Date.now().toString().slice(-6)}`,
    amount,
    issue_date: isoDate(),
    status: "aprovada",
    charges,
  });
  const firstCharge = (pi.purchase_invoice_charges || pi.charges || [])[0];
  log({ step: "purchase", status: "ok", detail: `Conta a pagar ${pi.id} · ${fmtMoney(amount)} · ${charges.length} parcela(s)` });

  // 3. Despesa vinculada
  log({ step: "expense", status: "run", detail: "Registrando despesa…" });
  const expense = await api.expenses.create({
    supplier_id: sup.id,
    description: `[DEMO] Despesa de ${supplier.name}`,
    amount,
    expense_date: isoDate(),
    status: "pendente",
  });
  log({ step: "expense", status: "ok", detail: `Despesa ${expense.id}` });

  // 4. Payout Pix (exige integração bancária; 422 → simulação)
  log({ step: "payout", status: "run", detail: "Gerando payout Pix…" });
  let bankAccountId = null;
  try {
    const ba = await api.bankAccounts.list({ per_page: 1 });
    bankAccountId = ba.data?.[0]?.id || null;
  } catch { /* sem scope bank_accounts:read */ }

  if (!bankAccountId) {
    const reason = "Sem conta bancária cadastrada para originar o payout.";
    log({ step: "payout", status: "sim", detail: `Modo simulação — ${reason}` });
    return { supplier: sup, paymentMethod: pm, purchaseInvoice: pi, expense, payout: simulatedPayout(amount, pixKey), simulated: true, reason };
  }

  try {
    const payout = await api.payouts.create({
      method: "pix",
      bank_account_id: bankAccountId,
      amount: firstCharge?.amount ?? amount,
      pix_key: pixKey,
      pix_key_type: pixKeyType,
      ...(firstCharge?.id ? { purchase_invoice_charge_id: firstCharge.id } : {}),
    });
    log({ step: "payout", status: "ok", detail: `Payout ${payout.id} · ${payout.status} · ${payout.provider ?? ""}` });
    return { supplier: sup, paymentMethod: pm, purchaseInvoice: pi, expense, payout, simulated: false };
  } catch (err) {
    if (err instanceof ComandoApiError && err.status === 422) {
      const reason = err.body?.error ?? "Sem integração bancária ativa.";
      log({ step: "payout", status: "sim", detail: `Modo simulação — ${reason}` });
      return { supplier: sup, paymentMethod: pm, purchaseInvoice: pi, expense, payout: simulatedPayout(amount, pixKey), simulated: true, reason };
    }
    throw err;
  }
}

/** Payout fake para o modo simulação (sem provedor). */
export function simulatedPayout(amount, pixKey) {
  return { id: "sim_" + Math.random().toString(36).slice(2, 12), status: "pending", method: "pix", provider: "simulado", amount, pix_key: pixKey };
}

/** Limpeza best-effort: cancela conta a pagar, exclui despesa e fornecedor. */
export async function cleanupPayable(api, { supplier, purchaseInvoice, expense, payout, simulated }, log = () => {}) {
  const done = [], kept = [];
  const tryDo = async (label, fn) => { try { await fn(); done.push(label); } catch (e) { kept.push(`${label} (${e instanceof ComandoApiError ? e.status : "erro"})`); } };
  if (payout?.id && !simulated) await tryDo("payout cancelado", () => api.payouts.cancel(payout.id));
  if (purchaseInvoice?.id)      await tryDo("conta a pagar cancelada", () => api.purchaseInvoices.cancel(purchaseInvoice.id));
  if (expense?.id)              await tryDo("despesa excluída", () => api.expenses.delete(expense.id));
  if (supplier?.id)             await tryDo("fornecedor excluído", () => api.suppliers.delete(supplier.id));
  log({ step: "cleanup", status: kept.length ? "sim" : "ok", detail: [done.join(", "), kept.length ? `retidos: ${kept.join(", ")}` : ""].filter(Boolean).join(" · ") || "nada a limpar" });
  return { done, kept };
}
