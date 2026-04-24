import {
  Attr,
  BLOCKQUOTE,
  CHECKBOX,
  CODE_BLOCK,
  CODE_FENCE,
  CODE_INLINE,
  EQUATION_BLOCK,
  HEADING_1,
  HEADING_2,
  HEADING_3,
  HEADING_4,
  HEADING_5,
  HEADING_6,
  ITALIC_AST,
  ITALIC_UND,
  LINE_BREAK,
  LINK,
  LIST_ITEM,
  LIST_ORDERED,
  LIST_UNORDERED,
  PARAGRAPH,
  RAW_URL,
  RULE,
  STRIKE,
  STRONG_AST,
  STRONG_UND,
  TABLE,
  TABLE_CELL,
  TABLE_ROW
} from "streaming-markdown";

const FLUSH_INTERVAL_MS = 32;
const MAX_PENDING_CHARS = 320;
const HEADING_SIZES = {
  [HEADING_1]: 18,
  [HEADING_2]: 16,
  [HEADING_3]: 15,
  [HEADING_4]: 14,
  [HEADING_5]: 13,
  [HEADING_6]: 13
};

const INLINE_DEFAULTS = Object.freeze({
  bold: false,
  code: false,
  italic: false,
  size: null,
  strike: false,
  underline: false
});

function getApplication() {
  if (window.Application) {
    return window.Application;
  }

  if (window.wps?.Application) {
    return window.wps.Application;
  }

  if (window.instance?.Application) {
    return window.instance.Application;
  }

  return null;
}

function getSelectionRange(app) {
  return app.Selection?.Range || app.ActiveDocument?.ActiveWindow?.Selection?.Range || null;
}

function sameStyle(left, right) {
  return (
    left.bold === right.bold &&
    left.code === right.code &&
    left.italic === right.italic &&
    left.size === right.size &&
    left.strike === right.strike &&
    left.underline === right.underline
  );
}

function isDefaultStyle(style) {
  return sameStyle(style, INLINE_DEFAULTS);
}

function applyTextStyle(range, style) {
  const font = range.Font;

  font.Bold = style.bold ? 1 : 0;
  font.Italic = style.italic ? 1 : 0;

  if (style.size) {
    font.Size = style.size;
  }

  if (style.code) {
    font.Name = "Consolas";
    font.NameAscii = "Consolas";
  }

  try {
    font.StrikeThrough = style.strike ? 1 : 0;
  } catch {
    // Some hosts may not expose StrikeThrough.
  }

  try {
    range.Underline = style.underline ? 1 : 0;
  } catch {
    // Some hosts may not expose Underline on range.
  }
}

function captureBaseStyle(range) {
  const font = range.Font;
  const size = Number(font.Size);

  return {
    name: String(font.Name ?? ""),
    nameAscii: String(font.NameAscii ?? font.Name ?? ""),
    size: Number.isFinite(size) ? size : null
  };
}

function applyBaseStyle(range, baseStyle) {
  const font = range.Font;

  font.Bold = 0;
  font.Italic = 0;

  if (baseStyle?.size) {
    font.Size = baseStyle.size;
  }

  if (baseStyle?.name) {
    font.Name = baseStyle.name;
    font.NameAscii = baseStyle.nameAscii || baseStyle.name;
  }

  try {
    font.StrikeThrough = 0;
  } catch {
    // Some hosts may not expose StrikeThrough.
  }

  try {
    range.Underline = 0;
  } catch {
    // Some hosts may not expose Underline on range.
  }
}

