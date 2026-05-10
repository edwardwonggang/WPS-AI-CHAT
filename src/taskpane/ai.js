import { tryStartLocalRelay } from "../shared/relay";
import { pushDebugLog } from "./debugLog";

const RELAY_BASE_URL = "http://127.0.0.1:3888";
const RELAY_BOOTSTRAP_URL = `${RELAY_BASE_URL}/bootstrap`;
const DEFAULT_SELECTION_CONTEXT_LIMIT = 24000;
const DEFAULT_HISTORY_MESSAGE_LIMIT = 12;
const DEFAULT_HISTORY_CHAR_LIMIT = 18000;

export const PROVIDERS = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    relayPrefix: `${RELAY_BASE_URL}/openrouter/v1`,
    placeholderModel: "openai/gpt-4o-mini",
    recommendedModel: "openai/gpt-4o-mini",
    requiresApiKey: true
  },
  nvidia: {
    id: "nvidia",
    label: "NVIDIA Build",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    relayPrefix: `${RELAY_BASE_URL}/nvidia/v1`,
    placeholderModel: "deepseek-ai/deepseek-v3.1-terminus",
    recommendedModel: "deepseek-ai/deepseek-v3.1-terminus",
    requiresApiKey: true
  }
};

export const DEFAULT_SETTINGS = {
  activeProvider: "nvidia",
  providers: {
    openrouter: {
      baseUrl: PROVIDERS.openrouter.defaultBaseUrl,
      apiKey: "",
      model: ""
    },
    nvidia: {
      baseUrl: PROVIDERS.nvidia.defaultBaseUrl,
      apiKey: "",
      model: PROVIDERS.nvidia.recommendedModel
    }
  },
  proxyUrl: "",
  useRelay: true,
  streamingMode: "auto",
  temperature: 0.5,
  maxTokens: "",
  systemPrompt:
    "You are the WPS writing assistant. Output Markdown suitable for direct insertion into the document body. Use headings, lists, bold, and italics only when they improve readability. Do not add greetings, prefaces, or explanatory filler.",
  referer: "https://localhost",
  title: "WPS AI",
  useSelectionAsContext: true,
  replaceSelection: true,
  firstTokenTimeoutMs: 120000
};

function normalizeMaxTokens(value) {
  if (value === "" || value === null || value === undefined) {
    return "";
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "";
  }
  return String(Math.floor(parsed));
}

function normalizeFirstTokenTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SETTINGS.firstTokenTimeoutMs;
  }
  return Math.min(Math.floor(parsed), 10 * 60 * 1000);
}

function normalizeProviderRecord(providerId, input) {
  const defaults = DEFAULT_SETTINGS.providers[providerId] || {
    baseUrl: "",
    apiKey: "",
    model: ""
  };
  const record = input && typeof input === "object" ? input : {};

  return {
    baseUrl: String(record.baseUrl ?? "").trim() || defaults.baseUrl,
    apiKey: String(record.apiKey ?? ""),
    model: String(record.model ?? "").trim() || defaults.model || ""
  };
}

function migrateLegacySettings(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  // Detect legacy flat shape: providerId + apiKey + baseUrl + model at root level.
  if (input.providers || !input.providerId) {
    return null;
  }

  const providerId =
    input.providerId === "openrouter" ? "openrouter" : "nvidia";
  const base = {
    ...DEFAULT_SETTINGS,
    activeProvider: providerId,
    providers: {
      ...DEFAULT_SETTINGS.providers,
      [providerId]: {
        baseUrl:
          String(input.baseUrl ?? "").trim() ||
          PROVIDERS[providerId].defaultBaseUrl,
        apiKey: String(input.apiKey ?? ""),
        model: String(input.model ?? "").trim()
      }
    },
    temperature: input.temperature ?? DEFAULT_SETTINGS.temperature,
    maxTokens: input.maxTokens ?? "",
    systemPrompt: input.systemPrompt ?? DEFAULT_SETTINGS.systemPrompt,
    useSelectionAsContext:
      typeof input.useSelectionAsContext === "boolean"
        ? input.useSelectionAsContext
        : DEFAULT_SETTINGS.useSelectionAsContext,
    replaceSelection:
      typeof input.replaceSelection === "boolean"
        ? input.replaceSelection
        : DEFAULT_SETTINGS.replaceSelection,
    firstTokenTimeoutMs:
      input.firstTokenTimeoutMs ?? DEFAULT_SETTINGS.firstTokenTimeoutMs,
    referer: input.referer ?? DEFAULT_SETTINGS.referer,
    title: input.title ?? DEFAULT_SETTINGS.title
  };

  return base;
}

