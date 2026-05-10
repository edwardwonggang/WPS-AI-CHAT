import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Node 18+ ships undici internally but doesn't expose ProxyAgent via a stable
// public entry. We depend on the `undici` npm package (v5, compatible back to
// Node 16.8+) which provides ProxyAgent, Agent, and a standards-aligned fetch.
let ProxyAgent;
let Agent;
let undiciFetch;
try {
  const undici = await import("undici");
  ProxyAgent = undici.ProxyAgent;
  Agent = undici.Agent;
  undiciFetch = undici.fetch;
} catch (error) {
  console.error(
    "[relay] Failed to load the 'undici' package. Run `npm install` inside the project directory and retry."
  );
  console.error(
    "[relay] Details:",
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
}

// Sanity check: undici v5 requires Node 16.8+. If the runtime is older we
// surface a friendly message instead of cryptic internal errors.
const nodeMajor = Number(process.versions.node.split(".")[0] || 0);
if (nodeMajor < 18) {
  console.error(
    `[relay] Node ${process.versions.node} is too old. Install Node 18 LTS or newer and relaunch.`
  );
  process.exit(1);
}

const PORT = 3888;
const RELAY_CONFIG_URL = new URL("./relay.config.json", import.meta.url);
const DEFAULT_BENCHMARK_TIMEOUT_MS = 12000;
const DEFAULT_BENCHMARK_CONCURRENCY = 6;

const DEFAULT_SESSION_ROOT =
  process.platform === "win32"
    ? join(process.env.APPDATA || homedir(), "WPS AI", "Sessions")
    : join(homedir(), ".wps-ai", "sessions");

const SESSION_BLOCK_CLOSE = "<!-- /WPS-AI-MESSAGE -->";
const BENCHMARK_MESSAGES = [{ role: "user", content: "Reply with OK only." }];

const PROVIDER_META = {
  nvidia: { defaultBaseUrl: "https://integrate.api.nvidia.com/v1" },
  openrouter: { defaultBaseUrl: "https://openrouter.ai/api/v1" }
};

const DEFAULT_BOOTSTRAP_SETTINGS = Object.freeze({
  activeProvider: "nvidia",
  providers: {
    nvidia: {
      baseUrl: PROVIDER_META.nvidia.defaultBaseUrl,
      apiKey: "",
      model: "deepseek-ai/deepseek-v3.1-terminus"
    },
    openrouter: {
      baseUrl: PROVIDER_META.openrouter.defaultBaseUrl,
      apiKey: "",
      model: ""
    }
  },
  proxyUrl: "",
  useRelay: true,
  temperature: 0.5,
  maxTokens: "",
  systemPrompt:
    "You are the WPS writing assistant. Output Markdown suitable for direct insertion into the document body. Use headings, lists, bold, and italics only when they improve readability. Do not add greetings, prefaces, or explanatory filler.",
  useSelectionAsContext: true,
  replaceSelection: true,
  firstTokenTimeoutMs: 120000
});

// ============================================================================
// Config + proxy helpers
// ============================================================================

function normalizeProxyUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function readRelayConfig() {
  try {
    if (!existsSync(RELAY_CONFIG_URL)) return {};
    return JSON.parse(readFileSync(RELAY_CONFIG_URL, "utf8"));
  } catch {
    return {};
  }
}

function resolveConfigProxy(config) {
  return normalizeProxyUrl(
    config.proxyUrl ||
      config.httpsProxy ||
      config.httpProxy ||
      config.HTTPS_PROXY ||
      config.HTTP_PROXY ||
      ""
  );
}

function resolveWindowsProxy() {
  if (process.platform !== "win32") return "";
  try {
    const settingsPath =
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

    try {
      const enableOutput = execFileSync(
        "reg.exe",
        ["query", settingsPath, "/v", "ProxyEnable"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true
        }
      );
      const enableMatch = enableOutput.match(
        /ProxyEnable\s+REG_\w+\s+0x([0-9a-f]+)/i
      );
      if (!enableMatch || parseInt(enableMatch[1], 16) === 0) return "";
    } catch {
      return "";
    }

    const output = execFileSync(
      "reg.exe",
      ["query", settingsPath, "/v", "ProxyServer"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
    );
    const match = output.match(/ProxyServer\s+REG_\w+\s+(.+)$/im);
    if (!match) return "";
    const raw = match[1].trim();
    if (!raw) return "";
    if (!raw.includes("=")) return normalizeProxyUrl(raw);

    const map = Object.fromEntries(
      raw
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [key, value] = part.split("=", 2);
          return [key.toLowerCase(), normalizeProxyUrl(value)];
        })
    );
    return map.https || map.http || Object.values(map)[0] || "";
  } catch {
    return "";
  }
}

