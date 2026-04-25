import { tryStartLocalRelay } from "../shared/relay";
import { pushDebugLog } from "./debugLog";

const RELAY_BOOTSTRAP_URL = "http://127.0.0.1:3888/bootstrap";
const RELAY_NVIDIA_MODELS_URL = "http://127.0.0.1:3888/nvidia/v1/models";
const RELAY_NVIDIA_BENCHMARK_URL =
  "http://127.0.0.1:3888/nvidia/v1/models/benchmark";
const DEFAULT_SELECTION_CONTEXT_LIMIT = 24000;
const DEFAULT_HISTORY_MESSAGE_LIMIT = 12;
const DEFAULT_HISTORY_CHAR_LIMIT = 18000;

export const PROVIDERS = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    placeholderModel: "openai/gpt-4.1-mini"
  },
  nvidia: {
    id: "nvidia",
    label: "NVIDIA Build",
    defaultBaseUrl: "http://127.0.0.1:3888/nvidia/v1",
    relayBaseUrl: "http://127.0.0.1:3888/nvidia/v1",
    placeholderModel: "deepseek-ai/deepseek-v3.1-terminus",
    recommendedModel: "deepseek-ai/deepseek-v3.1-terminus"
  }
};

export const DEFAULT_SETTINGS = {
  providerId: "nvidia",
  baseUrl: PROVIDERS.nvidia.relayBaseUrl,
  apiKey: "",
  model: PROVIDERS.nvidia.recommendedModel,
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

function isNvidiaRelayMode(settings) {
  return settings?.providerId === "nvidia";
}

function createAuthorizationHeaders(apiKey) {
  return {
    Authorization: `Bearer ${String(apiKey ?? "").trim()}`
  };
}

function createNvidiaHeaders(apiKey) {
  return {
    ...createAuthorizationHeaders(apiKey),
    "Content-Type": "application/json"
  };
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
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }

    function finishWithValue(value) {
      if (settled) {
        return;
      }
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
      finishWithError(error instanceof Error ? error : new TypeError("Failed to fetch"));
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
  const response = await requestText({
    ...options,
    responseType: "json"
  });

  let json = null;
  try {
    json = response.text ? JSON.parse(response.text) : null;
  } catch {
    json = null;
  }

  return {
    ...response,
    json
  };
}

export function normalizeSettings(input) {
  const settings = { ...DEFAULT_SETTINGS, ...input };

  if (!PROVIDERS[settings.providerId]) {
    settings.providerId = DEFAULT_SETTINGS.providerId;
  }

  if (!String(settings.baseUrl ?? "").trim()) {
    settings.baseUrl = PROVIDERS[settings.providerId].defaultBaseUrl;
  }

  if (settings.providerId === "nvidia") {
    settings.baseUrl = PROVIDERS.nvidia.relayBaseUrl;
  }

  if (settings.providerId === "nvidia" && !String(settings.model || "").trim()) {
    settings.model = PROVIDERS.nvidia.recommendedModel;
  }

  settings.maxTokens = normalizeMaxTokens(settings.maxTokens);
  settings.firstTokenTimeoutMs = normalizeFirstTokenTimeout(
    settings.firstTokenTimeoutMs
  );

  return settings;
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
      pushDebugLog("warn", "bootstrap", "Relay bootstrap request returned a non-success status.", {
        status: response.status,
        statusText: response.statusText
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

async function buildError(response) {
  const contentType =
    response.headers?.get?.("content-type") ?? response.getHeader?.("content-type") ?? "";

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

function createRequestBody(settings, messages, options = {}) {
  const payload = {
    model: settings.model.trim(),
    messages,
    temperature: Number(settings.temperature),
    stream: options.stream !== false
  };

  if (Number(settings.maxTokens) > 0) {
    payload.max_tokens = Number(settings.maxTokens);
  }

  return payload;
}

function createRelayChatFormBody(settings, messages) {
  const params = new URLSearchParams();
  params.set("apiKey", settings.apiKey.trim());
  params.set("payload", JSON.stringify(createRequestBody(settings, messages)));
  return params.toString();
}

async function waitForLocalRelay(settings, signal) {
  if (!isNvidiaRelayMode(settings)) {
    return true;
  }

  const healthUrl = "http://127.0.0.1:3888/health";
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
          attempt: attempt + 1,
          status: response.status
        });
        return true;
      }

      lastStatus = `${response.status} ${response.statusText || ""}`.trim();
    } catch {
      // Relay may still be starting.
    }

    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }

  pushDebugLog("error", "relay", "Relay health check timed out.", {
    lastStatus
  });
  return false;
}

