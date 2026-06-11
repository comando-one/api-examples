/**
 * Chatzinho IA para o Comando.One — Gemini + MCP server.
 *
 *   GEMINI_API_KEY=... COMANDO_API_KEY=cmd_live_... node mcp-chat/chat.mjs
 *
 * Você conversa em português; o Gemini decide quando chamar as tools do
 * @comando.one/mcp-server (que fala com a API real do ERP). Mesmas envs do
 * projeto: GEMINI_API_KEY, GEMINI_MODEL, COMANDO_API_KEY, COMANDO_COMPANY_ID.
 *
 * O servidor MCP é iniciado automaticamente:
 *   - usa packages/mcp-server/dist/index.js se existir (modo repo, offline)
 *   - senão, npx -y @comando.one/mcp-server (pacote publicado)
 *   - override: COMANDO_MCP_CMD + COMANDO_MCP_ARGS
 */
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { McpStdioClient } from "./mcp-client.mjs";
import { callGemini, toolToFunctionDeclaration } from "./gemini.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- .env local (opcional, zero-dep) -------------------------------------
function loadDotEnv() {
  const p = resolve(__dirname, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const COMANDO_API_KEY = process.env.COMANDO_API_KEY;
const COMANDO_COMPANY_ID = process.env.COMANDO_COMPANY_ID || "";

const MODELS = [...new Set([GEMINI_MODEL, "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-1.5-flash"])];

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function die(msg) {
  console.error(C.yellow("⚠️  " + msg));
  process.exit(1);
}

if (!GEMINI_API_KEY) die("Defina GEMINI_API_KEY (chave do Google AI Studio).");
if (!COMANDO_API_KEY) die("Defina COMANDO_API_KEY (cmd_live_...).");

// ---- resolve o comando do servidor MCP -----------------------------------
function resolveMcpCommand() {
  if (process.env.COMANDO_MCP_CMD) {
    return { command: process.env.COMANDO_MCP_CMD, args: (process.env.COMANDO_MCP_ARGS || "").split(" ").filter(Boolean) };
  }
  const localDist = resolve(__dirname, "../../packages/mcp-server/dist/index.js");
  if (existsSync(localDist)) return { command: "node", args: [localDist] };
  return { command: "npx", args: ["-y", "@comando.one/mcp-server"] };
}

const SYSTEM_PROMPT = `Você é o assistente do Comando.One, um ERP brasileiro para empresas de serviço.
Você opera o ERP da empresa do usuário através das ferramentas (tools) disponíveis, que chamam a API real.

Regras:
- Responda sempre em português do Brasil, de forma objetiva e amigável.
- Use as tools para consultar e executar ações reais (clientes, faturas, cobranças Pix/boleto, NFS-e, financeiro, etc.).
- Para LER dados, pode chamar as tools diretamente.
- Para ações DESTRUTIVAS (cancelar, excluir, estornar, pagar fornecedor), SEMPRE confirme com o usuário em linguagem natural ANTES. Só depois que ele concordar, chame a tool com confirm: true.
- Valores monetários em reais. Datas no formato AAAA-MM-DD.
- Se uma tool retornar erro, explique o que houve em linguagem simples.
- Seja conciso: resuma os resultados em vez de despejar JSON cru.`;

async function main() {
  const { command, args } = resolveMcpCommand();
  console.log(C.dim(`Iniciando servidor MCP: ${command} ${args.join(" ")}`));

  const mcp = new McpStdioClient({
    command,
    args,
    env: { COMANDO_API_KEY, COMANDO_COMPANY_ID },
  });

  await mcp.initialize();
  const tools = await mcp.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  // comando_request tem params de objeto livre (não mapeiam bem p/ schema do Gemini);
  // as tools curadas + lookups cobrem o chat com schemas tipados.
  const exposed = tools.filter((t) => t.name !== "comando_request");
  const functionDeclarations = exposed.map(toolToFunctionDeclaration);

  console.log(C.green(`✓ Conectado. ${functionDeclarations.length} ferramentas expostas ao modelo (de ${tools.length}). Modelo: ${MODELS[0]}.`));
  console.log(C.dim('Digite sua mensagem. "sair" para encerrar.\n'));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  const contents = []; // histórico Gemini

  let closing = false;
  const cleanup = () => {
    if (closing) return;
    closing = true;
    mcp.close();
    rl.close();
  };
  process.on("SIGINT", () => {
    console.log("\n" + C.dim("até mais!"));
    cleanup();
    process.exit(0);
  });
  // EOF do stdin (pipe) ou Ctrl+D → encerra sem loop.
  rl.on("close", () => {
    if (!closing) {
      mcp.close();
      process.exit(0);
    }
  });

  for (;;) {
    const input = (await ask(C.cyan("você › "))).trim();
    if (!input) continue;
    if (["sair", "exit", "quit", ":q"].includes(input.toLowerCase())) break;

    contents.push({ role: "user", parts: [{ text: input }] });

    try {
      // Loop de function-calling: repete enquanto o modelo pedir ferramentas.
      for (let turn = 0; turn < 8; turn++) {
        const { parts, text, functionCalls } = await callGemini({
          apiKey: GEMINI_API_KEY,
          models: MODELS,
          systemPrompt: SYSTEM_PROMPT,
          contents,
          functionDeclarations,
        });

        if (functionCalls.length === 0) {
          console.log(C.green("assistente › ") + (text || "(sem resposta)") + "\n");
          contents.push({ role: "model", parts: parts.length ? parts : [{ text: text || "" }] });
          break;
        }

        // Registra o turno do modelo (com os functionCall) no histórico.
        contents.push({ role: "model", parts });

        // Executa cada tool e coleta as respostas.
        const responseParts = [];
        for (const fc of functionCalls) {
          const tool = byName.get(fc.name);
          console.log(C.yellow(`🔧 ${fc.name}`) + C.dim(" " + JSON.stringify(fc.args || {})));
          let responseObj;
          if (!tool) {
            responseObj = { error: `Ferramenta desconhecida: ${fc.name}` };
          } else {
            try {
              const result = await mcp.callTool(fc.name, fc.args || {});
              const textOut = (result.content || []).map((c) => c.text).filter(Boolean).join("\n");
              let parsed;
              try {
                parsed = JSON.parse(textOut);
              } catch {
                parsed = { text: textOut };
              }
              responseObj = result.isError ? { error: parsed } : { result: parsed };
            } catch (err) {
              responseObj = { error: err instanceof Error ? err.message : String(err) };
            }
          }
          responseParts.push({ functionResponse: { name: fc.name, response: responseObj } });
        }

        // Devolve os resultados ao modelo (role "user" — único papel aceito além de "model").
        contents.push({ role: "user", parts: responseParts });
      }
    } catch (err) {
      console.log(C.yellow("⚠️  " + (err instanceof Error ? err.message : String(err))) + "\n");
    }
  }

  cleanup();
  console.log(C.dim("até mais!"));
  process.exit(0);
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
