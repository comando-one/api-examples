/**
 * Demo do módulo de Split de Pagamentos — cenário "Hub de estacionamento".
 *
 * Um hub agrega estacionamentos. O motorista paga (Pix); o valor é dividido
 * entre o HUB (plataforma, comissão %) e o ESTACIONAMENTO (fornecedor, fatia
 * dele) e repassado automaticamente. Ver specs/split-fornecedores/01 §1.3.
 *
 * Fluxo (tudo via API pública):
 *   1. setupScenario()      cria fornecedor + Pix + regra de split 15/85
 *   2. createInstallmentRule() regra de split POR PARCELA (recurso API-only)
 *   3. simulateSale()       cliente → fatura → cobrança Pix → confirma (paga)
 *   4. waitForExecution()   o orquestrador calcula o split (cron ~1 min); a
 *                           demo aguarda a execução aparecer em /v1/split-executions
 *   5. teardown()           limpeza best-effort (estorna, apaga regra, cancela)
 *
 * Reutilizável no navegador (index.html) e em Node (run.js).
 */

import { ComandoApi, ComandoApiError } from "../_shared/comando-api.js?v=split";

export function makeApi(apiKey, baseUrl, companyId) {
  return new ComandoApi({ apiKey, baseUrl: baseUrl || undefined, companyId: companyId || undefined, autoIdempotency: true });
}

