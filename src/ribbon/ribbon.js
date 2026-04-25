import { tryStartLocalRelay } from "../shared/relay";

const STORAGE_KEY = "wps_ai_taskpane_id";

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

const ribbon = {
  OnAddinLoad(ribbonUI) {
    if (typeof window.Application.ribbonUI !== "object") {
      window.Application.ribbonUI = ribbonUI;
    }

    tryStartLocalRelay();

    try {
      if (window.Application?.ActiveDocument) {
        const taskPane = ensureTaskPane();
        taskPane.Visible = true;
      }
    } catch {
      // Ignore auto-open failures in host startup.
    }

    return true;
  },

  OnAction(control) {
    const doc = window.Application?.ActiveDocument;
    if (!doc) {
      alert("No text document is currently open.");
      return true;
    }

    if (control.Id === "btnOpenAssistant") {
      const taskPane = ensureTaskPane();
      taskPane.Visible = true;
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
