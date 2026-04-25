import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import StreamingMarkdown from "../taskpane/StreamingMarkdown";
import "../taskpane/styles.css";
import { createWpsMarkdownSink } from "../taskpane/wps";

const TABLE_MARKER = "\uFFF0";

function hasEffectiveTextStyle(output, text, predicate) {
  const start = output.stream.indexOf(text);
  if (start < 0) {
    return false;
  }

  const end = start + text.length;
  const fonts = Array.from({ length: text.length }, () => ({}));

  for (const record of output.ranges) {
    const from = Math.max(start, record.start);
    const to = Math.min(end, record.end);
    if (to <= from) {
      continue;
    }

    for (let index = from; index < to; index += 1) {
      Object.assign(fonts[index - start], record.font);
    }
  }

  return fonts.length > 0 && fonts.every(predicate);
}

const SAMPLES = [
  {
    id: "heading-paragraph",
    label: "Heading and Body",
    markdown:
      "# Primary Heading\n\n## Secondary Heading\n\n### Third Heading\n\nThis is the first body paragraph used to verify standard paragraph formatting with **bold text** and *italic text*.",
    verifyChat(root) {
      return Boolean(root.querySelector("h1") && root.querySelector("p"));
    },
    verifyWps(output) {
      return (
        output.stream.includes("1 Primary Heading") &&
        output.stream.includes("1.1 Secondary Heading") &&
        output.stream.includes("1.1.1 Third Heading") &&
        output.stream.includes("first body paragraph") &&
        hasEffectiveTextStyle(output, "bold text", (font) => font.Bold === 1) &&
        hasEffectiveTextStyle(output, "italic text", (font) => font.Italic === 1) &&
        output.ranges.some(
          (record) =>
            record.paragraph.Alignment === 0 &&
            Number(record.font.Size) === 16 &&
            record.font.Name === "SimHei"
        ) &&
        output.ranges.some(
          (record) =>
            record.paragraph.Alignment === 0 &&
            record.paragraph.CharacterUnitFirstLineIndent === 2 &&
            record.paragraph.LineSpacing === 20 &&
            record.font.Name === "SimSun"
        )
      );
    }
  },
  {
    id: "task-list",
    label: "Task List",
    markdown: "- [x] Completed item\n- [ ] Pending item\n  - Child item",
    verifyChat(root) {
      return root.querySelectorAll('input[type="checkbox"]').length === 2;
    },
    verifyWps(output) {
      return (
        /☑\s+Completed item/.test(output.stream) &&
        /☐\s+Pending item/.test(output.stream) &&
        output.ranges.some(
          (record) =>
            record.paragraph.CharacterUnitLeftIndent === 2 &&
            record.paragraph.CharacterUnitFirstLineIndent === -2
        )
      );
    }
  },
  {
    id: "blockquote-rule",
    label: "Blockquote and Rule",
    markdown: "> This is quoted content\n>\n> Second quote line\n\n---",
    verifyChat(root) {
      return Boolean(root.querySelector("blockquote") && root.querySelector("hr"));
    },
    verifyWps(output) {
      return (
        output.stream.includes("This is quoted content") &&
        output.stream.includes("----------------") &&
        output.ranges.some((record) => record.paragraph.CharacterUnitLeftIndent === 2)
      );
    }
  },
  {
    id: "code-math",
    label: "Code and Math",
    markdown:
      "Inline math $a^2+b^2=c^2$.\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n\n$$E=mc^2$$",
    verifyChat(root) {
      return Boolean(root.querySelector(".katex") && root.querySelector("pre code"));
    },
    verifyWps(output) {
      return (
        output.stream.includes("E=mc^2") &&
        output.stream.includes(" 1   const x = 1;") &&
        output.ranges.some((record) => record.font.Name === "Consolas") &&
        output.ranges.some((record) => Number.isFinite(record.font.Color)) &&
        output.ranges.some((record) => record.paragraph.Alignment === 1)
      );
    }
  },
  {
    id: "table-break",
    label: "Table and Line Break",
    markdown:
      "| **Person** | `Role` |\n| --- | --- |\n| Gattuso | **Patriarch**<br>Current: effective leader of the New Secret Party |\n| Vito | Elder |",
    verifyChat(root) {
      return Boolean(root.querySelector("td br"));
    },
    verifyWps(output) {
      return (
        output.tables.length === 1 &&
        output.tables[0].rows.length === 3 &&
        output.tables[0].rows[0].cells.length === 2 &&
        output.tables[0].rows[0].cells[0].font.Bold === 1 &&
        Number(output.tables[0].rows[0].cells[0].font.Size) === 10.5 &&
        output.tables[0].autoFitBehavior === 2 &&
        output.tables[0].preferredWidth === 100 &&
        output.tables[0].rows[0].cells[0].text === "Person" &&
        output.tables[0].rows[0].cells[1].text === "Role" &&
        output.tables[0].rows[1].cells[0].paragraph.Alignment === 1 &&
        output.tables[0].rows[1].cells[1].text.includes("Patriarch") &&
        !output.tables[0].rows[1].cells[1].text.includes("**") &&
        output.tables[0].rows[1].cells[1].text.includes("\n")
      );
    }
  },
  {
    id: "raw-html",
    label: "Raw HTML",
    markdown:
      "<ul><li>Alpha</li><li>Beta</li></ul><p>Paragraph content</p><sup>1</sup><input type=\"checkbox\" checked />",
    verifyChat(root) {
      return Boolean(root.querySelectorAll("li").length === 2 && root.querySelector("sup"));
    },
    verifyWps(output) {
      return (
        output.stream.includes("• Alpha") &&
        output.stream.includes("• Beta") &&
        output.stream.includes("[1]") &&
        output.stream.includes("☑")
      );
    }
  }
];

