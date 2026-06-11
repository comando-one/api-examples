/**
 * Cliente MCP mínimo (zero dependências) — fala JSON-RPC 2.0 por stdio com um
 * servidor MCP iniciado como subprocesso. Cobre o que o chat precisa:
 * initialize, tools/list, tools/call.
 */
import { spawn } from "node:child_process";

export class McpStdioClient {
  /** @param {{command:string, args?:string[], env?:Record<string,string>}} opts */
  constructor({ command, args = [], env = {} }) {
    this.proc = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"], // stderr do servidor vai pro terminal
    });
    this._buf = "";
    this._id = 0;
    this._pending = new Map();
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.on("exit", (code) => {
      for (const { reject } of this._pending.values()) {
        reject(new Error(`Servidor MCP encerrou (código ${code}).`));
      }
      this._pending.clear();
    });
  }

  _onData(chunk) {
    this._buf += chunk.toString();
    let idx;
    while ((idx = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // linha não-JSON (ruído) — ignora
      }
      if (msg.id !== undefined && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  }

  _send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params = {}) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`Timeout na chamada MCP ${method}.`));
        }
      }, 60000);
    });
  }

  notify(method, params = {}) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  async initialize() {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "comando-mcp-chat", version: "0.1.0" },
    });
    this.notify("notifications/initialized");
    return res;
  }

  async listTools() {
    const res = await this.request("tools/list", {});
    return res.tools ?? [];
  }

  async callTool(name, args) {
    return this.request("tools/call", { name, arguments: args ?? {} });
  }

  close() {
    try {
      this.proc.stdin.end();
      this.proc.kill();
    } catch {
      /* noop */
    }
  }
}
