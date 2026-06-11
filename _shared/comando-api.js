/**
 * SDK JS da API pública do Comando.One.
 * ESM puro, sem dependências — funciona no navegador e no Node 18+ (fetch nativo).
 *
 *   import { ComandoApi } from "../_shared/comando-api.js";
 *   const api = new ComandoApi({ apiKey: "cmd_live_..." });
 *   const me = await api.me();
 *   const clientes = await api.customers.list({ status: "ativo" });
 *   const todos = await api.customers.listAll();           // pagina sozinho
 *   const filial = api.withCompany("uuid");                // multi-empresa
 *
 * Base URL padrão: https://api.comando.one/v1 (produção; o gateway injeta a anon key).
 */

export class ComandoApiError extends Error {
  constructor(status, body, method, path) {
    super(`${method} ${path} → ${status}: ${body?.error ?? JSON.stringify(body)}`);
    this.name = "ComandoApiError";
    this.status = status;
    this.body = body;
  }
}

function qs(params) {
  if (!params) return "";
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

let _autoCounter = 0;
function genIdemKey() {
  // navegador moderno e Node 19+ têm crypto.randomUUID
  try { return `auto-${crypto.randomUUID()}`; } catch { return `auto-${Date.now()}-${_autoCounter++}`; }
}

export class ComandoApi {
  /** @param {{apiKey:string, baseUrl?:string, companyId?:string, autoIdempotency?:boolean}} opts */
  constructor({ apiKey, baseUrl = "https://api.comando.one/v1", companyId, autoIdempotency = false } = {}) {
    if (!apiKey) throw new Error("apiKey é obrigatório (cmd_live_...).");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.companyId = companyId || null;
    this.autoIdempotency = autoIdempotency;
    this._bindResources();
  }

  /** Clona o client fixando uma empresa (header X-Company-Id). */
  withCompany(companyId) {
    return new ComandoApi({ apiKey: this.apiKey, baseUrl: this.baseUrl, companyId, autoIdempotency: this.autoIdempotency });
  }

  /** Requisição genérica. opts: { body, idempotencyKey, companyId, raw } */
  async request(method, path, opts = {}) {
    const headers = { "x-api-key": this.apiKey, "Content-Type": "application/json" };
    const company = opts.companyId ?? this.companyId;
    if (company) headers["X-Company-Id"] = company;
    let idem = opts.idempotencyKey;
    if (!idem && this.autoIdempotency && method === "POST") idem = genIdemKey();
    if (idem) headers["Idempotency-Key"] = idem;

    const init = { method, headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    const res = await fetch(`${this.baseUrl}${path}`, init);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }

    if (opts.raw) return { status: res.status, body, replayed: res.headers.get("idempotent-replayed") === "true" };
    if (!res.ok) throw new ComandoApiError(res.status, body, method, path);
    return body;
  }

  get(path, opts)        { return this.request("GET", path, opts); }
  post(path, body, opts)  { return this.request("POST", path, { ...opts, body }); }
  patch(path, body, opts) { return this.request("PATCH", path, { ...opts, body }); }
  delete(path, opts)      { return this.request("DELETE", path, opts); }

  /** Paginação automática: itera ?page= até cobrir meta.total. Retorna array achatado. */
  async listAll(path, params = {}, opts = {}) {
    const perPage = params.per_page ?? 100;
    let page = 1, all = [], total = Infinity;
    while (all.length < total) {
      const r = await this.get(`${path}${qs({ ...params, page, per_page: perPage })}`, opts);
      const data = r.data ?? [];
      all = all.concat(data);
      total = r.meta?.total ?? all.length;
      if (data.length === 0) break;
      page++;
      if (page > 1000) break; // trava de segurança
    }
    return all;
  }

  // -------------------------------------------------------------------------
  // Namespaces por recurso (cobertura total da API)
  // -------------------------------------------------------------------------
  _bindResources() {
    const g = this;
    const crud = (base, { create = true, update = true, del = true } = {}) => ({
      list:   (params, opts) => g.get(`${base}${qs(params)}`, opts),
      listAll:(params, opts) => g.listAll(base, params, opts),
      get:    (id, opts) => g.get(`${base}/${id}`, opts),
      ...(create ? { create: (data, opts) => g.post(base, data, opts) } : {}),
      ...(update ? { update: (id, data, opts) => g.patch(`${base}/${id}`, data, opts) } : {}),
      ...(del ? { delete: (id, opts) => g.delete(`${base}/${id}`, opts) } : {}),
    });

    this.companies = {
      list: (opts) => g.get("/companies", opts),
      get:  (id, opts) => g.get(`/companies/${id}`, opts),
    };

    this.customers = {
      ...crud("/customers"),
      invoices:  (id, params, opts) => g.get(`/customers/${id}/invoices${qs(params)}`, opts),
      contracts: (id, params, opts) => g.get(`/customers/${id}/contracts${qs(params)}`, opts),
      proposals: (id, params, opts) => g.get(`/customers/${id}/proposals${qs(params)}`, opts),
      addresses: {
        list:   (cid, opts) => g.get(`/customers/${cid}/addresses`, opts),
        create: (cid, data, opts) => g.post(`/customers/${cid}/addresses`, data, opts),
        update: (cid, aid, data, opts) => g.patch(`/customers/${cid}/addresses/${aid}`, data, opts),
        delete: (cid, aid, opts) => g.delete(`/customers/${cid}/addresses/${aid}`, opts),
      },
      contacts: {
        list:   (cid, opts) => g.get(`/customers/${cid}/contacts`, opts),
        create: (cid, data, opts) => g.post(`/customers/${cid}/contacts`, data, opts),
        update: (cid, kid, data, opts) => g.patch(`/customers/${cid}/contacts/${kid}`, data, opts),
        delete: (cid, kid, opts) => g.delete(`/customers/${cid}/contacts/${kid}`, opts),
      },
    };

    this.suppliers = {
      ...crud("/suppliers"),
      paymentMethods: {
        list:   (sid, opts) => g.get(`/suppliers/${sid}/payment-methods`, opts),
        create: (sid, data, opts) => g.post(`/suppliers/${sid}/payment-methods`, data, opts),
        update: (sid, mid, data, opts) => g.patch(`/suppliers/${sid}/payment-methods/${mid}`, data, opts),
        delete: (sid, mid, opts) => g.delete(`/suppliers/${sid}/payment-methods/${mid}`, opts),
      },
    };

    this.services = crud("/services");
    this.expenses = crud("/expenses");

    this.proposals = {
      ...crud("/proposals"),
      send: (id, opts) => g.post(`/proposals/${id}/send`, undefined, opts),
    };
    this.contracts = crud("/contracts");

    this.invoices = {
      list:   (params, opts) => g.get(`/invoices${qs(params)}`, opts),
      listAll:(params, opts) => g.listAll("/invoices", params, opts),
      get:    (id, opts) => g.get(`/invoices/${id}`, opts),
      create: (data, opts) => g.post("/invoices", data, opts),
      cancel: (id, opts) => g.patch(`/invoices/${id}/cancel`, {}, opts),
    };

    this.purchaseInvoices = {
      list:   (params, opts) => g.get(`/purchase-invoices${qs(params)}`, opts),
      listAll:(params, opts) => g.listAll("/purchase-invoices", params, opts),
      get:    (id, opts) => g.get(`/purchase-invoices/${id}`, opts),
      create: (data, opts) => g.post("/purchase-invoices", data, opts),
      cancel: (id, opts) => g.patch(`/purchase-invoices/${id}/cancel`, {}, opts),
    };

    this.charges = {
      list:   (params, opts) => g.get(`/charges${qs(params)}`, opts),
      listAll:(params, opts) => g.listAll("/charges", params, opts),
      get:    (id, opts) => g.get(`/charges/${id}`, opts),
      create: (data, opts) => g.post("/charges", data, opts),
      cancel: (id, opts) => g.delete(`/charges/${id}`, opts),
      refund: (id, opts) => g.post(`/charges/${id}/refund`, undefined, opts),
      confirm: (id, opts) => g.post(`/charges/${id}/confirm`, undefined, opts), // Pix estático: marca pago + dispara charge.paid
    };

    this.payouts = {
      list:   (params, opts) => g.get(`/payouts${qs(params)}`, opts),
      listAll:(params, opts) => g.listAll("/payouts", params, opts),
      get:    (id, opts) => g.get(`/payouts/${id}`, opts),
      create: (data, opts) => g.post("/payouts", data, opts),
      cancel: (id, opts) => g.post(`/payouts/${id}/cancel`, undefined, opts),
      sync:   (id, opts) => g.post(`/payouts/${id}/sync`, undefined, opts),
    };

    // Split de Pagamentos / Repasse a fornecedores
    this.split = {
      rules: crud("/split-rules"),
      executions: {
        list:    (params, opts) => g.get(`/split-executions${qs(params)}`, opts),
        listAll: (params, opts) => g.listAll("/split-executions", params, opts),
        get:     (id, opts) => g.get(`/split-executions/${id}`, opts),
        reverse: (id, opts) => g.post(`/split-executions/${id}/reverse`, undefined, opts),
      },
      items: {
        release: (id, opts) => g.post(`/split-items/${id}/release`, undefined, opts),
      },
    };

    this.nfse = {
      list:   (params, opts) => g.get(`/nfse${qs(params)}`, opts),
      get:    (id, opts) => g.get(`/nfse/${id}`, opts),
      emit:   (invoiceId, opts) => g.post("/nfse", { invoice_id: invoiceId }, opts),
      cancel: (id, { motivo, justificativa }, opts) => g.patch(`/nfse/${id}/cancel`, { motivo, justificativa }, opts),
    };

    this.finance = {
      ledger:         (params, opts) => g.get(`/finance/ledger${qs(params)}`, opts),
      natures:        (params, opts) => g.get(`/finance/natures${qs(params)}`, opts),
      createMovement: (data, opts) => g.post("/finance/movements", data, opts),
      deleteMovement: (id, opts) => g.delete(`/finance/movements/${id}`, opts),
    };

    this.lookups = {
      costCenters:      (params, opts) => g.get(`/cost-centers${qs(params)}`, opts),
      paymentConditions:(params, opts) => g.get(`/payment-conditions${qs(params)}`, opts),
      serviceUnits:     (params, opts) => g.get(`/service-units${qs(params)}`, opts),
      paymentMethods:   (params, opts) => g.get(`/payment-methods${qs(params)}`, opts),       // recebimento (AR)
      paymentMethodsAp: (params, opts) => g.get(`/payment-methods/ap${qs(params)}`, opts),     // pagamento (AP)
    };

    this.bankAccounts = {
      list: (params, opts) => g.get(`/bank-accounts${qs(params)}`, opts),
      get:  (id, opts) => g.get(`/bank-accounts/${id}`, opts),
    };

    this.webhooks = {
      get:    (opts) => g.get("/webhooks/payments", opts),
      set:    (data, opts) => g.request("PUT", "/webhooks/payments", { ...opts, body: data }),
      delete: (opts) => g.delete("/webhooks/payments", opts),
      deliveries: {
        list:      (params, opts) => g.get(`/webhooks/deliveries${qs(params)}`, opts),
        redeliver: (id, opts) => g.post(`/webhooks/deliveries/${id}/redeliver`, undefined, opts),
      },
    };
  }

  // ---- Atalho de identidade ----
  me(opts) { return this.get("/me", opts); }

  // ---- Aliases legados (compatibilidade) ----
  listCustomers(q = "") { return this.get(`/customers${q}`); }
  createCustomer(data, opts) { return this.post("/customers", data, opts); }
  getCustomer(id) { return this.get(`/customers/${id}`); }
  deleteCustomer(id) { return this.delete(`/customers/${id}`); }
  addCustomerAddress(id, data) { return this.post(`/customers/${id}/addresses`, data); }
  createInvoice(data) { return this.post("/invoices", data); }
  cancelInvoice(id) { return this.patch(`/invoices/${id}/cancel`, {}); }
  createCharge(data, opts) { return this.post("/charges", data, opts); }
  getCharge(id) { return this.get(`/charges/${id}`); }
  financeNatures() { return this.get("/finance/natures"); }
  paymentMethods() { return this.get("/payment-methods"); }
}
