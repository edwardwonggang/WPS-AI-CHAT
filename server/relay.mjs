import { execFileSync, spawn } from "node:child_process";
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
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 3888;
const CURL_BIN = process.platform === "win32" ? "curl.exe" : "curl";
const RELAY_CONFIG_URL = new URL("./relay.config.json", import.meta.url);
const LOCAL_NO_PROXY = "127.0.0.1,localhost,::1";
const DEFAULT_BENCHMARK_TIMEOUT_MS = 12000;
const DEFAULT_BENCHMARK_CONCURRENCY = 6;

const DEFAULT_SESSION_ROOT =
  process.platform === "win32"
    ? join(process.env.APPDATA || homedir(), "WPS AI", "Sessions")
    : join(homedir(), ".wps-ai", "sessions");

const SESSION_BLOCK_CLOSE = "<!-- /WPS-AI-MESSAGE -->";
const BENCHMARK_MESSAGES = [
  { role: "user", content: "Reply with OK only." }
];

// Static provider metadata. Base URLs can be overridden per request via the
// X-Upstream-Base-Url header or the `baseUrl` form field.
const PROVIDER_META = {
  nvidia: {
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1"
  },
  openrouter: {
    defaultBaseUrl: "https://openrouter.ai/api/v1"
  }
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

    // Only honor the IE/system proxy if it is actually enabled.
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
      if (!enableMatch || parseInt(enableMatch[1], 16) === 0) {
        return "";
      }
    } catch {
      // Treat missing ProxyEnable as disabled.
      return "";
    }

    const output = execFileSync(
      "reg.exe",
      ["query", settingsPath, "/v", "ProxyServer"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      }
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
  } catch {
    // scutil may be unavailable.
  }
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

function buildEnvWithProxy(proxyUrl) {
  const noProxy = [
    LOCAL_NO_PROXY,
    process.env.NO_PROXY || "",
    process.env.no_proxy || ""
  ]
    .filter(Boolean)
    .join(",");

  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) {
    return {
      ...process.env,
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      ALL_PROXY: "",
      all_proxy: "",
      NO_PROXY: noProxy,
      no_proxy: noProxy
    };
  }

  return {
    ...process.env,
    HTTP_PROXY: normalized,
    HTTPS_PROXY: normalized,
    http_proxy: normalized,
    https_proxy: normalized,
    NO_PROXY: noProxy,
    no_proxy: noProxy
  };
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
  const title = String(input?.title ?? input?.name ?? "").trim() || "Untitled Document";
  const path = String(input?.path ?? "").trim();
  let fullName = String(input?.fullName ?? "").trim();
  if (!fullName && path) {
    fullName = `${path}${path.endsWith("\\") || path.endsWith("/") ? "" : "/"}${title}`;
  }
  const key =
    String(input?.key ?? "").trim() ||
    (fullName ? `saved:${fullName.toLowerCase()}` : `unsaved:${title}`);
  return {
    key,
    title,
    path,
    fullName,
    isSaved: Boolean(fullName)
  };
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
// HTTP helpers
// ============================================================================

const RELAY_CONFIG = readRelayConfig();
const SYSTEM_PROXY = resolveSystemProxy(RELAY_CONFIG);
const BOOTSTRAP_SETTINGS = normalizeBootstrapSettings(RELAY_CONFIG);
const SESSION_ROOT = normalizeSessionRoot(RELAY_CONFIG);
const RELAY_LOG_BUFFER = [];

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

/**
 * Write a `data: {type:"relay_debug",...}` event into the SSE response so the
 * front-end can merge relay-side events into its own Debug Logs view. The
 * front-end recognizes `type === "relay_debug"` and routes these to the log
 * buffer instead of the chat stream.
 */
