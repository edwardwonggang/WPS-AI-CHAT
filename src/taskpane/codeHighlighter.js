import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import csharp from "highlight.js/lib/languages/csharp";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dos from "highlight.js/lib/languages/dos";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const REGISTERED_LANGUAGES = {
  bash,
  csharp,
  cpp,
  css,
  diff,
  dos,
  go,
  java,
  javascript,
  json,
  markdown,
  plaintext,
  powershell,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml
};

for (const [name, language] of Object.entries(REGISTERED_LANGUAGES)) {
  hljs.registerLanguage(name, language);
}

export function normalizeCodeLanguage(language) {
  const normalized = String(language || "").trim().toLowerCase();
  if (!normalized) {
    return "plaintext";
  }

  const aliases = {
    c: "cpp",
    "c++": "cpp",
    bash: "bash",
    cjs: "javascript",
    cmd: "dos",
    cs: "csharp",
    html: "xml",
    js: "javascript",
    jsx: "javascript",
    md: "markdown",
    mjs: "javascript",
    ps1: "powershell",
    py: "python",
    shell: "bash",
    sh: "bash",
    text: "plaintext",
    ts: "typescript",
    tsx: "typescript",
    xml: "xml",
    yml: "yaml"
  };

  return aliases[normalized] || normalized;
}

export default hljs;
