const SESSION_RELAY_URL = "http://127.0.0.1:3888";
const SESSION_STORAGE_PREFIX = "wps-ai.session.";

function sessionStorageKey(document) {
  return `${SESSION_STORAGE_PREFIX}${document.key}`;
}

function readLocalSession(document) {
  const key = sessionStorageKey(document);

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return {
        exists: false,
        messages: []
      };
    }

    const parsed = JSON.parse(raw);
    return {
      exists: true,
      messages: normalizeMessages(parsed?.messages)
    };
  } catch {
    return {
      exists: false,
      messages: []
    };
  }
}

function writeLocalSession(document, messages) {
  try {
    window.localStorage.setItem(
      sessionStorageKey(document),
      JSON.stringify({
        document,
        messages: normalizeMessages(messages),
        updatedAt: Date.now()
      })
    );
  } catch {
    // Ignore local persistence failures.
  }
}

function deleteLocalSession(document) {
  try {
    window.localStorage.removeItem(sessionStorageKey(document));
  } catch {
    // Ignore local persistence failures.
  }
}

async function postJson(path, payload) {
  const response = await fetch(`${SESSION_RELAY_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(data?.error?.message || "Session operation failed.");
  }

  return data;
}

function normalizeDocument(document) {
  if (!document?.key) {
    return null;
  }

  return {
    key: String(document.key),
    title: String(document.title ?? document.name ?? "Untitled Document"),
    path: String(document.path ?? ""),
    fullName: String(document.fullName ?? ""),
    isSaved: Boolean(document.isSaved)
  };
}

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message, index) => ({
    id: String(message?.id ?? `session-${index + 1}`),
    role: message?.role === "assistant" ? "assistant" : "user",
    content: String(message?.content ?? ""),
    error: Boolean(message?.error),
    streaming: false
  }));
}

export async function loadDocumentSession(document) {
  const normalized = normalizeDocument(document);
  if (!normalized) {
    return {
      exists: false,
      messages: []
    };
  }

  try {
    const data = await postJson("/session/load", {
      document: normalized
    });

    const session = {
      exists: Boolean(data?.exists),
      messages: normalizeMessages(data?.messages)
    };

    if (session.exists) {
      writeLocalSession(normalized, session.messages);
    }

    return session;
  } catch {
    return readLocalSession(normalized);
  }
}

export async function saveDocumentSession(document, messages) {
  const normalized = normalizeDocument(document);
  if (!normalized) {
    return null;
  }

  const normalizedMessages = normalizeMessages(messages);
  writeLocalSession(normalized, normalizedMessages);

  try {
    return await postJson("/session/save", {
      document: normalized,
      messages: normalizedMessages
    });
  } catch {
    return {
      ok: true,
      localOnly: true
    };
  }
}

export async function deleteDocumentSession(document) {
  const normalized = normalizeDocument(document);
  if (!normalized) {
    return null;
  }

  deleteLocalSession(normalized);

  try {
    return await postJson("/session/delete", {
      document: normalized
    });
  } catch {
    return {
      ok: true,
      localOnly: true
    };
  }
}
