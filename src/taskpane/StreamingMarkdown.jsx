import { Children, isValidElement, useMemo, useState } from "react";
import hljs, { normalizeCodeLanguage } from "./codeHighlighter";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "highlight.js/styles/github.css";
import "katex/dist/katex.min.css";

function flattenText(node) {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((item) => flattenText(item)).join("");
  }

  if (isValidElement(node)) {
    return flattenText(node.props?.children);
  }

  return "";
}

function normalizeLanguage(className = "") {
  const match = String(className).match(/\blanguage-([\w-]+)/);
  return normalizeCodeLanguage(match?.[1]);
}

function highlightCode(code, language) {
  try {
    if (language && language !== "text" && hljs.getLanguage(language)) {
      return hljs.highlight(code, {
        ignoreIllegals: true,
        language
      }).value;
    }

    return hljs.highlightAuto(code).value;
  } catch {
    return hljs.highlight(code, {
      ignoreIllegals: true,
      language: "plaintext"
    }).value;
  }
}

function CodeBlock({ className, code }) {
  const language = useMemo(() => normalizeLanguage(className), [className]);
  const html = useMemo(() => highlightCode(code, language), [code, language]);
  const [copied, setCopied] = useState(false);

  async function copyCode() {
    try {
      await navigator.clipboard?.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="chat-code-block">
      <div className="chat-code-toolbar">
        <span>{language}</span>
        <button type="button" onClick={copyCode}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="chat-code-content">
        <code
          className={`hljs language-${language}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    </div>
  );
}

export default function StreamingMarkdown({ content, streaming }) {
  const markdown = String(content ?? "");

  if (!markdown) {
    return <div className="bubble-placeholder">{streaming ? "..." : ""}</div>;
  }

  return (
    <div className="bubble-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeRaw, rehypeKatex]}
        components={{
          a(props) {
            return <a {...props} target="_blank" rel="noreferrer" />;
          },
          pre({ children }) {
            const child = Children.toArray(children).find(isValidElement);
            if (child?.props?.["data-code-block"]) {
              return (
                <CodeBlock
                  className={child.props.className || ""}
                  code={child.props["data-code-value"] || ""}
                />
              );
            }

            return <pre>{children}</pre>;
          },
          code({ className, children, node, ...props }) {
            const value = flattenText(Children.toArray(children));
            const isBlock = /\blanguage-/.test(className || "") || value.includes("\n");

            if (isBlock) {
              return (
                <code
                  className={className}
                  data-code-block="true"
                  data-code-value={value.replace(/\n$/, "")}
                  {...props}
                >
                  {value.replace(/\n$/, "")}
                </code>
              );
            }

            return (
              <code {...props}>
                {value}
              </code>
            );
          }
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