function emitSseDebug(res, entry) {
  if (!res || res.writableEnded) return;
  try {
    res.write(`data: ${JSON.stringify({ type: "relay_debug", ...entry })}\n\n`);
  } catch {
    // Best-effort.
  }
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
 * Resolve which proxy to use for this request.
 * Header `X-Upstream-Proxy` overrides the system proxy:
 *   - `__direct__` → force direct (ignore system proxy)
 *   - any URL → use this proxy
 *   - empty → use system/config proxy
 */
function resolveUpstreamProxy(req, body = null) {
  const headerValue = String(req.headers["x-upstream-proxy"] || "").trim();
  const bodyValue = body ? String(body.proxyUrl ?? "").trim() : "";
  const requested = headerValue || bodyValue;

  if (requested === "__direct__") return "";
  if (requested) return normalizeProxyUrl(requested);
  return SYSTEM_PROXY || "";
}

function formatCurlFailure(stderr) {
  const message = String(stderr || "").trim();
  if (!message) return "Failed to reach upstream.";
  return message
    .replace(/^curl:\s*/i, "")
    .replace(/^\(\d+\)\s*/, "");
}

function isProxyConnectionFailure(message) {
  const normalized = String(message || "");
  return (
    /proxy/i.test(normalized) ||
    /failed to connect to 127\.0\.0\.1 port \d+/i.test(normalized) ||
    /failed to connect to localhost port \d+/i.test(normalized) ||
    /could not connect to server/i.test(normalized) ||
    /connection refused/i.test(normalized) ||
    /proxyconnect/i.test(normalized)
  );
}

// ============================================================================
// SSE parsing
// ============================================================================

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "text" in item) {
        return String(item.text ?? "");
      }
      return "";
    })
    .join("");
}

function extractChunk(payload) {
  const choice = payload?.choices?.[0];
  if (!choice) return "";
  return (
    normalizeContent(choice.delta?.content) ||
    normalizeContent(choice.message?.content) ||
    ""
  );
}

function parseSseEvent(block) {
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

// ============================================================================
// Curl wrappers
// ============================================================================

function createCurlArgs({
  authorization,
  url,
  method = "GET",
  headers = [],
  dataFromStdin = false,
  stream = false,
  includeStatus = false
}) {
  const args = ["-sS"];
  if (stream) args.push("-N");
  // -w writes the status code to stdout only if requested (not in streaming mode).
  if (includeStatus && !stream) {
    args.push("-o", "-", "-w", "\n__HTTP_STATUS__:%{http_code}");
  }
  args.push("-X", method);
  if (authorization) args.push("-H", `Authorization: ${authorization}`);
  for (const header of headers) {
    args.push("-H", header);
  }
  if (dataFromStdin) args.push("--data-binary", "@-");
  args.push(url);
  return args;
}

function buildAttemptEnvs(preferredProxy) {
  const attempts = [];
  const normalizedPreferred = normalizeProxyUrl(preferredProxy);
  if (normalizedPreferred) {
    attempts.push({
      label: "proxy",
      env: buildEnvWithProxy(normalizedPreferred)
    });
  }
  attempts.push({
    label: "direct",
    env: buildEnvWithProxy("")
  });
  return attempts;
}

function runCurlBuffered({
  authorization,
  url,
  method = "GET",
  headers = [],
  body = "",
  preferredProxy = ""
}) {
  const attempts = buildAttemptEnvs(preferredProxy);

  function runAttempt(index) {
    return new Promise((resolvePromise, reject) => {
      const attempt = attempts[index];
      const curl = spawn(
        CURL_BIN,
        createCurlArgs({
          authorization,
          url,
          method,
          headers,
          dataFromStdin: method !== "GET",
          includeStatus: true
        }),
        {
          env: attempt.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        }
      );

      let stdout = "";
      let stderr = "";

      curl.on("error", (error) => {
        reject(error instanceof Error ? error : new Error("Failed to start curl."));
      });

      curl.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });

      curl.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });

      curl.on("close", (code) => {
        if (code !== 0) {
          const message = formatCurlFailure(stderr || stdout);
          if (
            attempt.label === "proxy" &&
            index + 1 < attempts.length &&
            isProxyConnectionFailure(message)
          ) {
            relayLog("proxy", "Proxy attempt failed, retrying direct.", { url, message });
            resolvePromise(runAttempt(index + 1));
            return;
          }
          reject(new Error(message));
          return;
        }

        // Extract HTTP status we appended via `-w`.
        const statusMatch = stdout.match(/\n__HTTP_STATUS__:(\d+)\s*$/);
        const httpStatus = statusMatch ? Number(statusMatch[1]) : 0;
        const responseBody = statusMatch
          ? stdout.slice(0, statusMatch.index)
          : stdout;

        if (httpStatus >= 200 && httpStatus < 300) {
          resolvePromise(responseBody);
          return;
        }

        // Non-2xx from upstream: surface the body as the error message.
        const upstreamMessage =
          parseUpstreamErrorBody(responseBody) ||
          `Upstream responded with HTTP ${httpStatus || "unknown"}.`;

        if (
          attempt.label === "proxy" &&
          index + 1 < attempts.length &&
          httpStatus >= 500
        ) {
          relayLog("proxy", "Proxy returned 5xx, retrying direct.", {
            url,
            status: httpStatus,
            message: upstreamMessage
          });
          resolvePromise(runAttempt(index + 1));
          return;
        }

        reject(new Error(`HTTP ${httpStatus}: ${upstreamMessage}`));
      });

      if (method === "GET") {
        curl.stdin.end();
        return;
      }
      curl.stdin.end(body);
    });
  }

  return runAttempt(0);
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
      if (raw && typeof raw === "string") {
        parts.push(`upstream=${raw.slice(0, 200)}`);
      }
      if (parts.length > 0) return parts.join(" | ");
    }
    return json?.message || JSON.stringify(json).slice(0, 400);
  } catch {
    return trimmed.slice(0, 400);
  }
}

