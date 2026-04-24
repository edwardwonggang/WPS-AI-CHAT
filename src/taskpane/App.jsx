import { Eraser, Gauge, SendHorizontal, ServerCog, SlidersHorizontal, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  PROVIDERS,
  buildMessages,
  loadBootstrapSettings,
  loadNvidiaModels,
  normalizeSettings,
  streamCompletion,
  streamNvidiaModelBenchmarks
} from "./ai";
import StreamingMarkdown from "./StreamingMarkdown";
import {
  applyBenchmarkResult,
  benchmarkClassName,
  benchmarkLabel,
  benchmarkStatusText,
  compareModelEntries,
  createModelEntry,
  normalizeModelCatalogState
} from "./modelCatalog";
import {
  MODEL_CATALOG_KEY,
  PROMPT_KEY,
  SETTINGS_KEY,
  loadStoredValue,
  saveStoredValue
} from "./storage";
import {
  createWpsMarkdownSink,
  hasWpsDocument,
  readDocumentInfo,
  readSelectionText
} from "./wps";
import {
  deleteDocumentSession,
  loadDocumentSession,
  saveDocumentSession
} from "./sessionStore";

function createMessageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function placeholderModel(providerId) {
  return PROVIDERS[providerId]?.placeholderModel ?? "";
}

function mergeBootstrapSettings(current, bootstrap) {
  const normalizedCurrent = normalizeSettings(current);
  const normalizedBootstrap = normalizeSettings(bootstrap);

  return normalizeSettings({
    ...normalizedCurrent,
    apiKey: normalizedCurrent.apiKey || normalizedBootstrap.apiKey,
    model: normalizedCurrent.model || normalizedBootstrap.model,
    baseUrl: normalizedCurrent.baseUrl || normalizedBootstrap.baseUrl,
    firstTokenTimeoutMs:
      normalizedCurrent.firstTokenTimeoutMs || normalizedBootstrap.firstTokenTimeoutMs
  });
}

function modelEntryTitle(entry) {
  const lines = [entry.id, entry.ownedBy || "nvidia", benchmarkLabel(entry)];

  if (entry.benchmark?.message) {
    lines.push(entry.benchmark.message);
  }

  return lines.join("\n");
}

const ICONS = {
  settings: SlidersHorizontal,
  clear: Eraser,
  send: SendHorizontal,
  stop: Square,
  close: X,
  provider: ServerCog,
  flask: Gauge
};

function Icon({ name }) {
  const Component = ICONS[name];
  return Component ? <Component size={17} strokeWidth={1.85} /> : null;
}

