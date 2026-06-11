/**
 * Chatbot do Comando.One — front-end estático.
 * Conversa via SSE com o backend `api.comando.one/mcp-chat`, que roda o loop do
 * Gemini consumindo o MCP remoto (`api.comando.one/mcp`). O navegador só guarda a
 * chave da API (cmd_live_…); a chave do Gemini fica no servidor.
 */

const CHAT_URL = "https://api.comando.one/mcp-chat";

const $ = (id) => document.getElementById(id);
const els = {
  apiKey: $("apiKey"),
  companyId: $("companyId"),
  connect: $("connect"),
  status: $("status"),
  log: $("log"),
  input: $("input"),
  send: $("send"),
};

let apiKey = "";
let companyId = "";
let busy = false;
const history = []; // [{ role: "user"|"assistant", text }]

// ---- persistência local ----
els.apiKey.value = localStorage.getItem("chatbot_api_key") || "";
els.companyId.value = localStorage.getItem("chatbot_company_id") || "";

function setStatus(msg, isErr = false) {
  els.status.textContent = msg;
  els.status.className = "status" + (isErr ? " err" : "");
}

function enableChat(on) {
  els.input.disabled = !on;
  els.send.disabled = !on;
  if (on) els.input.focus();
}

// ---- conectar: valida a chave com um tools/list rápido via mcp ----
els.connect.addEventListener("click", async () => {
  apiKey = els.apiKey.value.trim();
  companyId = els.companyId.value.trim();
  if (!apiKey) return setStatus("Informe a chave cmd_live_…", true);
  localStorage.setItem("chatbot_api_key", apiKey);
  localStorage.setItem("chatbot_company_id", companyId);
  setStatus("Conectando…");
  els.connect.disabled = true;
  try {
    const res = await fetch("https://api.comando.one/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...(companyId ? { "x-company-id": companyId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const data = await res.json();
    if (data.error || !data.result) throw new Error(data.error?.message || "Falha ao listar ferramentas.");
    setStatus(`✓ Conectado · ${data.result.tools.length} ferramentas disponíveis`);
    enableChat(true);
    if (!history.length) addBot("Olá! Sou o assistente do Comando.One. Posso consultar e operar seu ERP. O que você precisa?");
  } catch (err) {
    setStatus(`Erro: ${err.message}`, true);
  } finally {
    els.connect.disabled = false;
  }
});

// ---- render ----
function addUser(text) {
  const d = document.createElement("div");
  d.className = "msg user";
  d.textContent = text;
  els.log.appendChild(d);
  scroll();
}
function addBot(text = "") {
  const d = document.createElement("div");
  d.className = "msg bot";
  d.textContent = text;
  els.log.appendChild(d);
  scroll();
  return d;
}
function addTool(name, args) {
  const d = document.createElement("div");
  d.className = "tool";
  d.textContent = `🔧 ${name} ${args && Object.keys(args).length ? JSON.stringify(args) : ""}`.trim();
  els.log.appendChild(d);
  scroll();
  return d;
}
function scroll() {
  els.log.scrollTop = els.log.scrollHeight;
}

// ---- enviar mensagem ----
async function sendMessage() {
  const text = els.input.value.trim();
  if (!text || busy) return;
  els.input.value = "";
  els.input.style.height = "auto";
  addUser(text);
  history.push({ role: "user", text });
  busy = true;
  enableChat(false);

  let botEl = null;
  let botText = "";
  const lastTool = {};

  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...(companyId ? { "x-company-id": companyId } : {}) },
      body: JSON.stringify({ messages: history, company_id: companyId || undefined }),
    });
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => res.statusText);
      throw new Error(t.slice(0, 200));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }

        if (evt.type === "text") {
          if (!botEl) botEl = addBot("");
          botText += evt.delta;
          botEl.textContent = botText;
          scroll();
        } else if (evt.type === "tool_call") {
          lastTool[evt.name] = addTool(evt.name, evt.args);
        } else if (evt.type === "tool_result") {
          const chip = lastTool[evt.name];
          if (chip) chip.className = "tool " + (evt.ok ? "ok" : "fail");
        } else if (evt.type === "error") {
          if (!botEl) botEl = addBot("");
          botText += (botText ? "\n\n" : "") + "⚠️ " + evt.message;
          botEl.textContent = botText;
        } else if (evt.type === "done") {
          // fim
        }
      }
    }
    if (botText) history.push({ role: "assistant", text: botText });
  } catch (err) {
    addBot("⚠️ " + (err instanceof Error ? err.message : String(err)));
  } finally {
    busy = false;
    enableChat(true);
  }
}

els.send.addEventListener("click", sendMessage);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(120, els.input.scrollHeight) + "px";
});

// auto-conecta se já houver chave salva
if (els.apiKey.value.trim()) els.connect.click();