function resolveMacSystemProxy() {
  if (process.platform !== "darwin") return "";
  try {
    const output = execFileSync("scutil", ["--proxy"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const httpsEnabled = /HTTPSEnable\s*:\s*1/.test(output);
    const httpEnabled = /HTTPEnable\s*:\s*1/.test(output);
    if (httpsEnabled) {
      const host = output.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
      const port = output.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
      if (host && port) return `http://${host}:${port}`;
    }
    if (httpEnabled) {
      const host = output.match(/HTTPProxy\s*:\s*(\S+)/)?.[1];
      const port = output.match(/HTTPPort\s*:\s*(\d+)/)?.[1];
      if (host && port) return `http://${host}:${port}`;
    }
  } catch {}
  return "";
}

function resolveSystemProxy(config) {
  return (
    resolveConfigProxy(config) ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    (process.platform === "win32"
      ? resolveWindowsProxy()
      : process.platform === "darwin"
        ? resolveMacSystemProxy()
        : "")
  );
}

// Cache ProxyAgent / Agent instances by proxy URL so we reuse connections.
const DISPATCHER_CACHE = new Map();
const DIRECT_DISPATCHER = new Agent();

function getDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return DIRECT_DISPATCHER;
  if (DISPATCHER_CACHE.has(normalized)) return DISPATCHER_CACHE.get(normalized);
  const agent = new ProxyAgent({ uri: normalized });
  DISPATCHER_CACHE.set(normalized, agent);
  return agent;
}

// ============================================================================
// Bootstrap + session helpers
// ============================================================================

function normalizeBootstrapSettings(config) {
  const defaults =
    config.defaults && typeof config.defaults === "object" ? config.defaults : {};

  const settings = { ...DEFAULT_BOOTSTRAP_SETTINGS, ...defaults };
  const providers = {
    ...DEFAULT_BOOTSTRAP_SETTINGS.providers,
    ...(defaults.providers && typeof defaults.providers === "object"
      ? defaults.providers
      : {})
  };

  for (const providerId of Object.keys(DEFAULT_BOOTSTRAP_SETTINGS.providers)) {
    const record = providers[providerId] || {};
    providers[providerId] = {
      baseUrl:
        String(record.baseUrl ?? "").trim() ||
        PROVIDER_META[providerId].defaultBaseUrl,
      apiKey: String(record.apiKey ?? ""),
      model: String(record.model ?? "").trim()
    };
  }

  if (!providers[settings.activeProvider]) {
    settings.activeProvider = DEFAULT_BOOTSTRAP_SETTINGS.activeProvider;
  }

  settings.providers = providers;
  settings.proxyUrl = String(settings.proxyUrl ?? "").trim();
  return settings;
}

function normalizeSessionRoot(config) {
  const configured = String(config.sessionRoot ?? "").trim();
  return resolve(configured || DEFAULT_SESSION_ROOT);
}

function normalizeSessionDocument(input) {
  const title =
    String(input?.title ?? input?.name ?? "").trim() || "Untitled Document";
  const path = String(input?.path ?? "").trim();
  let fullName = String(input?.fullName ?? "").trim();
  if (!fullName && path) {
    fullName = `${path}${path.endsWith("\\") || path.endsWith("/") ? "" : "/"}${title}`;
  }
  const key =
    String(input?.key ?? "").trim() ||
    (fullName ? `saved:${fullName.toLowerCase()}` : `unsaved:${title}`);
  return { key, title, path, fullName, isSaved: Boolean(fullName) };
}

function normalizeSessionMessages(input) {
  return (Array.isArray(input) ? input : [])
    .map((entry, index) => ({
      id: String(entry?.id ?? "").trim() || `session-${Date.now()}-${index + 1}`,
      role: entry?.role === "assistant" ? "assistant" : "user",
      content: String(entry?.content ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
      error: Boolean(entry?.error),
      streaming: false
    }))
    .filter(
      (entry) => entry.content || entry.role === "assistant" || entry.role === "user"
    );
}

function sanitizeSessionFileLabel(value) {
  const cleaned = String(value ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 80) || "Untitled Document";
}

function escapeSessionAttribute(value) {
  return String(value ?? "").replace(/"/g, "&quot;");
}

function sessionFilePathForDocument(sessionRoot, document) {
  const hash = createHash("sha1")
    .update(String(document.key ?? ""))
    .digest("hex")
    .slice(0, 12);
  return join(sessionRoot, `${sanitizeSessionFileLabel(document.title)}__${hash}.md`);
}

function serializeSessionMarkdown(document, messages) {
  const metadata = JSON.stringify(
    {
      version: 1,
      documentKey: document.key,
      title: document.title,
      fullName: document.fullName,
      updatedAt: new Date().toISOString()
    },
    null,
    2
  );

  const blocks = messages.map((message) => {
    const body = String(message.content ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return [
      `<!-- WPS-AI-MESSAGE role="${escapeSessionAttribute(message.role)}" id="${escapeSessionAttribute(message.id)}" error="${message.error ? "1" : "0"}" -->`,
      body,
      SESSION_BLOCK_CLOSE
    ].join("\n");
  });

  return [
    "<!-- WPS-AI-SESSION",
    metadata,
    "-->",
    `# ${document.title}`,
    "",
    "> Conversation history maintained automatically by WPS AI.",
    "",
    blocks.join("\n\n")
  ]
    .join("\n")
    .trimEnd()
    .concat("\n");
}

function parseSessionMarkdown(markdown) {
  const messages = [];
  const pattern =
    /<!-- WPS-AI-MESSAGE role="([^"]+)" id="([^"]*)" error="([^"]*)" -->\n?([\s\S]*?)\n?<!-- \/WPS-AI-MESSAGE -->/g;
  let match;
  while ((match = pattern.exec(String(markdown ?? ""))) !== null) {
    messages.push({
      id: match[2] || `session-${messages.length + 1}`,
      role: match[1] === "assistant" ? "assistant" : "user",
      content: match[4].replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
      error: match[3] === "1",
      streaming: false
    });
  }
  return messages;
}

// ============================================================================
// Shared state
// ============================================================================

const RELAY_CONFIG = readRelayConfig();
const SYSTEM_PROXY = resolveSystemProxy(RELAY_CONFIG);
const BOOTSTRAP_SETTINGS = normalizeBootstrapSettings(RELAY_CONFIG);
const SESSION_ROOT = normalizeSessionRoot(RELAY_CONFIG);
const RELAY_LOG_BUFFER = [];

function relayLog(scope, message, details = undefined) {
  const suffix =
    details && typeof details === "object" && Object.keys(details).length > 0
      ? ` ${JSON.stringify(details)}`
      : "";
  console.log(`[relay] [${scope}] ${message}${suffix}`);

  const entry = {
    time: new Date().toISOString(),
    level: "info",
    scope,
    message,
    details: details && typeof details === "object" ? details : {}
  };
  RELAY_LOG_BUFFER.push(entry);
  if (RELAY_LOG_BUFFER.length > 500) RELAY_LOG_BUFFER.shift();
  return entry;
}

function relayLogError(scope, message, details = undefined) {
  const suffix =
    details && typeof details === "object" && Object.keys(details).length > 0
      ? ` ${JSON.stringify(details)}`
      : "";
  console.error(`[relay] [${scope}] [error] ${message}${suffix}`);

  const entry = {
    time: new Date().toISOString(),
    level: "error",
    scope,
    message,
    details: details && typeof details === "object" ? details : {}
  };
  RELAY_LOG_BUFFER.push(entry);
  if (RELAY_LOG_BUFFER.length > 500) RELAY_LOG_BUFFER.shift();
  return entry;
}

function sanitizeAuthHeader(value) {
  if (!value) return "";
  const text = String(value);
  if (text.length <= 12) return "***";
  return `${text.slice(0, 10)}...${text.slice(-4)} (len=${text.length})`;
}

function sanitizePayloadForLog(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const copy = { ...payload };
  if (Array.isArray(copy.messages)) {
    copy.messages = copy.messages.map((msg) => ({
      role: msg?.role || "",
      contentPreview: String(msg?.content ?? "").slice(0, 120),
      contentLength: String(msg?.content ?? "").length
    }));
  }
  return copy;
}

function emitSseDebug(res, entry) {
  if (!res || res.writableEnded) return;
  try {
    res.write(`data: ${JSON.stringify({ type: "relay_debug", ...entry })}\n\n`);
  } catch {}
}

// ============================================================================
// HTTP helpers
// ============================================================================

function setCorsHeaders(res, req = null) {
  const origin = req?.headers?.origin;
  const requestHeaders = req?.headers?.["access-control-request-headers"];
  const requestPrivateNetwork = req?.headers?.["access-control-request-private-network"];

  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader(
    "Vary",
    "Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    requestHeaders ||
      "authorization,content-type,accept,x-upstream-base-url,x-upstream-proxy,http-referer,x-title"
  );
  res.setHeader("Access-Control-Max-Age", "600");
  if (requestPrivateNetwork === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

async function readFormBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

function resolveRelayAuthorization(req, body = null) {
  const headerValue = String(req.headers.authorization || "").trim();
  if (headerValue) return headerValue;
  const apiKey = String(body?.apiKey ?? "").trim();
  if (!apiKey) return "";
  if (/^Bearer\s+/i.test(apiKey)) return apiKey;
  return `Bearer ${apiKey}`;
}

function resolveUpstreamBaseUrl(req, providerId, body = null) {
  const headerValue = String(req.headers["x-upstream-base-url"] || "").trim();
  if (headerValue) return headerValue.replace(/\/+$/, "");
  const bodyValue = String(body?.baseUrl ?? "").trim();
  if (bodyValue) return bodyValue.replace(/\/+$/, "");
  return PROVIDER_META[providerId].defaultBaseUrl;
}

/**
 * Resolve which proxy the relay should use for this request:
 *   - `__direct__` → force direct (skip system proxy)
 *   - any URL → use this proxy
 *   - empty → fall back to the system/config proxy detected at boot
 */
function resolveUpstreamProxy(req, body = null) {
  const headerValue = String(req.headers["x-upstream-proxy"] || "").trim();
  const bodyValue = body ? String(body.proxyUrl ?? "").trim() : "";
  const requested = headerValue || bodyValue;

  if (requested === "__direct__") return "";
  if (requested) return normalizeProxyUrl(requested);
  return SYSTEM_PROXY || "";
}

function parseUpstreamErrorBody(body) {
  const trimmed = String(body || "").trim();
  if (!trimmed) return "";
  try {
    const json = JSON.parse(trimmed);
    if (json?.error) {
      const parts = [];
      if (json.error.message) parts.push(String(json.error.message));
      if (json.error.code && json.error.code !== json.error.message) {
        parts.push(`code=${json.error.code}`);
      }
      const providerName = json.error.metadata?.provider_name;
      if (providerName) parts.push(`provider=${providerName}`);
      const raw = json.error.metadata?.raw;
      if (raw && typeof raw === "string") parts.push(`upstream=${raw.slice(0, 200)}`);
      if (parts.length > 0) return parts.join(" | ");
    }
    return json?.message || JSON.stringify(json).slice(0, 400);
  } catch {
    return trimmed.slice(0, 400);
  }
}

function buildProviderExtraHeaders(providerId, req, body = null) {
  if (providerId !== "openrouter") return {};
  const referer =
    String(req.headers["http-referer"] || "").trim() ||
    String(body?.referer ?? "").trim() ||
    "https://localhost";
  const title =
    String(req.headers["x-title"] || "").trim() ||
    String(body?.title ?? "").trim() ||
    "WPS AI";
  return { "HTTP-Referer": referer, "X-Title": title };
}

// ============================================================================
// Core upstream request wrapper — Node.js fetch + undici ProxyAgent
// ============================================================================

/**
 * Try the request through the preferred proxy first, then fall back to
 * direct connection if the proxy throws a connection error.
 */
async function fetchUpstream(url, init, preferredProxy, debugFn = null) {
  const attempts = [];
  if (preferredProxy) {
    attempts.push({ label: "proxy", proxy: preferredProxy });
  }
  attempts.push({ label: "direct", proxy: "" });

  let lastError = null;
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    const dispatcher = getDispatcher(attempt.proxy);
    try {
      debugFn?.("debug", "Upstream fetch attempt.", {
        attemptLabel: attempt.label,
        proxy: attempt.proxy || "(direct)",
        url
      });
      const response = await undiciFetch(url, { ...init, dispatcher });
      return { response, attempt };
    } catch (error) {
      lastError = error;
      debugFn?.("error", "Upstream fetch threw before response headers.", {
        attemptLabel: attempt.label,
        proxy: attempt.proxy || "(direct)",
        errorName: error?.name || "",
        errorMessage: error?.message || String(error),
        errorCause:
          error?.cause && typeof error.cause === "object"
            ? String(error.cause.message || error.cause.code || error.cause)
            : ""
      });

      // Only fall through to direct when the first attempt was the proxy
      // and it failed at the network layer.
      if (attempt.label === "proxy") continue;
      throw error;
    }
  }
  throw lastError || new Error("Upstream fetch failed.");
}

async function fetchUpstreamText(url, init, preferredProxy, debugFn = null) {
  const { response, attempt } = await fetchUpstream(url, init, preferredProxy, debugFn);
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text,
    headers: response.headers,
    attempt
  };
}

// ============================================================================
// Model list
// ============================================================================

function normalizeModelEntry(item) {
  return {
    id: String(item?.id ?? "").trim(),
    object: String(item?.object ?? "model"),
    owned_by: String(item?.owned_by ?? item?.ownedBy ?? "").trim()
  };
}

async function listProviderModels({
  authorization,
  baseUrl,
  preferredProxy,
  extraHeaders = {},
  debugFn
}) {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const result = await fetchUpstreamText(
    url,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: authorization,
        ...extraHeaders
      }
    },
    preferredProxy,
    debugFn
  );

  if (!result.ok) {
    throw new Error(
      parseUpstreamErrorBody(result.text) ||
        `HTTP ${result.status} ${result.statusText}`
    );
  }

  const json = JSON.parse(result.text);
  const seen = new Set();
  const list = Array.isArray(json?.data)
    ? json.data
    : Array.isArray(json?.models)
      ? json.models
      : [];

  const data = list
    .map(normalizeModelEntry)
    .filter((item) => {
      if (!item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((l, r) => l.id.localeCompare(r.id));

  return { object: "list", data };
}

// ============================================================================
// Benchmark
// ============================================================================

function extractChunk(payload) {
  const choice = payload?.choices?.[0];
  if (!choice) return "";
  const source = choice.delta?.content ?? choice.message?.content;
  if (typeof source === "string") return source;
  if (Array.isArray(source)) {
    return source
      .map((item) =>
        typeof item === "string"
          ? item
          : item && typeof item === "object" && "text" in item
            ? String(item.text ?? "")
            : ""
      )
      .join("");
  }
  return "";
}

function parseSseEventBlock(block) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function benchmarkModel({
  authorization,
  baseUrl,
  model,
  timeoutMs,
  preferredProxy,
  extraHeaders = {}
}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = JSON.stringify({
    model,
    messages: BENCHMARK_MESSAGES,
    temperature: 0,
    stream: true,
    max_tokens: 8
  });

  let firstByteMs = null;
  let firstTokenMs = null;

  function result(status, message) {
    clearTimeout(timeoutId);
    return {
      model,
      ok: status === "ok",
      status,
      firstByteMs,
      firstTokenMs,
      totalMs: firstTokenMs !== null ? firstTokenMs : Math.max(0, Date.now() - startedAt),
      message: message || ""
    };
  }

  try {
    const { response } = await fetchUpstream(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: authorization,
          ...extraHeaders
        },
        body,
        signal: controller.signal
      },
      preferredProxy
    );

    firstByteMs = Math.max(0, Date.now() - startedAt);

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 401 || response.status === 403) {
        return result("unauthorized", "The current key cannot access this model.");
      }
      if ([400, 404, 415, 422].includes(response.status)) {
        return result("unsupported", parseUpstreamErrorBody(text) || "Unsupported");
      }
      return result("error", parseUpstreamErrorBody(text) || `HTTP ${response.status}`);
    }

    const reader = response.body?.getReader?.();
    if (!reader) {
      const text = await response.text();
      if (text.trim()) {
        firstTokenMs = Math.max(0, Date.now() - startedAt);
        return result("ok", "");
      }
      return result("error", "Empty response");
    }

    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const payload = parseSseEventBlock(part);
        const text = extractChunk(payload);
        if (text) {
          firstTokenMs = Math.max(0, Date.now() - startedAt);
          try {
            await reader.cancel();
          } catch {}
          return result("ok", "");
        }
      }
    }

    return result("error", "Stream closed without content");
  } catch (error) {
    if (controller.signal.aborted) {
      return result("timeout", "Timed out before first content token.");
    }
    return result(
      "error",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// Handlers
// ============================================================================

async function handleListModels(req, res, providerId) {
  let body = {};
  if (req.method === "POST") {
    try {
      const contentType = String(req.headers["content-type"] || "").toLowerCase();
      body = contentType.includes("application/x-www-form-urlencoded")
        ? await readFormBody(req)
        : await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: { message: "Invalid request body" } });
      return;
    }
  }

  const authorization = resolveRelayAuthorization(req, body);
  if (!authorization) {
    sendJson(res, 400, { error: { message: "Missing API key" } });
    return;
  }

  const baseUrl = resolveUpstreamBaseUrl(req, providerId, body);
  const preferredProxy = resolveUpstreamProxy(req, body);
  const extraHeaders = buildProviderExtraHeaders(providerId, req, body);

  try {
    const models = await listProviderModels({
      authorization,
      baseUrl,
      preferredProxy,
      extraHeaders,
      debugFn: (level, message, details) =>
        level === "error"
          ? relayLogError("models", message, details)
          : relayLog("models", message, details)
    });
    sendJson(res, 200, models);
  } catch (error) {
    sendJson(res, 502, {
      error: {
        message: error instanceof Error ? error.message : "Failed to load models."
      }
    });
  }
}

