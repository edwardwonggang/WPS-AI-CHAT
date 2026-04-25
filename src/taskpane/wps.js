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
  TABLE_ROW,
  parser as createParser,
  parser_end,
  parser_write
} from "streaming-markdown";
import hljs, { normalizeCodeLanguage } from "./codeHighlighter";

const FLUSH_INTERVAL_MS = 12;
const MAX_PENDING_CHARS = 160;
const WPS_REFRESH_INTERVAL_MS = 80;
const ALIGN_LEFT = 0;
const ALIGN_CENTER = 1;
const LINE_SPACING_EXACTLY = 4;
const HEADING_SIZES = {
  [HEADING_1]: 16,
  [HEADING_2]: 15,
  [HEADING_3]: 14,
  [HEADING_4]: 12,
  [HEADING_5]: 12,
  [HEADING_6]: 12
};
const HEADING_LEVELS = {
  [HEADING_1]: 1,
  [HEADING_2]: 2,
  [HEADING_3]: 3,
  [HEADING_4]: 4,
  [HEADING_5]: 5,
  [HEADING_6]: 6
};
const HEADING_SIZE_BY_LEVEL = {
  1: 16,
  2: 15,
  3: 14,
  4: 12,
  5: 12,
  6: 12
};
const PAPER_BODY_STYLE = Object.freeze({
  name: "SimSun",
  nameAscii: "Times New Roman",
  size: 12
});
const PAPER_TABLE_STYLE = Object.freeze({
  name: "SimSun",
  nameAscii: "Times New Roman",
  size: 10.5
});
const PAPER_BODY_LINE_SPACING = 20;
const PAPER_HEADING_LINE_SPACING = 22;
const PAPER_TABLE_LINE_SPACING = 18;
const PAPER_CODE_LINE_SPACING = 18;
const PAPER_EQUATION_LINE_SPACING = 20;
const PAPER_PARAGRAPH_INDENT_CHARS = 2;
const CODE_LINE_NUMBER_SEPARATOR = "   ";
const CODE_LINE_NUMBER_MIN_WIDTH = 2;
const CODE_LINE_NUMBER_COLOR = "#8c959f";
const CODE_BLOCK_BORDER_COLOR = "#ff3040";
const HORIZONTAL_RULE_TEXT = "----------------";
const RAW_BREAK_PLACEHOLDER = "WPS-BR-PLACEHOLDER-ZXCV";
const RAW_CHECKED_PLACEHOLDER = "WPSCHECKEDBOXPLACEHOLDERZXCV";
const RAW_UNCHECKED_PLACEHOLDER = "WPSUNCHECKEDBOXPLACEHOLDERZXCV";
const RAW_SUP_START = "WPSSUPSTARTZXCV";
const RAW_SUP_END = "WPSSUPENDZXCV";
const RAW_SUB_START = "WPSSUBSTARTZXCV";
const RAW_SUB_END = "WPSSUBENDZXCV";
const RAW_EQUATION_START = "WPSDISPLAYMATHSTARTZXCV";
const RAW_EQUATION_END = "WPSDISPLAYMATHENDZXCV";
const RAW_TOKEN_MARKERS = [
  RAW_BREAK_PLACEHOLDER,
  RAW_CHECKED_PLACEHOLDER,
  RAW_UNCHECKED_PLACEHOLDER,
  RAW_SUP_START,
  RAW_SUP_END,
  RAW_SUB_START,
  RAW_SUB_END,
  RAW_EQUATION_START,
  RAW_EQUATION_END
];