function createMutableState(initial = {}) {
  return new Proxy(initial, {
    get(target, key) {
      return target[key];
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    }
  });
}

class FakeRange {
  constructor(doc, start, end, formatRecord) {
    this.doc = doc;
    this.start = start;
    this.end = end;
    this.record = formatRecord;
    this.fontState = formatRecord.font;
    this.paragraphState = formatRecord.paragraph;
    this.fontProxy = createMutableState(this.fontState);
    this.paragraphProxy = createMutableState(this.paragraphState);
  }

  get Font() {
    return this.fontProxy;
  }

  get ParagraphFormat() {
    return this.paragraphProxy;
  }

  get Underline() {
    return this.record.underline || 0;
  }

  set Underline(value) {
    this.record.underline = value;
  }

  get Text() {
    return this.doc.getText(this.start, this.end);
  }

  set Text(value) {
    this.doc.replaceText(this.start, this.end, String(value ?? ""));
    this.end = this.start + String(value ?? "").length;
  }

  InsertAfter(value) {
    const text = String(value ?? "");
    this.doc.insertText(this.start, text);
    this.end = this.start + text.length;
  }
}

class FakeCellRange {
  constructor(cell) {
    this.cell = cell;
    this.fontProxy = createMutableState(cell.format.font);
    this.paragraphProxy = createMutableState(cell.format.paragraph);
  }

  get Font() {
    return this.fontProxy;
  }

  get ParagraphFormat() {
    return this.paragraphProxy;
  }

  get Underline() {
    return this.cell.format.underline || 0;
  }

  set Underline(value) {
    this.cell.format.underline = value;
  }

  get Text() {
    return this.cell.text;
  }

  set Text(value) {
    this.cell.text = String(value ?? "");
  }
}

class FakeDocument {
  constructor() {
    this.stream = "";
    this.rangeRecords = [];
    this.tables = [];
    this.ActiveWindow = {
      Selection: {
        Range: null
      }
    };
    const self = this;
    this.Tables = {
      get Count() {
        return self.tables.length;
      },
      Add: (range, rowCount, columnCount) => this.addTable(range, rowCount, columnCount)
    };
  }

  get Content() {
    return {
      End: this.stream.length + 1
    };
  }

  getText(start, end) {
    return this.stream.slice(start, end);
  }

  insertText(index, value) {
    this.stream = `${this.stream.slice(0, index)}${value}${this.stream.slice(index)}`;
  }

  replaceText(start, end, value) {
    this.stream = `${this.stream.slice(0, start)}${value}${this.stream.slice(end)}`;
  }

  Range(start, end) {
    const record = {
      end,
      font: {},
      paragraph: {},
      start,
      underline: 0
    };
    this.rangeRecords.push(record);
    return new FakeRange(this, start, end, record);
  }

  addTable(range, rowCount, columnCount) {
    const start = range.start;
    const rows = Array.from({ length: rowCount }, () =>
      Array.from({ length: columnCount }, () => ({
        format: {
          font: {},
          paragraph: {},
          underline: 0
        },
        text: ""
      }))
    );
    const table = {
      autoFitBehavior: null,
      Borders: {
        Enable: 0
      },
      AutoFitBehavior(value) {
        this.autoFitBehavior = value;
      },
      Cell: (row, column) => ({
        Range: new FakeCellRange(rows[row - 1][column - 1])
      }),
      preferredWidth: null,
      preferredWidthType: null,
      get PreferredWidth() {
        return this.preferredWidth;
      },
      set PreferredWidth(value) {
        this.preferredWidth = value;
      },
      get PreferredWidthType() {
        return this.preferredWidthType;
      },
      set PreferredWidthType(value) {
        this.preferredWidthType = value;
      },
      Range: {
        End: start + 1
      },
      rows
    };

    this.stream = `${this.stream.slice(0, start)}${TABLE_MARKER}${this.stream.slice(start)}`;
    this.tables.push(table);
    return table;
  }
}

class FakeSelection {
  constructor(doc) {
    this.doc = doc;
    this.range = doc.Range(0, 0);
  }

  get Range() {
    return this.range;
  }

  SetRange(start, end) {
    this.range = this.doc.Range(start, end);
  }
}