async function handleChatCompletions(req, res, providerId) {
  relayLog("chat", "Incoming chat request.", {
    provider: providerId,
    contentType: String(req.headers["content-type"] || ""),
    userAgent: String(req.headers["user-agent"] || "").slice(0, 120)
  });

  let body;
  try {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    body = contentType.includes("application/x-www-form-urlencoded")
      ? await readFormBody(req)
      : await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: { message: "Invalid request body" } });
    return;
  }

  const authorization = resolveRelayAuthorization(req, body);
  if (!authorization) {
    sendJson(res, 400, { error: { message: "Missing API key" } });
    return;
  }

  let payloadBody = body;
  if (typeof body?.payload === "string" && body.payload.trim()) {
    try {
      payloadBody = JSON.parse(body.payload);
    } catch {
      sendJson(res, 400, { error: { message: "Invalid payload" } });
      return;
    }
  }

  const baseUrl = resolveUpstreamBaseUrl(req, providerId, body);
  const preferredProxy = resolveUpstreamProxy(req, body);
  const extraHeaders = buildProviderExtraHeaders(providerId, req, body);
  const requestedStream = payloadBody?.stream !== false;

  const upstreamUrl = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  // Open SSE response immediately so we can emit relay_debug events.
  setCorsHeaders(res, req);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": stream-open\n\n");

  let finished = false;

  function debug(scope, message, details) {
    const entry = relayLog(scope, message, details);
    emitSseDebug(res, entry);
  }

  function debugError(scope, message, details) {
    const entry = relayLogError(scope, message, details);
    emitSseDebug(res, entry);
  }

  function fail(message) {
    if (finished) return;
    finished = true;
    debugError("chat", "Final failure returned to client.", { message });
    sendSse(res, { error: { message } });
    res.end();
  }

  debug("chat", "Resolved upstream target.", {
    provider: providerId,
    upstreamUrl,
    model: String(payloadBody?.model || ""),
    requestedStream,
    preferredProxy: preferredProxy || "(direct)",
    systemProxy: SYSTEM_PROXY || "",
    authHeader: sanitizeAuthHeader(authorization),
    extraHeaderKeys: Object.keys(extraHeaders),
    payloadPreview: sanitizePayloadForLog(payloadBody)
  });

  const controller = new AbortController();
  req.on("aborted", () => controller.abort());

  const upstreamInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: requestedStream ? "text/event-stream" : "application/json",
      Authorization: authorization,
      ...extraHeaders
    },
    body: JSON.stringify(payloadBody),
    signal: controller.signal
  };

  let upstream;
  try {
    upstream = await fetchUpstream(upstreamUrl, upstreamInit, preferredProxy, (level, msg, det) =>
      level === "error" ? debugError("chat", msg, det) : debug("chat", msg, det)
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : "Upstream connection failed.");
    return;
  }

  const { response, attempt } = upstream;
  debug("chat", "Upstream response received.", {
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type") || "",
    attemptLabel: attempt.label
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    fail(
      parseUpstreamErrorBody(text) ||
        `Upstream HTTP ${response.status} ${response.statusText}`
    );
    return;
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const isStream =
    contentType.includes("text/event-stream") ||
    contentType.includes("stream");

  // Non-streaming upstream (caller set stream:false, or server didn't
  // honor the stream flag). Wrap the single JSON response into one SSE
  // event + [DONE] so the front-end consumer works unchanged.
  if (!isStream) {
    try {
      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        fail(`Non-JSON upstream response: ${text.slice(0, 200)}`);
        return;
      }

      if (json?.error) {
        fail(parseUpstreamErrorBody(text) || "Upstream returned an error.");
        return;
      }

      const message = json?.choices?.[0]?.message || {};
      const content = extractChunk({ choices: [{ message }] });
      const ssePayload = {
        id: json?.id || `buffered-${Date.now()}`,
        object: "chat.completion.chunk",
        created: json?.created || Math.floor(Date.now() / 1000),
        model: json?.model || payloadBody?.model || "",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content },
            finish_reason: json?.choices?.[0]?.finish_reason || "stop"
          }
        ]
      };
      res.write(`data: ${JSON.stringify(ssePayload)}\n\n`);
      res.write("data: [DONE]\n\n");
      finished = true;
      res.end();
    } catch (error) {
      fail(error instanceof Error ? error.message : "Failed to read upstream response.");
    }
    return;
  }

  // Stream SSE chunks through unchanged.
  const reader = response.body?.getReader?.();
  if (!reader) {
    fail("Upstream response has no readable body.");
    return;
  }

  const decoder = new TextDecoder("utf-8");
  let bytesForwarded = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      bytesForwarded += text.length;
      res.write(text);
    }

    debug("chat", "Upstream stream completed.", { bytesForwarded });
    finished = true;
    res.end();
  } catch (error) {
    debugError("chat", "Upstream stream read error.", {
      errorName: error?.name || "",
      errorMessage: error?.message || String(error)
    });
    fail(error instanceof Error ? error.message : "Stream read failed.");
  }
}

