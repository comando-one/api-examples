# Guia de Webhooks — Comando.One API

Webhooks notificam o seu sistema quando algo acontece na conta (pagamentos,
faturas, propostas, etc.). São **por empresa** (você pode ter vários, cada um
com sua URL e seus eventos) e **assinados** com HMAC-SHA256.

---

## 1. Cadastrar um webhook

**Pela UI:** Configurações → **Webhooks** → *Novo webhook* (nome, URL https, eventos).
O **secret** é mostrado uma única vez.

**Pela API:**
```bash
curl -X POST "https://api.comando.one/v1/webhooks" \
  -H "Authorization: Bearer cmd_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "name": "Meu ERP", "url": "https://seu-app.com/webhook",
        "events": ["charge.paid", "invoice.paid"] }'
# 201 → { "webhook": {...}, "secret": "whsec...", "secret_note": "guarde — não será exibido de novo" }
```
Endpoints: `GET/POST /v1/webhooks`, `GET/PATCH/DELETE /v1/webhooks/:id`. Scope: `webhooks:manage`.

> Descobrir os eventos disponíveis: `GET /v1/webhooks/events` → `{ data: [{ key, label, group }] }`.

---

## 2. Eventos disponíveis

| Grupo | Eventos |
|---|---|
| Cobranças | `charge.paid`, `charge.cancelled`, `charge.expired`, `charge.failed`, `charge.refunded` |
| Faturas | `invoice.created`, `invoice.paid`, `invoice.cancelled` |
| Propostas | `proposal.created`, `proposal.sent`, `proposal.accepted`, `proposal.rejected` |
| Contratos | `contract.created`, `contract.cancelled`, `contract.finished` |
| NFS-e | `nfse.issued`, `nfse.rejected`, `nfse.cancelled` |
| Contas a pagar | `purchase_invoice.created`, `purchase_invoice.paid`, `expense.paid` |
| Clientes | `customer.created`, `customer.updated`, `customer.deleted` |
| Fornecedores | `supplier.created`, `supplier.updated`, `supplier.deleted` |
| Repasses | `payout.completed`, `payout.failed`, `payout.scheduled`, `payout.cancelled` |

Os eventos de negócio disparam **independente da origem** (app ou API), via triggers no banco.

---

## 3. Formato da entrega (POST no seu endpoint)

Headers:
- `x-event`: o evento (ex.: `charge.paid`)
- `x-signature`: HMAC-SHA256 do **corpo bruto** com o seu secret (hex)
- `x-delivery-id`: id único da entrega (use para **idempotência**)
- `Content-Type: application/json`

Corpo:
```json
{
  "event": "charge.paid",
  "charge": { "id": "...", "provider": "inter", "invoice_id": "...", "status": "paid", "status_raw": "RECEBIDO", "amount": 250.0 },
  "timestamp": "2026-06-07T12:00:00.000Z"
}
```
A chave do payload varia por tipo: `charge` (cobranças), `payout` (repasses) ou `data` (faturas, propostas, contratos, NFS-e, clientes, fornecedores, contas a pagar).

Responda **2xx** para confirmar o recebimento. Qualquer outro status é considerado falha.

---

## 4. Verificar a assinatura (obrigatório)

Recalcule o HMAC do corpo bruto com o seu secret e compare com `x-signature`
(comparação em tempo constante). Veja `_shared/webhook.js`:

```js
import { verifyWebhookSignature } from "./_shared/webhook.js";
const ok = await verifyWebhookSignature(secret, rawBody, req.headers["x-signature"]);
if (!ok) return res.status(401).end();
```

> Use o **corpo bruto** (string exata recebida), não o JSON re-serializado.

---

## 5. Entregas, retries e DLQ

- Fila confiável (Supabase Queues / pgmq) com concorrência e visibility timeout.
- **3 tentativas** no total (1 + 2 retries) quando a resposta não for 2xx ou der timeout (10s).
- **Backoff:** retry 1 em ~30s, retry 2 em ~2min. Esgotado → **DLQ** (status `failed`).
- Consultar o log: `GET /v1/webhooks/deliveries` (filtros `status`, `event`).
- Reenviar manualmente: `POST /v1/webhooks/deliveries/:id/redeliver` (ou botão no painel).

---

## 6. Testar antes de produção

- **Evento de teste:** `POST /v1/webhooks/:id/test` (ou botão **Enviar teste** no painel) → enfileira um `webhook.test` só para aquele webhook.
- **Receiver local** (`webhook-receiver/`): recebe, valida a assinatura e mostra o feed ao vivo. Exponha com um túnel (`cloudflared tunnel --url http://localhost:8090`) e registre a URL.

---

## 7. Boas práticas

- **Idempotência:** trate o mesmo `x-delivery-id` uma vez só (retries podem reentregar).
- **Responda rápido (≤10s)** e processe de forma assíncrona no seu lado.
- **Rotacione o secret** periodicamente (painel → *Rotacionar secret*).
- Assine **só os eventos que usa** — menos ruído e menos carga.
