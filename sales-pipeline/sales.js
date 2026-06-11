/**
 * Pipeline comercial — Proposta → Contrato (lado vendedor).
 *
 * Demonstra o ciclo comercial via API: cria/reusa um cliente, gera uma proposta,
 * "envia" (status→enviada), "aceita" e converte num contrato recorrente.
 *
 * Reutilizável no navegador (index.html) e no Node (run.js).
 *
 * Fluxo:
 *   1. cria/reusa o cliente        → customers.create (idempotente por documento)
 *   2. cria a proposta             → proposals.create (total_amount, valid_until)
 *   3. envia a proposta            → proposals.send  (status→enviada)
 *   4. "aceita"                    → proposals.update (status→aceita)
 *   5. converte em contrato        → contracts.create (frequency, amount, start_date)
 *
 * ⚠️ Limitação da API: POST /proposals e POST /contracts aceitam só o CABEÇALHO —
 *    itens de linha NÃO entram via API (apenas total_amount / amount). O contrato
 *    é criado com o valor total da proposta.
 *
 * Scopes: customers:write, proposals:write, proposals:send, contracts:write
 *         (e :read/:delete para detalhe e limpeza).
 */

import { ComandoApi, ComandoApiError } from "../_shared/comando-api.js";

export function makeApi(apiKey, baseUrl, companyId) {
  return new ComandoApi({ apiKey, baseUrl: baseUrl || undefined, companyId: companyId || undefined, autoIdempotency: true });
}

/** YYYY-MM-DD daqui a N dias (default: hoje). */
export function isoDate(daysAhead = 0) {
  return new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
}

export function fmtMoney(n) {
  return "R$ " + Number(n || 0).toFixed(2).replace(".", ",");
}

const FREQ_LABEL = {
  semanal: "Semanal", quinzenal: "Quinzenal", mensal: "Mensal", bimestral: "Bimestral",
  trimestral: "Trimestral", semestral: "Semestral", anual: "Anual",
};
export function freqLabel(f) { return FREQ_LABEL[f] || f; }

/**
 * Executa o pipeline completo proposta → contrato.
 * @param {ComandoApi} api
 * @param {{ customer:{name,document?,email?,type?}, amount:number, frequency?:string,
 *           validDays?:number, notes?:string, log?:Function }} opts
 * @returns {{ customer, proposal, contract }}
 */
export async function runSalesPipeline(api, { customer, amount, frequency = "mensal", validDays = 15, notes, log = () => {} }) {
  if (!customer?.name) throw new Error("Informe o nome do cliente.");
  if (!amount || amount <= 0) throw new Error("Informe um valor (amount) positivo.");

  const type = customer.type
    || ((customer.document || "").replace(/\D/g, "").length > 11 ? "juridica" : "fisica");

  // 1. Cliente (idempotente por documento)
  log({ step: "customer", status: "run", detail: "Criando/reusando cliente…" });
  const idemKey = customer.document ? `sales-cust-${customer.document}` : undefined;
  const cust = await api.customers.create(
    { name: customer.name, type, document: customer.document || null, email: customer.email || null },
    idemKey ? { idempotencyKey: idemKey } : {},
  );
  log({ step: "customer", status: "ok", detail: `Cliente ${cust.id} (${type})` });

  // 2. Proposta
  log({ step: "proposal", status: "run", detail: "Criando proposta…" });
  const proposal = await api.proposals.create({
    customer_id: cust.id,
    total_amount: amount,
    valid_until: isoDate(validDays),
    notes: notes || `Proposta gerada via demo sales-pipeline (${isoDate()})`,
  });
  log({ step: "proposal", status: "ok", detail: `Proposta ${proposal.id} · ${fmtMoney(amount)} · status ${proposal.status}` });

  // 3. Enviar
  log({ step: "send", status: "run", detail: "Enviando proposta…" });
  await api.proposals.send(proposal.id);
  log({ step: "send", status: "ok", detail: "Proposta enviada (status→enviada)" });

  // 4. Aceitar
  log({ step: "accept", status: "run", detail: "Marcando como aceita…" });
  let accepted = null;
  try {
    accepted = await api.proposals.update(proposal.id, { status: "aceita" });
    log({ step: "accept", status: "ok", detail: "Proposta aceita (status→aceita)" });
  } catch (err) {
    // Se a API não permitir esse status diretamente, segue o fluxo mesmo assim.
    const reason = err instanceof ComandoApiError ? `${err.status} ${err.body?.error ?? ""}` : String(err);
    log({ step: "accept", status: "sim", detail: `Não foi possível marcar aceita (${reason}) — seguindo` });
  }

  // 5. Converter em contrato
  log({ step: "contract", status: "run", detail: "Convertendo em contrato…" });
  const contract = await api.contracts.create({
    customer_id: cust.id,
    title: `Contrato — proposta ${proposal.id.slice(0, 8)}`,
    status: "ativo",
    frequency,
    amount,
    start_date: isoDate(),
    notes: `Origem: proposta ${proposal.id}`,
  });
  log({ step: "contract", status: "ok", detail: `Contrato ${contract.id} · ${freqLabel(frequency)} · ${fmtMoney(amount)} · status ${contract.status}` });

  return { customer: cust, proposal: accepted || proposal, contract };
}

/** Limpeza best-effort: exclui contrato, proposta e cliente criados. */
export async function cleanupSalesPipeline(api, { customer, proposal, contract }, log = () => {}) {
  const done = [], kept = [];
  const tryDo = async (label, fn) => { try { await fn(); done.push(label); } catch (e) { kept.push(`${label} (${e instanceof ComandoApiError ? e.status : "erro"})`); } };
  if (contract?.id) await tryDo("contrato excluído", () => api.contracts.delete(contract.id));
  if (proposal?.id) await tryDo("proposta excluída", () => api.proposals.delete(proposal.id));
  if (customer?.id) await tryDo("cliente excluído", () => api.customers.delete(customer.id));
  log({ step: "cleanup", status: kept.length ? "sim" : "ok", detail: [done.join(", "), kept.length ? `retidos: ${kept.join(", ")}` : ""].filter(Boolean).join(" · ") || "nada a limpar" });
  return { done, kept };
}