export function normalizeSettings(input) {
  const migrated = migrateLegacySettings(input) || input || {};
  const merged = { ...DEFAULT_SETTINGS, ...migrated };

  if (!PROVIDERS[merged.activeProvider]) {
    merged.activeProvider = DEFAULT_SETTINGS.activeProvider;
  }

  const providerRecords = {};
  for (const providerId of Object.keys(PROVIDERS)) {
    providerRecords[providerId] = normalizeProviderRecord(
      providerId,
      merged.providers?.[providerId]
    );
  }
  merged.providers = providerRecords;

  merged.proxyUrl = String(merged.proxyUrl ?? "").trim();
  merged.useRelay = merged.useRelay !== false;
  merged.temperature = Number.isFinite(Number(merged.temperature))
    ? Number(merged.temperature)
    : DEFAULT_SETTINGS.temperature;
  merged.maxTokens = normalizeMaxTokens(merged.maxTokens);
  merged.firstTokenTimeoutMs = normalizeFirstTokenTimeout(
    merged.firstTokenTimeoutMs
  );
  merged.systemPrompt = String(
    merged.systemPrompt ?? DEFAULT_SETTINGS.systemPrompt
  );
  merged.referer = String(merged.referer ?? DEFAULT_SETTINGS.referer);
  merged.title = String(merged.title ?? DEFAULT_SETTINGS.title);
  merged.useSelectionAsContext = merged.useSelectionAsContext !== false;
  merged.replaceSelection = merged.replaceSelection !== false;

  return merged;
}

export function getActiveProviderRecord(settings) {
  const providerId = settings?.activeProvider || DEFAULT_SETTINGS.activeProvider;
  const record = settings?.providers?.[providerId] || {};
  return { providerId, ...record };
}

function isFetchTransportError(error) {
  return (
    error instanceof TypeError ||
    (error instanceof Error &&
      /failed to fetch|networkerror|load failed/i.test(error.message || ""))
  );
}

function mergeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [key, String(value)])
  );
}

function xhrRequest({
  url,
  method = "GET",
  headers = {},
  body = null,
  signal,
  responseType = "text",
  onProgress
}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;

    function cleanup() {
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }
    }

    function finishWithError(error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function finishWithValue(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    function handleAbort() {
      try {
        xhr.abort();
      } catch {
        // Ignore abort failures.
      }
      finishWithError(new DOMException("Aborted", "AbortError"));
    }

    xhr.open(method, url, true);

    for (const [key, value] of Object.entries(mergeHeaders(headers))) {
      xhr.setRequestHeader(key, value);
    }

    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4) {
        finishWithValue({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          statusText: xhr.statusText || "",
          text: xhr.responseText || "",
          getHeader(name) {
            return xhr.getResponseHeader(name);
          }
        });
      }
    };

    xhr.onerror = () => {
      finishWithError(new TypeError("Failed to fetch"));
    };

    xhr.onabort = () => {
      finishWithError(new DOMException("Aborted", "AbortError"));
    };

    if (typeof onProgress === "function") {
      xhr.onprogress = () => {
        onProgress(xhr.responseText || "", xhr);
      };
    }

    if (signal) {
      if (signal.aborted) {
        handleAbort();
        return;
      }
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    try {
      if (responseType === "json" && !headers.Accept) {
        xhr.setRequestHeader("Accept", "application/json");
      }
      xhr.send(body);
    } catch (error) {
      finishWithError(
        error instanceof Error ? error : new TypeError("Failed to fetch")
      );
    }
  });
}

async function requestText(options) {
  try {
    const response = await fetch(options.url, {
      method: options.method || "GET",
      headers: options.headers,
      body: options.body,
      cache: "no-store",
      signal: options.signal
    });

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text: await response.text(),
      getHeader(name) {
        return response.headers.get(name);
      }
    };
  } catch (error) {
    if (!isFetchTransportError(error)) {
      throw error;
    }
    return xhrRequest(options);
  }
}

async function requestJson(options) {
  const response = await requestText({ ...options, responseType: "json" });
  let json = null;
  try {
    json = response.text ? JSON.parse(response.text) : null;
  } catch {
    json = null;
  }
  return { ...response, json };
}

