import {
  Clipboard,
  Eraser,
  Gauge,
  KeyRound,
  Link as LinkIcon,
  RefreshCw,
  ScrollText,
  SendHorizontal,
  ServerCog,
  Settings as SettingsIcon,
  Square,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  PROVIDERS,
  buildMessages,
  getActiveProviderRecord,
  loadBootstrapSettings,
  loadProviderModels,
  normalizeSettings,
  streamCompletion,
  streamModelBenchmarks
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

/**
 * Merge bootstrap settings from the relay into existing local settings. Local
 * settings always win; bootstrap only fills gaps.
 */
function mergeBootstrapSettings(current, bootstrap) {
  const normalizedCurrent = normalizeSettings(current);
  const normalizedBootstrap = normalizeSettings(bootstrap);

  const mergedProviders = {};
  for (const providerId of Object.keys(PROVIDERS)) {
    const currentRecord = normalizedCurrent.providers[providerId] || {};
    const bootstrapRecord = normalizedBootstrap.providers[providerId] || {};
    mergedProviders[providerId] = {
      baseUrl: currentRecord.baseUrl || bootstrapRecord.baseUrl,
      apiKey: currentRecord.apiKey || bootstrapRecord.apiKey,
      model: currentRecord.model || bootstrapRecord.model
    };
  }

  return normalizeSettings({
    ...normalizedCurrent,
    providers: mergedProviders,
    proxyUrl: normalizedCurrent.proxyUrl || normalizedBootstrap.proxyUrl,
    firstTokenTimeoutMs:
      normalizedCurrent.firstTokenTimeoutMs ||
      normalizedBootstrap.firstTokenTimeoutMs
  });
}

const TEST_COMMAND_BASE_URL = "http://127.0.0.1:3888/test-command";
const TEST_AUTOMATION_POLL_MS = 900;

function normalizeVisibleDelayMs(value) {
  return Math.min(8000, Math.max(600, Number(value) || 1800));
}

async function postTestCommandJson(path, payload) {
  try {
    const response = await fetch(`${TEST_COMMAND_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function acknowledgeTestCommand(id, stage, document, detail = {}) {
  if (!id) return;
  void postTestCommandJson("/ack", { id, stage, document, detail });
}

function modelEntryTitle(entry) {
  const lines = [entry.id, entry.ownedBy || "", benchmarkLabel(entry)];
  if (entry.benchmark?.message) lines.push(entry.benchmark.message);
  return lines.filter(Boolean).join("\n");
}

const ICONS = {
  settings: SettingsIcon,
  clear: Eraser,
  send: SendHorizontal,
  stop: Square,
  close: X,
  provider: ServerCog,
  flask: Gauge,
  logs: ScrollText,
  copy: Clipboard,
  trash: Trash2,
  key: KeyRound,
  link: LinkIcon,
  refresh: RefreshCw
};

function Icon({ name, size = 17 }) {
  const Component = ICONS[name];
  return Component ? <Component size={size} strokeWidth={1.85} /> : null;
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
  const [settingsTab, setSettingsTab] = useState(() => settings.activeProvider);
  const [modelCatalogsByProvider, setModelCatalogsByProvider] = useState(() => {
    const legacy = loadStoredValue(MODEL_CATALOG_KEY, null);
    if (Array.isArray(legacy)) {
      return { nvidia: normalizeModelCatalogState(legacy), openrouter: [] };
    }
    if (legacy && typeof legacy === "object") {
      return {
        nvidia: normalizeModelCatalogState(legacy.nvidia),
        openrouter: normalizeModelCatalogState(legacy.openrouter)
      };
    }
    return { nvidia: [], openrouter: [] };
  });
  const [modelLabProvider, setModelLabProvider] = useState(
    () => settings.activeProvider
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
  const handleGenerateRef = useRef(null);
  const latestMessagesRef = useRef([]);
  const messageBufferRef = useRef({ chunk: "", messageId: "", timerId: null });
  const sessionLoadRef = useRef({ busy: false, token: 0 });
  const sessionSaveTimerRef = useRef(null);

  const activeProviderRecord = getActiveProviderRecord(settings);
  const currentCatalog =
    modelCatalogsByProvider[modelLabProvider] || [];

  useEffect(() => {
    saveStoredValue(SETTINGS_KEY, settings);
  }, [settings]);

  useEffect(() => {
    saveStoredValue(PROMPT_KEY, prompt);
  }, [prompt]);

  useEffect(() => {
    saveStoredValue(MODEL_CATALOG_KEY, modelCatalogsByProvider);
  }, [modelCatalogsByProvider]);

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
    function refreshDocumentInfo() {
      if (isGeneratingRef.current) return;
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
      if (!bootstrapSettings) return;
      setSettings((current) =>
        mergeBootstrapSettings(current, bootstrapSettings)
      );
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [prompt]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread || !shouldStickToBottomRef.current) return;
    thread.scrollTop = thread.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!showSettings && !showModelLab && !showLogs) return undefined;
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

  // Session load/save effects (unchanged from original)
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

        const nextMessages = shouldCarryForward
          ? previousMessages
          : session.messages;

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
    if (messages.length === 0) return undefined;

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

  // -------- Settings mutation helpers --------
  function updateSetting(key, value) {
    setSettings((current) => normalizeSettings({ ...current, [key]: value }));
  }

  function updateProviderSetting(providerId, key, value) {
    setSettings((current) =>
      normalizeSettings({
        ...current,
        providers: {
          ...current.providers,
          [providerId]: {
            ...(current.providers?.[providerId] || {}),
            [key]: value
          }
        }
      })
    );
  }

  function selectActiveProvider(providerId) {
    setSettings((current) =>
      normalizeSettings({ ...current, activeProvider: providerId })
    );
  }

  function openSettings() {
    setShowModelLab(false);
    setShowLogs(false);
    setSettingsTab(settings.activeProvider);
    setShowSettings(true);
  }

  function openModelLab(providerId) {
    setShowSettings(false);
    setShowLogs(false);
    setModelLabProvider(providerId || settings.activeProvider);
    setShowModelLab(true);
  }

  function openLogs() {
    setShowSettings(false);
    setShowModelLab(false);
    setShowLogs(true);
  }

  function handleThreadScroll() {
    const thread = threadRef.current;
    if (!thread) return;
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
      if (!targetMessageId) buffer.messageId = "";
      return;
    }
    if (buffer.timerId !== null) {
      window.clearTimeout(buffer.timerId);
      buffer.timerId = null;
    }
    const chunk = buffer.chunk;
    buffer.chunk = "";
    if (!targetMessageId) buffer.messageId = "";
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? { ...message, content: `${message.content}${chunk}`, streaming: true }
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
    if (buffer.timerId !== null) return;
    buffer.timerId = window.setTimeout(() => {
      messageBufferRef.current.timerId = null;
      flushBufferedAssistantMessage(messageId);
    }, 8);
  }

  // -------- Model loading / benchmarking --------
  async function handleLoadModels(targetProviderId = modelLabProvider) {
    const provider = settings.providers[targetProviderId];
    if (!provider?.apiKey?.trim()) {
      setModelLabError(
        `Enter the ${PROVIDERS[targetProviderId].label} API key before loading models.`
      );
      return;
    }

    setIsLoadingModels(true);
    setModelLabError("");

    try {
      const items = await loadProviderModels({
        settings,
        providerId: targetProviderId,
        signal: undefined
      });

      setModelCatalogsByProvider((current) => {
        const existing = current[targetProviderId] || [];
        const previousMap = new Map(existing.map((entry) => [entry.id, entry]));
        return {
          ...current,
          [targetProviderId]: items.map((item) =>
            createModelEntry(item, previousMap.get(item.id))
          )
        };
      });
    } catch (caught) {
      setModelLabError(
        caught instanceof Error ? caught.message : "Failed to load models."
      );
    } finally {
      setIsLoadingModels(false);
    }
  }

  async function handleBenchmarkModels(targetProviderId = modelLabProvider) {
    const provider = settings.providers[targetProviderId];
    if (!provider?.apiKey?.trim()) {
      setModelLabError(
        `Enter the ${PROVIDERS[targetProviderId].label} API key before running benchmarks.`
      );
      return;
    }

    let items = modelCatalogsByProvider[targetProviderId] || [];
    if (items.length === 0) {
      setIsLoadingModels(true);
      try {
        const fetched = await loadProviderModels({
          settings,
          providerId: targetProviderId,
          signal: undefined
        });
        items = fetched.map((item) => createModelEntry(item));
        setModelCatalogsByProvider((current) => ({
          ...current,
          [targetProviderId]: items
        }));
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
    setBenchmarkProgress({ completed: 0, total: items.length });

    try {
      for await (const event of streamModelBenchmarks({
        settings,
        providerId: targetProviderId,
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
          setModelCatalogsByProvider((current) => ({
            ...current,
            [targetProviderId]: applyBenchmarkResult(
              current[targetProviderId] || [],
              event.result
            )
          }));
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
    updateProviderSetting(modelLabProvider, "model", modelId);
    if (modelLabProvider !== settings.activeProvider) {
      selectActiveProvider(modelLabProvider);
    }
    setShowModelLab(false);
    setModelSearch("");
  }

  // -------- Main generation handler --------
  async function handleGenerate(promptOverride = prompt) {
    const trimmedPrompt = String(promptOverride ?? "").trim();
    const activeProvider = getActiveProviderRecord(settings);

    if (!activeProvider.apiKey?.trim()) {
      setError(`Enter the ${PROVIDERS[activeProvider.providerId].label} API key first.`);
      openSettings();
      return;
    }
    if (!activeProvider.model?.trim()) {
      setError("Select or enter a model first.");
      openSettings();
      return;
    }
    if (!trimmedPrompt) return;

    setError("");
    setIsGenerating(true);
    pushDebugLog("info", "ui", "User submitted a generation request.", {
      promptLength: trimmedPrompt.length,
      provider: activeProvider.providerId
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
    liveSinkRef.current = { messageId: assistantMessageId, sink };
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
        const message =
          caught instanceof Error ? caught.message : "Generation failed.";
        setError(message);
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
      if (!isGenerating) void handleGenerate();
    }
  }

  useEffect(() => {
    handleGenerateRef.current = handleGenerate;
  });

  // -------- Test automation polling (kept) --------
  useEffect(() => {
    let stopped = false;
    let pollTimerId = null;
    let submitTimerId = null;

    function schedulePoll(delay = TEST_AUTOMATION_POLL_MS) {
      if (stopped) return;
      pollTimerId = window.setTimeout(() => {
        void pollTestCommand();
      }, delay);
    }

    async function pollTestCommand() {
      if (stopped) return;
      try {
        const document = readDocumentInfo();
        const data = await postTestCommandJson("/poll", { document });
        const command = data?.command;
        if (command?.id && typeof command.prompt === "string") {
          const nextPrompt = command.prompt;
          const visibleDelayMs = normalizeVisibleDelayMs(command.visibleDelayMs);
          setPrompt(nextPrompt);
          shouldStickToBottomRef.current = true;

          window.requestAnimationFrame(() => {
            if (stopped) return;
            promptRef.current?.focus();
            acknowledgeTestCommand(command.id, "filled", readDocumentInfo(), {
              promptLength: nextPrompt.length,
              visibleDelayMs
            });
            submitTimerId = window.setTimeout(() => {
              if (stopped) return;
              acknowledgeTestCommand(command.id, "submitted", readDocumentInfo(), {
                promptLength: nextPrompt.length
              });
              void handleGenerateRef.current?.(nextPrompt);
            }, visibleDelayMs);
          });
        }
      } catch {
        // Preview may not have the relay.
      } finally {
        schedulePoll();
      }
    }

    schedulePoll(700);

    return () => {
      stopped = true;
      if (pollTimerId !== null) window.clearTimeout(pollTimerId);
      if (submitTimerId !== null) window.clearTimeout(submitTimerId);
    };
  }, []);

  function clearConversation() {
    if (isGenerating) return;
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
    } catch (err) {
      const message = err instanceof Error ? err.message : "Copy failed.";
      setCopyLogStatus(message);
    }
  }

  const visibleModelCatalog = [...currentCatalog]
    .sort((left, right) =>
      compareModelEntries(
        left,
        right,
        settings.providers[modelLabProvider]?.model || ""
      )
    )
    .filter((entry) => {
      const query = modelSearch.trim().toLowerCase();
      if (!query) return true;
      const haystack = `${entry.id} ${entry.ownedBy}`.toLowerCase();
      return haystack.includes(query);
    });

  const latestDebugLog = debugLogs[debugLogs.length - 1] ?? null;
  const generatingStatus =
    isGenerating && latestDebugLog
      ? `${latestDebugLog.scope}: ${latestDebugLog.message}`
      : "";

  const activeProviderMeta = PROVIDERS[activeProviderRecord.providerId];
  const settingsTabProvider = settings.providers[settingsTab] || {};
  const settingsTabMeta = PROVIDERS[settingsTab];

  return (
    <>
      <main className="minimal-shell">
        <header className="minimal-toolbar">
          <div className="toolbar-group">
            <button
              className="icon-button"
              type="button"
              onClick={() => openModelLab(settings.activeProvider)}
              aria-label="Model Benchmarks"
              title="Model Benchmarks"
            >
              <Icon name="flask" />
            </button>
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
          <div className="toolbar-meta" title={activeProviderRecord.model}>
            <span className="meta-label">{activeProviderMeta.label}</span>
            <span className="meta-model">
              {activeProviderRecord.model || "(no model)"}
            </span>
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
          {generatingStatus ? (
            <div className="tiny-status">{generatingStatus}</div>
          ) : null}

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
            className="modal-card settings-card"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="settings-header">
              <div className="settings-title">
                <span className="icon-badge">
                  <Icon name="settings" />
                </span>
                <div>
                  <h2>设置</h2>
                  <p>配置 AI 中转站、模型和代理</p>
                </div>
              </div>
              <button
                className="icon-button quiet"
                type="button"
                onClick={() => setShowSettings(false)}
                aria-label="Close"
              >
                <Icon name="close" />
              </button>
            </header>

            <div className="settings-body">
              <section className="settings-section">
                <h3 className="section-title">当前使用</h3>
                <div className="provider-picker">
                  {Object.values(PROVIDERS).map((provider) => {
                    const record = settings.providers[provider.id] || {};
                    const isActive = settings.activeProvider === provider.id;
                    return (
                      <button
                        key={provider.id}
                        type="button"
                        className={`provider-card ${isActive ? "active" : ""}`}
                        onClick={() => selectActiveProvider(provider.id)}
                      >
                        <div className="provider-card-title">
                          <span className="provider-card-name">{provider.label}</span>
                          {isActive ? (
                            <span className="provider-card-badge">已选</span>
                          ) : null}
                        </div>
                        <div className="provider-card-model">
                          {record.model || "未选择模型"}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="settings-section">
                <div className="settings-tabs">
                  {Object.values(PROVIDERS).map((provider) => (
                    <button
                      key={provider.id}
                      type="button"
                      className={`settings-tab ${
                        settingsTab === provider.id ? "active" : ""
                      }`}
                      onClick={() => setSettingsTab(provider.id)}
                    >
                      {provider.label}
                    </button>
                  ))}
                </div>

                <div className="form-group">
                  <label className="form-label">
                    <Icon name="link" size={14} />
                    <span>Base URL</span>
                  </label>
                  <input
                    className="form-input"
                    value={settingsTabProvider.baseUrl || ""}
                    onChange={(event) =>
                      updateProviderSetting(
                        settingsTab,
                        "baseUrl",
                        event.target.value
                      )
                    }
                    placeholder={settingsTabMeta.defaultBaseUrl}
                  />
                  <span className="form-hint">
                    默认：{settingsTabMeta.defaultBaseUrl}
                  </span>
                </div>

                <div className="form-group">
                  <label className="form-label">
                    <Icon name="key" size={14} />
                    <span>API Key</span>
                  </label>
                  <input
                    className="form-input"
                    type="password"
                    value={settingsTabProvider.apiKey || ""}
                    onChange={(event) =>
                      updateProviderSetting(
                        settingsTab,
                        "apiKey",
                        event.target.value
                      )
                    }
                    placeholder={`${settingsTabMeta.label} API Key`}
                    autoComplete="off"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">
                    <Icon name="provider" size={14} />
                    <span>模型</span>
                  </label>
                  <div className="input-with-action">
                    <input
                      className="form-input"
                      value={settingsTabProvider.model || ""}
                      onChange={(event) =>
                        updateProviderSetting(
                          settingsTab,
                          "model",
                          event.target.value
                        )
                      }
                      placeholder={
                        settingsTabMeta.placeholderModel || "模型名称"
                      }
                    />
                    <button
                      className="inline-button"
                      type="button"
                      onClick={() => openModelLab(settingsTab)}
                    >
                      <Icon name="flask" size={14} />
                      <span>浏览</span>
                    </button>
                  </div>
                  <span className="form-hint">
                    支持从 {settingsTabMeta.label} 获取模型列表
                  </span>
                </div>
              </section>

              <section className="settings-section">
                <h3 className="section-title">网络与代理</h3>
                <div className="form-group">
                  <label className="form-label">
                    <Icon name="link" size={14} />
                    <span>HTTP 代理</span>
                  </label>
                  <input
                    className="form-input"
                    value={settings.proxyUrl || ""}
                    onChange={(event) =>
                      updateSetting("proxyUrl", event.target.value)
                    }
                    placeholder="留空使用系统代理，例：http://127.0.0.1:7890"
                  />
                  <span className="form-hint">
                    留空自动使用系统代理；设置 URL 后优先使用该代理；设置
                    <code>direct</code> 可强制直连
                  </span>
                </div>
              </section>

              <details className="settings-section details-panel">
                <summary>高级选项</summary>
                <div className="form-group">
                  <label className="form-label">
                    <span>Temperature</span>
                  </label>
                  <input
                    className="form-input"
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={settings.temperature}
                    onChange={(event) =>
                      updateSetting(
                        "temperature",
                        Number(event.target.value || 0)
                      )
                    }
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">
                    <span>最大输出长度</span>
                  </label>
                  <input
                    className="form-input"
                    type="number"
                    min="0"
                    step="1"
                    value={settings.maxTokens}
                    onChange={(event) =>
                      updateSetting("maxTokens", event.target.value)
                    }
                    placeholder="留空自动"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">
                    <span>System Prompt</span>
                  </label>
                  <textarea
                    className="form-input form-textarea"
                    rows="4"
                    value={settings.systemPrompt}
                    onChange={(event) =>
                      updateSetting("systemPrompt", event.target.value)
                    }
                  />
                </div>
                <label className="toggle-row">
                  <div>
                    <div className="toggle-title">使用当前选区作为上下文</div>
                    <div className="toggle-hint">
                      将 WPS 当前选区一并发送给模型
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.useSelectionAsContext}
                    onChange={(event) =>
                      updateSetting(
                        "useSelectionAsContext",
                        event.target.checked
                      )
                    }
                  />
                </label>
                <label className="toggle-row">
                  <div>
                    <div className="toggle-title">直接替换当前选区</div>
                    <div className="toggle-hint">
                      输出前先删除当前选区内容
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.replaceSelection}
                    onChange={(event) =>
                      updateSetting("replaceSelection", event.target.checked)
                    }
                  />
                </label>
                {settingsTab === "openrouter" ? (
                  <>
                    <div className="form-group">
                      <label className="form-label">
                        <span>Referer</span>
                      </label>
                      <input
                        className="form-input"
                        value={settings.referer}
                        onChange={(event) =>
                          updateSetting("referer", event.target.value)
                        }
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">
                        <span>应用标题</span>
                      </label>
                      <input
                        className="form-input"
                        value={settings.title}
                        onChange={(event) =>
                          updateSetting("title", event.target.value)
                        }
                      />
                    </div>
                  </>
                ) : null}
              </details>
            </div>
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
              <button
                className="secondary-button"
                type="button"
                onClick={() => void copyLogs()}
              >
                <Icon name="copy" />
                <span>Copy Logs</span>
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={clearLogs}
              >
                <Icon name="trash" />
                <span>Clear Logs</span>
              </button>
            </div>

            {copyLogStatus ? (
              <div className="tiny-status">{copyLogStatus}</div>
            ) : null}

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
            className="modal-card compact wide model-lab-card"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal-toolbar">
              <div className="modal-icons">
                <span className="icon-badge">
                  <Icon name="flask" />
                </span>
                <div className="model-lab-title">
                  <span>模型列表</span>
                </div>
              </div>
              <button
                className="icon-button quiet"
                type="button"
                onClick={() => setShowModelLab(false)}
                aria-label="Close"
              >
                <Icon name="close" />
              </button>
            </header>

            <div className="settings-tabs lab-tabs">
              {Object.values(PROVIDERS).map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className={`settings-tab ${
                    modelLabProvider === provider.id ? "active" : ""
                  }`}
                  onClick={() => {
                    setModelLabProvider(provider.id);
                    setModelSearch("");
                    setModelLabError("");
                  }}
                >
                  {provider.label}
                </button>
              ))}
            </div>

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
                  onClick={() => void handleLoadModels(modelLabProvider)}
                  disabled={isLoadingModels || isBenchmarkingModels}
                >
                  <Icon name="refresh" size={14} />
                  <span>{isLoadingModels ? "加载中..." : "刷新模型列表"}</span>
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() =>
                    isBenchmarkingModels
                      ? stopBenchmarking()
                      : void handleBenchmarkModels(modelLabProvider)
                  }
                  disabled={isLoadingModels || currentCatalog.length === 0}
                >
                  <Icon name="flask" size={14} />
                  <span>
                    {isBenchmarkingModels
                      ? `停止 ${benchmarkProgress.completed}/${benchmarkProgress.total}`
                      : "开始基准测试"}
                  </span>
                </button>
              </div>
            </div>

            {modelLabError ? (
              <div className="tiny-error">{modelLabError}</div>
            ) : null}

            <div className="model-list">
              {visibleModelCatalog.length === 0 ? (
                <div className="log-empty">
                  {isLoadingModels
                    ? "正在加载模型列表..."
                    : "暂无模型。请配置 API Key 后刷新。"}
                </div>
              ) : (
                visibleModelCatalog.map((entry) => {
                  const isCurrent =
                    settings.providers[modelLabProvider]?.model === entry.id;
                  return (
                    <article
                      key={entry.id}
                      className={`model-row ${isCurrent ? "active" : ""}`}
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
                            isCurrent ? "active" : ""
                          }`}
                          type="button"
                          onClick={() => applyModel(entry.id)}
                        >
                          <span>{isCurrent ? "当前" : "使用"}</span>
                        </button>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