export function fmtMoney(v) { return `R$ ${Number(v || 0).toFixed(2)}`; }
export function fmtCents(c) { return `R$ ${(Number(c || 0) / 100).toFixed(2)}`; }
export function isoDate(daysAhead = 0) { return new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SUPPLIER_DOC = "11222333000181"; // CNPJ fake do estacionamento
const DRIVER_DOC = "39053344705";      // CPF fake do motorista
const onlyDigits = (s) => (s || "").replace(/\D/g, "");

/**
 * Busca por documento e reusa; senão cria. Evita duplicar entre execuções (e o
 * problema de idempotência apontar para um registro já excluído na limpeza).
 */
async function findOrCreate(resource, doc, createData) {
  try {
    const r = await resource.list({ search: doc, per_page: 10 });
    const hit = (r.data || []).find((x) => onlyDigits(x.document) === onlyDigits(doc));
    if (hit) return hit;
  } catch { /* sem scope :read → cria direto */ }
  return await resource.create(createData);
}

/**
 * Monta o cenário: fornecedor (estacionamento) + chave Pix + regra de split
 * "padrão da empresa" dividindo todo recebimento entre hub e estacionamento.
 */
export async function setupScenario(api, { platformPercent = 15, log = () => {} } = {}) {
  // 0. Remove regras [SPLIT] de execuções anteriores (evita acumular várias
  //    company_default — na resolução, a mais recente venceria de forma confusa).
  try {
    const prev = await api.split.rules.list({ per_page: 50 });
    for (const r of (prev.data || []).filter((x) => (x.name || "").startsWith("[SPLIT]"))) {
      await api.split.rules.delete(r.id).catch(() => {});
    }
  } catch { /* sem scope split:list → segue */ }

  // 1. Fornecedor (estacionamento) — busca por documento e reusa, senão cria.
  log({ step: "supplier", status: "run", detail: "Criando estacionamento (fornecedor)…" });
  const supplier = await findOrCreate(api.suppliers, SUPPLIER_DOC,
    { name: "[SPLIT] Estacionamento Centro", legal_name: "Estacionamento Centro Ltda", type: "juridica", document: SUPPLIER_DOC, email: "centro@estac.demo" });
  log({ step: "supplier", status: "ok", detail: `Estacionamento ${supplier.id}` });

  // 2. Chave Pix do estacionamento (destino do repasse) — reusa se já existir.
  log({ step: "pix", status: "run", detail: "Cadastrando chave Pix do estacionamento…" });
  let paymentMethod = null;
  try {
    const existing = await api.suppliers.paymentMethods.list(supplier.id).catch(() => ({ data: [] }));
    paymentMethod = (existing.data || []).find((m) => m.type === "pix")
      || await api.suppliers.paymentMethods.create(supplier.id, {
        type: "pix", label: "Pix principal", pix_key: "centro@estac.demo", pix_key_type: "email", is_default: true,
      });
    log({ step: "pix", status: "ok", detail: `Pix ${paymentMethod.id}` });
  } catch (e) {
    log({ step: "pix", status: "skip", detail: `Pix pulado (${e.status || "erro"})` });
  }

  // 3. Regra de split padrão da empresa: hub (plataforma) X% + estacionamento (resto).
  const supplierPercent = 100 - platformPercent;
  log({ step: "rule", status: "run", detail: `Criando regra ${platformPercent}/${supplierPercent} (hub/estac)…` });
  const rule = await api.split.rules.create({
    name: "[SPLIT] Hub de estacionamento",
    scope: "company_default",
    fiscal_mode: "intermediacao",
    fee_payer: "platform",
    release_trigger: "on_settlement",
    recipients: [
      { recipient_type: "platform", is_platform_fee: true, basis: "percentual", percent: platformPercent },
      { recipient_type: "supplier", supplier_id: supplier.id, basis: "percentual", percent: supplierPercent,
        ...(paymentMethod ? { supplier_payment_method_id: paymentMethod.id } : {}) },
    ],
  });
  log({ step: "rule", status: "ok", detail: `Regra ${rule.id} — hub ${platformPercent}% / estac ${supplierPercent}%` });

  return { supplier, paymentMethod, rule };
}

/**
 * Regra de split POR PARCELA — recurso exposto só na API (igual à Iugu).
 * Ex.: o hub retém comissão maior na 1ª parcela e menor nas seguintes.
 * Cria e relê a regra para provar que os installments foram persistidos.
 */
export async function createInstallmentRule(api, { supplier, paymentMethod, log = () => {} }) {
  log({ step: "installment", status: "run", detail: "Criando regra de split POR PARCELA…" });
  const created = await api.split.rules.create({
    name: "[SPLIT] Parcelado (comissão progressiva)",
    scope: "company_default",
    fee_payer: "platform",
    release_trigger: "manual",
    recipients: [
      // Hub (mestre) absorve a sobra; estacionamento varia por parcela.
      { recipient_type: "platform", is_platform_fee: true, basis: "percentual", percent: 0 },
      {
        recipient_type: "supplier", supplier_id: supplier.id, basis: "percentual",
        ...(paymentMethod ? { supplier_payment_method_id: paymentMethod.id } : {}),
        apply_per_installment: true,
        installments: { "1": { percent: 50 }, "default": { percent: 90 } },
      },
    ],
  });
  // Relê para confirmar persistência dos installments.
  const fetched = await api.split.rules.get(created.id);
  const sup = (fetched.recipients || []).find((r) => r.apply_per_installment);
  // Remove logo após demonstrar: como também é company_default, ela "venceria" a
  // regra 15/85 na resolução por escopo (a mais recente ganha). Aqui o objetivo é
  // só provar o recurso de split por parcela via API, sem afetar a venda.
  await api.split.rules.delete(created.id).catch(() => {});
  log({ step: "installment", status: "ok", detail: `Regra ${created.id} — parcela 1: 50% / demais: 90% (criada, lida, removida)` });
  return { rule: fetched, installmentRecipient: sup };
}

/**
 * Valida vários TIPOS de regra via API: cria → relê → confere os campos
 * persistidos → apaga. Não interfere na venda (cada cenário se autolimpa).
 * Cobre: fixo, combinado, fee_payer, arredondamento e split por parcela.
 */
export async function validateRuleScenarios(api, { supplier, log = () => {} }) {
  const sid = supplier.id;
  const scenarios = [
    { label: "fixo (R$2 plataforma + R$8 fornecedor)",
      body: { name: "[SPLIT] v-fixo", scope: "company_default", fee_payer: "platform", recipients: [
        { recipient_type: "platform", is_platform_fee: true, basis: "fixo", fixed_cents: 200 },
        { recipient_type: "supplier", supplier_id: sid, basis: "fixo", fixed_cents: 800 } ] },
      check: (r) => { const s = r.recipients.find((x) => x.recipient_type === "supplier");
        if (s.basis !== "fixo" || Number(s.fixed_cents) !== 800) throw new Error("fixo não persistiu"); } },
    { label: "combinado (10% + R$5)",
      body: { name: "[SPLIT] v-comb", scope: "company_default", fee_payer: "platform", recipients: [
        { recipient_type: "platform", is_platform_fee: true, basis: "percentual", percent: 0 },
        { recipient_type: "supplier", supplier_id: sid, basis: "combinado", percent: 10, fixed_cents: 500 } ] },
      check: (r) => { const s = r.recipients.find((x) => x.recipient_type === "supplier");
        if (s.basis !== "combinado" || Number(s.percent) !== 10 || Number(s.fixed_cents) !== 500) throw new Error("combinado não persistiu"); } },
    { label: "split por parcela % (1=50/default=90)",
      body: { name: "[SPLIT] v-parc", scope: "company_default", fee_payer: "platform", release_trigger: "manual", recipients: [
        { recipient_type: "platform", is_platform_fee: true, basis: "percentual", percent: 0 },
        { recipient_type: "supplier", supplier_id: sid, basis: "percentual", apply_per_installment: true,
          installments: { "1": { percent: 50 }, "default": { percent: 90 } } } ] },
      check: (r) => { const s = r.recipients.find((x) => x.apply_per_installment);
        if (s?.installments?.["1"]?.percent !== 50) throw new Error("installments não persistiram"); } },
    { label: "fee_payer=proportional",
      body: { name: "[SPLIT] v-prop", scope: "company_default", fee_payer: "proportional", recipients: [
        { recipient_type: "platform", is_platform_fee: true, basis: "percentual", percent: 20 },
        { recipient_type: "supplier", supplier_id: sid, basis: "percentual", percent: 80 } ] },
      check: (r) => { if (r.fee_payer !== "proportional") throw new Error("fee_payer não persistiu"); } },
  ];
  let ok = 0;
  for (const s of scenarios) {
    log({ step: "validate", status: "run", detail: `Validando regra: ${s.label}…` });
    let created = null;
    try {
      created = await api.split.rules.create(s.body);
      s.check(await api.split.rules.get(created.id));
      log({ step: "validate", status: "ok", detail: `${s.label} — campos persistidos ✓` });
      ok++;
    } catch (e) {
      log({ step: "validate", status: "fail", detail: `${s.label} — ${e.message}` });
    } finally {
      if (created) await api.split.rules.delete(created.id).catch(() => {});
    }
  }
  return { ok, total: scenarios.length };
}

/**
 * Simula uma venda do estacionamento: motorista → fatura → cobrança Pix.
 * Confirma o pagamento (Pix estático) para liquidar e disparar o split.
 */
export async function simulateSale(api, { amount = 20, log = () => {} } = {}) {
  log({ step: "driver", status: "run", detail: "Criando motorista (cliente)…" });
  const customer = await findOrCreate(api.customers, DRIVER_DOC,
    { name: "[SPLIT] Motorista Demo", type: "fisica", document: DRIVER_DOC, email: "motorista@demo.com" });
  log({ step: "driver", status: "ok", detail: `Motorista ${customer.id}` });

  log({ step: "invoice", status: "run", detail: "Emitindo fatura da estadia…" });
  const invoice = await api.invoices.create({
    customer_id: customer.id,
    title: `Estacionamento — ${isoDate()}`,
    due_date: isoDate(0),
    items: [{ name: "Estadia 2h — Estacionamento Centro", quantity: 1, unit_price: amount }],
  });
  log({ step: "invoice", status: "ok", detail: `Fatura ${invoice.id} · ${fmtMoney(amount)}` });

  log({ step: "charge", status: "run", detail: "Gerando cobrança Pix…" });
  let charge = null, simulated = false, reason = null;
  try {
    charge = await api.charges.create({ invoice_id: invoice.id, method: "pix" });
    log({ step: "charge", status: "ok", detail: `Cobrança ${charge.id} · ${charge.provider ?? ""}` });
    // Confirma o pagamento (Pix estático) → liquida → dispara o split.
    log({ step: "confirm", status: "run", detail: "Confirmando pagamento (Pix)…" });
    await api.charges.confirm(charge.id);
    log({ step: "confirm", status: "ok", detail: "Pagamento confirmado — recebimento liquidado." });
  } catch (e) {
    if (e instanceof ComandoApiError && e.status === 422) {
      simulated = true; reason = e.body?.error ?? "Sem integração bancária ativa.";
      log({ step: "charge", status: "sim", detail: `Sem integração — recebimento não liquidado (${reason})` });
    } else { throw e; }
  }

  return { customer, invoice, charge, simulated, reason };
}

/**
 * Aguarda o orquestrador calcular o split para a fatura. O orquestrador roda por
 * cron (~1 min), então fazemos polling em /v1/split-executions?invoice_id=...
 */
export async function waitForExecution(api, { invoiceId, timeoutMs = 90000, intervalMs = 5000, log = () => {} }) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const r = await api.split.executions.list({ invoice_id: invoiceId, per_page: 5 });
    const exec = (r.data || [])[0];
    if (exec) { log({ step: "exec", status: "ok", detail: `Execução ${exec.id} · ${exec.status}` }); return exec; }
    log({ step: "exec", status: "run", detail: `Aguardando o split ser calculado (tentativa ${attempt})…` });
    await sleep(intervalMs);
  }
  log({ step: "exec", status: "skip", detail: "Split não calculado no tempo (cron ~1 min ou sem liquidação)." });
  return null;
}

