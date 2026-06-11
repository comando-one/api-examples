/**
 * Glue do Gemini (Google AI Studio) — zero dependências, via fetch.
 * Usa o mesmo padrão de chamada das Edge Functions do projeto
 * (generativelanguage v1beta) e as mesmas envs GEMINI_API_KEY / GEMINI_MODEL.
 */

const TYPE_MAP = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  array: "ARRAY",
  object: "OBJECT",
};

/**
 * Converte um JSON Schema (do MCP) no subconjunto de Schema aceito pelo Gemini.
 * Retorna undefined para schemas vazios/objetos livres sem propriedades.
 */
export function toGeminiSchema(s) {
  if (!s || typeof s !== "object") return undefined;

  let type = s.type;
  let nullable = false;
  if (Array.isArray(type)) {
    nullable = type.includes("null");
    type = type.find((t) => t !== "null");
  }
  const gType = type ? TYPE_MAP[type] : undefined;
  if (!gType) return undefined;

  const out = { type: gType };
  if (s.description) out.description = String(s.description).slice(0, 240);
  if (nullable) out.nullable = true;
  if (Array.isArray(s.enum) && s.enum.length) out.enum = s.enum.map(String);

  if (gType === "ARRAY") {
    out.items = toGeminiSchema(s.items) || { type: "STRING" };
  }

  if (gType === "OBJECT") {
    const props = s.properties || {};
    const keys = Object.keys(props);
    if (!keys.length) {
      // Objeto livre (ex.: body genérico). Gemini não lida bem — representa como texto JSON.
      return {
        type: "STRING",
        description: (out.description ? out.description + " " : "") + "(objeto JSON serializado em texto)",
      };
    }
    out.properties = {};
    for (const k of keys) {
      const gs = toGeminiSchema(props[k]);
      if (gs) out.properties[k] = gs;
    }
    if (Array.isArray(s.required) && s.required.length) {
      const req = s.required.filter((r) => out.properties[r]);
      if (req.length) out.required = req;
    }
  }

  return out;
}

/** Converte uma tool MCP numa functionDeclaration do Gemini. */
export function toolToFunctionDeclaration(tool) {
  const decl = { name: tool.name, description: (tool.description || tool.name).slice(0, 1024) };
  const params = toGeminiSchema(tool.inputSchema);
  // Só inclui parameters se for um OBJECT com propriedades.
  if (params && params.type === "OBJECT" && params.properties && Object.keys(params.properties).length) {
    decl.parameters = params;
  }
  return decl;
}

/**
 * Chama o Gemini com histórico + ferramentas. Tenta modelos em ordem de fallback.
 * Retorna { parts, text, functionCalls }.
 */
export async function callGemini({ apiKey, models, systemPrompt, contents, functionDeclarations }) {
  let lastError = "Falha ao chamar Gemini.";
  for (const model of models) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
            contents,
            tools: functionDeclarations?.length ? [{ functionDeclarations }] : undefined,
            generationConfig: { temperature: 0.3 },
          }),
          signal: controller.signal,
        },
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastError = `Modelo ${model}: ${payload?.error?.message || res.statusText}`;
        continue;
      }
      const parts = payload?.candidates?.[0]?.content?.parts ?? [];
      const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      const text = parts
        .filter((p) => typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim();
      return { parts, text, functionCalls };
    } catch (err) {
      lastError = `Modelo ${model}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(lastError);
}