function getSelectionContextLimit(settings) {
  if (Number(settings.maxTokens) > 0) {
    return Math.min(Math.max(Number(settings.maxTokens) * 8, 8000), 48000);
  }

  return settings.providerId === "nvidia"
    ? DEFAULT_SELECTION_CONTEXT_LIMIT
    : 16000;
}

function trimSelectionContext(selectionText, settings) {
  const normalized = String(selectionText ?? "").trim();
  if (!normalized) {
    return "";
  }

  const limit = getSelectionContextLimit(settings);
  if (normalized.length <= limit) {
    return normalized;
  }

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

  if (!data || data === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function getNvidiaConnectionError(settings) {
  if (isNvidiaRelayMode(settings)) {
    return "The local NVIDIA relay is unavailable. Auto-start was attempted, but the relay is still not ready. Check the local Node and PowerShell environment and try again.";
  }
}

function getNvidiaRelayStartupError() {
  return "The local NVIDIA relay startup timed out. Auto-start was attempted, but /health is still not ready.";
}

function getNvidiaTimeoutError(settings) {
  const seconds = Math.max(
    1,
    Math.round(Number(settings.firstTokenTimeoutMs || 0) / 1000)
  );

  return `Model ${settings.model.trim() || "deepseek-ai/deepseek-v3.1-terminus"} did not return the first valid output within ${seconds} seconds.`;
}

function createRequestController(signal) {
  const controller = new AbortController();

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", () => controller.abort(), {
        once: true
      });
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
      if (!item.id || seen.has(item.id)) {
        return false;
      }

      seen.add(item.id);
      return true;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function loadNvidiaModels({ apiKey, settings, signal }) {
  pushDebugLog("info", "models", "Loading NVIDIA models through the local relay.");
  const normalizedSettings = normalizeSettings({
    providerId: "nvidia",
    baseUrl: settings?.baseUrl || PROVIDERS.nvidia.relayBaseUrl
  });

  const relayReady = await waitForLocalRelay(normalizedSettings, signal);
  if (!relayReady && isNvidiaRelayMode(normalizedSettings)) {
    throw new Error(getNvidiaRelayStartupError());
  }

  const response = await requestJson({
    url: RELAY_NVIDIA_MODELS_URL,
    method: "GET",
    headers: createAuthorizationHeaders(apiKey),
    signal
  });

  if (!response.ok) {
    pushDebugLog("error", "models", "Model list request failed.", {
      status: response.status,
      statusText: response.statusText
    });
    throw new Error(await buildError(response));
  }

  const payload = response.json;
  const items = normalizeModelCatalog(payload?.data ?? payload?.models ?? []);
  pushDebugLog("info", "models", "Model list loaded.", {
    count: items.length
  });
  return items;
}

async function* streamSseViaXhr({ url, headers, body, signal }) {
  let buffer = "";
  let processedLength = 0;
  const queue = [];
  let done = false;
  let failed = null;
  let notify = null;
  let loggedFirstProgress = false;
  let loggedFirstEvent = false;

  pushDebugLog("info", "stream", "Opening relay streaming request.", {
    url
  });

  function pushChunk(text) {
    buffer += text;
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const payload = parseSseEvent(part);
      if (payload) {
        queue.push(payload);
      }
    }
    if (notify) {
      notify();
      notify = null;
    }
  }

  xhrRequest({
    url,
    method: "POST",
    headers,
    body,
    signal,
    onProgress(responseText, xhr) {
      const next = responseText.slice(processedLength);
      processedLength = responseText.length;
      if (xhr.status && xhr.status >= 400 && !failed) {
        failed = new Error(responseText || `${xhr.status} ${xhr.statusText}`);
      }
      if (!loggedFirstProgress && processedLength > 0) {
        loggedFirstProgress = true;
        pushDebugLog("info", "stream", "Relay returned the first response bytes.", {
          status: xhr.status || "",
          bytes: processedLength
        });
      }
      if (next) {
        pushChunk(next);
      }
    }
  })
    .then((response) => {
      pushDebugLog("info", "stream", "Relay streaming request completed.", {
        status: response.status,
        bytes: response.text.length
      });
      if (response.status >= 400) {
        failed = new Error(response.text || `${response.status} ${response.statusText}`);
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
    if (!loggedFirstEvent) {
      loggedFirstEvent = true;
      pushDebugLog("info", "stream", "Relay produced the first parsed SSE event.");
    }
  }

  if (failed) {
    throw failed;
  }
}

export async function* streamNvidiaModelBenchmarks({
  apiKey,
  models,
  settings,
  signal,
  timeoutMs = 12000,
  concurrency = 6
}) {
  const normalizedSettings = normalizeSettings({
    providerId: "nvidia",
    baseUrl: settings?.baseUrl || PROVIDERS.nvidia.relayBaseUrl
  });

  const relayReady = await waitForLocalRelay(normalizedSettings, signal);
  if (!relayReady) {
    throw new Error(getNvidiaRelayStartupError());
  }

  for await (const payload of streamSseViaXhr({
    url: RELAY_NVIDIA_BENCHMARK_URL,
    headers: {
      ...createAuthorizationHeaders(apiKey),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      models,
      timeoutMs,
      concurrency
    }),
    signal
  })) {
    if (payload) {
      yield payload;
    }
  }
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

    if (!role || !content || entry?.streaming || entry?.error) {
      continue;
    }

    if (remainingChars <= 0) {
      break;
    }

    normalizedHistory.unshift({
      role,
      content
    });
    remainingChars -= content.length;

    if (normalizedHistory.length >= DEFAULT_HISTORY_MESSAGE_LIMIT) {
      break;
    }
  }

  return [
    {
      role: "system",
      content: settings.systemPrompt.trim()
    },
    ...normalizedHistory,
    {
      role: "user",
      content: `${selectionBlock}${prompt.trim()}`
    }
  ];
}