async function handleBenchmark(req, res, providerId) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON body" } });
    return;
  }

  const authorization = resolveRelayAuthorization(req, body);
  if (!authorization) {
    sendJson(res, 400, { error: { message: "Missing API key" } });
    return;
  }

  const baseUrl = resolveUpstreamBaseUrl(req, providerId, body);
  const preferredProxy = resolveUpstreamProxy(req, body);
  const extraHeaders = buildProviderExtraHeaders(providerId, req, body);

  const models = Array.from(
    new Set(
      (Array.isArray(body?.models) ? body.models : [])
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
    )
  );
  if (models.length === 0) {
    sendJson(res, 400, { error: { message: "No models provided" } });
    return;
  }

  const timeoutMs = Number.isFinite(Number(body?.timeoutMs))
    ? Math.min(Math.max(Math.floor(Number(body.timeoutMs)), 1000), 60000)
    : DEFAULT_BENCHMARK_TIMEOUT_MS;
  const concurrency = Number.isFinite(Number(body?.concurrency))
    ? Math.min(Math.max(Math.floor(Number(body.concurrency)), 1), 12)
    : DEFAULT_BENCHMARK_CONCURRENCY;

  setCorsHeaders(res, req);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": benchmark-open\n\n");

  let completed = 0;
  let cursor = 0;
  let active = 0;
  let responseClosed = false;
  const results = [];

  req.on("aborted", () => {
    responseClosed = true;
  });

  sendSse(res, { type: "start", total: models.length, timeoutMs, concurrency });

  await new Promise((resolvePromise) => {
    function flushDone() {
      if (responseClosed) return resolvePromise();
      sendSse(res, { type: "done", total: models.length, completed, results });
      res.end();
      resolvePromise();
    }

    function launchNext() {
      if (responseClosed) return resolvePromise();
      while (active < concurrency && cursor < models.length) {
        const model = models[cursor];
        cursor += 1;
        active += 1;
        benchmarkModel({
          authorization,
          baseUrl,
          model,
          timeoutMs,
          preferredProxy,
          extraHeaders
        })
          .then((result) => {
            results.push(result);
            completed += 1;
            if (!responseClosed) {
              sendSse(res, {
                type: "result",
                completed,
                total: models.length,
                result
              });
            }
          })
          .finally(() => {
            active -= 1;
            if (cursor >= models.length && active === 0) {
              flushDone();
              return;
            }
            launchNext();
          });
      }
    }

    launchNext();
  });
}