function normalizeNewlines(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function updateLineState(state, text) {
  const trailingMatch = String(text).match(/\r+$/);
  state.trailingBreaks = trailingMatch ? trailingMatch[0].length : 0;
  state.lineStart = state.trailingBreaks > 0;
}

function ensureWriteTarget(state) {
  if (state.startedWriting || state.cancelled || state.disabled) {
    return;
  }

  if (state.replaceSelection && state.selectionEnd > state.selectionStart) {
    state.doc.Range(state.selectionStart, state.selectionEnd).Text = "";
  }

  state.startedWriting = true;
}

function clearFlushTimer(state) {
  if (state.flushTimer === null) {
    return;
  }

  window.clearTimeout(state.flushTimer);
  state.flushTimer = null;
}

function flushPending(state) {
  if (state.cancelled || state.disabled || state.pendingRuns.length === 0) {
    clearFlushTimer(state);
    return;
  }

  clearFlushTimer(state);
  try {
    ensureWriteTarget(state);

    const runs = state.pendingRuns;
    const batchText = runs.map((run) => run.text).join("");
    const batchStart = state.anchor + state.position;

    state.doc.Range(batchStart, batchStart).InsertAfter(batchText);

    const batchEnd = batchStart + batchText.length;
    const batchRange = state.doc.Range(batchStart, batchEnd);
    applyBaseStyle(batchRange, state.baseStyle);

    let offset = 0;
    for (const run of runs) {
      const runLength = run.text.length;
      if (runLength > 0 && !isDefaultStyle(run.style)) {
        applyTextStyle(
          state.doc.Range(batchStart + offset, batchStart + offset + runLength),
          run.style
        );
      }

      offset += runLength;
    }

    state.position += batchText.length;
  } catch {
    state.disabled = true;
  }

  state.pendingRuns = [];
  state.pendingChars = 0;
}

function scheduleFlush(state, immediate = false) {
  if (state.cancelled || state.disabled) {
    return;
  }

  if (immediate || state.pendingChars >= MAX_PENDING_CHARS) {
    flushPending(state);
    return;
  }

  if (state.flushTimer !== null) {
    return;
  }

  state.flushTimer = window.setTimeout(() => {
    state.flushTimer = null;
    flushPending(state);
  }, FLUSH_INTERVAL_MS);
}

function queueText(state, text, style = INLINE_DEFAULTS, immediate = false) {
  const normalized = String(text ?? "").replace(/\n/g, "\r");
  if (!normalized || state.cancelled || state.disabled) {
    return;
  }

  const lastRun = state.pendingRuns[state.pendingRuns.length - 1];
  if (lastRun && sameStyle(lastRun.style, style)) {
    lastRun.text += normalized;
  } else {
    state.pendingRuns.push({
      style: { ...style },
      text: normalized
    });
  }

  state.pendingChars += normalized.length;
  updateLineState(state, normalized);
  scheduleFlush(state, immediate || normalized.includes("\r"));
}

function ensureBreaks(state, count = 1) {
  while (state.trailingBreaks < count) {
    queueText(state, "\r", INLINE_DEFAULTS, true);
  }
}

function findLastContext(state, predicate) {
  for (let index = state.stack.length - 1; index >= 0; index -= 1) {
    const entry = state.stack[index];
    if (predicate(entry)) {
      return entry;
    }
  }

  return null;
}

function createListMarker(state) {
  const listContext = findLastContext(
    state,
    (entry) => entry.type === LIST_ORDERED || entry.type === LIST_UNORDERED
  );

  if (!listContext || listContext.type === LIST_UNORDERED) {
    return "\u2022 ";
  }

  const marker = `${listContext.nextIndex}. `;
  listContext.nextIndex += 1;
  return marker;
}

function currentTextStyle(state) {
  const style = { ...INLINE_DEFAULTS };

  for (const entry of state.stack) {
    switch (entry.type) {
      case HEADING_1:
      case HEADING_2:
      case HEADING_3:
      case HEADING_4:
      case HEADING_5:
      case HEADING_6:
        style.bold = true;
        style.size = HEADING_SIZES[entry.type];
        break;
      case STRONG_AST:
      case STRONG_UND:
        style.bold = true;
        break;
      case ITALIC_AST:
      case ITALIC_UND:
        style.italic = true;
        break;
      case CODE_BLOCK:
      case CODE_FENCE:
      case CODE_INLINE:
        style.code = true;
        break;
      case STRIKE:
        style.strike = true;
        break;
      case LINK:
      case RAW_URL:
        style.underline = true;
        break;
      default:
        break;
    }
  }

  return style;
}

function shouldIndentParagraph(state) {
  const hasParagraph = state.stack.some((entry) => entry.type === PARAGRAPH);
  if (!hasParagraph) {
    return false;
  }

  return !state.stack.some(
    (entry) =>
      entry.type === BLOCKQUOTE ||
      entry.type === LIST_ITEM ||
      entry.type === LIST_ORDERED ||
      entry.type === LIST_UNORDERED ||
      entry.type === HEADING_1 ||
      entry.type === HEADING_2 ||
      entry.type === HEADING_3 ||
      entry.type === HEADING_4 ||
      entry.type === HEADING_5 ||
      entry.type === HEADING_6 ||
      entry.type === CODE_BLOCK ||
      entry.type === CODE_FENCE ||
      entry.type === TABLE ||
      entry.type === TABLE_ROW ||
      entry.type === TABLE_CELL
  );
}

function consumeLinePrefix(state) {
  if (!state.lineStart || state.cancelled || state.disabled) {
    return;
  }

  const quoteDepth = state.stack.filter((entry) => entry.type === BLOCKQUOTE).length;
  const listItemDepth = state.stack.filter((entry) => entry.type === LIST_ITEM).length;
  const listItem = findLastContext(state, (entry) => entry.type === LIST_ITEM);

  let prefix = "";
  if (listItemDepth > 1) {
    prefix += "  ".repeat(listItemDepth - 1);
  }

  if (quoteDepth > 0) {
    prefix += "> ".repeat(quoteDepth);
  }

  if (listItem?.prefixPending) {
    prefix += listItem.marker || "\u2022 ";
    listItem.prefixPending = false;
  }

  if (!prefix && shouldIndentParagraph(state)) {
    prefix = "  ";
  }

  if (prefix) {
    queueText(state, prefix, currentTextStyle(state));
  }
}

function appendText(state, text) {
  const normalized = normalizeNewlines(text);
  if (!normalized || state.disabled) {
    return;
  }

  const parts = normalized.split("\n");
  const style = currentTextStyle(state);

  parts.forEach((part, index) => {
    if (part) {
      consumeLinePrefix(state);
      queueText(state, part, style);
    }

    if (index < parts.length - 1) {
      queueText(state, "\r", INLINE_DEFAULTS, true);
    }
  });
}

function pushToken(state, type) {
  const context = {
    type,
    attrs: new Map()
  };

  switch (type) {
    case LIST_ORDERED:
      context.nextIndex = 1;
      break;
    case TABLE:
      if (state.position > 0 || state.pendingChars > 0) {
        ensureBreaks(state, 1);
      }
      context.rowCount = 0;
      break;
    case TABLE_ROW: {
      const table = findLastContext(state, (entry) => entry.type === TABLE);
      if (table?.rowCount > 0 && state.trailingBreaks === 0) {
        ensureBreaks(state, 1);
      }
      if (table) {
        table.rowCount += 1;
      }
      context.cellCount = 0;
      break;
    }
    case TABLE_CELL: {
      const row = findLastContext(state, (entry) => entry.type === TABLE_ROW);
      if (row?.cellCount > 0) {
        queueText(state, "\t", INLINE_DEFAULTS);
      }
      if (row) {
        row.cellCount += 1;
      }
      break;
    }
    case PARAGRAPH:
    case HEADING_1:
    case HEADING_2:
    case HEADING_3:
    case HEADING_4:
    case HEADING_5:
    case HEADING_6:
    case CODE_BLOCK:
    case CODE_FENCE:
    case EQUATION_BLOCK:
      if ((state.position > 0 || state.pendingChars > 0) && state.trailingBreaks === 0) {
        ensureBreaks(state, 1);
      }
      break;
    case LIST_ITEM:
      if ((state.position > 0 || state.pendingChars > 0) && state.trailingBreaks === 0) {
        ensureBreaks(state, 1);
      }
      context.marker = createListMarker(state);
      context.prefixPending = true;
      break;
    case LINE_BREAK:
      queueText(state, "\r", INLINE_DEFAULTS, true);
      break;
    case RULE:
      if ((state.position > 0 || state.pendingChars > 0) && state.trailingBreaks === 0) {
        ensureBreaks(state, 1);
      }
      break;
    case CHECKBOX:
      context.checked = false;
      break;
    default:
      break;
  }

  state.stack.push(context);

  if (type === RULE) {
    consumeLinePrefix(state);
    queueText(state, "────────────────", INLINE_DEFAULTS, true);
    ensureBreaks(state, 1);
  }
}

function popToken(state) {
  const context = state.stack.pop();
  if (!context) {
    return;
  }

  if (context.type === CHECKBOX) {
    const listItem = findLastContext(state, (entry) => entry.type === LIST_ITEM);
    const marker = context.checked ? "\u2611 " : "\u2610 ";

    if (listItem?.prefixPending) {
      listItem.marker = marker;
    } else {
      consumeLinePrefix(state);
      queueText(state, marker, currentTextStyle(state));
    }
  }
}

function setTokenAttr(state, type, value) {
  const current = state.stack[state.stack.length - 1];
  if (!current) {
    return;
  }

  current.attrs.set(type, value);

  if (current.type === LIST_ORDERED && type === Attr.Start) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      current.nextIndex = parsed;
    }
  }

  if (current.type === CHECKBOX && type === Attr.Checked) {
    current.checked = true;
  }
}