const INLINE_DEFAULTS = Object.freeze({
  bold: false,
  code: false,
  color: null,
  italic: false,
  size: null,
  strike: false,
  underline: false
});
const CODE_TOKEN_COLORS = Object.freeze({
  attr: "#953800",
  attribute: "#953800",
  built_in: "#953800",
  bullet: "#735c0f",
  comment: "#6a737d",
  doctag: "#d73a49",
  keyword: "#d73a49",
  literal: "#005cc5",
  meta: "#6a737d",
  number: "#005cc5",
  operator: "#d73a49",
  regexp: "#032f62",
  section: "#005cc5",
  string: "#032f62",
  subst: "#24292e",
  symbol: "#953800",
  title: "#6f42c1",
  type: "#d73a49",
  variable: "#e36209"
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

function clearRefreshTimer(state) {
  if (state.refreshTimer === null) {
    return;
  }

  window.clearTimeout(state.refreshTimer);
  state.refreshTimer = null;
}

function forceWpsViewportRefresh(state) {
  if (state.cancelled || state.disabled || !state.startedWriting) {
    clearRefreshTimer(state);
    return;
  }

  clearRefreshTimer(state);
  state.lastRefreshAt = Date.now();

  const app = getApplication();
  const caretPosition = state.anchor + state.position;

  try {
    app?.Selection?.SetRange(caretPosition, caretPosition);
  } catch {
    // Some hosts may not expose a mutable selection.
  }

  try {
    app?.ScreenRefresh?.();
  } catch {
    // WPS/Word-compatible hosts differ; refresh is best-effort only.
  }
}

function requestWpsViewportRefresh(state, immediate = false) {
  if (state.cancelled || state.disabled || !state.startedWriting) {
    return;
  }

  if (immediate) {
    forceWpsViewportRefresh(state);
    return;
  }

  const elapsed = Date.now() - state.lastRefreshAt;
  if (elapsed >= WPS_REFRESH_INTERVAL_MS) {
    forceWpsViewportRefresh(state);
    return;
  }

  if (state.refreshTimer !== null) {
    return;
  }

  state.refreshTimer = window.setTimeout(() => {
    state.refreshTimer = null;
    forceWpsViewportRefresh(state);
  }, WPS_REFRESH_INTERVAL_MS - elapsed);
}

function sameStyle(left, right) {
  return (
    left.bold === right.bold &&
    left.code === right.code &&
    left.color === right.color &&
    left.italic === right.italic &&
    left.size === right.size &&
    left.strike === right.strike &&
    left.underline === right.underline
  );
}

function isDefaultStyle(style) {
  return sameStyle(style, INLINE_DEFAULTS);
}

function cssColorToWpsColor(color) {
  const match = String(color || "").trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match) {
    return null;
  }

  const value = match[1];
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return red + green * 256 + blue * 65536;
}

function codeTokenColor(className, inheritedColor = null) {
  const classes = String(className || "").split(/\s+/);
  for (const item of classes) {
    const token = item.replace(/^hljs-/, "");
    const color = CODE_TOKEN_COLORS[token];
    if (color) {
      return cssColorToWpsColor(color);
    }
  }

  return inheritedColor;
}

function collectHighlightedRuns(node, runs, inheritedColor = null) {
  if (!node) {
    return;
  }

  if (node.nodeType === 3) {
    const text = node.nodeValue || "";
    if (text) {
      runs.push({ color: inheritedColor, text });
    }
    return;
  }

  const nextColor =
    node.nodeType === 1 ? codeTokenColor(node.getAttribute("class"), inheritedColor) : inheritedColor;

  for (const child of Array.from(node.childNodes || [])) {
    collectHighlightedRuns(child, runs, nextColor);
  }
}

function createHighlightedCodeRuns(text, language) {
  const source = String(text ?? "");
  if (!source) {
    return [];
  }

  if (typeof document === "undefined") {
    return [{ color: null, text: source }];
  }

  try {
    const normalizedLanguage = normalizeCodeLanguage(language);
    const result =
      normalizedLanguage && hljs.getLanguage(normalizedLanguage)
        ? hljs.highlight(source, {
            ignoreIllegals: true,
            language: normalizedLanguage
          })
        : hljs.highlightAuto(source);

    const root = document.createElement("div");
    root.innerHTML = result.value;
    const runs = [];
    collectHighlightedRuns(root, runs);
    return runs.length > 0 ? runs : [{ color: null, text: source }];
  } catch {
    return [{ color: null, text: source }];
  }
}

function activeCodeBlockContext(state) {
  return findLastContext(
    state,
    (entry) => entry.type === CODE_BLOCK || entry.type === CODE_FENCE
  );
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

  if (style.color !== null && style.color !== undefined) {
    try {
      font.Color = style.color;
    } catch {
      // Some hosts may not expose font color.
    }
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

function createPaperBodyStyle() {
  return { ...PAPER_BODY_STYLE };
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

function currentOutputOffset(state) {
  return state.position + state.pendingChars;
}

function setFontFamily(font, name, nameAscii = name) {
  if (!name) {
    return;
  }

  font.Name = name;

  if (nameAscii) {
    font.NameAscii = nameAscii;
  }

  try {
    font.NameFarEast = name;
  } catch {
    // Some hosts may not expose Far East font names.
  }
}

function setParagraphNumeric(paragraph, key, value) {
  try {
    paragraph[key] = value;
  } catch {
    // Some hosts may not expose every paragraph property.
  }
}

function forEachParagraph(range, applyParagraph) {
  try {
    const paragraphs = range?.Paragraphs;
    const count = Number(paragraphs?.Count ?? 0);

    if (count > 0) {
      for (let index = 1; index <= count; index += 1) {
        const paragraphRange = paragraphs.Item(index)?.Range;
        const paragraph = paragraphRange?.ParagraphFormat;
        if (paragraphRange && paragraph) {
          applyParagraph(paragraphRange, paragraph);
        }
      }
      return;
    }
  } catch {
    // Fall back to the range paragraph format below.
  }

  const paragraph = range?.ParagraphFormat;
  if (paragraph) {
    applyParagraph(range, paragraph);
  }
}

function getRangeTextSafe(doc, start, end) {
  try {
    return String(doc.Range(start, end).Text || "");
  } catch {
    return "";
  }
}

function resolveDocumentAppendAnchor(doc) {
  const contentEnd = Number(doc?.Content?.End ?? 0);
  return Math.max(0, contentEnd > 0 ? contentEnd - 1 : 0);
}

function createBlockMeta(state, type) {
  const quoteDepth = state.stack.filter((entry) => entry.type === BLOCKQUOTE).length;
  const listDepth = state.stack.filter((entry) => entry.type === LIST_ITEM).length;

  switch (type) {
    case PARAGRAPH:
      if (listDepth > 0) {
        return null;
      }
      return {
        kind: quoteDepth > 0 ? "quote" : "paragraph"
      };
    case LIST_ITEM:
      return {
        kind: "list",
        depth: listDepth + 1,
        quoteDepth
      };
    case HEADING_1:
    case HEADING_2:
    case HEADING_3:
    case HEADING_4:
    case HEADING_5:
    case HEADING_6:
      return {
        kind: "heading",
        level: HEADING_LEVELS[type]
      };
    case CODE_BLOCK:
    case CODE_FENCE:
      return {
        kind: "code"
      };
    case EQUATION_BLOCK:
      return {
        kind: "equation"
      };
    case RULE:
      return {
        kind: "rule"
      };
    default:
      return null;
  }
}

function beginBlock(state, context) {
  const meta = createBlockMeta(state, context.type);
  if (!meta) {
    return;
  }

  context.blockMeta = meta;
  context.blockStart = currentOutputOffset(state);
}

function finishBlock(state, context) {
  if (!context?.blockMeta) {
    return;
  }

  const end = currentOutputOffset(state);
  if (end <= context.blockStart) {
    return;
  }

  state.blocks.push({
    ...context.blockMeta,
    end,
    start: context.blockStart
  });
}

function createHeadingMarker(state, level) {
  const normalizedLevel = Math.max(1, Math.min(6, Number(level) || 1));

  for (let index = 0; index < normalizedLevel - 1; index += 1) {
    if (!state.headingCounters[index]) {
      state.headingCounters[index] = 1;
    }
  }

  state.headingCounters[normalizedLevel - 1] =
    (state.headingCounters[normalizedLevel - 1] || 0) + 1;

  for (let index = normalizedLevel; index < state.headingCounters.length; index += 1) {
    state.headingCounters[index] = 0;
  }

  return `${state.headingCounters.slice(0, normalizedLevel).join(".")} `;
}

function applyHeadingFormat(range, level) {
  const font = range.Font;
  setFontFamily(font, "SimHei", "Times New Roman");
  font.Bold = 1;

  if (HEADING_SIZE_BY_LEVEL[level]) {
    font.Size = HEADING_SIZE_BY_LEVEL[level];
  }

  forEachParagraph(range, (_paragraphRange, paragraph) => {
    setParagraphNumeric(paragraph, "Alignment", ALIGN_LEFT);
    setParagraphNumeric(paragraph, "CharacterUnitFirstLineIndent", 0);
    setParagraphNumeric(paragraph, "CharacterUnitLeftIndent", 0);
    setParagraphNumeric(paragraph, "LineSpacingRule", LINE_SPACING_EXACTLY);
    setParagraphNumeric(paragraph, "LineSpacing", PAPER_HEADING_LINE_SPACING);
    setParagraphNumeric(paragraph, "SpaceBefore", level === 1 ? 10 : 6);
    setParagraphNumeric(paragraph, "SpaceAfter", level === 1 ? 6 : 3);
  });
}

function applyParagraphFormat(range, kind, depth = 0) {
  let leftIndent = 0;
  let firstLineIndent = 0;

  if (kind === "paragraph") {
    firstLineIndent = PAPER_PARAGRAPH_INDENT_CHARS;
  } else if (kind === "list") {
    leftIndent = Math.max(1, depth) * 2;
    firstLineIndent = -2;
  } else if (kind === "quote") {
    leftIndent = 2;
  }

  if (kind === "quote") {
    try {
      range.Font.Color = cssColorToWpsColor("#57606a");
    } catch {
      // Some hosts may not expose font color on paragraph ranges.
    }
  }

  forEachParagraph(range, (_paragraphRange, paragraph) => {
    setParagraphNumeric(paragraph, "Alignment", ALIGN_LEFT);
    setParagraphNumeric(paragraph, "CharacterUnitLeftIndent", leftIndent);
    setParagraphNumeric(paragraph, "CharacterUnitFirstLineIndent", firstLineIndent);
    setParagraphNumeric(paragraph, "LineSpacingRule", LINE_SPACING_EXACTLY);
    setParagraphNumeric(paragraph, "LineSpacing", PAPER_BODY_LINE_SPACING);
    setParagraphNumeric(paragraph, "SpaceBefore", 0);
    setParagraphNumeric(paragraph, "SpaceAfter", kind === "table" ? 3 : 0);
  });
}

function applyTableCellFormat(range, { header = false } = {}) {
  const font = range.Font;
  setFontFamily(font, PAPER_TABLE_STYLE.name, PAPER_TABLE_STYLE.nameAscii);
  font.Size = PAPER_TABLE_STYLE.size;
  font.Bold = header ? 1 : 0;
  font.Italic = 0;

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

  forEachParagraph(range, (_paragraphRange, paragraph) => {
    setParagraphNumeric(paragraph, "Alignment", ALIGN_CENTER);
    setParagraphNumeric(paragraph, "CharacterUnitLeftIndent", 0);
    setParagraphNumeric(paragraph, "CharacterUnitFirstLineIndent", 0);
    setParagraphNumeric(paragraph, "LineSpacingRule", LINE_SPACING_EXACTLY);
    setParagraphNumeric(paragraph, "LineSpacing", PAPER_TABLE_LINE_SPACING);
    setParagraphNumeric(paragraph, "SpaceBefore", 0);
    setParagraphNumeric(paragraph, "SpaceAfter", 0);
  });
}

function applyTableFormat(table) {
  try {
    table.Borders.Enable = 1;
  } catch {
    // Some hosts may not expose Borders.Enable.
  }

  try {
    table.Rows.Alignment = ALIGN_CENTER;
  } catch {
    // Some hosts may not expose row alignment.
  }

  try {
    table.Range.ParagraphFormat.Alignment = ALIGN_CENTER;
  } catch {
    // Some hosts may not expose paragraph formatting on table ranges.
  }

  try {
    table.PreferredWidthType = 2;
    table.PreferredWidth = 100;
  } catch {
    // Some hosts may not expose preferred table width.
  }

  try {
    table.AutoFitBehavior(2);
  } catch {
    // Some hosts may not expose AutoFitBehavior.
  }
}

function applyCodeFormat(range) {
  const font = range.Font;
  setFontFamily(font, "Consolas", "Consolas");
  font.Size = 10.5;

  forEachParagraph(range, (_paragraphRange, paragraph) => {
    setParagraphNumeric(paragraph, "Alignment", ALIGN_LEFT);
    setParagraphNumeric(paragraph, "CharacterUnitLeftIndent", 0);
    setParagraphNumeric(paragraph, "CharacterUnitFirstLineIndent", 0);
    setParagraphNumeric(paragraph, "LineSpacingRule", LINE_SPACING_EXACTLY);
    setParagraphNumeric(paragraph, "LineSpacing", PAPER_CODE_LINE_SPACING);
    setParagraphNumeric(paragraph, "SpaceBefore", 6);
    setParagraphNumeric(paragraph, "SpaceAfter", 6);
  });

  applyCodeBlockBorder(range);
}

function applyCodeBlockBorder(range) {
  const borderColor = cssColorToWpsColor(CODE_BLOCK_BORDER_COLOR);

  try {
    range.Borders.Enable = 1;
  } catch {
    // Some hosts may not expose paragraph borders.
  }

  try {
    range.Borders.OutsideLineStyle = 1;
    range.Borders.OutsideColor = borderColor;
  } catch {
    // Some hosts may not expose outside border shortcuts.
  }

  for (const borderIndex of [-1, -2, -3, -4, 1, 2, 3, 4]) {
    try {
      const border = range.Borders.Item(borderIndex);
      border.LineStyle = 1;
      border.LineWidth = 4;
      border.Color = borderColor;
    } catch {
      // WPS and Word expose different border index constants.
    }
  }

  for (const borderIndex of [-5, -6, 5, 6]) {
    try {
      range.Borders.Item(borderIndex).LineStyle = 0;
    } catch {
      // Internal borders are optional for paragraph groups.
    }
  }
}

function applyEquationFormat(range) {
  const font = range.Font;
  setFontFamily(font, "Cambria Math", "Cambria Math");
  font.Italic = 0;

  forEachParagraph(range, (_paragraphRange, paragraph) => {
    setParagraphNumeric(paragraph, "Alignment", ALIGN_CENTER);
    setParagraphNumeric(paragraph, "CharacterUnitLeftIndent", 0);
    setParagraphNumeric(paragraph, "CharacterUnitFirstLineIndent", 0);
    setParagraphNumeric(paragraph, "LineSpacingRule", LINE_SPACING_EXACTLY);
    setParagraphNumeric(paragraph, "LineSpacing", PAPER_EQUATION_LINE_SPACING);
    setParagraphNumeric(paragraph, "SpaceBefore", 6);
    setParagraphNumeric(paragraph, "SpaceAfter", 6);
  });
}

function applyBaseParagraphFormat(range) {
  forEachParagraph(range, (_paragraphRange, paragraph) => {
    setParagraphNumeric(paragraph, "Alignment", ALIGN_LEFT);
    setParagraphNumeric(paragraph, "CharacterUnitLeftIndent", 0);
    setParagraphNumeric(paragraph, "CharacterUnitFirstLineIndent", PAPER_PARAGRAPH_INDENT_CHARS);
    setParagraphNumeric(paragraph, "LineSpacingRule", LINE_SPACING_EXACTLY);
    setParagraphNumeric(paragraph, "LineSpacing", PAPER_BODY_LINE_SPACING);
    setParagraphNumeric(paragraph, "SpaceBefore", 0);
    setParagraphNumeric(paragraph, "SpaceAfter", 0);
  });
}

function applyBaseRangeFormat(state, start, end) {
  if (!state.startedWriting || end <= start) {
    return;
  }

  try {
    const range = state.doc.Range(start, end);
    applyBaseStyle(range, state.writeStyle);
    applyBaseParagraphFormat(range);
  } catch (error) {
    state.debugError = `table:${error?.message || error}`;
    state.disabled = true;
  }
}

function activeTableContext(state) {
  return findLastContext(state, (entry) => entry.type === TABLE);
}

function activeTableRowContext(state) {
  return findLastContext(state, (entry) => entry.type === TABLE_ROW);
}

function activeTableCellContext(state) {
  return findLastContext(state, (entry) => entry.type === TABLE_CELL);
}

function insertWpsTable(state, tableContext) {
  const rows = tableContext?.rows ?? [];
  if (rows.length === 0) {
    return;
  }

  const columnCount = rows.reduce(
    (max, row) => Math.max(max, Array.isArray(row) ? row.length : 0),
    0
  );

  if (columnCount === 0) {
    return;
  }

  flushPending(state);
  ensureWriteTarget(state);

  const start = state.anchor + state.position;

  try {
    const insertionRange = state.doc.Range(start, start);
    let table = null;

    try {
      table = state.doc.Tables.Add(insertionRange, rows.length, columnCount);
    } catch (error) {
      state.debugError = `table:add-doc:${error?.message || error}`;
    }

    if (!table) {
      try {
        const app = getApplication();
        const activeDoc = app?.ActiveDocument;
        if (activeDoc?.Tables?.Add) {
          table = activeDoc.Tables.Add(activeDoc.Range(start, start), rows.length, columnCount);
        }
      } catch (error) {
        state.debugError = `table:add-active:${error?.message || error}`;
      }
    }

    if (!table) {
      const app = getApplication();
      try {
        app?.Selection?.SetRange(start, start);
        const selectionRange = getSelectionRange(app);
        const activeDoc = app?.ActiveDocument;
        if (selectionRange && activeDoc?.Tables?.Add) {
          table = activeDoc.Tables.Add(selectionRange, rows.length, columnCount);
        }
      } catch (error) {
        state.debugError = `table:add-selection:${error?.message || error}`;
      }
    }

    if (!table) {
      throw new Error(
        `unable to add table rows=${rows.length} cols=${columnCount}`
      );
    }

    applyTableFormat(table);

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex] || [];

      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const cellRange = table.Cell(rowIndex + 1, columnIndex + 1).Range;
        const cellText = normalizeTableCellText(row[columnIndex] ?? "");

        cellRange.Text = cellText;
        applyTableCellFormat(cellRange, { header: rowIndex === 0 });
      }
    }

    state.position = Math.max(state.position, Number(table.Range.End) - state.anchor);
    state.lineStart = true;
    state.trailingBreaks = 1;
    state.createdTableCount += 1;
  } catch (error) {
    state.debugError = `table:final:${error?.message || error}`;
    state.lineStart = true;
    state.trailingBreaks = Math.max(state.trailingBreaks, 1);
  }
}

function applyPendingBlockFormats(state) {
  if (
    !state.startedWriting ||
    state.position <= 0 ||
    state.formattedBlockCount >= state.blocks.length
  ) {
    return;
  }

  const pendingBlocks = state.blocks.slice(state.formattedBlockCount);
  const orderedBlocks = [
    ...pendingBlocks.filter((block) => block.kind !== "equation"),
    ...pendingBlocks.filter((block) => block.kind === "equation")
  ];

  for (const block of orderedBlocks) {
    const start = state.anchor + block.start;
    let end = state.anchor + block.end;
    const trailingText = getRangeTextSafe(state.doc, end, end + 1);

    if (trailingText === "\r" || trailingText === "\n") {
      end += 1;
    }

    if (end <= start) {
      continue;
    }

    try {
      const range = state.doc.Range(start, end);

      if (block.kind === "heading") {
        applyHeadingFormat(range, block.level);
        continue;
      }

      if (block.kind === "code") {
        applyCodeFormat(range);
        continue;
      }

      if (block.kind === "equation") {
        applyEquationFormat(range);
        continue;
      }

      applyParagraphFormat(range, block.kind, block.depth || 0);
    } catch {
      state.disabled = true;
      return;
    }
  }

  state.formattedBlockCount = state.blocks.length;
}

function applyInsertedBlockFormats(state) {
  state.formattedBlockCount = 0;
  applyPendingBlockFormats(state);
}

function normalizeNewlines(text) {
  return String(text ?? "")
    .replace(new RegExp(RAW_BREAK_PLACEHOLDER, "g"), "\n")
    .replace(new RegExp(RAW_CHECKED_PLACEHOLDER, "g"), "\u2611 ")
    .replace(new RegExp(RAW_UNCHECKED_PLACEHOLDER, "g"), "\u2610 ")
    .replace(new RegExp(`${RAW_SUP_START}(.*?)${RAW_SUP_END}`, "g"), "[$1]")
    .replace(new RegExp(`${RAW_SUB_START}(.*?)${RAW_SUB_END}`, "g"), "_$1")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<sup[^>]*>(.*?)<\/sup>/gi, "[$1]")
    .replace(/<sub[^>]*>(.*?)<\/sub>/gi, "_$1")
    .replace(/<\/(p|div|section|article|blockquote|h[1-6]|pre|ul|ol)>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<(li)(\s[^>]*)?>/gi, "• ")
    .replace(/<input[^>]*type=["']checkbox["'][^>]*checked[^>]*>/gi, "☑ ")
    .replace(/<input[^>]*type=["']checkbox["'][^>]*>/gi, "☐ ")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, `\n${HORIZONTAL_RULE_TEXT}\n`)
    .replace(/<(strong|b)>/gi, "")
    .replace(/<\/(strong|b)>/gi, "")
    .replace(/<(em|i)>/gi, "")
    .replace(/<\/(em|i)>/gi, "")
    .replace(/<(code|pre)>/gi, "")
    .replace(/<\/(code|pre)>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function normalizeMarkdownInput(text) {
  return String(text ?? "")
    .replace(/(^|\n)\s*\$\$([\s\S]*?)\$\$\s*(?=\n|$)/g, (_match, prefix, value) => {
      const body = String(value ?? "").trim();
      return `${prefix}${RAW_EQUATION_START}${body}${RAW_EQUATION_END}\n`;
    })
    .replace(/<br\s*\/?>/gi, RAW_BREAK_PLACEHOLDER)
    .replace(/<input[^>]*type=["']checkbox["'][^>]*checked[^>]*>/gi, `${RAW_CHECKED_PLACEHOLDER} `)
    .replace(/<input[^>]*type=["']checkbox["'][^>]*>/gi, `${RAW_UNCHECKED_PLACEHOLDER} `)
    .replace(/<sup[^>]*>(.*?)<\/sup>/gi, `${RAW_SUP_START}$1${RAW_SUP_END}`)
    .replace(/<sub[^>]*>(.*?)<\/sub>/gi, `${RAW_SUB_START}$1${RAW_SUB_END}`)
    .replace(/<(li)(\s[^>]*)?>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/?(ul|ol|p|div|section|article|blockquote)[^>]*>/gi, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, "\"");
}

function normalizeTableCellText(text) {
  return normalizeNewlines(text)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\s*\|\s*$/, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function parseMarkdownTableBlock(block) {
  const lines = String(block ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return null;
  }

  const separator = lines[1];
  if (!/^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(separator)) {
    return null;
  }

  const rows = lines
    .filter((line, index) => index !== 1)
    .map((line) =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim())
    )
    .filter((row) => row.length > 0);

  return rows.length >= 2 ? rows : null;
}

function extractMarkdownTables(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const tables = [];
  let buffer = [];
  let inCodeFence = false;

  function flushBuffer() {
    if (buffer.length === 0) {
      return;
    }

    const parsed = parseMarkdownTableBlock(buffer.join("\n"));
    if (parsed) {
      tables.push(parsed);
    }
    buffer = [];
  }

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      flushBuffer();
      continue;
    }

    if (inCodeFence) {
      flushBuffer();
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      buffer.push(line);
      continue;
    }

    flushBuffer();
  }

  flushBuffer();
  return tables;
}

function insertMarkdownTableFallbacks(state) {
  if (state.createdTableCount > 0) {
    return;
  }

  const currentCount = Number(state.doc?.Tables?.Count ?? 0);
  if (currentCount > state.initialTableCount) {
    return;
  }

  const tables = extractMarkdownTables(state.rawMarkdown);
  if (tables.length === 0) {
    return;
  }

  for (const rows of tables) {
    insertWpsTable(state, { rows });
    if (!state.disabled) {
      ensureBreaks(state, 1);
    }
  }
}

function insertEquationFallback(state, equationText) {
  const normalized = normalizeNewlines(equationText).trim();
  if (!normalized || state.cancelled || state.disabled) {
    return;
  }

  if ((state.position > 0 || state.pendingChars > 0) && state.trailingBreaks === 0) {
    ensureBreaks(state, 1);
  }

  const start = currentOutputOffset(state);
  queueText(state, normalized, INLINE_DEFAULTS, true);
  ensureBreaks(state, 1);

  const end = currentOutputOffset(state);
  if (end > start) {
    state.blocks.push({
      kind: "equation",
      start,
      end
    });
  }
}

function splitPlaceholderCarry(text) {
  const source = String(text ?? "");
  if (!source) {
    return {
      carry: "",
      safeText: ""
    };
  }

  let carryIndex = -1;

  for (const marker of RAW_TOKEN_MARKERS) {
    const markerLength = marker.length;
    for (let size = 1; size < markerLength; size += 1) {
      if (source.endsWith(marker.slice(0, size))) {
        carryIndex = Math.max(carryIndex, source.length - size);
      }
    }
  }

  for (const [startMarker, endMarker] of [
    [RAW_SUP_START, RAW_SUP_END],
    [RAW_SUB_START, RAW_SUB_END],
    [RAW_EQUATION_START, RAW_EQUATION_END]
  ]) {
    const startIndex = source.lastIndexOf(startMarker);
    if (startIndex >= 0 && source.indexOf(endMarker, startIndex + startMarker.length) === -1) {
      carryIndex = Math.max(carryIndex, startIndex);
    }
  }

  if (carryIndex < 0) {
    return {
      carry: "",
      safeText: source
    };
  }

  return {
    carry: source.slice(carryIndex),
    safeText: source.slice(0, carryIndex)
  };
}

function flushPlaceholderCarry(state) {
  if (!state.rawTextCarry) {
    return;
  }

  const remaining = state.rawTextCarry;
  state.rawTextCarry = "";
  appendText(state, remaining);

  if (state.rawTextCarry) {
    const unresolved = normalizeNewlines(state.rawTextCarry);
    state.rawTextCarry = "";
    if (unresolved) {
      appendText(state, unresolved);
    }
  }
}

function updateLineState(state, text) {
  const trailingMatch = String(text).match(/\r+$/);
  state.trailingBreaks = trailingMatch ? trailingMatch[0].length : 0;
  state.lineStart = state.trailingBreaks > 0;
}

function insertDirectText(state, text, style = null) {
  const normalized = String(text ?? "");
  if (!normalized || state.cancelled || state.disabled) {
    return;
  }

  const start = state.anchor + state.position;
  const end = start + normalized.length;

  state.doc.Range(start, start).InsertAfter(normalized);

  const range = state.doc.Range(start, end);
  applyBaseStyle(range, state.writeStyle);
  applyBaseParagraphFormat(range);

  if (style && !isDefaultStyle(style)) {
    applyTextStyle(range, style);
  }

  state.position += normalized.length;
  updateLineState(state, normalized);
  requestWpsViewportRefresh(state);
}

function ensureLeadingBreak(state) {
  if (state.replaceSelection || state.position > 0 || state.anchor <= 0) {
    return;
  }

  let previousText = "";
  try {
    previousText = String(state.doc.Range(state.anchor - 1, state.anchor).Text || "");
  } catch {
    previousText = "";
  }

  if (!previousText || previousText === "\r" || previousText === "\n") {
    return;
  }

  insertDirectText(state, "\r");
}

function restoreCaretStyle(state) {
  const app = getApplication();
  const caret = state.doc.Range(state.anchor + state.position, state.anchor + state.position);

  applyBaseStyle(caret, state.baseStyle);

  try {
    app?.Selection?.SetRange(state.anchor + state.position, state.anchor + state.position);
    const selectionRange = getSelectionRange(app);
    if (selectionRange) {
      applyBaseStyle(selectionRange, state.baseStyle);
    }
  } catch {
    // Some hosts may not expose a mutable selection range.
  }
}

function ensureWriteTarget(state) {
  if (state.startedWriting || state.cancelled || state.disabled) {
    return;
  }

  if (state.replaceSelection && state.selectionEnd > state.selectionStart) {
    state.doc.Range(state.selectionStart, state.selectionEnd).Text = "";
  }

  ensureLeadingBreak(state);
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
    applyBaseStyle(batchRange, state.writeStyle);
    applyBaseParagraphFormat(batchRange);

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
    applyPendingBlockFormats(state);
    requestWpsViewportRefresh(state);
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

function consumeLinePrefix(state) {
  if (!state.lineStart || state.cancelled || state.disabled) {
    return;
  }

  const quoteDepth = state.stack.filter((entry) => entry.type === BLOCKQUOTE).length;
  const listItemDepth = state.stack.filter((entry) => entry.type === LIST_ITEM).length;
  const listItem = findLastContext(state, (entry) => entry.type === LIST_ITEM);
  const heading = findLastContext(state, (entry) => Boolean(entry.headingPrefixPending));

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

  if (heading?.headingPrefixPending) {
    prefix += heading.headingMarker || "";
    heading.headingPrefixPending = false;
  }

  if (prefix) {
    queueText(state, prefix, currentTextStyle(state));
  }
}

function queueCodeLineNumber(state, codeBlock) {
  if (!codeBlock) {
    return;
  }

  if (!Number.isFinite(codeBlock.codeLineNumber)) {
    codeBlock.codeLineNumber = 1;
  }

  const label = String(codeBlock.codeLineNumber).padStart(CODE_LINE_NUMBER_MIN_WIDTH, " ");
  codeBlock.codeLineNumber += 1;
  codeBlock.codeLineStart = false;

  queueText(state, `${label}${CODE_LINE_NUMBER_SEPARATOR}`, {
    ...INLINE_DEFAULTS,
    code: true,
    color: cssColorToWpsColor(CODE_LINE_NUMBER_COLOR)
  });
}

function queueHighlightedCodeRun(state, codeBlock, text, color) {
  const source = normalizeNewlines(text);
  if (!source) {
    return;
  }

  let remaining = source;
  while (remaining.length > 0) {
    if (codeBlock?.codeLineStart) {
      queueCodeLineNumber(state, codeBlock);
    }

    const newlineIndex = remaining.indexOf("\n");
    const segment = newlineIndex >= 0 ? remaining.slice(0, newlineIndex) : remaining;

    if (segment) {
      queueText(state, segment, {
        ...INLINE_DEFAULTS,
        code: true,
        color
      });
    }

    if (newlineIndex < 0) {
      break;
    }

    queueText(state, "\r", INLINE_DEFAULTS, true);
    if (codeBlock) {
      codeBlock.codeLineStart = true;
    }
    remaining = remaining.slice(newlineIndex + 1);
  }
}

function appendHighlightedCodeText(state, text, language, codeBlock = null) {
  if (codeBlock && !Number.isFinite(codeBlock.codeLineNumber)) {
    codeBlock.codeLineNumber = 1;
    codeBlock.codeLineStart = true;
  }

  const runs = createHighlightedCodeRuns(text, language);

  for (const run of runs) {
    if (!run.text) {
      continue;
    }

    queueHighlightedCodeRun(state, codeBlock, run.text, run.color);
  }
}

function appendText(state, text) {
  const combined = `${state.rawTextCarry || ""}${String(text ?? "")}`;
  const { carry, safeText } = splitPlaceholderCarry(combined);
  state.rawTextCarry = carry;

  const normalized = normalizeNewlines(safeText);
  if (!normalized || state.disabled) {
    return;
  }

  const equationPattern = new RegExp(`${RAW_EQUATION_START}(.*?)${RAW_EQUATION_END}`, "g");
  let cursor = 0;
  let match = equationPattern.exec(normalized);

  if (match) {
    do {
      const plainText = normalized.slice(cursor, match.index);
      if (plainText) {
        appendText(state, plainText);
      }

      insertEquationFallback(state, match[1]);
      cursor = match.index + match[0].length;
      match = equationPattern.exec(normalized);
    } while (match);

    const tail = normalized.slice(cursor);
    if (tail) {
      appendText(state, tail);
    }
    return;
  }

  const codeBlock = activeCodeBlockContext(state);
  if (codeBlock) {
    appendHighlightedCodeText(state, normalized, codeBlock.attrs?.get(Attr.Lang), codeBlock);
    return;
  }

  const tableCell = activeTableCellContext(state);
  if (tableCell) {
    tableCell.text = `${tableCell.text || ""}${normalized}`;
    return;
  }

  const parts = normalized.split("\n");
  const style = currentTextStyle(state);
  const quote = findLastContext(state, (entry) => entry.type === BLOCKQUOTE);

  parts.forEach((part, index) => {
    let textPart = part;
    if (quote) {
      textPart = textPart.replace(/^>\s?/, "");
    }

    if (textPart) {
      consumeLinePrefix(state);
      queueText(state, textPart, style);
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
      context.rows = [];
      break;
    case TABLE_ROW: {
      const table = activeTableContext(state);
      if (table) {
        table.rows.push([]);
      }
      break;
    }
    case TABLE_CELL: {
      const row = activeTableRowContext(state);
      const table = activeTableContext(state);
      const currentRow = table?.rows?.[table.rows.length - 1];
      context.text = "";
      if (row && currentRow) {
        currentRow.push("");
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
      if (HEADING_LEVELS[type]) {
        context.headingMarker = createHeadingMarker(state, HEADING_LEVELS[type]);
        context.headingPrefixPending = true;
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

  beginBlock(state, context);
  state.stack.push(context);

  if (type === RULE) {
    consumeLinePrefix(state);
    queueText(state, HORIZONTAL_RULE_TEXT, INLINE_DEFAULTS, true);
    ensureBreaks(state, 1);
  }
}

function popToken(state) {
  const context = state.stack.pop();
  if (!context) {
    return;
  }

  if (context.type === TABLE_CELL) {
    const table = activeTableContext(state);
    const currentRow = table?.rows?.[table.rows.length - 1];
    if (currentRow && currentRow.length > 0) {
      currentRow[currentRow.length - 1] = context.text || "";
    }
  } else if (context.type === TABLE) {
    insertWpsTable(state, context);
  } else {
    finishBlock(state, context);
  }

  if (state.pendingChars === 0) {
    applyPendingBlockFormats(state);
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
    write() {},
    finish() {},
    cancel() {}
  };
}

function createSinkRenderer(state) {
  return {
    data: state,
    add_token: pushToken,
    end_token: popToken,
    add_text: appendText,
    set_attr: setTokenAttr
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

  const title = String(doc.Name ?? "").trim() || "Untitled Document";
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
  const writeStyle = createPaperBodyStyle();
  const selectionStart = Number(selectionRange.Start);
  const selectionEnd = Number(selectionRange.End);
  const originalText = String(selectionRange.Text || "");
  const anchor = resolveDocumentAppendAnchor(doc);

  const rendererState = {
    anchor,
    baseStyle,
    cancelled: false,
    createdTableCount: 0,
    disabled: false,
    doc,
    flushTimer: null,
    lastRefreshAt: 0,
    headingCounters: [0, 0, 0, 0, 0, 0],
    initialTableCount: Number(doc?.Tables?.Count ?? 0),
    lineStart: true,
    blocks: [],
    pendingChars: 0,
    pendingRuns: [],
    position: 0,
    formattedBlockCount: 0,
    replaceSelection: Boolean(replaceSelection),
    rawMarkdown: "",
    rawTextCarry: "",
    refreshTimer: null,
    debugError: "",
    selectionEnd,
    selectionStart,
    stack: [],
    startedWriting: false,
    trailingBreaks: 0,
    writeStyle
  };
  const parser = createParser(createSinkRenderer(rendererState));
  let ended = false;

  return {
    debugState: rendererState,
    locationLabel: replaceSelection ? "Replace selection" : "Insert at cursor",
    write(chunk) {
      if (rendererState.cancelled || rendererState.disabled || ended) {
        return;
      }

      const text = normalizeMarkdownInput(chunk);
      if (!text) {
        return;
      }

      rendererState.rawMarkdown += String(chunk ?? "");
      parser_write(parser, text);
    },
    finish() {
      if (rendererState.cancelled || ended) {
        return;
      }

      parser_end(parser);
      ended = true;
      flushPlaceholderCarry(rendererState);
      flushPending(rendererState);
      if (
        !rendererState.cancelled &&
        !rendererState.disabled &&
        rendererState.startedWriting &&
        !rendererState.replaceSelection &&
        rendererState.trailingBreaks === 0
      ) {
        insertDirectText(rendererState, "\r");
      }
      insertMarkdownTableFallbacks(rendererState);
      applyInsertedBlockFormats(rendererState);
      restoreCaretStyle(rendererState);
      requestWpsViewportRefresh(rendererState, true);
    },
    cancel() {
      rendererState.cancelled = true;
      ended = true;
      rendererState.pendingRuns = [];
      rendererState.pendingChars = 0;
      clearFlushTimer(rendererState);
      clearRefreshTimer(rendererState);

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
