const STORAGE_KEY = "wps-ai.debugLogs";
const MAX_ENTRIES = 400;

const listeners = new Set();
let entries = loadEntries();

function loadEntries() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistEntries() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Ignore storage failures in embedded hosts.
  }
}

function notifyListeners() {
  for (const listener of listeners) {
    try {
      listener(entries);
    } catch {
      // Ignore listener failures.
    }
  }
}

function normalizeValue(value) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value === "string" || typeof value === "number") {
    return value;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (value instanceof Error) {
    return value.message;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function readDebugLogs() {
  return entries;
}

export function subscribeDebugLogs(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearDebugLogs() {
  entries = [];
  persistEntries();
  notifyListeners();
}

export function pushDebugLog(level, scope, message, details = undefined) {
  const normalizedDetails =
    details && typeof details === "object"
      ? Object.fromEntries(
          Object.entries(details)
            .map(([key, value]) => [key, normalizeValue(value)])
            .filter(([, value]) => value !== undefined && value !== "")
        )
      : undefined;

  entries = [
    ...entries.slice(-(MAX_ENTRIES - 1)),
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      time: new Date().toISOString(),
      level: String(level || "info").toLowerCase(),
      scope: String(scope || "app"),
      message: String(message || ""),
      details: normalizedDetails
    }
  ];

  persistEntries();
  notifyListeners();
}

export function formatDebugLogs(logs) {
  return (Array.isArray(logs) ? logs : [])
    .map((entry) => {
      const prefix = `[${entry.time}] [${String(entry.level || "info").toUpperCase()}] [${
        entry.scope || "app"
      }] ${entry.message || ""}`;
      const details =
        entry.details && Object.keys(entry.details).length > 0
          ? ` ${JSON.stringify(entry.details)}`
          : "";
      return `${prefix}${details}`;
    })
    .join("\n");
}
