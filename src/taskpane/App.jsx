import {
  Clipboard,
  Eraser,
  Gauge,
  ScrollText,
  SendHorizontal,
  ServerCog,
  SlidersHorizontal,
  Square,
  Trash2,
  X
} from "lucide-react";
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
import {
  clearDebugLogs,
  formatDebugLogs,
  pushDebugLog,
  readDebugLogs,
  subscribeDebugLogs
} from "./debugLog";

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

const E2E_RICH_FORMAT_SAMPLE = [
  "# E2E Title",
  "",
  "This is the first body paragraph used to verify standard paper formatting, first-line indentation, left alignment, and comfortable line spacing.",
  "",
  "This is the second body paragraph used to confirm content is appended at the document end and that real-time paragraph formatting remains stable.",
  "",
  "## List Check",
  "",
  "- List item one",
  "- List item two",
  "",
  "## Code Block Check",
  "",
  "```js",
  "function sum(a, b) {",
  "  return a + b;",
  "}",
  "```",
  "",
  "## Formula Check",
  "",
  "$$",
  "E = mc^2",
  "$$",
  "",
  "## Table Check",
  "",
  "| Person | Role |",
  "| --- | --- |",
  "| Gattuso | Patriarch<br>Current: effective leader of the New Secret Party |",
  "| Vito | Elder |"
].join("\n");

function shouldRunWpsE2E() {
  if (!hasWpsDocument()) {
    return false;
  }

  try {
    const url = new URL(window.location.href);
    return url.searchParams.get("e2e") === "rich-format";
  } catch {
    return false;
  }
}

