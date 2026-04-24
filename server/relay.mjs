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
import { join, resolve } from "node:path";

const PORT = 3888;
const NVIDIA_CHAT_UPSTREAM = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODELS_UPSTREAM = "https://integrate.api.nvidia.com/v1/models";
const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const CURL_BIN = process.platform === "win32" ? "curl.exe" : "curl";
const RELAY_CONFIG_URL = new URL("./relay.config.json", import.meta.url);
const DEFAULT_BENCHMARK_TIMEOUT_MS = 12000;
const DEFAULT_BENCHMARK_CONCURRENCY = 6;
const DEFAULT_SESSION_ROOT =
  process.platform === "win32"
    ? "D:\\Programs\\WPS AI Sessions"
    : "/tmp/wps-ai-sessions";
const SESSION_BLOCK_CLOSE = "<!-- /WPS-AI-MESSAGE -->";
const BENCHMARK_MESSAGES = [
  {
    role: "user",
    content: "Reply with OK only."
  }
];
const DEFAULT_BOOTSTRAP_SETTINGS = Object.freeze({
  providerId: "nvidia",
  baseUrl: "http://127.0.0.1:3888/nvidia/v1",
  apiKey: "",
  model: "deepseek-ai/deepseek-v3.1-terminus",
  temperature: 0.5,
  maxTokens: "",
  systemPrompt:
    "你是 WPS 写作助手。请直接输出适合插入正文的 Markdown 内容，仅在有助于可读性时使用标题、列表、加粗和斜体，不要添加寒暄、前言或解释性套话。",
  useSelectionAsContext: true,
  replaceSelection: true,
  firstTokenTimeoutMs: 120000
});

function normalizeProxyUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `http://${trimmed}`;
}

function readRelayConfig() {
  try {
    if (!existsSync(RELAY_CONFIG_URL)) {
      return {};
    }

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
  try {
    const output = execFileSync(
      "reg.exe",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        "/v",
        "ProxyServer"
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      }
    );

    const match = output.match(/ProxyServer\s+REG_\w+\s+(.+)$/im);
    if (!match) {
      return "";
    }

    const raw = match[1].trim();
    if (!raw) {
      return "";
    }

    if (!raw.includes("=")) {
      return normalizeProxyUrl(raw);
    }

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

function resolveProxyEnv(config) {
  const proxy =
    resolveConfigProxy(config) ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    (process.platform === "win32" ? resolveWindowsProxy() : "");

  if (!proxy) {
    return process.env;
  }

  return {
    ...process.env,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: process.env.NO_PROXY || "127.0.0.1,localhost",
    no_proxy: process.env.no_proxy || "127.0.0.1,localhost"
  };
}

function normalizeBootstrapSettings(config) {
  const defaults =
    config.defaults && typeof config.defaults === "object" ? config.defaults : {};
  const providerId =
    String(defaults.providerId ?? "").trim() === "openrouter"
      ? "openrouter"
      : "nvidia";
  const defaultBaseUrl =
    providerId === "openrouter"
      ? OPENROUTER_DEFAULT_BASE_URL
      : DEFAULT_BOOTSTRAP_SETTINGS.baseUrl;

  return {
    ...DEFAULT_BOOTSTRAP_SETTINGS,
    ...defaults,
    providerId,
    baseUrl:
      defaults.baseUrl && String(defaults.baseUrl).trim()
        ? String(defaults.baseUrl).trim()
        : defaultBaseUrl,
    apiKey: String(defaults.apiKey ?? ""),
    model:
      String(defaults.model ?? "").trim() ||
      DEFAULT_BOOTSTRAP_SETTINGS.model,
    temperature: Number.isFinite(Number(defaults.temperature))
      ? Number(defaults.temperature)
      : DEFAULT_BOOTSTRAP_SETTINGS.temperature,
    maxTokens:
      defaults.maxTokens === "" || defaults.maxTokens === null
        ? ""
        : String(defaults.maxTokens ?? ""),
    systemPrompt:
      String(defaults.systemPrompt ?? "").trim() ||
      DEFAULT_BOOTSTRAP_SETTINGS.systemPrompt,
    useSelectionAsContext:
      typeof defaults.useSelectionAsContext === "boolean"
        ? defaults.useSelectionAsContext
        : DEFAULT_BOOTSTRAP_SETTINGS.useSelectionAsContext,
    replaceSelection:
      typeof defaults.replaceSelection === "boolean"
        ? defaults.replaceSelection
        : DEFAULT_BOOTSTRAP_SETTINGS.replaceSelection,
    firstTokenTimeoutMs: Number.isFinite(Number(defaults.firstTokenTimeoutMs))
      ? Math.min(Math.floor(Number(defaults.firstTokenTimeoutMs)), 10 * 60 * 1000)
      : DEFAULT_BOOTSTRAP_SETTINGS.firstTokenTimeoutMs
  };
}

function normalizeSessionRoot(config) {
  const configured = String(config.sessionRoot ?? "").trim();
  return resolve(configured || DEFAULT_SESSION_ROOT);
}

function normalizeSessionDocument(input) {
  const title =
    String(input?.title ?? input?.name ?? "").trim() || "未命名文档";
  const path = String(input?.path ?? "").trim();
  let fullName = String(input?.fullName ?? "").trim();

  if (!fullName && path) {
    fullName = `${path}${path.endsWith("\\") || path.endsWith("/") ? "" : "\\"}${title}`;
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
      id:
        String(entry?.id ?? "").trim() ||
        `session-${Date.now()}-${index + 1}`,
      role: entry?.role === "assistant" ? "assistant" : "user",
      content: String(entry?.content ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
      error: Boolean(entry?.error),
      streaming: false
    }))
    .filter((entry) => entry.content || entry.role === "assistant" || entry.role === "user");
}

function sanitizeSessionFileLabel(value) {
  const cleaned = String(value ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.slice(0, 80) || "未命名文档";
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
    "> 由 WPS AI 自动维护的对话记录。",
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

const RELAY_CONFIG = readRelayConfig();
const PROXY_ENV = resolveProxyEnv(RELAY_CONFIG);
const BOOTSTRAP_SETTINGS = normalizeBootstrapSettings(RELAY_CONFIG);
const SESSION_ROOT = normalizeSessionRoot(RELAY_CONFIG);

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
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
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

function formatCurlFailure(stderr) {
  const message = stderr.trim();
  if (!message) {
    return "Failed to reach NVIDIA upstream";
  }

  return message.replace(/^curl:\s*/i, "");
}

function normalizeContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (item && typeof item === "object" && "text" in item) {
        return String(item.text ?? "");
      }

      return "";
    })
    .join("");
}