function createPreviewSink(label) {
  return {
    locationLabel: label,
    renderer: {
      data: null,
      add_token() {},
      end_token() {},
      add_text() {},
      set_attr() {}
    },
    finish() {},
    cancel() {}
  };
}

export function detectHostLabel() {
  if (window.Application) {
    return "WPS local";
  }

  if (window.wps?.Application) {
    return "WPS host";
  }

  if (window.instance?.Application) {
    return "WebOffice host";
  }

  return "Browser preview";
}

export function readSelectionText() {
  const app = getApplication();
  if (!app?.ActiveDocument) {
    return "";
  }

  const range = getSelectionRange(app);
  return range?.Text ? String(range.Text) : "";
}

export function readDocumentInfo() {
  const app = getApplication();
  const doc = app?.ActiveDocument;
  if (!doc) {
    return null;
  }

  const title = String(doc.Name ?? "").trim() || "未命名文档";
  const path = String(doc.Path ?? "").trim();
  let fullName = String(doc.FullName ?? "").trim();

  if (!fullName && path) {
    fullName = `${path}${path.endsWith("\\") || path.endsWith("/") ? "" : "\\"}${title}`;
  }

  const normalizedFullName = fullName.trim();
  return {
    key: normalizedFullName
      ? `saved:${normalizedFullName.toLowerCase()}`
      : `unsaved:${title}`,
    title,
    name: title,
    path,
    fullName: normalizedFullName,
    isSaved: Boolean(normalizedFullName)
  };
}

