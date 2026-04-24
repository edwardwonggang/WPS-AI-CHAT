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

    return true;
  },

  OnAction(control) {
    const doc = window.Application?.ActiveDocument;
    if (!doc) {
      alert("当前没有打开任何文字文档。");
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