async function fetchRelayLogsIntoDebug() {
  try {
    const response = await requestJson({
      url: `${RELAY_BASE_URL}/logs`,
      method: "GET"
    });
    if (!response.ok || !Array.isArray(response.json?.logs)) return;
    const logs = response.json.logs;
    // Only show logs from the last 30 seconds so we don't drown out older
    // noise when the user retries a failing request.
    const cutoff = Date.now() - 30 * 1000;
    for (const entry of logs) {
      const ts = Date.parse(entry?.time || "") || 0;
      if (ts && ts < cutoff) continue;
      pushDebugLog(
        entry.level === "error" ? "error" : "info",
        `relay:${entry.scope || "chat"}`,
        String(entry.message || ""),
        entry.details || {}
      );
    }
  } catch {
    // Relay may be unreachable; skip.
  }
}

export async function loadBootstrapSettings(signal) {
  try {
    pushDebugLog("info", "bootstrap", "Loading relay bootstrap settings.");
    const response = await requestJson({
      url: RELAY_BOOTSTRAP_URL,
      method: "GET",
      signal
    });

    if (!response.ok) {
      pushDebugLog("warn", "bootstrap", "Relay bootstrap returned a non-success status.", {
        status: response.status
      });
      return null;
    }

    const payload = response.json;
    const settings =
      payload?.settings && typeof payload.settings === "object"
        ? payload.settings
        : payload;

    pushDebugLog("info", "bootstrap", "Relay bootstrap settings loaded.");
    return normalizeSettings(settings);
  } catch (error) {
    pushDebugLog("warn", "bootstrap", "Relay bootstrap settings were unavailable.", {
      error
    });
    return null;
  }
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

async function buildError(response) {
  const contentType =
    response.headers?.get?.("content-type") ??
    response.getHeader?.("content-type") ??
    "";
  try {
    if (contentType.includes("application/json")) {
      const json = response.json ?? JSON.parse(response.text ?? "{}");
      return json?.error?.message || JSON.stringify(json);
    }
    return response.text ?? "";
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

function buildChatPayload(settings, messages, options = {}) {
  const provider = getActiveProviderRecord(settings);
  const payload = {
    model: String(provider.model ?? "").trim(),
    messages,
    temperature: Number(settings.temperature),
    stream: options.stream !== false
  };
  if (Number(settings.maxTokens) > 0) {
    payload.max_tokens = Number(settings.maxTokens);
  }
  return payload;
}

function createRelayRequestHeaders(settings, provider, extra = {}) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${String(provider.apiKey ?? "").trim()}`,
    "X-Upstream-Base-Url": String(provider.baseUrl ?? "").trim(),
    ...extra
  };

  const proxyUrl = String(settings.proxyUrl ?? "").trim();
  if (proxyUrl.toLowerCase() === "direct") {
    headers["X-Upstream-Proxy"] = "__direct__";
  } else if (proxyUrl) {
    headers["X-Upstream-Proxy"] = proxyUrl;
  }
  // Leave the header unset so the relay falls back to its configured/system
  // proxy. Previously we always forced `__direct__` here, which silently
  // disabled system proxies for users who left the field empty.

  if (provider.providerId === "openrouter") {
    headers["HTTP-Referer"] = String(settings.referer ?? "").trim() || "https://localhost";
    headers["X-Title"] = String(settings.title ?? "").trim() || "WPS AI";
  }

  return headers;
}

function createRelayChatFormBody(settings, messages) {
  const provider = getActiveProviderRecord(settings);
  const params = new URLSearchParams();
  params.set("apiKey", String(provider.apiKey ?? "").trim());
  params.set("baseUrl", String(provider.baseUrl ?? "").trim());
  params.set("proxyUrl", String(settings.proxyUrl ?? "").trim());
  params.set("provider", provider.providerId);
  params.set("streamingMode", String(settings.streamingMode ?? "auto"));
  if (provider.providerId === "openrouter") {
    params.set("referer", String(settings.referer ?? "").trim() || "https://localhost");
    params.set("title", String(settings.title ?? "").trim() || "WPS AI");
  }
  params.set("payload", JSON.stringify(buildChatPayload(settings, messages)));
  return params.toString();
}

async function waitForLocalRelay(signal) {
  const healthUrl = `${RELAY_BASE_URL}/health`;
  pushDebugLog("info", "relay", "Starting local relay health check.", {
    url: healthUrl
  });
  tryStartLocalRelay();
  let lastStatus = "";

  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (signal?.aborted) {
      pushDebugLog("warn", "relay", "Relay health check aborted.");
      return false;
    }
    try {
      const response = await requestText({
        url: healthUrl,
        method: "GET",
        signal
      });
      if (response.ok) {
        pushDebugLog("info", "relay", "Relay health check succeeded.", {
          attempt: attempt + 1
        });
        return true;
      }
      lastStatus = `${response.status} ${response.statusText || ""}`.trim();
    } catch {
      // Relay may still be starting.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }

  pushDebugLog("error", "relay", "Relay health check timed out.", { lastStatus });
  return false;
}

function getSelectionContextLimit(settings) {
  if (Number(settings.maxTokens) > 0) {
    return Math.min(Math.max(Number(settings.maxTokens) * 8, 8000), 48000);
  }
  return settings.activeProvider === "nvidia"
    ? DEFAULT_SELECTION_CONTEXT_LIMIT
    : 16000;
}

function trimSelectionContext(selectionText, settings) {
  const normalized = String(selectionText ?? "").trim();
  if (!normalized) return "";
  const limit = getSelectionContextLimit(settings);
  if (normalized.length <= limit) return normalized;

  const headLength = Math.max(2000, Math.floor(limit * 0.65));
  const tailLength = Math.max(1200, limit - headLength);
  const omitted = Math.max(0, normalized.length - headLength - tailLength);

  return [
    normalized.slice(0, headLength).trimEnd(),
    "",
    `[... ${omitted} chars omitted to keep the request responsive ...]`,
    "",
    normalized.slice(-tailLength).trimStart()
  ].join("\n");
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

function getRelayStartupError() {
  return "The local relay startup timed out. Start the relay (npm run relay) and try again.";
}

function getConnectionError() {
  return "The local relay is unavailable. Start the relay (npm run relay) and retry.";
}

function getTimeoutError(settings) {
  const provider = getActiveProviderRecord(settings);
  const seconds = Math.max(
    1,
    Math.round(Number(settings.firstTokenTimeoutMs || 0) / 1000)
  );
  return `Model ${provider.model || "(unspecified)"} did not return the first valid output within ${seconds} seconds.`;
}

function createRequestController(signal) {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  return controller;
}

function normalizeModelCatalog(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: String(item?.id ?? "").trim(),
      ownedBy: String(item?.owned_by ?? item?.ownedBy ?? "").trim()
    }))
    .filter((item) => {
      if (!item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Load the list of available models for a given provider. Routes through the
 * local relay so proxies and streaming transport stay consistent on every OS.
 */
export async function loadProviderModels({ settings, providerId, signal }) {
  const targetProviderId = providerId || settings.activeProvider;
  const provider = PROVIDERS[targetProviderId];
  if (!provider) {
    throw new Error(`Unknown provider: ${targetProviderId}`);
  }

  const providerRecord = {
    providerId: targetProviderId,
    ...(settings.providers?.[targetProviderId] || {})
  };

  pushDebugLog("info", "models", "Loading models through the local relay.", {
    provider: targetProviderId
  });

  const relayReady = await waitForLocalRelay(signal);
  if (!relayReady) {
    throw new Error(getRelayStartupError());
  }

  const url = `${provider.relayPrefix}/models`;
  const response = await requestJson({
    url,
    method: "GET",
    headers: createRelayRequestHeaders(settings, providerRecord),
    signal
  });

  if (!response.ok) {
    pushDebugLog("error", "models", "Model list request failed.", {
      status: response.status
    });
    throw new Error(await buildError(response));
  }

  const payload = response.json;
  const items = normalizeModelCatalog(
    payload?.data ?? payload?.models ?? payload?.items ?? []
  );
  pushDebugLog("info", "models", "Model list loaded.", { count: items.length });
  return items;
}

// Kept for backwards compatibility with existing callers.
export async function loadNvidiaModels({ apiKey, settings, signal }) {
  const merged = normalizeSettings({
    ...settings,
    providers: {
      ...settings?.providers,
      nvidia: {
        ...(settings?.providers?.nvidia || {}),
        apiKey: apiKey ?? settings?.providers?.nvidia?.apiKey ?? ""
      }
    }
  });
  return loadProviderModels({ settings: merged, providerId: "nvidia", signal });
}

async function* streamSseViaXhr({ url, headers, body, method = "POST", signal }) {
  let buffer = "";
  let processedLength = 0;
  const queue = [];
  let done = false;
  let failed = null;
  let notify = null;

  pushDebugLog("info", "stream", "Opening relay streaming request.", { url });

  function pushChunk(text) {
    buffer += text;
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const payload = parseSseEvent(part);
      if (payload) queue.push(payload);
    }
    if (notify) {
      notify();
      notify = null;
    }
  }

  xhrRequest({
    url,
    method,
    headers,
    body,
    signal,
    onProgress(responseText, xhr) {
      const next = responseText.slice(processedLength);
      processedLength = responseText.length;
      if (xhr.status && xhr.status >= 400 && !failed) {
        failed = new Error(responseText || `${xhr.status} ${xhr.statusText}`);
      }
      if (next) pushChunk(next);
    }
  })
    .then((response) => {
      if (response.status >= 400) {
        failed = new Error(
          response.text || `${response.status} ${response.statusText}`
        );
      } else if (response.text.length > processedLength) {
        pushChunk(response.text.slice(processedLength));
      }
      done = true;
      if (notify) {
        notify();
        notify = null;
      }
    })
    .catch((error) => {
      pushDebugLog("error", "stream", "Relay streaming request failed.", {
        url,
        error
      });
      failed = error instanceof Error ? error : new Error("Request failed.");
      done = true;
      if (notify) {
        notify();
        notify = null;
      }
    });

  while (!done || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise((resolve) => {
        notify = resolve;
      });
      continue;
    }
    yield queue.shift();
  }

  if (failed) throw failed;
}

export async function* streamModelBenchmarks({
  settings,
  providerId,
  models,
  signal,
  timeoutMs = 12000,
  concurrency = 6
}) {
  const targetProviderId = providerId || settings.activeProvider;
  const provider = PROVIDERS[targetProviderId];
  if (!provider) {
    throw new Error(`Unknown provider: ${targetProviderId}`);
  }

  const relayReady = await waitForLocalRelay(signal);
  if (!relayReady) {
    throw new Error(getRelayStartupError());
  }

  const providerRecord = {
    providerId: targetProviderId,
    ...(settings.providers?.[targetProviderId] || {})
  };

  for await (const payload of streamSseViaXhr({
    url: `${provider.relayPrefix}/benchmark`,
    headers: createRelayRequestHeaders(settings, providerRecord),
    body: JSON.stringify({
      models,
      timeoutMs,
      concurrency,
      streamingMode: settings.streamingMode || "auto"
    }),
    signal
  })) {
    if (payload?.type === "relay_debug") {
      pushDebugLog(
        payload.level === "error" ? "error" : "info",
        `relay:${payload.scope || "bench"}`,
        String(payload.message || ""),
        payload.details || {}
      );
      continue;
    }
    if (payload) yield payload;
  }
}

// Backwards-compatible alias used by existing callers.
export async function* streamNvidiaModelBenchmarks(options = {}) {
  const settings = normalizeSettings({
    ...(options.settings || {}),
    providers: {
      ...(options.settings?.providers || {}),
      nvidia: {
        ...(options.settings?.providers?.nvidia || {}),
        apiKey:
          options.apiKey ?? options.settings?.providers?.nvidia?.apiKey ?? ""
      }
    }
  });
  yield* streamModelBenchmarks({
    ...options,
    settings,
    providerId: "nvidia"
  });
}

export function buildMessages({ prompt, selectionText, settings, history = [] }) {
  const trimmedSelectionText = trimSelectionContext(selectionText, settings);
  const selectionBlock =
    settings.useSelectionAsContext && trimmedSelectionText
      ? [
          "The following content is the current WPS selection. Use it as context, but do not mechanically repeat it.",
          "",
          "---- Selection Start ----",
          trimmedSelectionText,
          "---- Selection End ----",
          ""
        ].join("\n")
      : "";

  const normalizedHistory = [];
  let remainingChars = DEFAULT_HISTORY_CHAR_LIMIT;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    const role =
      entry?.role === "assistant"
        ? "assistant"
        : entry?.role === "user"
          ? "user"
          : "";
    const content = String(entry?.content ?? "").trim();

    if (!role || !content || entry?.streaming || entry?.error) continue;
    if (remainingChars <= 0) break;

    normalizedHistory.unshift({ role, content });
    remainingChars -= content.length;

    if (normalizedHistory.length >= DEFAULT_HISTORY_MESSAGE_LIMIT) break;
  }

  return [
    { role: "system", content: String(settings.systemPrompt ?? "").trim() },
    ...normalizedHistory,
    { role: "user", content: `${selectionBlock}${prompt.trim()}` }
  ];
}

export async function* streamCompletion({ settings, messages, signal }) {
  const provider = getActiveProviderRecord(settings);
  const providerMeta = PROVIDERS[provider.providerId];
  if (!providerMeta) {
    throw new Error(`Unknown provider: ${provider.providerId}`);
  }

  const requestController = createRequestController(signal);
  let timedOutBeforeFirstChunk = false;
  let firstChunkTimeoutId = null;

  firstChunkTimeoutId = window.setTimeout(() => {
    timedOutBeforeFirstChunk = true;
    requestController.abort();
  }, normalizeFirstTokenTimeout(settings.firstTokenTimeoutMs));

  pushDebugLog("info", "generation", "Preparing streamed completion.", {
    provider: provider.providerId,
    model: provider.model,
    baseUrl: provider.baseUrl,
    proxyUrl: settings.proxyUrl || "(system)",
    temperature: settings.temperature,
    maxTokens: settings.maxTokens || "auto",
    messagesCount: Array.isArray(messages) ? messages.length : 0,
    apiKeyPreview: provider.apiKey
      ? `${String(provider.apiKey).slice(0, 8)}...(len=${String(provider.apiKey).length})`
      : "(empty)",
    referer: settings.referer,
    title: settings.title
  });

  try {
    const relayReady = await waitForLocalRelay(signal);
    if (!relayReady) {
      throw new Error(getRelayStartupError());
    }
  } catch (error) {
    if (firstChunkTimeoutId !== null) {
      window.clearTimeout(firstChunkTimeoutId);
    }
    if (timedOutBeforeFirstChunk) {
      throw new Error(getTimeoutError(settings));
    }
    if (error instanceof Error && error.message) throw error;
    throw new Error(getConnectionError());
  }

  const url = `${providerMeta.relayPrefix}/chat/completions`;

  // Relay now accepts plain JSON + standard headers from the front-end. It
  // internally uses Node fetch + undici ProxyAgent to talk to the upstream,
  // which removes the old curl + form-encoded indirection entirely.
  const provider2 = getActiveProviderRecord(settings);
  const requestHeaders = createRelayRequestHeaders(settings, provider2);
  const requestBody = JSON.stringify(buildChatPayload(settings, messages));

  let receivedFirstChunk = false;
  let receivedEvent = false;
  let totalChars = 0;

  try {
    pushDebugLog("info", "generation", "Sending streamed completion.", { url });
    for await (const payload of streamSseViaXhr({
      url,
      headers: requestHeaders,
      body: requestBody,
      signal: requestController.signal
    })) {
      // Relay forwards its own internal diagnostics as `relay_debug` events
      // so every step of the upstream handshake shows up in the plugin log.
      if (payload?.type === "relay_debug") {
        pushDebugLog(
          payload.level === "error" ? "error" : "info",
          `relay:${payload.scope || "chat"}`,
          String(payload.message || ""),
          payload.details || {}
        );
        continue;
      }

      receivedEvent = true;

      if (payload?.error?.message) {
        throw new Error(String(payload.error.message));
      }

      const text = extractChunk(payload);
      if (text) {
        if (!receivedFirstChunk) {
          receivedFirstChunk = true;
          if (firstChunkTimeoutId !== null) {
            window.clearTimeout(firstChunkTimeoutId);
            firstChunkTimeoutId = null;
          }
        }
        totalChars += text.length;
        yield text;
      }
    }

    if (!receivedFirstChunk) {
      const message = receivedEvent
        ? "The relay stream completed without any text output."
        : "The relay stream closed without returning any events.";
      pushDebugLog("error", "generation", message);
      await fetchRelayLogsIntoDebug();
      throw new Error(message);
    }

    pushDebugLog("info", "generation", "Streamed completion finished.", {
      totalChars
    });
  } catch (error) {
    if (firstChunkTimeoutId !== null) {
      window.clearTimeout(firstChunkTimeoutId);
    }
    if (timedOutBeforeFirstChunk) {
      pushDebugLog("error", "generation", "Timed out before first text chunk.");
      await fetchRelayLogsIntoDebug();
      throw new Error(getTimeoutError(settings));
    }
    pushDebugLog("error", "generation", "Streamed completion failed.", {
      error: error instanceof Error ? error.message : String(error)
    });
    await fetchRelayLogsIntoDebug();
    throw error;
  }
}