// ============================================================================
// Session handlers
// ============================================================================

async function handleSessionLoad(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON body" } });
    return;
  }

  const document = normalizeSessionDocument(body?.document);
  const filePath = sessionFilePathForDocument(SESSION_ROOT, document);

  if (!existsSync(filePath)) {
    sendJson(res, 200, {
      ok: true,
      exists: false,
      directory: SESSION_ROOT,
      filePath,
      document,
      messages: []
    });
    return;
  }

  try {
    const markdown = readFileSync(filePath, "utf8");
    const stats = statSync(filePath);
    sendJson(res, 200, {
      ok: true,
      exists: true,
      directory: SESSION_ROOT,
      filePath,
      document,
      updatedAt: stats.mtime.toISOString(),
      messages: parseSessionMarkdown(markdown)
    });
  } catch (error) {
    sendJson(res, 500, {
      error: {
        message: error instanceof Error ? error.message : "Failed to load session"
      }
    });
  }
}

async function handleSessionSave(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON body" } });
    return;
  }

  const document = normalizeSessionDocument(body?.document);
  const messages = normalizeSessionMessages(body?.messages);
  const filePath = sessionFilePathForDocument(SESSION_ROOT, document);

  try {
    mkdirSync(SESSION_ROOT, { recursive: true });
    writeFileSync(filePath, serializeSessionMarkdown(document, messages), "utf8");
    sendJson(res, 200, {
      ok: true,
      directory: SESSION_ROOT,
      filePath,
      document,
      messageCount: messages.length,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    sendJson(res, 500, {
      error: {
        message: error instanceof Error ? error.message : "Failed to save session"
      }
    });
  }
}

async function handleSessionDelete(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON body" } });
    return;
  }

  const document = normalizeSessionDocument(body?.document);
  const filePath = sessionFilePathForDocument(SESSION_ROOT, document);

  try {
    if (existsSync(filePath)) unlinkSync(filePath);
    sendJson(res, 200, { ok: true, directory: SESSION_ROOT, filePath, document });
  } catch (error) {
    sendJson(res, 500, {
      error: {
        message: error instanceof Error ? error.message : "Failed to delete session"
      }
    });
  }
}