export default function App() {
  const [settings, setSettings] = useState(() =>
    normalizeSettings(loadStoredValue(SETTINGS_KEY, DEFAULT_SETTINGS))
  );
  const [prompt, setPrompt] = useState(() => loadStoredValue(PROMPT_KEY, ""));
  const [documentInfo, setDocumentInfo] = useState(() => readDocumentInfo());
  const [selectionText, setSelectionText] = useState("");
  const [error, setError] = useState("");
  const [messages, setMessages] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showModelLab, setShowModelLab] = useState(false);
  const [modelCatalog, setModelCatalog] = useState(() =>
    normalizeModelCatalogState(loadStoredValue(MODEL_CATALOG_KEY, []))
  );
  const [modelSearch, setModelSearch] = useState("");
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isBenchmarkingModels, setIsBenchmarkingModels] = useState(false);
  const [modelLabError, setModelLabError] = useState("");
  const [benchmarkProgress, setBenchmarkProgress] = useState({
    completed: 0,
    total: 0
  });

  const abortRef = useRef(null);
  const benchmarkAbortRef = useRef(null);
  const promptRef = useRef(null);
  const threadRef = useRef(null);
  const shouldStickToBottomRef = useRef(true);
  const liveSinkRef = useRef(null);
  const activeDocumentRef = useRef(readDocumentInfo());
  const isGeneratingRef = useRef(false);
  const latestMessagesRef = useRef([]);
  const messageBufferRef = useRef({
    chunk: "",
    messageId: "",
    timerId: null
  });
  const sessionLoadRef = useRef({
    busy: false,
    token: 0
  });
  const sessionSaveTimerRef = useRef(null);

  useEffect(() => {
    saveStoredValue(SETTINGS_KEY, settings);
  }, [settings]);

  useEffect(() => {
    saveStoredValue(PROMPT_KEY, prompt);
  }, [prompt]);

  useEffect(() => {
    saveStoredValue(MODEL_CATALOG_KEY, modelCatalog);
  }, [modelCatalog]);

  useEffect(() => {
    latestMessagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    isGeneratingRef.current = isGenerating;
  }, [isGenerating]);

  useEffect(() => {
    if (hasWpsDocument()) {
      setSelectionText(readSelectionText());
    }
  }, []);

  useEffect(() => {
    function refreshDocumentInfo() {
      if (isGeneratingRef.current) {
        return;
      }

      const next = readDocumentInfo();

      setDocumentInfo((current) => {
        const currentKey = current?.key ?? "";
        const nextKey = next?.key ?? "";
        const currentTitle = current?.title ?? "";
        const nextTitle = next?.title ?? "";

        if (currentKey === nextKey && currentTitle === nextTitle) {
          return current;
        }

        return next;
      });
    }

    refreshDocumentInfo();
    const timerId = window.setInterval(refreshDocumentInfo, 1500);
    return () => window.clearInterval(timerId);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void loadBootstrapSettings(controller.signal).then((bootstrapSettings) => {
      if (!bootstrapSettings) {
        return;
      }

      setSettings((current) => mergeBootstrapSettings(current, bootstrapSettings));
    });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [prompt]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread || !shouldStickToBottomRef.current) {
      return;
    }

    thread.scrollTop = thread.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!showSettings && !showModelLab) {
      return undefined;
    }

    function onKeyDown(event) {
      if (event.key === "Escape") {
        setShowSettings(false);
        setShowModelLab(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showModelLab, showSettings]);

  useEffect(() => {
    if (
      !showModelLab ||
      settings.providerId !== "nvidia" ||
      isLoadingModels ||
      isBenchmarkingModels
    ) {
      return;
    }

    if (modelCatalog.length === 0) {
      void handleLoadModels();
      return;
    }

    const hasBenchmarkedModels = modelCatalog.some(
      (entry) => entry.benchmark?.status && entry.benchmark.status !== "untested"
    );

    if (!hasBenchmarkedModels) {
      void handleBenchmarkModels();
    }
  }, [
    isBenchmarkingModels,
    isLoadingModels,
    modelCatalog,
    showModelLab,
    settings.providerId
  ]);

  useEffect(() => {
    const nextDocument = documentInfo;
    const nextKey = nextDocument?.key ?? "";
    const previousDocument = activeDocumentRef.current;
    const previousMessages = latestMessagesRef.current;

    if (!nextKey) {
      if (previousDocument?.key && previousMessages.length > 0) {
        void saveDocumentSession(previousDocument, previousMessages).catch(() => {});
      }

      activeDocumentRef.current = nextDocument;
      setMessages([]);
      return undefined;
    }

    activeDocumentRef.current = nextDocument;
    sessionLoadRef.current.busy = true;
    sessionLoadRef.current.token += 1;
    const loadToken = sessionLoadRef.current.token;

    if (
      previousDocument?.key &&
      previousDocument.key !== nextKey &&
      previousMessages.length > 0
    ) {
      void saveDocumentSession(previousDocument, previousMessages).catch(() => {});
    }

    let disposed = false;

    void loadDocumentSession(nextDocument)
      .then((session) => {
        if (
          disposed ||
          loadToken !== sessionLoadRef.current.token ||
          activeDocumentRef.current?.key !== nextKey
        ) {
          return;
        }

        const shouldCarryForward =
          previousDocument &&
          previousDocument.key !== nextKey &&
          !previousDocument.isSaved &&
          nextDocument.isSaved &&
          previousDocument.title === nextDocument.title &&
          previousMessages.length > 0 &&
          !session.exists;

        const nextMessages = shouldCarryForward ? previousMessages : session.messages;

        setMessages(nextMessages);
        setSelectionText(readSelectionText());
        setError("");
        liveSinkRef.current = null;

        if (shouldCarryForward) {
          void saveDocumentSession(nextDocument, previousMessages).catch(() => {});
          void deleteDocumentSession(previousDocument).catch(() => {});
        }
      })
      .catch(() => {
        if (
          disposed ||
          loadToken !== sessionLoadRef.current.token ||
          activeDocumentRef.current?.key !== nextKey
        ) {
          return;
        }

        setMessages([]);
      })
      .finally(() => {
        if (!disposed && loadToken === sessionLoadRef.current.token) {
          sessionLoadRef.current.busy = false;
        }
      });

    return () => {
      disposed = true;
    };
  }, [documentInfo]);

  useEffect(() => {
    if (sessionSaveTimerRef.current !== null) {
      window.clearTimeout(sessionSaveTimerRef.current);
      sessionSaveTimerRef.current = null;
    }

    if (!documentInfo?.key || sessionLoadRef.current.busy || isGenerating) {
      return undefined;
    }

    if (messages.length === 0) {
      return undefined;
    }

    sessionSaveTimerRef.current = window.setTimeout(() => {
      sessionSaveTimerRef.current = null;
      void saveDocumentSession(documentInfo, latestMessagesRef.current).catch(() => {});
    }, 700);

    return () => {
      if (sessionSaveTimerRef.current !== null) {
        window.clearTimeout(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = null;
      }
    };
  }, [documentInfo, isGenerating, messages]);

  useEffect(() => {
    return () => {
      if (sessionSaveTimerRef.current !== null) {
        window.clearTimeout(sessionSaveTimerRef.current);
      }

      if (activeDocumentRef.current?.key && latestMessagesRef.current.length > 0) {
        void saveDocumentSession(
          activeDocumentRef.current,
          latestMessagesRef.current
        ).catch(() => {});
      }

      if (messageBufferRef.current.timerId !== null) {
        window.clearTimeout(messageBufferRef.current.timerId);
      }
      abortRef.current?.abort();
      benchmarkAbortRef.current?.abort();
      liveSinkRef.current?.sink?.cancel?.();
    };
  }, []);

  function updateSetting(key, value) {
    setSettings((current) => normalizeSettings({ ...current, [key]: value }));
  }

  function openSettings() {
    setShowModelLab(false);
    setShowSettings(true);
  }

  function openModelLab() {
    setShowSettings(false);
    setShowModelLab(true);
  }

  function switchProvider(providerId) {
    setSettings((current) =>
      normalizeSettings({
        ...current,
        providerId,
        baseUrl: PROVIDERS[providerId].defaultBaseUrl
      })
    );
  }

  function handleThreadScroll() {
    const thread = threadRef.current;
    if (!thread) {
      return;
    }

    const distanceToBottom =
      thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    shouldStickToBottomRef.current = distanceToBottom < 40;
  }

  function stopGeneration() {
    abortRef.current?.abort();
  }

  function stopBenchmarking() {
    benchmarkAbortRef.current?.abort();
  }

  function flushBufferedAssistantMessage(targetMessageId = "") {
    const buffer = messageBufferRef.current;
    const messageId = targetMessageId || buffer.messageId;

    if (!buffer.chunk || !messageId) {
      if (!targetMessageId) {
        buffer.messageId = "";
      }
      return;
    }

    if (buffer.timerId !== null) {
      window.clearTimeout(buffer.timerId);
      buffer.timerId = null;
    }

    const chunk = buffer.chunk;
    buffer.chunk = "";
    if (!targetMessageId) {
      buffer.messageId = "";
    }

    setMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? {
              ...message,
              content: `${message.content}${chunk}`,
              streaming: true
            }
          : message
      )
    );
  }

  function queueAssistantChunk(messageId, chunk) {
    const buffer = messageBufferRef.current;

    if (buffer.messageId && buffer.messageId !== messageId) {
      flushBufferedAssistantMessage(buffer.messageId);
      buffer.messageId = "";
    }

    buffer.messageId = messageId;
    buffer.chunk += chunk;

    if (buffer.timerId !== null) {
      return;
    }

    buffer.timerId = window.setTimeout(() => {
      messageBufferRef.current.timerId = null;
      flushBufferedAssistantMessage(messageId);
    }, 16);
  }

  async function handleLoadModels() {
    if (!settings.apiKey.trim()) {
      setModelLabError("请先填写 API 密钥，再加载 NVIDIA 模型。");
      return;
    }

    setIsLoadingModels(true);
    setModelLabError("");

    try {
      const items = await loadNvidiaModels({
        apiKey: settings.apiKey,
        signal: undefined
      });

      setModelCatalog((current) => {
        const currentMap = new Map(current.map((entry) => [entry.id, entry]));
        return items.map((item) => createModelEntry(item, currentMap.get(item.id)));
      });
    } catch (caught) {
      setModelLabError(
        caught instanceof Error ? caught.message : "加载模型失败。"
      );
    } finally {
      setIsLoadingModels(false);
    }
  }

  async function handleBenchmarkModels() {
    if (!settings.apiKey.trim()) {
      setModelLabError("请先填写 API 密钥，再执行模型测速。");
      return;
    }

    let items = modelCatalog;
    if (items.length === 0) {
      setIsLoadingModels(true);
      try {
        const fetched = await loadNvidiaModels({
          apiKey: settings.apiKey,
          signal: undefined
        });
        items = fetched.map((item) => createModelEntry(item));
        setModelCatalog(items);
      } catch (caught) {
        setModelLabError(
          caught instanceof Error ? caught.message : "加载模型失败。"
        );
        setIsLoadingModels(false);
        return;
      }
      setIsLoadingModels(false);
    }

    const controller = new AbortController();
    benchmarkAbortRef.current = controller;
    setIsBenchmarkingModels(true);
    setModelLabError("");
    setBenchmarkProgress({
      completed: 0,
      total: items.length
    });

    try {
      for await (const event of streamNvidiaModelBenchmarks({
        apiKey: settings.apiKey,
        models: items.map((entry) => entry.id),
        timeoutMs: 20000,
        concurrency: 6,
        signal: controller.signal
      })) {
        if (event.type === "start") {
          setBenchmarkProgress({
            completed: 0,
            total: Number(event.total) || items.length
          });
          continue;
        }

        if (event.type === "result" && event.result) {
          setBenchmarkProgress({
            completed: Number(event.completed) || 0,
            total: Number(event.total) || items.length
          });
          setModelCatalog((current) => applyBenchmarkResult(current, event.result));
          continue;
        }

        if (event.type === "done") {
          setBenchmarkProgress({
            completed: Number(event.completed) || items.length,
            total: Number(event.total) || items.length
          });
        }
      }
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setModelLabError(
          caught instanceof Error ? caught.message : "模型测速失败。"
        );
      }
    } finally {
      benchmarkAbortRef.current = null;
      setIsBenchmarkingModels(false);
    }
  }

  function applyModel(modelId) {
    updateSetting("model", modelId);
    setShowModelLab(false);
    setModelSearch("");
  }

  async function handleGenerate() {
    const trimmedPrompt = prompt.trim();
    if (!settings.apiKey.trim()) {
      setError("请先填写 API 密钥。");
      openSettings();
      return;
    }

    if (!settings.model.trim()) {
      setError("请先填写模型名称。");
      openSettings();
      return;
    }

    if (!trimmedPrompt) {
      return;
    }

    setError("");
    setIsGenerating(true);

    let latestSelectionText = selectionText;
    if (settings.useSelectionAsContext) {
      latestSelectionText = readSelectionText();
      setSelectionText(latestSelectionText);
    }

    const controller = new AbortController();
    const userMessageId = createMessageId();
    const assistantMessageId = createMessageId();
    const sink = createWpsMarkdownSink({
      replaceSelection: settings.replaceSelection
    });

    abortRef.current = controller;
    liveSinkRef.current = {
      messageId: assistantMessageId,
      sink
    };
    shouldStickToBottomRef.current = true;

    setMessages((current) => [
      ...current,
      { id: userMessageId, role: "user", content: trimmedPrompt },
      { id: assistantMessageId, role: "assistant", content: "", streaming: true }
    ]);

    try {
      let aggregate = "";

      for await (const chunk of streamCompletion({
        settings,
        messages: buildMessages({
          prompt: trimmedPrompt,
          selectionText: latestSelectionText,
          settings
        }),
        signal: controller.signal
      })) {
        aggregate += chunk;
        queueAssistantChunk(assistantMessageId, chunk);
      }

      flushBufferedAssistantMessage(assistantMessageId);
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantMessageId
            ? { ...message, content: aggregate, streaming: false }
            : message
        )
      );
      setPrompt("");
    } catch (caught) {
      const aborted =
        caught instanceof DOMException && caught.name === "AbortError";

      flushBufferedAssistantMessage(assistantMessageId);

      if (aborted) {
        sink.cancel();
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantMessageId
              ? { ...message, streaming: false }
              : message
          )
        );
      } else {
        const message = caught instanceof Error ? caught.message : "生成失败。";
        setError(message);
        setMessages((current) =>
          current.map((entry) =>
            entry.id === assistantMessageId
              ? {
                  ...entry,
                  content: entry.content || "请求失败。",
                  streaming: false,
                  error: true
                }
              : entry
          )
        );
      }
    } finally {
      const buffer = messageBufferRef.current;
      if (buffer.messageId === assistantMessageId) {
        buffer.chunk = "";
        buffer.messageId = "";
        if (buffer.timerId !== null) {
          window.clearTimeout(buffer.timerId);
          buffer.timerId = null;
        }
      }

      abortRef.current = null;
      setIsGenerating(false);
    }
  }

  function handlePromptKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!isGenerating) {
        void handleGenerate();
      }
    }
  }

  function clearConversation() {
    if (isGenerating) {
      return;
    }

    if (documentInfo?.key) {
      void deleteDocumentSession(documentInfo).catch(() => {});
    }

    setMessages([]);
    setError("");
    liveSinkRef.current = null;
  }

  const visibleModelCatalog = [...modelCatalog]
    .sort((left, right) => compareModelEntries(left, right, settings.model))
    .filter((entry) => {
      const query = modelSearch.trim().toLowerCase();
      if (!query) {
        return true;
      }

      const haystack = `${entry.id} ${entry.ownedBy}`.toLowerCase();
      return haystack.includes(query);
    });

  return (
    <>
      <main className="minimal-shell">
        <header className="minimal-toolbar">
          <div className="toolbar-group">
            {settings.providerId === "nvidia" ? (
              <button
                className="icon-button"
                type="button"
                onClick={openModelLab}
                aria-label="模型测速"
                title="模型测速"
              >
                <Icon name="flask" />
              </button>
            ) : null}
            <button
              className="icon-button"
              type="button"
              onClick={openSettings}
              aria-label="设置"
              title="设置"
            >
              <Icon name="settings" />
            </button>
            <button
              className="icon-button quiet"
              type="button"
              onClick={clearConversation}
              disabled={isGenerating || messages.length === 0}
              aria-label="清理会话"
              title="清理会话"
            >
              <Icon name="clear" />
            </button>
          </div>
        </header>

        <section className="minimal-thread">
          <div
            ref={threadRef}
            className="message-list"
            onScroll={handleThreadScroll}
          >
            {messages.map((message) => (
              <article
                key={message.id}
                className={`bubble-row ${message.role === "user" ? "user" : "assistant"}`}
              >
                <div className={`bubble ${message.error ? "error" : ""}`}>
                  {message.role === "assistant" && !message.error ? (
                    <StreamingMarkdown
                      content={message.content}
                      streaming={message.streaming}
                      sink={
                        liveSinkRef.current?.messageId === message.id
                          ? liveSinkRef.current.sink
                          : null
                      }
                    />
                  ) : (
                    <div className="bubble-plain">
                      {message.content || (message.streaming ? "..." : "")}
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>

        <footer className="minimal-composer">
          {error ? <div className="tiny-error">{error}</div> : null}

          <div className="composer-card">
            <textarea
              ref={promptRef}
              value={prompt}
              rows="1"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handlePromptKeyDown}
              placeholder=""
            />

            <div className="composer-actions">
              {isGenerating ? (
                <button
                  className="icon-button ghost"
                  type="button"
                  onClick={stopGeneration}
                  aria-label="停止生成"
                  title="停止生成"
                >
                  <Icon name="stop" />
                </button>
              ) : null}
              <button
                className="icon-button primary"
                type="button"
                disabled={isGenerating || !prompt.trim()}
                onClick={() => void handleGenerate()}
                aria-label="发送"
                title="发送"
              >
                <Icon name="send" />
              </button>
            </div>
          </div>
        </footer>
      </main>

      {showSettings ? (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <section
            className="modal-card compact"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal-toolbar">
              <div className="modal-icons">
                <span className="icon-badge">
                  <Icon name="provider" />
                </span>
              </div>
              <button
                className="icon-button quiet"
                type="button"
                onClick={() => setShowSettings(false)}
                aria-label="关闭设置"
              >
                <Icon name="close" />
              </button>
            </header>

            <div className="provider-switch">
              {Object.values(PROVIDERS).map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className={`provider-chip ${
                    settings.providerId === provider.id ? "active" : ""
                  }`}
                  onClick={() => switchProvider(provider.id)}
                >
                  {provider.label}
                </button>
              ))}
            </div>

            <div className="field-grid">
              <input
                type="password"
                value={settings.apiKey}
                onChange={(event) => updateSetting("apiKey", event.target.value)}
                placeholder="API 密钥"
              />
              <input
                value={settings.model}
                onChange={(event) => updateSetting("model", event.target.value)}
                placeholder={placeholderModel(settings.providerId) || "模型名称"}
              />
              <input
                value={settings.baseUrl}
                onChange={(event) => updateSetting("baseUrl", event.target.value)}
                placeholder="接口地址"
              />
            </div>

            {settings.providerId === "nvidia" ? (
              <div className="utility-row">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={openModelLab}
                >
                  <Icon name="flask" />
                  <span>模型测速</span>
                </button>
              </div>
            ) : null}

            <details className="details-panel">
              <summary>高级设置</summary>
              <div className="field-grid advanced">
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={settings.temperature}
                  onChange={(event) =>
                    updateSetting("temperature", Number(event.target.value || 0))
                  }
                  placeholder="温度"
                />
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={settings.maxTokens}
                  onChange={(event) => updateSetting("maxTokens", event.target.value)}
                  placeholder="最大输出长度（自动）"
                />
                <textarea
                  rows="4"
                  value={settings.systemPrompt}
                  onChange={(event) =>
                    updateSetting("systemPrompt", event.target.value)
                  }
                  placeholder="系统提示词"
                />
                <label className="toggle-item">
                  <span>使用当前选区作为上下文</span>
                  <input
                    type="checkbox"
                    checked={settings.useSelectionAsContext}
                    onChange={(event) =>
                      updateSetting("useSelectionAsContext", event.target.checked)
                    }
                  />
                </label>
                <label className="toggle-item">
                  <span>直接替换当前选区</span>
                  <input
                    type="checkbox"
                    checked={settings.replaceSelection}
                    onChange={(event) =>
                      updateSetting("replaceSelection", event.target.checked)
                    }
                  />
                </label>
                {settings.providerId === "openrouter" ? (
                  <>
                    <input
                      value={settings.referer}
                      onChange={(event) => updateSetting("referer", event.target.value)}
                      placeholder="来源站点"
                    />
                    <input
                      value={settings.title}
                      onChange={(event) => updateSetting("title", event.target.value)}
                      placeholder="应用名称"
                    />
                  </>
                ) : null}
              </div>
            </details>
          </section>
        </div>
      ) : null}
      {showModelLab ? (
        <div className="modal-backdrop" onClick={() => setShowModelLab(false)}>
          <section
            className="modal-card compact wide"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal-toolbar">
              <div className="modal-icons">
                <span className="icon-badge">
                  <Icon name="flask" />
                </span>
              </div>
              <button
                className="icon-button quiet"
                type="button"
                onClick={() => setShowModelLab(false)}
                aria-label="关闭模型测速"
              >
                <Icon name="close" />
              </button>
            </header>

            <div className="lab-toolbar">
              <input
                className="model-search-input"
                value={modelSearch}
                onChange={(event) => setModelSearch(event.target.value)}
                placeholder="搜索模型"
              />

              <div className="lab-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void handleLoadModels()}
                  disabled={isLoadingModels || isBenchmarkingModels}
                >
                  <span>{isLoadingModels ? "加载中..." : "刷新模型"}</span>
                </button>

                <button
                  className="secondary-button"
                  type="button"
                  onClick={() =>
                    isBenchmarkingModels
                      ? stopBenchmarking()
                      : void handleBenchmarkModels()
                  }
                  disabled={isLoadingModels || modelCatalog.length === 0}
                >
                  <span>
                    {isBenchmarkingModels
                      ? `停止测速 ${benchmarkProgress.completed}/${benchmarkProgress.total}`
                      : "开始测速"}
                  </span>
                </button>
              </div>
            </div>

            {modelLabError ? <div className="tiny-error">{modelLabError}</div> : null}

            <div className="model-list">
              {visibleModelCatalog.map((entry) => (
                <article
                  key={entry.id}
                  className={`model-row ${settings.model === entry.id ? "active" : ""}`}
                  title={modelEntryTitle(entry)}
                >
                  <div className="model-name">{entry.id}</div>

                  <div className="model-actions">
                    <span
                      className={`${benchmarkClassName(entry)} compact`}
                      title={benchmarkLabel(entry)}
                    >
                      {benchmarkStatusText(entry)}
                    </span>
                    <button
                      className={`secondary-button slim model-use-button ${
                        settings.model === entry.id ? "active" : ""
                      }`}
                      type="button"
                      onClick={() => applyModel(entry.id)}
                    >
                      <span>{settings.model === entry.id ? "当前" : "使用"}</span>
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
