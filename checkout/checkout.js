/**
 * Lógica do checkout fake — usa o SDK para transformar um carrinho em uma
 * fatura + cobrança (Pix/boleto) reais na API do Comando.One.
 *
 * Reutilizável no navegador (index.html) e em Node (para testes).
 *
 * Fluxo de placeOrder():
 *   1. cria/reusa o cliente (idempotência por documento)
 *   2. cria a fatura (invoice) com os itens do carrinho
 *   3. cria a cobrança (charge) no método escolhido
 *      - se a empresa não tiver integração bancária → 422 → modo SIMULAÇÃO
 *        (gera um Pix copia-e-cola fake para demonstrar a tela)
 *   4. devolve { invoice, charge, simulated, reason }
 *
 * Depois, refreshCharge() consulta o status até "paid" (confirmado por webhook
 * no provider real). No modo simulação, simulatePaid() finge a confirmação.
 */

import { ComandoApi, ComandoApiError } from "../_shared/comando-api.js";

/** Catálogo fake da loja (não depende da API). */
export const CATALOG = [
  { id: "svc-consultoria", name: "Consultoria (1h)",        price: 250.0, emoji: "🧠" },
  { id: "svc-implantacao", name: "Implantação de sistema",  price: 1800.0, emoji: "🚀" },
  { id: "svc-suporte",     name: "Suporte mensal",          price: 490.0, emoji: "🛠️" },
  { id: "svc-treinamento", name: "Treinamento de equipe",   price: 1200.0, emoji: "🎓" },
  { id: "svc-auditoria",   name: "Auditoria fiscal",        price: 3500.0, emoji: "🔎" },
  { id: "svc-website",     name: "Site institucional",      price: 2900.0, emoji: "🌐" },
];

/** Cria o client do SDK com idempotência automática (evita cobrança dupla). */
export function makeApi(apiKey, baseUrl, companyId) {
  return new ComandoApi({ apiKey, baseUrl: baseUrl || undefined, companyId: companyId || undefined, autoIdempotency: true });
}

/**
 * Carrega o catálogo a partir dos SERVIÇOS cadastrados (GET /v1/services).
 * Retorna { products, source }: se a empresa tiver serviços, usa-os (com
 * service_id real); senão cai no catálogo fixo (CATALOG) sem service_id.
 */
export async function loadCatalog(api) {
  try {
    const r = await api.services.list({ active: "true", per_page: 50 });
    const items = (r.data || []).filter((s) => Number(s.price) > 0);
    if (items.length) {
      return {
        source: "services",
        products: items.map((s) => ({
          id: s.id,            // service_id real
          serviceId: s.id,
          name: s.name,
          price: Number(s.price),
          unit: s.unit || "un",
          emoji: emojiFor(s.name),
        })),
      };
    }
  } catch { /* sem scope services:read ou erro → usa catálogo fixo */ }
  return { source: "fallback", products: CATALOG };
}

/**
 * Carrega as formas de recebimento ATIVAS da empresa (GET /v1/payment-methods).
 * São as únicas opções de pagamento válidas — cada uma é um banco × canal real
 * (ex.: "Pix Estático (CPF)", "Boleto Inter"). Sem integração = lista vazia.
 */
export async function loadPaymentMethods(api) {
  try {
    const r = await api.lookups.paymentMethods({ active: "true", per_page: 50 });
    return (r.data || []).map((m) => ({ id: m.id, name: m.name, channel: m.channel_key, provider: m.provider_name }));
  } catch {
    return [];
  }
}

function emojiFor(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("consult")) return "🧠";
  if (n.includes("implant")) return "🚀";
  if (n.includes("suporte")) return "🛠️";
  if (n.includes("trein"))   return "🎓";
  if (n.includes("auditor")) return "🔎";
  if (n.includes("site") || n.includes("web")) return "🌐";
  return "📦";
}

export function cartTotal(cart) {
  return cart.reduce((sum, line) => sum + line.price * line.qty, 0);
}

/** YYYY-MM-DD daqui a N dias (default: hoje). */
export function isoDate(daysAhead = 0) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return d.toISOString().slice(0, 10);
}

/**
 * Pedido completo: cliente → fatura → cobrança.
 * @param {ComandoApi} api
 * @param {{ customer: {name,email,document}, cart: Array, method: "pix"|"boleto", log?: Function }} opts
 */
