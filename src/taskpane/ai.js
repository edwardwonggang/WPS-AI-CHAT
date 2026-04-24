const RELAY_BOOTSTRAP_URL = "http://127.0.0.1:3888/bootstrap";
const RELAY_NVIDIA_MODELS_URL = "http://127.0.0.1:3888/nvidia/v1/models";
const RELAY_NVIDIA_BENCHMARK_URL =
  "http://127.0.0.1:3888/nvidia/v1/models/benchmark";
const DEFAULT_SELECTION_CONTEXT_LIMIT = 24000;

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
    directBaseUrl: "https://integrate.api.nvidia.com/v1",
    placeholderModel: "deepseek-ai/deepseek-v3.1-terminus",
    recommendedModel: "deepseek-ai/deepseek-v3.1-terminus"
  }
};

export const DEFAULT_SETTINGS = {
  providerId: "nvidia",
  baseUrl: PROVIDERS.nvidia.defaultBaseUrl,
  apiKey: "",
  model: PROVIDERS.nvidia.recommendedModel,
  temperature: 0.5,
  maxTokens: "",
  systemPrompt:
    "你是 WPS 写作助手。请直接输出适合插入正文的 Markdown 内容，仅在有助于可读性时使用标题、列表、加粗和斜体，不要添加寒暄、前言或解释性套话。",
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

export function normalizeSettings(input) {
  const settings = { ...DEFAULT_SETTINGS, ...input };

  if (!PROVIDERS[settings.providerId]) {
    settings.providerId = DEFAULT_SETTINGS.providerId;
  }

  if (!String(settings.baseUrl ?? "").trim()) {
    settings.baseUrl = PROVIDERS[settings.providerId].defaultBaseUrl;
  }

  if (
    settings.providerId === "nvidia" &&
    (!settings.baseUrl || settings.baseUrl === PROVIDERS.nvidia.directBaseUrl)
  ) {
    settings.baseUrl = PROVIDERS.nvidia.defaultBaseUrl;
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

function createAuthorizationHeaders(apiKey) {
  return {
    Authorization: `Bearer ${String(apiKey ?? "").trim()}`
  };
}

export async function loadBootstrapSettings(signal) {
  try {
    const response = await fetch(RELAY_BOOTSTRAP_URL, {
      method: "GET",
      cache: "no-store",
      signal
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const settings =
      payload?.settings && typeof payload.settings === "object"
        ? payload.settings
        : payload;

    return normalizeSettings(settings);
  } catch {
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
  const contentType = response.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const json = await response.json();
      return json?.error?.message || JSON.stringify(json);
    }

    return await response.text();
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

function createRequestBody(settings, messages) {
  const payload = {
    model: settings.model.trim(),
    messages,
    temperature: Number(settings.temperature),
    stream: true
  };

  if (Number(settings.maxTokens) > 0) {
    payload.max_tokens = Number(settings.maxTokens);
  }

  return payload;
}

async function waitForLocalRelay(settings, signal) {
  if (
    settings.providerId !== "nvidia" ||
    !settings.baseUrl.includes("127.0.0.1:3888")
  ) {
    return;
  }

  const healthUrl = "http://127.0.0.1:3888/health";

  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (signal?.aborted) {
      return;
    }

    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        cache: "no-store",
        signal
      });

      if (response.ok) {
        return;
      }
    } catch {
      // Relay may still be starting.
    }

    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
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
  if (settings.baseUrl.includes("127.0.0.1:3888")) {
    return "本地 NVIDIA 转发服务不可用，请重新打开 WPS 后再试。";
  }

  return "WPS 任务窗格无法直接访问 NVIDIA 接口，请通过本地转发服务连接。";
}

function getNvidiaTimeoutError(settings) {
  const seconds = Math.max(
    1,
    Math.round(Number(settings.firstTokenTimeoutMs || 0) / 1000)
  );

  return `模型 ${settings.model.trim() || "deepseek-ai/deepseek-v3.1-terminus"} 在 ${seconds} 秒内没有返回首个有效输出。`;
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

export async function loadNvidiaModels({ apiKey, signal }) {
  await waitForLocalRelay(
    {
      providerId: "nvidia",
      baseUrl: PROVIDERS.nvidia.defaultBaseUrl
    },
    signal
  );

  const response = await fetch(RELAY_NVIDIA_MODELS_URL, {
    method: "GET",
    cache: "no-store",
    headers: createAuthorizationHeaders(apiKey),
    signal
  });

  if (!response.ok) {
    throw new Error(await buildError(response));
  }

  const payload = await response.json();
  return normalizeModelCatalog(payload?.data ?? payload?.models ?? []);
}

export async function* streamNvidiaModelBenchmarks({
  apiKey,
  models,
  signal,
  timeoutMs = 12000,
  concurrency = 6
}) {
  await waitForLocalRelay(
    {
      providerId: "nvidia",
      baseUrl: PROVIDERS.nvidia.defaultBaseUrl
    },
    signal
  );

  const response = await fetch(RELAY_NVIDIA_BENCHMARK_URL, {
    method: "POST",
    cache: "no-store",
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
  });

  if (!response.ok) {
    throw new Error(await buildError(response));
  }

  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      buffer += decoder.decode();
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const payload = parseSseEvent(part);
      if (payload) {
        yield payload;
      }
    }
  }

  if (!buffer.trim()) {
    return;
  }

  const payload = parseSseEvent(buffer);
  if (payload) {
    yield payload;
  }
}

export function buildMessages({ prompt, selectionText, settings }) {
  const trimmedSelectionText = trimSelectionContext(selectionText, settings);
  const selectionBlock =
    settings.useSelectionAsContext && trimmedSelectionText
      ? [
          "下面内容是当前 WPS 选区，请把它作为上下文理解，但不要机械重复。",
          "",
          "---- 选区开始 ----",
          trimmedSelectionText,
          "---- 选区结束 ----",
          ""
        ].join("\n")
      : "";

  return [
    {
      role: "system",
      content: settings.systemPrompt.trim()
    },
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

  if (settings.providerId === "openrouter") {
    headers["HTTP-Referer"] = settings.referer.trim() || "https://localhost";
    headers["X-Title"] = settings.title.trim() || "WPS AI";
  }

  let response;
  const requestController = createRequestController(signal);
  let timedOutBeforeFirstChunk = false;
  let firstChunkTimeoutId = null;

  if (settings.providerId === "nvidia") {
    firstChunkTimeoutId = window.setTimeout(() => {
      timedOutBeforeFirstChunk = true;
      requestController.abort();
    }, normalizeFirstTokenTimeout(settings.firstTokenTimeoutMs));
  }

  try {
    await waitForLocalRelay(settings, signal);
    response = await fetch(
      `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(createRequestBody(settings, messages)),
        signal: requestController.signal
      }
    );
  } catch (error) {
    if (firstChunkTimeoutId !== null) {
      window.clearTimeout(firstChunkTimeoutId);
    }

    if (timedOutBeforeFirstChunk && settings.providerId === "nvidia") {
      throw new Error(getNvidiaTimeoutError(settings));
    }

    if (settings.providerId === "nvidia") {
      throw new Error(getNvidiaConnectionError(settings));
    }

    throw error;
  }

  if (!response.ok) {
    throw new Error(await buildError(response));
  }

  if (!response.body) {
    if (firstChunkTimeoutId !== null) {
      window.clearTimeout(firstChunkTimeoutId);
    }

    const json = await response.json();
    const fallbackText = extractChunk(json);
    if (fallbackText) {
      yield fallbackText;
    }
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    if (firstChunkTimeoutId !== null) {
      window.clearTimeout(firstChunkTimeoutId);
    }

    const json = await response.json();
    const fallbackText = extractChunk(json);
    if (fallbackText) {
      yield fallbackText;
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedFirstChunk = false;

  while (true) {
    let result;

    try {
      result = await reader.read();
    } catch (error) {
      if (firstChunkTimeoutId !== null) {
        window.clearTimeout(firstChunkTimeoutId);
      }

      if (timedOutBeforeFirstChunk && settings.providerId === "nvidia") {
        throw new Error(getNvidiaTimeoutError(settings));
      }

      throw error;
    }

    const { value, done } = result;

    if (!receivedFirstChunk && (done || (value && value.length > 0))) {
      receivedFirstChunk = true;
      if (firstChunkTimeoutId !== null) {
        window.clearTimeout(firstChunkTimeoutId);
        firstChunkTimeoutId = null;
      }
    }

    if (done) {
      buffer += decoder.decode();
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const payload = parseSseEvent(part);
      const text = extractChunk(payload);
      if (text) {
        yield text;
      }
    }
  }

  if (!buffer.trim()) {
    return;
  }

  const payload = parseSseEvent(buffer);
  const text = extractChunk(payload);
  if (text) {
    yield text;
  }
}