function runWpsSample(markdown) {
  const previousApp = window.Application;
  const doc = new FakeDocument();
  const selection = new FakeSelection(doc);
  doc.ActiveWindow.Selection.Range = selection.Range;
  window.Application = {
    ActiveDocument: doc,
    Selection: selection
  };

  try {
    const sink = createWpsMarkdownSink();
    sink.write(markdown);
    sink.finish();
    var debugError = sink.debugState?.debugError || "";
  } finally {
    if (previousApp === undefined) {
      delete window.Application;
    } else {
      window.Application = previousApp;
    }
  }

  return {
    debugError,
    ranges: doc.rangeRecords.map((record) => ({
      end: record.end,
      font: { ...record.font },
      paragraph: { ...record.paragraph },
      start: record.start,
      underline: record.underline || 0
    })),
    stream: doc.stream.replaceAll(TABLE_MARKER, "[TABLE]"),
    tables: doc.tables.map((table) => ({
      autoFitBehavior: table.autoFitBehavior,
      preferredWidth: table.preferredWidth,
      preferredWidthType: table.preferredWidthType,
      rows: table.rows.map((row) => ({
        cells: row.map((cell) => ({
          font: { ...cell.format.font },
          paragraph: { ...cell.format.paragraph },
          text: cell.text,
          underline: cell.format.underline || 0
        }))
      }))
    }))
  };
}

function App() {
  const wpsOutputs = useMemo(
    () =>
      Object.fromEntries(SAMPLES.map((sample) => [sample.id, runWpsSample(sample.markdown)])),
    []
  );
  const [results, setResults] = useState(null);

  useEffect(() => {
    const nextResults = SAMPLES.map((sample) => {
      const root = document.querySelector(`[data-chat-sample="${sample.id}"]`);
      const chatPassed = sample.verifyChat(root);
      const wpsPassed = sample.verifyWps(wpsOutputs[sample.id]);

      return {
        chatPassed,
        id: sample.id,
        label: sample.label,
        wpsPassed
      };
    });

    const summary = {
      allPassed: nextResults.every((item) => item.chatPassed && item.wpsPassed),
      results: nextResults,
      wpsOutputs
    };

    window.__SMOKE_RESULTS__ = summary;
    setResults(summary);
  }, [wpsOutputs]);

  return (
    <main
      style={{
        background: "#f3f4f6",
        color: "#111827",
        fontFamily:
          '"SF Pro Text", "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif',
        minHeight: "100vh",
        padding: 24
      }}
    >
      <h1 style={{ margin: "0 0 12px" }}>Render Smoke</h1>
      <p style={{ margin: "0 0 20px", color: "#4b5563" }}>
        Automatically verifies common format samples for both AI chat rendering and the WPS writer renderer.
      </p>

      <section
        style={{
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 16,
          marginBottom: 20,
          padding: 16
        }}
      >
        <div id="smoke-status" style={{ fontWeight: 700 }}>
          {results ? (results.allPassed ? "PASS" : "FAIL") : "RUNNING"}
        </div>
      </section>

      <script
        id="smoke-json"
        type="application/json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(results ?? { allPassed: false, pending: true })
        }}
      />

      <div style={{ display: "grid", gap: 18 }}>
        {SAMPLES.map((sample) => {
          const result = results?.results.find((item) => item.id === sample.id);
          const wpsOutput = wpsOutputs[sample.id];

          return (
            <section
              key={sample.id}
              style={{
                background: "#fff",
                border: "1px solid #e5e7eb",
                borderRadius: 18,
                overflow: "hidden"
              }}
            >
              <header
                style={{
                  alignItems: "center",
                  borderBottom: "1px solid #e5e7eb",
                  display: "flex",
                  gap: 12,
                  justifyContent: "space-between",
                  padding: "14px 16px"
                }}
              >
                <strong>{sample.label}</strong>
                <span data-result={sample.id} style={{ color: "#374151", fontSize: 12 }}>
                  {result
                    ? `chat:${result.chatPassed ? "pass" : "fail"} | wps:${
                        result.wpsPassed ? "pass" : "fail"
                      }`
                    : "pending"}
                </span>
              </header>

              <div
                style={{
                  display: "grid",
                  gap: 0,
                  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)"
                }}
              >
                <div style={{ borderRight: "1px solid #e5e7eb", padding: 16 }}>
                  <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 10 }}>
                    AI chat rendering
                  </div>
                  <div className="bubble" data-chat-sample={sample.id}>
                    <StreamingMarkdown content={sample.markdown} streaming={false} />
                  </div>
                </div>

                <div style={{ padding: 16 }}>
                  <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 10 }}>
                    WPS writer output
                  </div>
                  <pre
                    data-wps-sample={sample.id}
                    style={{
                      background: "#f8fafc",
                      border: "1px solid #e5e7eb",
                      borderRadius: 12,
                      fontFamily: '"Cascadia Code", Consolas, monospace',
                      fontSize: 12,
                      lineHeight: 1.55,
                      margin: 0,
                      overflow: "auto",
                      padding: 12,
                      whiteSpace: "pre-wrap"
                    }}
                  >
                    {JSON.stringify(wpsOutput, null, 2)}
                  </pre>
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