function extractChunk(payload) {
  const choice = payload?.choices?.[0];
  if (!choice) {
    return "";
  }

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

  if (!data || data === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function createCurlArgs({
  authorization,
  url,
  method = "GET",
  headers = [],
  dataFromStdin = false,
  stream = false
}) {
  const args = ["-sS"];

  if (stream) {
    args.push("-N");
  }

  args.push("-f", "-X", method);

  if (authorization) {
    args.push("-H", `Authorization: ${authorization}`);
  }

  for (const header of headers) {
    args.push("-H", header);
  }

  if (dataFromStdin) {
    args.push("--data-binary", "@-");
  }

  args.push(url);
  return args;
}

function runCurlBuffered({
  authorization,
  url,
  method = "GET",
  headers = [],
  body = ""
}) {
  return new Promise((resolve, reject) => {
    const curl = spawn(
      CURL_BIN,
      createCurlArgs({
        authorization,
        url,
        method,
        headers,
        dataFromStdin: method !== "GET"
      }),
      {
        env: PROXY_ENV,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );

    let stdout = "";
    let stderr = "";

    curl.on("error", (error) => {
      reject(error instanceof Error ? error : new Error("Failed to start curl"));
    });

    curl.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    curl.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    curl.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(formatCurlFailure(stderr || stdout)));
    });

    if (method === "GET") {
      curl.stdin.end();
      return;
    }

    curl.stdin.end(body);
  });
}

