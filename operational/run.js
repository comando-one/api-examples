/**
 * Módulos operacionais (somente leitura) — validação via CLI (Node 18+).
 *
 *   COMANDO_API_KEY=cmd_live_... node operational/run.js
 *   # opcionais: COMANDO_BASE_URL, COMANDO_COMPANY_ID, ou a chave como argv[2]
 *
 * Percorre os sete módulos que passaram a ser legíveis pela API em 2026-09-01 — caixa de
 * entrada, conciliação, faturas de cartão, DDA, recorrentes (despesa e conta a pagar),
 * insumos e notificações — e mostra o que a sua empresa tem em cada um.
 *
 * Não escreve nada: esses módulos são read-only na API. Uma chave sem o scope de um módulo
 * recebe 403 naquele módulo e o demo segue nos outros — é assim que dá para ver, na prática,
 * o que cada scope libera.
 */

import { ComandoApi } from "../_shared/comando-api.js";

const apiKey = process.env.COMANDO_API_KEY || process.argv[2];
const baseUrl = process.env.COMANDO_BASE_URL || undefined;
const companyId = process.env.COMANDO_COMPANY_ID || undefined;

if (!apiKey) {
  console.error("Informe a chave: COMANDO_API_KEY=cmd_live_... node operational/run.js");
  process.exit(2);
}

const api = new ComandoApi({ apiKey, ...(baseUrl ? { baseUrl } : {}), ...(companyId ? { companyId } : {}) });

const money = (v) =>
  v == null ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dia = (v) => (v ? String(v).slice(0, 10).split("-").reverse().join("/") : "—");

/** Cada módulo: rótulo, scope necessário, chamada e como resumir uma linha. */
const MODULOS = [
  {
    rotulo: "Caixa de entrada — mensagens", scope: "inbox:read",
    buscar: () => api.inbox.messages.list({ per_page: 3 }),
    linha: (m) => `${m.subject || "(sem assunto)"} · de ${m.from_email} · ${m.status}`,
  },
  {
    rotulo: "Caixa de entrada — documentos", scope: "inbox:read",
    buscar: () => api.inbox.documents.list({ per_page: 3 }),
    linha: (d) => `${d.filename} · ${d.kind || "?"} · ${money(d.amount)} · vence ${dia(d.due_date)}`,
  },
  {
    rotulo: "Conciliação — extrato", scope: "reconciliation:read",
    buscar: () => api.reconciliation.entries.list({ per_page: 3 }),
    linha: (e) => `${dia(e.entry_date)} · ${money(e.amount)} · ${e.description || "—"}`,
  },
  {
    rotulo: "Conciliação — períodos", scope: "reconciliation:read",
    buscar: () => api.reconciliation.periods.list({ per_page: 3 }),
    linha: (p) => `${dia(p.start_date)} a ${dia(p.end_date)} · ${p.status} · saldo ${money(p.closing_balance)}`,
  },
  {
    rotulo: "Faturas de cartão", scope: "cards:read",
    buscar: () => api.cardStatements.list({ per_page: 3 }),
    linha: (f) => `${String(f.reference_month).slice(0, 7)} · ${f.status} · ${money(f.total_expenses)} · vence ${dia(f.due_date)}`,
  },
  {
    rotulo: "DDA — boletos avisados", scope: "dda:read",
    buscar: () => api.ddaBoletos.list({ per_page: 3 }),
    linha: (b) => `${b.beneficiary_name || "?"} · ${money(b.amount)} · vence ${dia(b.due_date)} · ${b.match_status}`,
  },
  {
    rotulo: "Despesas recorrentes", scope: "recurring:read",
    buscar: () => api.recurringExpenses.list({ per_page: 3 }),
    linha: (r) => `${r.description || "?"} · ${money(r.amount)} · ${r.frequency} · próxima ${dia(r.next_generation_date)}`,
  },
  {
    rotulo: "Contas a pagar recorrentes", scope: "recurring:read",
    buscar: () => api.recurringPurchaseInvoices.list({ per_page: 3 }),
    linha: (r) => `${r.frequency} · ${r.status} · próxima ${dia(r.next_generation_date)}`,
  },
  {
    rotulo: "Insumos", scope: "insumos:read",
    buscar: () => api.insumos.list({ per_page: 3 }),
    linha: (i) => `${i.name} · ${money(i.unit_price)}/${i.unit || "un"} · ${i.active ? "ativo" : "inativo"}`,
  },
  {
    rotulo: "Notificações", scope: "notifications:read",
    buscar: () => api.notifications.list({ per_page: 3 }),
    linha: (n) => `${n.title || n.type} · ${dia(n.created_at)} · ${n.read_at ? "lida" : "não lida"}`,
  },
];

console.log("\nMódulos operacionais — somente leitura\n" + "─".repeat(60));

let comAcesso = 0;
let semScope = 0;

for (const m of MODULOS) {
  try {
    const r = await m.buscar();
    const total = r?.meta?.total ?? 0;
    const itens = r?.data ?? [];
    comAcesso++;
    console.log(`\n${m.rotulo}  (${total})`);
    if (itens.length === 0) {
      console.log("   — nada por aqui");
    } else {
      for (const item of itens) console.log(`   · ${m.linha(item)}`);
      if (total > itens.length) console.log(`   … e mais ${total - itens.length}`);
    }
  } catch (err) {
    // 403 aqui não é falha do demo: é a chave sem aquele scope. Dizer QUAL scope falta é o
    // que transforma o erro em instrução.
    if (err?.status === 403) {
      semScope++;
      console.log(`\n${m.rotulo}\n   ⏭️  sem o scope \`${m.scope}\` nesta chave`);
    } else {
      console.log(`\n${m.rotulo}\n   ❌ ${err?.status ?? ""} ${err?.message ?? err}`);
    }
  }
}

console.log("\n" + "─".repeat(60));
console.log(`${comAcesso} de ${MODULOS.length} módulos legíveis com esta chave` +
  (semScope ? ` · ${semScope} bloqueado(s) por scope` : ""));
console.log("Escrita nesses módulos ainda não é exposta na API.\n");