async function listProviderModels({
  providerId,
  authorization,
  baseUrl,
  preferredProxy,
  extraHeaders = []
}) {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const raw = await runCurlBuffered({
    authorization,
    url,
    method: "GET",
    headers: ["Accept: application/json", ...extraHeaders],
    preferredProxy
  });

  const json = JSON.parse(raw);
  const seen = new Set();
  const list = Array.isArray(json?.data)
    ? json.data
    : Array.isArray(json?.models)
      ? json.models
      : [];

  const data = list
    .map((item) => ({
      id: String(item?.id ?? "").trim(),
      object: String(item?.object ?? "model"),
      owned_by: String(item?.owned_by ?? item?.ownedBy ?? "").trim()
    }))
    .filter((item) => {
      if (!item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  return { object: "list", data };
}

function buildProviderExtraHeaders(providerId, req, body = null) {
  if (providerId !== "openrouter") return [];
  const referer =
    String(req.headers["http-referer"] || "").trim() ||
    String(body?.referer ?? "").trim() ||
    "https://localhost";
  const title =
    String(req.headers["x-title"] || "").trim() ||
    String(body?.title ?? "").trim() ||
    "WPS AI";
  return [`HTTP-Referer: ${referer}`, `X-Title: ${title}`];
}

function classifyBenchmarkFailure(stderr) {
  const message = String(stderr || "");
  if (/operation timed out/i.test(message)) {
    return { status: "timeout", message: "Timed out before first content token." };
  }
  if (/(400|404|415|422)/.test(message)) {
    return { status: "unsupported", message: "This model did not accept chat/completions." };
  }
  if (/(401|403)/.test(message)) {
    return { status: "unauthorized", message: "The current key cannot access this model." };
  }
  return { status: "error", message: formatCurlFailure(message) };
}

function createBenchmarkBody(model, bufferedOnly = false) {
  return JSON.stringify({
    model,
    messages: BENCHMARK_MESSAGES,
    temperature: 0,
    stream: !bufferedOnly,
    max_tokens: 8
  });
}

function benchmarkModel({
  authorization,
  baseUrl,
  model,
  timeoutMs,
  preferredProxy,
  extraHeaders = [],
  bufferedOnly = false
}) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    let buffer = "";
    let firstByteMs = null;
    let firstTokenMs = null;
    let settled = false;
    let activeCurl = null;
    let nonSseDetected = false;

    const attempts = buildAttemptEnvs(preferredProxy);

    function finalize(status, message) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      try {
        activeCurl?.kill();
      } catch {
        // Ignore.
      }
      resolvePromise({
        model,
        ok: status === "ok",
        status,
        firstByteMs,
        firstTokenMs,
        totalMs:
          firstTokenMs !== null ? firstTokenMs : Math.max(0, Date.now() - startedAt),
        message: message || ""
      });
    }

    const timeoutId = setTimeout(() => {
      finalize("timeout", "Timed out before first content token.");
    }, timeoutMs);

    function startAttempt(index) {
      const attempt = attempts[index];
      let stderr = "";
      let attemptCompleted = false;

      activeCurl = spawn(
        CURL_BIN,
        createCurlArgs({
          authorization,
          url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
          method: "POST",
          headers: ["Content-Type: application/json", ...extraHeaders],
          dataFromStdin: true,
          stream: !bufferedOnly
        }),
        {
          env: attempt.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        }
      );

      activeCurl.on("error", (error) => {
        finalize(
          "error",
          error instanceof Error ? error.message : "Failed to start curl"
        );
      });

      activeCurl.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });

      activeCurl.stdout.on("data", (chunk) => {
        if (firstByteMs === null) {
          firstByteMs = Math.max(0, Date.now() - startedAt);
        }

        const text = chunk.toString("utf8");
        buffer += text;

        if (bufferedOnly) {
          // Wait for full JSON at `close`.
          return;
        }

        // Detect non-SSE body (proxy error page).
        if (!nonSseDetected && buffer.length > 4) {
          const preview = buffer.trimStart();
          const looksLikeSse =
            preview.startsWith("data:") ||
            preview.startsWith(":") ||
            preview.startsWith("event:");
          if (!looksLikeSse) {
            nonSseDetected = true;
          }
        }

        if (nonSseDetected) return;

        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const payload = parseSseEvent(part);
          const tokenText = extractChunk(payload);
          if (tokenText && firstTokenMs === null) {
            firstTokenMs = Math.max(0, Date.now() - startedAt);
            finalize("ok", "");
            return;
          }
        }
      });

      activeCurl.on("close", () => {
        if (settled || attemptCompleted) return;
        attemptCompleted = true;

        if (firstTokenMs !== null) {
          finalize("ok", "");
          return;
        }

        // Non-streaming mode: parse the final JSON to determine success.
        if (bufferedOnly) {
          try {
            const json = JSON.parse(buffer);
            if (json?.error) {
              finalize(
                "error",
                parseUpstreamErrorBody(buffer) ||
                  String(json.error?.message || "Upstream error")
              );
              return;
            }
            const content = normalizeContent(json?.choices?.[0]?.message?.content);
            if (content) {
              firstTokenMs = Math.max(0, Date.now() - startedAt);
              finalize("ok", "");
              return;
            }
            finalize("error", "Empty response");
          } catch {
            // Not JSON — likely a proxy error page.
            const preview = String(buffer || "").trim().slice(0, 200);
            finalize("error", preview || "Non-JSON upstream response");
          }
          return;
        }

        // Streaming path: report proxy error body if detected.
        if (nonSseDetected) {
          const preview = String(buffer || "").trim();
          finalize(
            "error",
            parseUpstreamErrorBody(preview) || preview.slice(0, 200) || "Non-SSE upstream body"
          );
          return;
        }

        const failure = classifyBenchmarkFailure(stderr);
        if (
          attempt.label === "proxy" &&
          index + 1 < attempts.length &&
          firstByteMs === null &&
          isProxyConnectionFailure(failure.message)
        ) {
          relayLog("proxy", "Proxy attempt failed during benchmark, retrying direct.", {
            model,
            message: failure.message
          });
          startAttempt(index + 1);
          return;
        }

        finalize(failure.status, failure.message);
      });

      activeCurl.stdin.end(createBenchmarkBody(model, bufferedOnly));
    }

    startAttempt(0);
  });
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
      providerId,
      authorization,
      baseUrl,
      preferredProxy,
      extraHeaders
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
  const streamingMode = String(body?.streamingMode ?? "auto").toLowerCase();

  const upstreamUrl = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  // Open the SSE response immediately so we can funnel relay_debug events to
  // the front-end in real time. The actual upstream data is detected later
  // and forwarded on top of the already-open stream.
  setCorsHeaders(res, req);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": stream-open\n\n");

  function debug(scope, message, details) {
    const entry = relayLog(scope, message, details);
    emitSseDebug(res, entry);
  }

  function debugError(scope, message, details) {
    const entry = relayLogError(scope, message, details);
    emitSseDebug(res, entry);
  }

  debug("chat", "Resolved upstream target.", {
    provider: providerId,
    upstreamUrl,
    model: String(payloadBody?.model || ""),
    stream: payloadBody?.stream !== false,
    streamingMode,
    preferredProxy: preferredProxy || "(direct)",
    systemProxy: SYSTEM_PROXY || "",
    authHeader: sanitizeAuthHeader(authorization),
    extraHeaderCount: extraHeaders.length,
    payloadPreview: sanitizePayloadForLog(payloadBody)
  });

  let streamStarted = true;
  let upstreamDataReceived = false;
  let finished = false;
  let activeCurl = null;
  let nonStreamingFallbackUsed = false;
  const attempts = buildAttemptEnvs(preferredProxy);

  // If the caller asked to skip streaming, go straight to the buffered path.
  if (streamingMode === "buffered") {
    void runNonStreamingFallback("streamingMode=buffered");
    return;
  }

  function fail(message) {
    if (finished) return;
    finished = true;
    debugError("chat", "Final failure returned to client.", { message });
    sendSse(res, { error: { message } });
    res.end();
  }

  function shouldTryNonStreamingFallback(detail) {
    if (nonStreamingFallbackUsed) return false;
    const normalized = String(detail || "").toLowerCase();
    return (
      normalized.includes("internal server error") ||
      normalized.includes("bad gateway") ||
      normalized.includes("proxy error") ||
      /<html/i.test(detail || "") ||
      /^\s*<\?xml/i.test(detail || "")
    );
  }

  async function runNonStreamingFallback(previousErrorDetail) {
    nonStreamingFallbackUsed = true;
    debug("chat", "Falling back to non-streaming upstream request.", {
      provider: providerId,
      model: String(payloadBody?.model || ""),
      previousErrorPreview: String(previousErrorDetail || "").slice(0, 300)
    });

    const bufferedPayload = { ...payloadBody, stream: false };

    try {
      const raw = await runCurlBuffered({
        authorization,
        url: upstreamUrl,
        method: "POST",
        headers: ["Content-Type: application/json", ...extraHeaders],
        body: JSON.stringify(bufferedPayload),
        preferredProxy
      });

      debug("chat", "Non-streaming upstream response received.", {
        bytes: raw.length,
        preview: raw.slice(0, 200)
      });

      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        fail(
          `Non-streaming fallback received a non-JSON response: ${String(raw).slice(0, 200)}`
        );
        return;
      }

      if (json?.error) {
        fail(parseUpstreamErrorBody(raw) || "Upstream returned an error.");
        return;
      }

      const message = json?.choices?.[0]?.message || {};
      const content = normalizeContent(message.content);
      const ssePayload = {
        id: json?.id || `fallback-${Date.now()}`,
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
      fail(error instanceof Error ? error.message : "Non-streaming fallback failed.");
    }
  }

  function startAttempt(index) {
    const attempt = attempts[index];
    let stderr = "";
    let attemptCompleted = false;
    let upstreamBuffer = "";
    let detectedNonSse = false;
    const attemptStartedAt = Date.now();

    debug("chat", "Starting upstream curl attempt.", {
      attemptIndex: index,
      attemptLabel: attempt.label,
      proxy: attempt.env.HTTPS_PROXY || "(direct)",
      model: String(payloadBody?.model || "")
    });

    activeCurl = spawn(
      CURL_BIN,
      createCurlArgs({
        authorization,
        url: upstreamUrl,
        method: "POST",
        headers: ["Content-Type: application/json", ...extraHeaders],
        dataFromStdin: true,
        stream: true
      }),
      {
        env: attempt.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );

    activeCurl.on("error", (error) => {
      debugError("chat", "curl process spawn error.", {
        error: error instanceof Error ? error.message : String(error)
      });
      fail(error instanceof Error ? error.message : "Failed to start curl");
    });

    activeCurl.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    activeCurl.stdout.on("data", (chunk) => {
      if (finished) return;
      const text = chunk.toString("utf8");

      if (!upstreamDataReceived) {
        upstreamBuffer += text;
        const preview = upstreamBuffer.trimStart();
        if (!preview) return;

        const looksLikeSse =
          preview.startsWith("data:") ||
          preview.startsWith(":") ||
          preview.startsWith("event:");

        if (looksLikeSse) {
          upstreamDataReceived = true;
          debug("chat", "Upstream first bytes look like SSE, forwarding.", {
            firstBytesPreview: upstreamBuffer.slice(0, 120),
            attemptMs: Date.now() - attemptStartedAt
          });
          res.write(upstreamBuffer);
          upstreamBuffer = "";
          return;
        }

        detectedNonSse = true;
        return;
      }

      res.write(text);
    });

    activeCurl.stdout.on("end", () => {
      if (finished || attemptCompleted) return;
      attemptCompleted = true;

      if (detectedNonSse) {
        const rawBody = upstreamBuffer;
        const upstreamMessage =
          parseUpstreamErrorBody(rawBody) ||
          formatCurlFailure(stderr || "Upstream returned an unexpected response.");

        debugError("chat", "Upstream returned non-SSE body.", {
          attemptLabel: attempt.label,
          bytes: rawBody.length,
          durationMs: Date.now() - attemptStartedAt,
          rawPreview: rawBody.slice(0, 400),
          stderrPreview: stderr.slice(0, 300),
          upstreamMessage
        });

        if (
          attempt.label === "proxy" &&
          index + 1 < attempts.length &&
          isProxyConnectionFailure(upstreamMessage)
        ) {
          debug("chat", "Proxy attempt failed, retrying direct.");
          startAttempt(index + 1);
          return;
        }

        if (shouldTryNonStreamingFallback(rawBody || upstreamMessage)) {
          void runNonStreamingFallback(rawBody || upstreamMessage);
          return;
        }

        fail(upstreamMessage);
        return;
      }

      if (!upstreamDataReceived) {
        const message = formatCurlFailure(stderr || "Upstream closed with no output.");
        debugError("chat", "Upstream closed without data.", {
          attemptLabel: attempt.label,
          stderrPreview: stderr.slice(0, 300),
          durationMs: Date.now() - attemptStartedAt,
          message
        });

        if (
          attempt.label === "proxy" &&
          index + 1 < attempts.length &&
          isProxyConnectionFailure(message)
        ) {
          startAttempt(index + 1);
          return;
        }

        if (shouldTryNonStreamingFallback(message)) {
          void runNonStreamingFallback(message);
          return;
        }

        fail(message);
        return;
      }

      debug("chat", "Upstream stream completed normally.", {
        durationMs: Date.now() - attemptStartedAt
      });
      finished = true;
      res.end();
    });

    activeCurl.on("close", (code) => {
      if (finished || attemptCompleted) return;
      attemptCompleted = true;
      if (!upstreamDataReceived) {
        const message = formatCurlFailure(
          stderr || `curl exited with code ${code ?? "unknown"}`
        );
        debugError("chat", "curl exited without upstream data.", {
          attemptLabel: attempt.label,
          exitCode: code,
          stderrPreview: stderr.slice(0, 300),
          durationMs: Date.now() - attemptStartedAt,
          message
        });

        if (
          attempt.label === "proxy" &&
          index + 1 < attempts.length &&
          isProxyConnectionFailure(message)
        ) {
          startAttempt(index + 1);
          return;
        }
        if (shouldTryNonStreamingFallback(message)) {
          void runNonStreamingFallback(message);
          return;
        }
        fail(message);
        return;
      }
      finished = true;
      res.end();
    });

    activeCurl.stdin.end(JSON.stringify(payloadBody));
  }

  req.on("aborted", () => {
    if (!finished) activeCurl?.kill();
  });

  startAttempt(0);
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
  const streamingMode = String(body?.streamingMode ?? "auto").toLowerCase();
  const bufferedOnly = streamingMode === "buffered";

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
      if (responseClosed) {
        resolvePromise();
        return;
      }
      sendSse(res, { type: "done", total: models.length, completed, results });
      res.end();
      resolvePromise();
    }

    function launchNext() {
      if (responseClosed) {
        resolvePromise();
        return;
      }

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
          extraHeaders,
          bufferedOnly
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
// Test command (used by smoke tests)
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
// Diagnose handler
// ============================================================================

async function handleDiagnose(req, res) {
  let body = {};
  try {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    body = contentType.includes("application/x-www-form-urlencoded")
      ? await readFormBody(req)
      : await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: { message: "Invalid body" } });
    return;
  }

  const providerId =
    body.provider === "openrouter" ? "openrouter" : "nvidia";
  const authorization = resolveRelayAuthorization(req, body);
  const baseUrl = resolveUpstreamBaseUrl(req, providerId, body);
  const preferredProxy = resolveUpstreamProxy(req, body);
  const extraHeaders = buildProviderExtraHeaders(providerId, req, body);

  const result = {
    platform: process.platform,
    systemProxy: SYSTEM_PROXY || "",
    providerId,
    baseUrl,
    usingProxy: preferredProxy || "",
    curlVersion: "",
    steps: []
  };

  try {
    const version = execFileSync(CURL_BIN, ["--version"], {
      encoding: "utf8",
      windowsHide: true
    });
    result.curlVersion = version.split("\n")[0];
  } catch (error) {
    result.curlVersion = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }

  async function probe(label, fn) {
    const startedAt = Date.now();
    try {
      const detail = await fn();
      result.steps.push({
        label,
        ok: true,
        durationMs: Date.now() - startedAt,
        detail
      });
    } catch (error) {
      result.steps.push({
        label,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // Probe 1: reachability of the base URL with no auth (to rule out network).
  await probe(`GET ${baseUrl}/models (auth + proxy)`, async () => {
    if (!authorization) {
      throw new Error("Missing API key — diagnose skipped.");
    }
    const raw = await runCurlBuffered({
      authorization,
      url: `${baseUrl.replace(/\/+$/, "")}/models`,
      method: "GET",
      headers: ["Accept: application/json", ...extraHeaders],
      preferredProxy
    });
    try {
      const json = JSON.parse(raw);
      return {
        modelCount: Array.isArray(json?.data) ? json.data.length : 0
      };
    } catch {
      return { bodyPreview: String(raw).slice(0, 200) };
    }
  });

  sendJson(res, 200, result);
}



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
      transport: "curl",
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

  if (req.method === "POST" && pathname === "/diagnose") {
    await handleDiagnose(req, res);
    return;
  }

  // Provider-agnostic routes: /<provider>/v1/{models,chat/completions,benchmark}
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

  // Legacy NVIDIA routes for backwards compatibility
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
  console.log(`  session root: ${SESSION_ROOT}`);
  if (SYSTEM_PROXY) {
    console.log(`  default proxy: ${SYSTEM_PROXY}`);
  } else {
    console.log("  default proxy: (direct)");
  }
});