async function listNvidiaModels(authorization) {
  const raw = await runCurlBuffered({
    authorization,
    url: NVIDIA_MODELS_UPSTREAM,
    method: "GET",
    headers: ["Accept: application/json"]
  });

  const json = JSON.parse(raw);
  const seen = new Set();
  const data = (Array.isArray(json?.data) ? json.data : [])
    .map((item) => ({
      id: String(item?.id ?? "").trim(),
      object: String(item?.object ?? "model"),
      owned_by: String(item?.owned_by ?? "").trim()
    }))
    .filter((item) => {
      if (!item.id || seen.has(item.id)) {
        return false;
      }

      seen.add(item.id);
      return true;
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    object: "list",
    data
  };
}

function createBenchmarkBody(model) {
  return JSON.stringify({
    model,
    messages: BENCHMARK_MESSAGES,
    temperature: 0,
    stream: true,
    max_tokens: 8
  });
}

function classifyBenchmarkFailure(stderr) {
  const message = String(stderr || "");

  if (/operation timed out/i.test(message)) {
    return {
      status: "timeout",
      message: "Timed out before first content token."
    };
  }

  if (/(400|404|415|422)/.test(message)) {
    return {
      status: "unsupported",
      message: "This model did not accept chat/completions."
    };
  }

  if (/(401|403)/.test(message)) {
    return {
      status: "unauthorized",
      message: "The current key cannot access this model."
    };
  }

  return {
    status: "error",
    message: formatCurlFailure(message)
  };
}

function benchmarkModel(authorization, model, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const curl = spawn(
      CURL_BIN,
      createCurlArgs({
        authorization,
        url: NVIDIA_CHAT_UPSTREAM,
        method: "POST",
        headers: ["Content-Type: application/json"],
        dataFromStdin: true,
        stream: true
      }),
      {
        env: PROXY_ENV,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );

    let stderr = "";
    let buffer = "";
    let firstByteMs = null;
    let firstTokenMs = null;
    let settled = false;

    function finalize(status, message) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);

      try {
        curl.kill();
      } catch {
        // Ignore kill failures after process exit.
      }

      resolve({
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

    curl.on("error", (error) => {
      finalize("error", error instanceof Error ? error.message : "Failed to start curl");
    });

    curl.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    curl.stdout.on("data", (chunk) => {
      if (firstByteMs === null) {
        firstByteMs = Math.max(0, Date.now() - startedAt);
      }

      buffer += chunk.toString("utf8");
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const payload = parseSseEvent(part);
        const text = extractChunk(payload);

        if (text && firstTokenMs === null) {
          firstTokenMs = Math.max(0, Date.now() - startedAt);
          finalize("ok", "");
          return;
        }
      }
    });

    curl.on("close", () => {
      if (settled) {
        return;
      }

      if (firstTokenMs !== null) {
        finalize("ok", "");
        return;
      }

      const failure = classifyBenchmarkFailure(stderr);
      finalize(failure.status, failure.message);
    });

    curl.stdin.end(createBenchmarkBody(model));
  });
}

async function handleNvidiaModels(req, res) {
  const authorization = req.headers.authorization;
  if (!authorization) {
    sendJson(res, 400, {
      error: {
        message: "Missing Authorization header"
      }
    });
    return;
  }

  try {
    const models = await listNvidiaModels(authorization);
    sendJson(res, 200, models);
  } catch (error) {
    sendJson(res, 502, {
      error: {
        message:
          error instanceof Error ? error.message : "Failed to load NVIDIA models"
      }
    });
  }
}

async function handleNvidiaChat(req, res) {
  const authorization = req.headers.authorization;
  if (!authorization) {
    sendJson(res, 400, {
      error: {
        message: "Missing Authorization header"
      }
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, {
      error: {
        message: "Invalid JSON body"
      }
    });
    return;
  }

  const curl = spawn(
    CURL_BIN,
    createCurlArgs({
      authorization,
      url: NVIDIA_CHAT_UPSTREAM,
      method: "POST",
      headers: ["Content-Type: application/json"],
      dataFromStdin: true,
      stream: true
    }),
    {
      env: PROXY_ENV,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );

  let stderr = "";
  let streamStarted = false;
  let finished = false;

  function fail(message) {
    if (finished) {
      return;
    }

    finished = true;
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message } });
      return;
    }

    res.end();
  }

  curl.on("error", (error) => {
    fail(error instanceof Error ? error.message : "Failed to start curl");
  });

  curl.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  curl.stdout.on("data", (chunk) => {
    if (finished) {
      return;
    }

    if (!streamStarted) {
      setCorsHeaders(res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache"
      });
      streamStarted = true;
    }

    res.write(chunk);
  });

  curl.stdout.on("end", () => {
    if (finished) {
      return;
    }

    finished = true;
    res.end();
  });

  curl.on("close", (code) => {
    if (finished) {
      return;
    }

    if (!streamStarted) {
      fail(formatCurlFailure(stderr || `curl exited with code ${code ?? "unknown"}`));
      return;
    }

    finished = true;
    res.end();
  });

  req.on("aborted", () => {
    if (!finished) {
      curl.kill();
    }
  });

  curl.stdin.end(JSON.stringify(body));
}

