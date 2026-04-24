const SESSION_RELAY_URL = "http://127.0.0.1:3888";

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
    throw new Error(data?.error?.message || "会话操作失败。");
  }

  return data;
}

function normalizeDocument(document) {
  if (!document?.key) {
    return null;
  }

  return {
    key: String(document.key),
    title: String(document.title ?? document.name ?? "未命名文档"),
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

  const data = await postJson("/session/load", {
    document: normalized
  });

  return {
    exists: Boolean(data?.exists),
    messages: normalizeMessages(data?.messages)
  };
}

export async function saveDocumentSession(document, messages) {
  const normalized = normalizeDocument(document);
  if (!normalized) {
    return null;
  }

  return postJson("/session/save", {
    document: normalized,
    messages: normalizeMessages(messages)
  });
}

export async function deleteDocumentSession(document) {
  const normalized = normalizeDocument(document);
  if (!normalized) {
    return null;
  }

  return postJson("/session/delete", {
    document: normalized
  });
}