const ICONS = {
  settings: SlidersHorizontal,
  clear: Eraser,
  send: SendHorizontal,
  stop: Square,
  close: X,
  provider: ServerCog,
  flask: Gauge,
  logs: ScrollText,
  copy: Clipboard,
  trash: Trash2
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
  const [showLogs, setShowLogs] = useState(false);
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
  const [debugLogs, setDebugLogs] = useState(() => readDebugLogs());
  const [copyLogStatus, setCopyLogStatus] = useState("");

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
    return subscribeDebugLogs(setDebugLogs);
  }, []);

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
    if (!shouldRunWpsE2E()) {
      return;
    }

    const e2eKey = "wps_ai_e2e_rich_format_done";
    if (window.sessionStorage.getItem(e2eKey) === "1") {
      return;
    }

    const timerId = window.setTimeout(() => {
      try {
        const sink = createWpsMarkdownSink({ replaceSelection: false });
        sink.write(E2E_RICH_FORMAT_SAMPLE);
        sink.finish();
        window.sessionStorage.setItem(e2eKey, "1");
      } catch (e) {
        console.error("WPS E2E table test failed:", e);
      }
    }, 1200);

    return () => window.clearTimeout(timerId);
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
    if (!showSettings && !showModelLab && !showLogs) {
      return undefined;
    }

    function onKeyDown(event) {
      if (event.key === "Escape") {
        setShowSettings(false);
        setShowModelLab(false);
        setShowLogs(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showLogs, showModelLab, showSettings]);

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
    setShowLogs(false);
    setShowSettings(true);
  }

  function openModelLab() {
    setShowSettings(false);
    setShowLogs(false);
    setShowModelLab(true);
  }

  function openLogs() {
    setShowSettings(false);
    setShowModelLab(false);
    setShowLogs(true);
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
    const shouldFlushImmediately = !buffer.chunk || chunk.includes("\n");

    if (buffer.messageId && buffer.messageId !== messageId) {
      flushBufferedAssistantMessage(buffer.messageId);
      buffer.messageId = "";
    }

    buffer.messageId = messageId;
    buffer.chunk += chunk;

    if (shouldFlushImmediately) {
      flushBufferedAssistantMessage(messageId);
      return;
    }

    if (buffer.timerId !== null) {
      return;
    }

    buffer.timerId = window.setTimeout(() => {
      messageBufferRef.current.timerId = null;
      flushBufferedAssistantMessage(messageId);
    }, 8);
  }

  async function handleLoadModels() {
    if (!settings.apiKey.trim()) {
      setModelLabError("Enter the API key before loading NVIDIA models.");
      return;
    }

    setIsLoadingModels(true);
    setModelLabError("");

    try {
      const items = await loadNvidiaModels({
        apiKey: settings.apiKey,
        settings,
        signal: undefined
      });

      setModelCatalog((current) => {
        const currentMap = new Map(current.map((entry) => [entry.id, entry]));
        return items.map((item) => createModelEntry(item, currentMap.get(item.id)));
      });
    } catch (caught) {
      setModelLabError(
        caught instanceof Error ? caught.message : "Failed to load models."
      );
    } finally {
      setIsLoadingModels(false);
    }
  }

  async function handleBenchmarkModels() {
    if (!settings.apiKey.trim()) {
      setModelLabError("Enter the API key before running model benchmarks.");
      return;
    }

    let items = modelCatalog;
    if (items.length === 0) {
      setIsLoadingModels(true);
      try {
        const fetched = await loadNvidiaModels({
          apiKey: settings.apiKey,
          settings,
          signal: undefined
        });
        items = fetched.map((item) => createModelEntry(item));
        setModelCatalog(items);
      } catch (caught) {
        setModelLabError(
          caught instanceof Error ? caught.message : "Failed to load models."
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
        settings,
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
          caught instanceof Error ? caught.message : "Model benchmark failed."
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
      setError("Enter the API key first.");
      openSettings();
      return;
    }

    if (!settings.model.trim()) {
      setError("Enter the model name first.");
      openSettings();
      return;
    }

    if (!trimmedPrompt) {
      return;
    }

    setError("");
    setIsGenerating(true);
    pushDebugLog("info", "ui", "User submitted a generation request.", {
      promptLength: trimmedPrompt.length
    });

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
          settings,
          history: latestMessagesRef.current
        }),
        signal: controller.signal
      })) {
        aggregate += chunk;
        queueAssistantChunk(assistantMessageId, chunk);
        sink.write(chunk);
      }

      sink.finish();
      pushDebugLog("info", "wps", "WPS sink finished appending streamed content.", {
        chars: aggregate.length
      });
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
        pushDebugLog("warn", "ui", "Generation aborted by the user.");
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantMessageId
              ? { ...message, streaming: false }
              : message
          )
        );
      } else {
        const message = caught instanceof Error ? caught.message : "Generation failed.";
        setError(message);
        pushDebugLog("error", "ui", "Generation ended with an error.", {
          error: message
        });
        setMessages((current) =>
          current.map((entry) =>
            entry.id === assistantMessageId
              ? {
                  ...entry,
                  content: entry.content || "Request failed.",
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

  function clearLogs() {
    clearDebugLogs();
    setCopyLogStatus("");
  }

  async function copyLogs() {
    const content = formatDebugLogs(debugLogs);
    if (!content) {
      setCopyLogStatus("No logs to copy.");
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = content;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }

      setCopyLogStatus("Logs copied.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Copy failed.";
      setCopyLogStatus(message);
    }
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

  const latestDebugLog = debugLogs[debugLogs.length - 1] ?? null;
  const generatingStatus =
    isGenerating && latestDebugLog
      ? `${latestDebugLog.scope}: ${latestDebugLog.message}`
      : "";

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
                aria-label="Model Benchmarks"
                title="Model Benchmarks"
              >
                <Icon name="flask" />
              </button>
            ) : null}
            <button
              className="icon-button"
              type="button"
              onClick={openSettings}
              aria-label="Settings"
              title="Settings"
            >
              <Icon name="settings" />
            </button>
            <button
              className="icon-button quiet"
              type="button"
              onClick={clearConversation}
              disabled={isGenerating || messages.length === 0}
              aria-label="Clear Conversation"
              title="Clear Conversation"
            >
              <Icon name="clear" />
            </button>
            <button
              className="icon-button quiet"
              type="button"
              onClick={openLogs}
              aria-label="Logs"
              title="Logs"
            >
              <Icon name="logs" />
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
          {generatingStatus ? <div className="tiny-status">{generatingStatus}</div> : null}

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
                  aria-label="Stop Generation"
                  title="Stop Generation"
                >
                  <Icon name="stop" />
                </button>
              ) : null}
              <button
                className="icon-button primary"
                type="button"
                disabled={isGenerating || !prompt.trim()}
                onClick={() => void handleGenerate()}
                aria-label="Send"
                title="Send"
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
                aria-label="Close Settings"
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
                placeholder="API Key"
              />
              <input
                value={settings.model}
                onChange={(event) => updateSetting("model", event.target.value)}
                placeholder={placeholderModel(settings.providerId) || "Model Name"}
              />
              <input
                value={settings.baseUrl}
                onChange={(event) => updateSetting("baseUrl", event.target.value)}
                placeholder="Base URL"
              />
            </div>

            {settings.providerId === "nvidia" ? (
              <div className="utility-row">
                <div className="tiny-error">
                  {"Current mode: local relay. Network access is forwarded through the local 3888 relay."}
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={openModelLab}
                >
                  <Icon name="flask" />
                  <span>Model Benchmarks</span>
                </button>
              </div>
            ) : null}

            <details className="details-panel">
              <summary>Advanced Settings</summary>
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
                  placeholder="Temperature"
                />
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={settings.maxTokens}
                  onChange={(event) => updateSetting("maxTokens", event.target.value)}
                  placeholder="Max Output Length (Auto)"
                />
                <textarea
                  rows="4"
                  value={settings.systemPrompt}
                  onChange={(event) =>
                    updateSetting("systemPrompt", event.target.value)
                  }
                  placeholder="System Prompt"
                />
                <label className="toggle-item">
                  <span>Use Current Selection as Context</span>
                  <input
                    type="checkbox"
                    checked={settings.useSelectionAsContext}
                    onChange={(event) =>
                      updateSetting("useSelectionAsContext", event.target.checked)
                    }
                  />
                </label>
                <label className="toggle-item">
                  <span>Replace Current Selection Directly</span>
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
                      placeholder="Referrer"
                    />
                    <input
                      value={settings.title}
                      onChange={(event) => updateSetting("title", event.target.value)}
                      placeholder="Application Title"
                    />
                  </>
                ) : null}
              </div>
            </details>
          </section>
        </div>
      ) : null}
      {showLogs ? (
        <div className="modal-backdrop" onClick={() => setShowLogs(false)}>
          <section
            className="modal-card compact wide"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal-toolbar">
              <div className="modal-icons">
                <span className="icon-badge">
                  <Icon name="logs" />
                </span>
              </div>
              <button
                className="icon-button quiet"
                type="button"
                onClick={() => setShowLogs(false)}
                aria-label="Close Logs"
              >
                <Icon name="close" />
              </button>
            </header>

            <div className="log-toolbar">
              <button className="secondary-button" type="button" onClick={() => void copyLogs()}>
                <Icon name="copy" />
                <span>Copy Logs</span>
              </button>
              <button className="secondary-button" type="button" onClick={clearLogs}>
                <Icon name="trash" />
                <span>Clear Logs</span>
              </button>
            </div>

            {copyLogStatus ? <div className="tiny-status">{copyLogStatus}</div> : null}

            <div className="log-list">
              {debugLogs.length === 0 ? (
                <div className="log-empty">No logs yet.</div>
              ) : (
                [...debugLogs].reverse().map((entry) => (
                  <article
                    key={entry.id}
                    className={`log-entry ${entry.level === "error" ? "error" : ""}`}
                  >
                    <div className="log-meta">
                      <span>{entry.time}</span>
                      <span>{String(entry.level || "info").toUpperCase()}</span>
                      <span>{entry.scope}</span>
                    </div>
                    <div className="log-message">{entry.message}</div>
                    {entry.details && Object.keys(entry.details).length > 0 ? (
                      <pre className="log-details">
                        {JSON.stringify(entry.details, null, 2)}
                      </pre>
                    ) : null}
                  </article>
                ))
              )}
            </div>
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
                aria-label="Close Model Benchmarks"
              >
                <Icon name="close" />
              </button>
            </header>

            <div className="lab-toolbar">
              <input
                className="model-search-input"
                value={modelSearch}
                onChange={(event) => setModelSearch(event.target.value)}
                placeholder="Search Models"
              />

              <div className="lab-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void handleLoadModels()}
                  disabled={isLoadingModels || isBenchmarkingModels}
                >
                  <span>{isLoadingModels ? "Loading..." : "Refresh Models"}</span>
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
                      ? `Stop Benchmark ${benchmarkProgress.completed}/${benchmarkProgress.total}`
                      : "Start Benchmark"}
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
                      <span>{settings.model === entry.id ? "Current" : "Use"}</span>
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