// ============================================================================
// Test command (used by E2E tests)
// ============================================================================

let pendingTestCommand = null;
let testCommandSeq = 0;
const testCommandStatuses = new Map();

function normalizeTestDocument(document) {
  if (!document || typeof document !== "object") return null;
  return {
    key: String(document.key ?? ""),
    title: String(document.title ?? document.name ?? ""),
    name: String(document.name ?? document.title ?? ""),
    fullName: String(document.fullName ?? "")
  };
}

function rememberTestCommandStatus(id, patch) {
  if (!id) return null;
  const current = testCommandStatuses.get(id) || {
    id,
    stage: "queued",
    updatedAt: new Date().toISOString()
  };
  const next = { ...current, ...patch, id, updatedAt: new Date().toISOString() };
  testCommandStatuses.set(id, next);
  if (testCommandStatuses.size > 40) {
    const oldest = testCommandStatuses.keys().next().value;
    testCommandStatuses.delete(oldest);
  }
  return next;
}

function documentMatchesTestCommand(command, document) {
  const target = String(command.documentTitle || command.documentKey || "")
    .trim()
    .toLowerCase();
  if (!target) return true;
  const normalized = normalizeTestDocument(document);
  if (!normalized) return false;
  return [normalized.key, normalized.title, normalized.name, normalized.fullName]
    .filter(Boolean)
    .some((value) => value.toLowerCase().includes(target));
}