export function hasWpsDocument() {
  const app = getApplication();
  return Boolean(app?.ActiveDocument);
}

export function createWpsMarkdownSink({ replaceSelection } = {}) {
  const app = getApplication();
  if (!app?.ActiveDocument) {
    return createPreviewSink("Preview only");
  }

  const doc = app.ActiveDocument;
  const selectionRange = getSelectionRange(app);

  if (!selectionRange) {
    throw new Error("Unable to access the current selection.");
  }

  const baseStyle = captureBaseStyle(selectionRange);
  const selectionStart = Number(selectionRange.Start);
  const selectionEnd = Number(selectionRange.End);
  const originalText = String(selectionRange.Text || "");
  const anchor = replaceSelection ? selectionStart : selectionEnd;

  const rendererState = {
    anchor,
    baseStyle,
    cancelled: false,
    disabled: false,
    doc,
    flushTimer: null,
    lineStart: true,
    pendingChars: 0,
    pendingRuns: [],
    position: 0,
    replaceSelection: Boolean(replaceSelection),
    selectionEnd,
    selectionStart,
    stack: [],
    startedWriting: false,
    trailingBreaks: 0
  };

  return {
    locationLabel: replaceSelection ? "Replace selection" : "Insert at cursor",
    renderer: {
      data: rendererState,
      add_token: pushToken,
      end_token: popToken,
      add_text: appendText,
      set_attr: setTokenAttr
    },
    finish() {
      flushPending(rendererState);
    },
    cancel() {
      rendererState.cancelled = true;
      rendererState.pendingRuns = [];
      rendererState.pendingChars = 0;
      clearFlushTimer(rendererState);

      if (
        rendererState.replaceSelection &&
        rendererState.startedWriting &&
        !rendererState.disabled
      ) {
        rendererState.doc.Range(
          rendererState.anchor,
          rendererState.anchor + rendererState.position
        ).Text = originalText;
      }
    }
  };
}

export function createStreamingWriter(options = {}) {
  return createWpsMarkdownSink(options);
}