export async function* streamCompletion({ settings, messages, signal }) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.apiKey.trim()}`
  };
  let requestHeaders = headers;
  let requestBody = JSON.stringify(createRequestBody(settings, messages));

  if (settings.providerId === "openrouter") {
    headers["HTTP-Referer"] = settings.referer.trim() || "https://localhost";
    headers["X-Title"] = settings.title.trim() || "WPS AI";
  }

  if (settings.providerId === "nvidia") {
    requestHeaders = {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
    };
    requestBody = createRelayChatFormBody(settings, messages);
    pushDebugLog(
      "info",
      "generation",
      "Using the relay compatibility transport for the local NVIDIA chat request."
    );
  }

  const requestController = createRequestController(signal);
  let timedOutBeforeFirstChunk = false;
  let firstChunkTimeoutId = null;

  if (settings.providerId === "nvidia") {
    firstChunkTimeoutId = window.setTimeout(() => {
      timedOutBeforeFirstChunk = true;
      requestController.abort();
    }, normalizeFirstTokenTimeout(settings.firstTokenTimeoutMs));
    pushDebugLog("info", "generation", "Armed the first-token timeout.", {
      timeoutMs: normalizeFirstTokenTimeout(settings.firstTokenTimeoutMs)
    });
  }

  try {
    pushDebugLog("info", "generation", "Preparing streamed completion request.", {
      provider: settings.providerId,
      model: settings.model.trim()
    });
    const relayReady = await waitForLocalRelay(settings, signal);
    if (!relayReady && isNvidiaRelayMode(settings)) {
      throw new Error(getNvidiaRelayStartupError());
    }
  } catch (error) {
    if (firstChunkTimeoutId !== null) {
      window.clearTimeout(firstChunkTimeoutId);
    }

    if (timedOutBeforeFirstChunk && settings.providerId === "nvidia") {
      throw new Error(getNvidiaTimeoutError(settings));
    }

    if (error instanceof Error && error.message) {
      throw error;
    }

    if (settings.providerId === "nvidia") {
      throw new Error(getNvidiaConnectionError(settings));
    }

    throw error;
  }

  let receivedFirstChunk = false;
  let receivedEvent = false;
  let totalChars = 0;
  try {
    pushDebugLog("info", "generation", "Sending streamed completion request to the relay.", {
      url: `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`
    });
    for await (const payload of streamSseViaXhr({
      url: `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      headers: requestHeaders,
      body: requestBody,
      signal: requestController.signal
    })) {
      receivedEvent = true;
      if (!receivedFirstChunk) {
        pushDebugLog("info", "generation", "Received the first relay event.");
      }

      if (payload?.error?.message) {
        throw new Error(String(payload.error.message));
      }

      const text = extractChunk(payload);
      if (text) {
        if (!receivedFirstChunk) {
          receivedFirstChunk = true;
          pushDebugLog("info", "generation", "Received the first streamed text chunk.", {
            length: text.length
          });
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
      throw new Error(message);
    }

    pushDebugLog("info", "generation", "Streamed completion finished successfully.", {
      totalChars
    });
  } catch (error) {
    if (firstChunkTimeoutId !== null) {
      window.clearTimeout(firstChunkTimeoutId);
    }

    if (timedOutBeforeFirstChunk && settings.providerId === "nvidia") {
      pushDebugLog("error", "generation", "Timed out before the first text chunk.", {
        model: settings.model.trim()
      });
      throw new Error(getNvidiaTimeoutError(settings));
    }

    pushDebugLog("error", "generation", "Streamed completion failed.", {
      error
    });
    if (error instanceof Error && error.message) {
      throw error;
    }

    throw error;
  }
}
