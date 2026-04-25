import { Children, isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
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

export default function StreamingMarkdown({ content, streaming }) {
  const markdown = String(content ?? "");

  if (!markdown) {
    return <div className="bubble-placeholder">{streaming ? "..." : ""}</div>;
  }

  return (
    <div className="bubble-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeRaw, rehypeKatex, rehypeHighlight]}
        components={{
          a(props) {
            return <a {...props} target="_blank" rel="noreferrer" />;
          },
          code({ className, children, node, ...props }) {
            const value = flattenText(Children.toArray(children));
            const isBlock = /\blanguage-/.test(className || "") || value.includes("\n");

            if (isBlock) {
              return (
                <code className={className} {...props}>
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
