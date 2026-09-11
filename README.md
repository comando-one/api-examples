<p align="center">
  <img src="assets/logo-comando.png" alt="Comando.One" width="360">
</p>

<h1 align="center">Exemplos da API Pública</h1>

<p align="center">
  <a href="https://comando.one"><strong>Site</strong></a> ·
  <a href="https://comando.one/docs"><strong>Documentação</strong></a> ·
  <a href="https://api.comando.one"><strong>API</strong></a> ·
  <a href="https://www.npmjs.com/package/@comando.one/sdk"><strong>SDK</strong></a> ·
  <a href="https://www.npmjs.com/package/@comando.one/mcp-server"><strong>MCP</strong></a>
</p>

Coleção de **demos prontos** que consomem a API pública (`https://api.comando.one`)
do jeito que um integrador real usaria — recebimento, contas a pagar, split,
NFS-e, relatórios e agentes de IA. Cada demo é **auto-contido**, em JavaScript puro
(ESM, zero dependências), e roda tanto no **navegador** quanto no **Node 18+**.

> ⚠️ **Use uma empresa de TESTE.** Os demos criam dados reais (clientes, faturas,
> cobranças). Crie uma empresa dedicada a testes e gere a chave nela.

---

## Começo rápido

1. No app Comando.One, entre numa **empresa de teste**.
2. **Configurações → API Keys** → criar uma chave `cmd_live_…` com os scopes desejados
   (os demos usam vários: `customers`, `suppliers`, `services`, `expenses`,
   `purchase_invoices`, `proposals`, `contracts`, `invoices`, `finance`, e
   opcionalmente `charges`/`payouts`/`nfse`). A chave é mostrada **uma única vez**.
3. Rode um demo:

```bash
# Node (a chave vem por variável de ambiente — nunca commite a chave)
COMANDO_API_KEY=cmd_live_sua_chave node checkout/run.js

# Navegador: abra o hub e navegue entre os demos
open index.html
```

Opcionais para todos os demos: `COMANDO_BASE_URL` (padrão `https://api.comando.one/v1`)
e `COMANDO_COMPANY_ID` (para chaves multi-empresa, vira o header `X-Company-Id`).

---

## Estrutura

Cada demo é uma pasta com até 3 arquivos: `<lib>.js` (lógica reutilizável Node+browser),
`run.js` (CLI) e `index.html` (UI no navegador).

- **`index.html`** — hub que lista e linka todos os demos.
- **`_shared/comando-api.js`** — client JS (ESM, zero deps; navegador + Node 18+).
- **`_shared/webhook.js`** — `verifyWebhookSignature` (HMAC-SHA256) para validar webhooks.

### Os demos

**Recebimento**
- **`checkout/`** — loja fake: carrinho → cliente → fatura → cobrança Pix/boleto, com
  tela de pagamento que faz polling do status. `node checkout/run.js`
- **`customer-portal/`** — portal do pagador (read-only): busca o cliente por
  documento/nome e mostra faturas em aberto + Pix de cada uma. `node customer-portal/run.js [query]`

**Comercial & Contas a pagar**
- **`sales-pipeline/`** — proposta → contrato: cria cliente, gera proposta, envia, aceita
  e converte num contrato recorrente. `node sales-pipeline/run.js`
- **`accounts-payable/`** — repasse a fornecedor: fornecedor + Pix → conta a pagar com
  parcelas → despesa → payout Pix. `node accounts-payable/run.js`
- **`split/`** — split de pagamentos: cria fornecedor + regra **15/85**, uma regra **por
  parcela** (recurso só da API), valida vários tipos de regra (fixo, combinado, `fee_payer`),
  simula uma venda Pix e aguarda o orquestrador calcular a divisão (`/v1/split-executions`).
  `node split/run.js` (`SPLIT_NO_WAIT=1` testa só as regras)

**Financeiro & Fiscal**
- **`dre-report/`** — mini DRE (read-only): pagina o ledger do período, separa entradas ×
  saídas e calcula o resultado. `node dre-report/run.js [início] [fim]`
- **`nfse-batch/`** — NFS-e em lote: lista faturas pagas, cruza com o histórico de NFS-e e
  emite as pendentes. `node nfse-batch/run.js` (só lista; `EMIT=1` para emitir)

**IA / Agentes**
- **`chatbot/`** — chatbot no navegador (Gemini + MCP remoto via streaming): você conversa
  em português e ele opera o ERP. A chave do Gemini fica no backend; você só informa a `cmd_live`.
- **`mcp-chat/`** — mesma ideia no terminal (CLI), via o pacote npm `@comando.one/mcp-server` (stdio).
  `node mcp-chat/chat.mjs`