async function handleTestCommandPush(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON body" } });
    return;
  }
  const prompt = String(body?.prompt ?? "");
  if (!prompt.trim()) {
    sendJson(res, 400, { error: { message: "Prompt is required" } });
    return;
  }
  const id = `test-${Date.now()}-${++testCommandSeq}`;
  pendingTestCommand = {
    id,
    prompt,
    documentTitle: String(body?.documentTitle ?? ""),
    documentKey: String(body?.documentKey ?? ""),
    visibleDelayMs: Math.min(8000, Math.max(600, Number(body?.visibleDelayMs) || 1800)),
    createdAt: new Date().toISOString()
  };
  rememberTestCommandStatus(id, { stage: "queued" });
  sendJson(res, 200, { ok: true, id, stage: "queued" });
}

async function handleTestCommandPoll(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON body" } });
    return;
  }
  if (!pendingTestCommand) {
    sendJson(res, 200, { ok: true, command: null });
    return;
  }
  if (!documentMatchesTestCommand(pendingTestCommand, body?.document)) {
    sendJson(res, 200, { ok: true, command: null });
    return;
  }
  const command = pendingTestCommand;
  pendingTestCommand = null;
  rememberTestCommandStatus(command.id, {
    stage: "delivered",
    document: normalizeTestDocument(body?.document)
  });
  sendJson(res, 200, { ok: true, command });
}