export async function placeOrder(api, { customer, cart, method, log = () => {} }) {
  if (!cart?.length) throw new Error("Carrinho vazio.");
  const total = cartTotal(cart);

  // Tipo do cliente: usa o informado; senão deduz pelo documento (>11 dígitos = CNPJ).
  const type = customer.type
    || ((customer.document || "").replace(/\D/g, "").length > 11 ? "juridica" : "fisica");

  // 1. Cliente (idempotente por documento para não duplicar em recompras)
  log({ step: "customer", status: "run", detail: "Criando cliente…" });
  const idemKey = customer.document ? `checkout-cust-${customer.document}` : undefined;
  const cust = await api.customers.create(
    {
      name: customer.name,
      type,
      document: customer.document || null,
      email: customer.email || null,
    },
    idemKey ? { idempotencyKey: idemKey } : {},
  );
  log({ step: "customer", status: "ok", detail: `Cliente ${cust.id} (${type})` });

  // 2. Fatura com os itens do carrinho (vincula service_id quando o produto
  //    vem de um serviço cadastrado).
  log({ step: "invoice", status: "run", detail: "Emitindo fatura…" });
  const invoice = await api.invoices.create({
    customer_id: cust.id,
    title: `Pedido loja — ${isoDate()}`,
    due_date: isoDate(3),
    items: cart.map((l) => ({
      ...(l.serviceId ? { service_id: l.serviceId } : {}),
      name: l.name,
      quantity: l.qty,
      unit_price: l.price,
    })),
  });
  log({ step: "invoice", status: "ok", detail: `Fatura ${invoice.id} · R$ ${total.toFixed(2)}` });

  // 3. Cobrança (Pix/boleto) — exige integração bancária na empresa
  log({ step: "charge", status: "run", detail: `Gerando cobrança ${method}…` });
  try {
    const charge = await api.charges.create({ invoice_id: invoice.id, method });
    log({ step: "charge", status: "ok", detail: `Cobrança ${charge.id} · ${charge.provider ?? ""}` });
    return { invoice, charge, customer: cust, simulated: false, total };
  } catch (err) {
    if (err instanceof ComandoApiError && err.status === 422) {
      // Sem integração bancária → demonstra a tela com dados simulados.
      const reason = err.body?.error ?? "Sem integração bancária ativa.";
      log({ step: "charge", status: "sim", detail: `Sem integração — modo simulação (${reason})` });
      return { invoice, customer: cust, simulated: true, reason, total, charge: simulatedCharge(method, total) };
    }
    throw err;
  }
}

/** Consulta o status atual da cobrança (no provider real, vira "paid" via webhook). */
export async function refreshCharge(api, chargeId) {
  return await api.charges.get(chargeId);
}

/** Cobrança fake para o modo simulação (sem provider). */
export function simulatedCharge(method, amount) {
  if (method === "boleto") {
    return {
      id: "sim_" + fakeId(),
      status: "pending",
      method: "boleto",
      provider: "simulado",
      amount,
      boleto: { digitable_line: fakeBoletoLine(), pdf_url: null },
    };
  }
  return {
    id: "sim_" + fakeId(),
    status: "pending",
    method: "pix",
    provider: "simulado",
    amount,
    pix: { qr_code: fakePixPayload(amount), qr_url: null, txid: fakeId() },
  };
}

/** No modo simulação, finge a confirmação de pagamento. */
export function simulatePaid(charge) {
  return { ...charge, status: "paid", status_raw: "CONCLUIDA" };
}

/** Simula localmente qualquer status terminal (sem tocar no backend). */
export function simulateStatus(charge, status) {
  const raw = { paid: "CONCLUIDA", cancelled: "CANCELADO", expired: "EXPIRADO", failed: "FALHA" }[status] || status;
  return { ...charge, status, status_raw: raw };
}

/** Cancela a cobrança DE VERDADE via API (DELETE /charges/:id). */
export async function cancelCharge(api, chargeId) {
  return await api.charges.cancel(chargeId);
}

/**
 * Confirma o pagamento DE VERDADE (Pix estático) via POST /charges/:id/confirm.
 * Marca a fatura como paga no servidor e dispara o webhook charge.paid — então
 * o polling da tela detecta "paid" sozinho.
 */
export async function confirmPayment(api, chargeId) {
  return await api.charges.confirm(chargeId);
}

/** Registra/atualiza o webhook de pagamentos da empresa (PUT /webhooks/payments). */
export async function registerWebhook(api, url, events) {
  return await api.webhooks.set({
    url,
    events: events || ["charge.paid", "charge.cancelled", "charge.expired", "charge.failed"],
  });
}

/** Lista as últimas entregas de webhook (GET /webhooks/deliveries). */
export async function listWebhookDeliveries(api, params) {
  return await api.webhooks.deliveries.list({ per_page: 5, ...(params || {}) });
}

// --- helpers de simulação -------------------------------------------------

function fakeId() {
  try { return crypto.randomUUID().replace(/-/g, "").slice(0, 16); }
  catch { return Math.abs(Math.sin(Date.now())).toString(36).slice(2, 18); }
}

/** Monta uma string Pix copia-e-cola no formato EMV (apenas para demonstração). */
function fakePixPayload(amount) {
  const val = amount.toFixed(2);
  const seg = (id, v) => id + String(v.length).padStart(2, "0") + v;
  const gui = seg("00", "br.gov.bcb.pix") + seg("01", "demo@comando.one");
  const mai = seg("26", gui);
  const payload =
    seg("00", "01") +
    mai +
    seg("52", "0000") +
    seg("53", "986") +
    seg("54", val) +
    seg("58", "BR") +
    seg("59", "LOJA FAKE COMANDO") +
    seg("60", "SAO PAULO") +
    seg("62", seg("05", "DEMO" + fakeId().slice(0, 6)));
  return payload + "6304" + "DEMO";
}

/** Linha digitável fake (47 posições) só para visual — não é boleto real. */
function fakeBoletoLine() {
  const d = (n) => Array.from({ length: n }, (_, i) => ((i * 7 + 3) % 10)).join("");
  return `${d(5)}.${d(5)} ${d(5)}.${d(6)} ${d(5)}.${d(6)} ${d(1)} ${d(14)}`;
}
