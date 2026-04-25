import { tryStartLocalRelay } from "../shared/relay";

const STORAGE_KEY = "wps_ai_taskpane_id";
const AUTO_OPEN_RETRY_LIMIT = 30;
const AUTO_OPEN_RETRY_MS = 500;
let autoOpenTimerId = 0;
let autoOpenAttempts = 0;

function getDockRightValue() {
  if (window.Application?.Enum?.msoCTPDockPositionRight !== undefined) {
    return window.Application.Enum.msoCTPDockPositionRight;
  }

  return 2;
}

function getTaskPaneUrl() {
  return new URL("./taskpane.html", window.location.href).href;
}

function ensureTaskPane() {
  const storage = window.Application.PluginStorage;
  const existingId = storage.getItem(STORAGE_KEY);

  if (existingId) {
    try {
      const existing = window.Application.GetTaskPane(existingId);
      if (existing) {
        return existing;
      }
    } catch {
      storage.removeItem(STORAGE_KEY);
    }
  }

  const taskPane = window.Application.CreateTaskPane(getTaskPaneUrl());
  storage.setItem(STORAGE_KEY, taskPane.ID);
  taskPane.DockPosition = getDockRightValue();
  return taskPane;
}

function showTaskPaneIfDocumentReady() {
  if (!window.Application?.ActiveDocument) {
    return false;
  }

  const taskPane = ensureTaskPane();
  taskPane.Visible = true;
  return true;
}

function scheduleAutoOpenTaskPane() {
  if (autoOpenTimerId) {
    window.clearTimeout(autoOpenTimerId);
    autoOpenTimerId = 0;
  }

  autoOpenAttempts = 0;

  function tryAutoOpen() {
    autoOpenAttempts += 1;

    try {
      if (showTaskPaneIfDocumentReady()) {
        autoOpenTimerId = 0;
        return;
      }
    } catch {
      // WPS may expose Application before ActiveDocument is ready.
    }

    if (autoOpenAttempts < AUTO_OPEN_RETRY_LIMIT) {
      autoOpenTimerId = window.setTimeout(tryAutoOpen, AUTO_OPEN_RETRY_MS);
    } else {
      autoOpenTimerId = 0;
    }
  }

  autoOpenTimerId = window.setTimeout(tryAutoOpen, AUTO_OPEN_RETRY_MS);
}

const ribbon = {
  OnAddinLoad(ribbonUI) {
    if (typeof window.Application.ribbonUI !== "object") {
      window.Application.ribbonUI = ribbonUI;
    }

    tryStartLocalRelay();
    scheduleAutoOpenTaskPane();

    return true;
  },

  OnAction(control) {
    const doc = window.Application?.ActiveDocument;
    if (!doc) {
      alert("No text document is currently open.");
      return true;
    }

    if (control.Id === "btnOpenAssistant") {
      showTaskPaneIfDocumentReady();
    }

    return true;
  },

  GetImage() {
    return "images/ai-stream.svg";
  },

  OnGetEnabled() {
    return Boolean(window.Application?.ActiveDocument);
  }
};

export default ribbon;