async function handleNvidiaBenchmark(req, res) {
  const authorization = req.headers.authorization;
  if (!authorization) {
    sendJson(res, 400, {
      error: {
        message: "Missing Authorization header"
      }
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, {
      error: {
        message: "Invalid JSON body"
      }
    });
    return;
  }

  const models = Array.from(
    new Set(
      (Array.isArray(body?.models) ? body.models : [])
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
    )
  );

  if (models.length === 0) {
    sendJson(res, 400, {
      error: {
        message: "No models provided"
      }
    });
    return;
  }

  const timeoutMs = Number.isFinite(Number(body?.timeoutMs))
    ? Math.min(Math.max(Math.floor(Number(body.timeoutMs)), 1000), 60000)
    : DEFAULT_BENCHMARK_TIMEOUT_MS;
  const concurrency = Number.isFinite(Number(body?.concurrency))
    ? Math.min(Math.max(Math.floor(Number(body.concurrency)), 1), 12)
    : DEFAULT_BENCHMARK_CONCURRENCY;

  setCorsHeaders(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache"
  });

  let completed = 0;
  let cursor = 0;
  let active = 0;
  let responseClosed = false;
  const results = [];

  req.on("aborted", () => {
    responseClosed = true;
  });

  sendSse(res, {
    type: "start",
    total: models.length,
    timeoutMs,
    concurrency
  });

  await new Promise((resolve) => {
    function flushDone() {
      if (responseClosed) {
        resolve();
        return;
      }

      sendSse(res, {
        type: "done",
        total: models.length,
        completed,
        results
      });
      res.end();
      resolve();
    }

    function launchNext() {
      if (responseClosed) {
        resolve();
        return;
      }

      while (active < concurrency && cursor < models.length) {
        const model = models[cursor];
        cursor += 1;
        active += 1;

        benchmarkModel(authorization, model, timeoutMs)
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

async function handleSessionLoad(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, {
      error: {
        message: "Invalid JSON body"
      }
    });
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
    sendJson(res, 400, {
      error: {
        message: "Invalid JSON body"
      }
    });
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
    sendJson(res, 400, {
      error: {
        message: "Invalid JSON body"
      }
    });
    return;
  }

  const document = normalizeSessionDocument(body?.document);
  const filePath = sessionFilePathForDocument(SESSION_ROOT, document);

  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }

    sendJson(res, 200, {
      ok: true,
      directory: SESSION_ROOT,
      filePath,
      document
    });
  } catch (error) {
    sendJson(res, 500, {
      error: {
        message: error instanceof Error ? error.message : "Failed to delete session"
      }
    });
  }
}

const server = createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 404, { error: { message: "Not found" } });
    return;
  }

  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, {
      ok: true,
      provider: "nvidia-relay",
      transport: "curl",
      proxy: PROXY_ENV.HTTPS_PROXY || PROXY_ENV.HTTP_PROXY || "",
      sessionRoot: SESSION_ROOT
    });
    return;
  }

  if (req.method === "GET" && req.url === "/bootstrap") {
    sendJson(res, 200, {
      ok: true,
      settings: BOOTSTRAP_SETTINGS
    });
    return;
  }

  if (req.method === "GET" && req.url === "/nvidia/v1/models") {
    await handleNvidiaModels(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/nvidia/v1/models/benchmark") {
    await handleNvidiaBenchmark(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/nvidia/v1/chat/completions") {
    await handleNvidiaChat(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/session/load") {
    await handleSessionLoad(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/session/save") {
    await handleSessionSave(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/session/delete") {
    await handleSessionDelete(req, res);
    return;
  }

  sendJson(res, 404, { error: { message: "Not found" } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`WPS AI relay listening on http://127.0.0.1:${PORT}`);
});