/** Texto-resumo da divisão de uma execução. */
export function summarizeExecution(exec) {
  if (!exec) return [];
  return (exec.items || []).map((it) => {
    const who = it.is_platform_fee ? "Hub (plataforma)"
      : it.recipient_type === "company_master" ? "Conta mestre"
      : (it.supplier_name || "Estacionamento");
    return { who, gross: it.gross_share_cents, fee: it.fee_share_cents, net: it.net_share_cents, status: it.status, error: it.error_message || null };
  });
}

/** Limpeza best-effort de tudo que a demo criou. */
export async function teardown(api, refs, log = () => {}) {
  const tryDo = async (label, fn) => { try { await fn(); log({ status: "ok", detail: label }); } catch (e) { log({ status: "skip", detail: `${label} pulado (${e.status || "erro"})` }); } };
  if (refs.execution?.id && refs.execution.status !== "reversed") {
    await tryDo("execução estornada", () => api.split.executions.reverse(refs.execution.id));
  }
  if (refs.invoice?.id) await tryDo("fatura cancelada", () => api.invoices.cancel(refs.invoice.id));
  if (refs.installmentRule?.id) await tryDo("regra por parcela removida", () => api.split.rules.delete(refs.installmentRule.id));
  if (refs.rule?.id) await tryDo("regra padrão removida", () => api.split.rules.delete(refs.rule.id));
  if (refs.customer?.id) await tryDo("motorista excluído", () => api.customers.delete(refs.customer.id));
  if (refs.supplier?.id) await tryDo("estacionamento excluído", () => api.suppliers.delete(refs.supplier.id));
}
