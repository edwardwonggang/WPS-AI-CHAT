const SETTINGS_KEY = "wps-ai.settings";
const PROMPT_KEY = "wps-ai.prompt";
const MODEL_CATALOG_KEY = "wps-ai.modelCatalog";

export function loadStoredValue(key, fallbackValue) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallbackValue;
  } catch {
    return fallbackValue;
  }
}

export function saveStoredValue(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore local storage failures in host environments with tighter quotas.
  }
}

export { MODEL_CATALOG_KEY, SETTINGS_KEY, PROMPT_KEY };