**Operacional (somente leitura)**
- **`operational/`** — percorre os sete módulos operacionais e mostra o que a empresa tem em
  cada um. Módulo sem o scope na chave aparece como pulado, dizendo **qual** scope falta — é a
  forma mais direta de ver o que cada scope libera. `node operational/run.js`
  Escrita disponível nesses módulos (pausar regra, arquivar boleto do DDA, marcar notificação,
  CRUD de insumos, desfazer conciliação) — cada uma com sua guarda; ver `/docs`.

**Ferramentas**
- **`webhook-receiver/`** — receiver de webhook (Node, zero deps): recebe `charge.*`, valida a
  assinatura HMAC e mostra um feed ao vivo. `node webhook-receiver/server.js`

> 📘 Guia completo de Webhooks (eventos, assinatura HMAC, retries/DLQ, teste): [`WEBHOOKS.md`](./WEBHOOKS.md).

---

## SDK — `@comando.one/sdk`

O `_shared/comando-api.js` é uma versão enxuta do SDK oficial, publicado no npm:

```bash
npm install @comando.one/sdk
```

```js
import { ComandoApi } from "@comando.one/sdk"; // ou "./_shared/comando-api.js"

const api = new ComandoApi({ apiKey: "cmd_live_...", autoIdempotency: true });

const me      = await api.me();                                   // identidade + scopes
const cliente = await api.customers.create({ name: "ACME", type: "juridica" });
await api.customers.addresses.create(cliente.id, { street: "Rua X", city: "SP", state: "SP" });

const fatura = await api.invoices.create({
  customer_id: cliente.id, title: "Serviços", due_date: "2026-07-30",
  items: [{ name: "Consultoria", quantity: 2, unit_price: 150 }],
});

// Conta a pagar: o vencimento mora nas parcelas (charges)
await api.purchaseInvoices.create({
  supplier_id, invoice_number: "NF-1", amount: 500,
  charges: [{ due_date: "2026-07-30", amount: 500 }],
});
```

### Helpers

| Helper | O que faz |
|---|---|
| `api.withCompany(id)` | Clona o client fixando `X-Company-Id` (chaves multi-empresa). |
| `api.listAll(path, params)` | Paginação automática — itera `?page=` até cobrir `meta.total`. |
| `autoIdempotency: true` | Gera `Idempotency-Key` automaticamente em todo POST. |
| `request(m, path, { raw: true })` | Retorna `{ status, body, replayed }` em vez de lançar erro. |

### Erros

Toda falha vem como JSON com `error`. Dois códigos que valem conhecer antes de integrar:

- **`424 Failed Dependency`** — a sua requisição estava correta; quem falhou foi um terceiro
  (o fisco, o banco, o gateway de pagamento). O motivo dele vem em `error`, em português.
  A API **não** responde 502/504: a borda da Cloudflare substituiria o corpo pela página HTML
  dela e o motivo não chegaria até você.
- **`409 Conflict`** — conflito de estado, e a mensagem diz a rota para resolver. Ex.: emitir
  NFS-e de uma fatura que já tem nota devolve o `id` da existente e a rota de cancelamento;
  apagar fatura com baixa devolve a rota do estorno.

**Não há ambiente de homologação**: só existem chaves `cmd_live_`, e emissão de NFS-e é
documento fiscal real. Para ensaiar sem gerar documento, exercite os caminhos que recusam.

### Namespaces

**Cadastros e vendas** — `companies` · `customers` (+ `addresses`, `contacts`, `invoices/contracts/proposals`) ·
`suppliers` (+ `paymentMethods`) · `services` · `serviceCategories` (CRUD) · `insumos` · `proposals` (+ `send`) ·
`contracts` (+ `pause`/`resume`).

**Financeiro** — `invoices` (+ `update`/`cancel`/`delete`, baixa e estorno de parcela) · `purchaseInvoices` (+ `cancel`) ·
`expenses` · `charges` (+ `cancel`/`refund`) · `payouts` (+ `cancel`/`sync`) ·
`split` (`rules`/`executions`/`items`) · `finance` (`ledger`/`natures`/`createMovement`/`deleteMovement`) ·
`costCenters` · `bankAccounts` · `marketIndices`.

**Fiscal e documentos** — `nfse` (+ `emit`/`cancel`/`sync`/`files`) · `documents` (`analyze`/`search`).

**Operacional** — `inbox` (`messages` + `setStatus`, `documents`) ·
`reconciliation` (`entries`/`periods` + `unmatch`) · `cardStatements` (leitura) ·
`ddaBoletos` (+ `triage`) · `recurringExpenses` e `recurringPurchaseInvoices` (+ `setStatus`) ·
`notifications` (+ `markRead`).
A escrita é seletiva de propósito: conciliar e pagar fatura de cartão continuam no aplicativo,
e as ações do DDA que criam documento também — elas registram quem fez, e uma chave de API
não tem usuário.