async function handleTestCommandAck(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON body" } });
    return;
  }
  const id = String(body?.id ?? "");
  if (!id) {
    sendJson(res, 400, { error: { message: "Command id is required" } });
    return;
  }
  const status = rememberTestCommandStatus(id, {
    stage: String(body?.stage ?? "ack"),
    document: normalizeTestDocument(body?.document),
    detail: body?.detail || {}
  });
  sendJson(res, 200, { ok: true, status });
}

function handleTestCommandStatus(res, requestUrl) {
  const id = String(requestUrl.searchParams.get("id") ?? "");
  if (!id) {
    sendJson(res, 400, { error: { message: "Command id is required" } });
    return;
  }
  sendJson(res, 200, { ok: true, status: testCommandStatuses.get(id) || null });
}

// ============================================================================
// Server
// ============================================================================

const server = createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 404, { error: { message: "Not found" } });
    return;
  }

  const requestUrl = new URL(req.url, "http://127.0.0.1");
  const pathname = requestUrl.pathname;

  if (req.method === "OPTIONS") {
    setCorsHeaders(res, req);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      platform: process.platform,
      transport: "fetch+undici",
      systemProxy: SYSTEM_PROXY || "",
      sessionRoot: SESSION_ROOT,
      providers: Object.keys(PROVIDER_META)
    });
    return;
  }

  if (req.method === "GET" && pathname === "/bootstrap") {
    sendJson(res, 200, { ok: true, settings: BOOTSTRAP_SETTINGS });
    return;
  }

  if (req.method === "GET" && pathname === "/logs") {
    sendJson(res, 200, { ok: true, logs: RELAY_LOG_BUFFER.slice() });
    return;
  }

  const providerRouteMatch = pathname.match(
    /^\/(nvidia|openrouter)\/v1\/(models|chat\/completions|benchmark)$/
  );
  if (providerRouteMatch) {
    const providerId = providerRouteMatch[1];
    const endpoint = providerRouteMatch[2];
    if (endpoint === "models" && (req.method === "GET" || req.method === "POST")) {
      await handleListModels(req, res, providerId);
      return;
    }
    if (endpoint === "chat/completions" && req.method === "POST") {
      await handleChatCompletions(req, res, providerId);
      return;
    }
    if (endpoint === "benchmark" && req.method === "POST") {
      await handleBenchmark(req, res, providerId);
      return;
    }
  }

  if (req.method === "POST" && pathname === "/nvidia/v1/models/benchmark") {
    await handleBenchmark(req, res, "nvidia");
    return;
  }

  if (req.method === "POST" && pathname === "/session/load") {
    await handleSessionLoad(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/session/save") {
    await handleSessionSave(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/session/delete") {
    await handleSessionDelete(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/test-command") {
    await handleTestCommandPush(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/test-command/poll") {
    await handleTestCommandPoll(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/test-command/ack") {
    await handleTestCommandAck(req, res);
    return;
  }
  if (req.method === "GET" && pathname === "/test-command/status") {
    handleTestCommandStatus(res, requestUrl);
    return;
  }

  sendJson(res, 404, { error: { message: "Not found" } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`WPS AI relay listening on http://127.0.0.1:${PORT}`);
  console.log(`  platform: ${process.platform}`);
  console.log(`  transport: Node fetch + undici ProxyAgent`);
  console.log(`  session root: ${SESSION_ROOT}`);
  if (SYSTEM_PROXY) {
    console.log(`  default proxy: ${SYSTEM_PROXY}`);
  } else {
    console.log("  default proxy: (direct)");
  }
});
