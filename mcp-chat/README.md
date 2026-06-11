# mcp-chat — chat de IA que opera o ERP via MCP

Um "chatzinho" de terminal onde você conversa em português e o **Gemini** decide quando chamar as ferramentas do **[`@comando.one/mcp-server`](https://www.npmjs.com/package/@comando.one/mcp-server)**, que executa ações reais na API do Comando.One.

```
você › quantos clientes eu tenho?
🔧 customers_list {"per_page":1}
assistente › Você tem 30 clientes cadastrados na Empresa Teste.

você › cria um cliente chamado Padaria do Zé, pessoa jurídica
🔧 customers_create {"body":{"name":"Padaria do Zé","type":"juridica"}}
assistente › Pronto! Cadastrei a Padaria do Zé (CNPJ não informado). Quer gerar uma fatura pra ela?
```

- **Zero dependências** — só Node 18+. Fala JSON-RPC com o MCP server por stdio e chama o Gemini via `fetch`.
- **Mesmas envs do projeto**: `GEMINI_API_KEY`, `GEMINI_MODEL`, `COMANDO_API_KEY`, `COMANDO_COMPANY_ID`.
- **Function calling** real: as ~50 tools do MCP viram `functionDeclarations` do Gemini.
- **Seguro**: ações destrutivas (cancelar/excluir/estornar/pagar) o assistente confirma antes e só então chama a tool com `confirm: true` (a guarda do MCP também exige isso).

## Como rodar

```bash
# 1. chaves
export GEMINI_API_KEY="..."          # https://aistudio.google.com/apikey
export COMANDO_API_KEY="cmd_live_..." # Configurações → API Keys

# 2. roda
node mcp-chat/chat.mjs
```

Ou copie `.env.example` para `.env` nesta pasta e preencha — o script carrega sozinho.

## Como ele inicia o MCP server

Em ordem de preferência:
1. `packages/mcp-server/dist/index.js` se existir (modo repositório, offline) — rode `cd packages/mcp-server && bun install && npm run build` antes.
2. Senão, `npx -y @comando.one/mcp-server` (pacote publicado no npm).
3. Override manual: `COMANDO_MCP_CMD` + `COMANDO_MCP_ARGS`.

## Exemplos de perguntas

- "Liste minhas últimas 5 faturas em aberto."
- "Qual meu faturamento desse mês? Some o ledger."
- "Crie uma fatura de R$ 250 pro cliente X com vencimento em 7 dias e gere um Pix."
- "Quais eventos de webhook existem?"
- "Cancela a fatura tal." → ele confirma antes de executar.

## Arquivos

| Arquivo | Papel |
|---|---|
| `chat.mjs` | REPL: lê env, sobe o MCP, loop de function-calling com o Gemini |
| `mcp-client.mjs` | Cliente MCP mínimo (JSON-RPC 2.0 por stdio) |
| `gemini.mjs` | Chamada ao Gemini + conversão JSON Schema → schema do Gemini |