**Plataforma** — `me()` · `reports` (`agingActions`/`cashflowForecast`) · `audit` (`timeline`) · `reminders` ·
`lookups` (`costCenters`/`paymentConditions`/`serviceUnits`/`paymentMethods`/`paymentMethodsAp`) ·
`webhooks` (+ `deliveries`).

---

## MCP — agentes de IA operando o ERP

Duas formas de conectar uma IA ao Comando.One:

- **Local (stdio)** — pacote [`@comando.one/mcp-server`](https://www.npmjs.com/package/@comando.one/mcp-server)
  no `claude_desktop_config.json` (`command: npx -y @comando.one/mcp-server`).
  Expõe **toda a API** como ferramentas curadas (mais `lookups` e `comando_request`),
  liberadas conforme os scopes da chave e com guardas de segurança — destrutiva exige
  `confirm`. A lista exata sai do próprio servidor: chame `tools/list` (abaixo).
- **Remoto (streaming)** — endpoint **`https://api.comando.one/mcp`** (MCP Streamable HTTP),
  autenticado com `Authorization: Bearer cmd_live_…`. Não instala nada; funciona com Claude
  Desktop (conector remoto), curl ou navegador.

```bash
curl https://api.comando.one/mcp \
  -H "Authorization: Bearer cmd_live_..." -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Veja os demos `chatbot/` (navegador, MCP remoto) e `mcp-chat/` (CLI, stdio).

---

## Webhooks

A API assina o corpo bruto de cada evento com HMAC-SHA256 e envia em `x-signature`:

```js
import { verifyWebhookSignature } from "./_shared/webhook.js";
const ok = await verifyWebhookSignature(secret, rawBody, req.headers["x-signature"]);
```

Detalhes (eventos disponíveis, retries, DLQ, rotação de secret) em [`WEBHOOKS.md`](./WEBHOOKS.md).

### Fluxo ponta a ponta (validação)

1. Rode o receiver: `COMANDO_WEBHOOK_SECRET=whsec_... node webhook-receiver/server.js`.
2. Exponha-o: `cloudflared tunnel --url http://localhost:8090` (ou `ngrok http 8090`).
3. No `checkout/`, registre a URL pública `…/webhook` (o secret é mostrado uma vez —
   passe-o ao receiver via `COMANDO_WEBHOOK_SECRET`).
4. Faça um pedido (Pix estático) → **Confirmar pagamento**. A API marca pago, dispara
   `charge.paid`, o polling atualiza a tela e o receiver recebe o evento com assinatura válida.
   As entregas aparecem em `GET /v1/webhooks/deliveries`.

---

## Deep-dive: `checkout/`

Uma loja de mentira que exercita o fluxo de **recebimento** completo:

1. Catálogo de produtos → carrinho (no `index.html`). Os produtos vêm de `GET /v1/services`
   (se a empresa tiver serviços ativos); senão, usa um catálogo fixo.
2. **Finalizar compra** → cria o **cliente** e a **fatura** (com os itens do carrinho) de verdade.
3. Gera a **cobrança** (`charges.create`) no método escolhido (Pix/boleto).
4. Tela de pagamento: mostra o Pix copia-e-cola / linha do boleto e fica **consultando o
   status** (`charges.get`) a cada 4s até `paid`.

A empresa pode ter três tipos de provedor de cobrança (todos retornam o mesmo formato
normalizado — `method`, `status`, `pix.qr_code`, etc.):

- **Pix dinâmico (Inter / C6 Bank)** — exige integração bancária (mTLS + OAuth); a baixa
  chega por webhook (`charge.paid`).
- **Pix estático (`pix_offline`)** — gera o **BR Code localmente** a partir da chave Pix do
  recebedor, sem API bancária. É um Pix pagável de verdade; a baixa é manual/por conciliação.
- **Sem provedor** → o passo 3 retorna **422** e o demo cai em **modo simulação** (Pix/boleto
  fake só para a tela; a fatura é real) com botão “Simular pagamento”.

```bash
COMANDO_API_KEY=cmd_live_sua_chave node checkout/run.js   # valida via CLI
open checkout/index.html                                  # usa no navegador
```

Usa `autoIdempotency` (não duplica cobrança em recompras) e idempotência por documento ao
criar o cliente.

---

## Próximos demos (ideias)

- **Dashboard multi-empresa** — `withCompany` + ledger consolidado por empresa.
- **Sincronização com planilha** — exporta clientes/faturas para CSV/Google Sheets via `listAll`.
- **Inspetor de webhooks com replay** — feed ao vivo + redelivery.

> ✅ Já implementados: Checkout, Portal do cliente, Repasse a fornecedores, Split de pagamentos,
> Proposta→Contrato, Mini DRE, NFS-e em lote, Chatbot e MCP-chat.

---

<p align="center">
  Desenvolvido por <a href="https://orbitaldev.com.br"><strong>Orbital Tecnologia</strong></a>
</p>
