import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_BOOK_ROOT = "test-artifacts/novel-book";
const DEFAULT_CONFIG_PATH = "server/novel.config.local.json";
const FALLBACK_CONFIG_PATH = "server/novel.config.example.json";
const RELAY_CONFIG_PATH = "server/relay.config.json";
const CURL_BIN = process.platform === "win32" ? "curl.exe" : "curl";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function readJson(path, fallback = {}) {
  if (!existsSync(path)) {
    return fallback;
  }
  return JSON.parse(readText(path));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function loadConfig(configPath) {
  const localConfig = readJson(configPath, null);
  if (localConfig && Object.keys(localConfig).length > 0) {
    return localConfig;
  }
  return readJson(FALLBACK_CONFIG_PATH, {});
}

function trimTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function resolveProxyUrl(config) {
  const relayConfig = readJson(RELAY_CONFIG_PATH, {});
  return String(
    config?.openai?.proxyUrl ||
      config?.proxyUrl ||
      relayConfig?.proxyUrl ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      ""
  ).trim();
}

function runCurlJson({ url, apiKey, body, proxyUrl }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      "-sS",
      "-X",
      "POST",
      "-H",
      `Authorization: Bearer ${apiKey}`,
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      "@-"
    ];

    if (proxyUrl) {
      args.push("--proxy", proxyUrl);
    }

    args.push(url);

    const curl = spawn(CURL_BIN, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    curl.on("error", (error) => {
      rejectPromise(error instanceof Error ? error : new Error("Failed to start curl"));
    });

    curl.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    curl.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    curl.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error((stderr || stdout || `curl exited with code ${code}`).trim()));
        return;
      }

      try {
        const payload = stdout ? JSON.parse(stdout) : {};
        if (payload?.error?.message) {
          rejectPromise(new Error(payload.error.message));
          return;
        }
        resolvePromise(payload);
      } catch (error) {
        rejectPromise(new Error(`Non-JSON API response: ${error.message}`));
      }
    });

    curl.stdin.end(body);
  });
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") {
        parts.push(part.text);
      } else if (typeof part?.output_text === "string") {
        parts.push(part.output_text);
      }
    }
  }
  if (parts.join("").trim()) {
    return parts.join("").trim();
  }

  const chatText = payload?.choices?.[0]?.message?.content;
  if (typeof chatText === "string") {
    return chatText.trim();
  }

  return "";
}

async function callTextModel({ config, prompt }) {
  const apiKeyEnv = String(config?.openai?.apiKeyEnv || "OPENAI_API_KEY");
  const apiKey = String(process.env[apiKeyEnv] || "").trim();
  if (!apiKey) {
    throw new Error(`${apiKeyEnv} is not set.`);
  }

  const baseUrl = trimTrailingSlash(
    process.env.OPENAI_BASE_URL ||
      process.env.OPENAI_API_BASE_URL ||
      config?.openai?.baseUrl ||
      "https://api.openai.com/v1"
  );
  const model = String(process.env.OPENAI_TEXT_MODEL || config?.models?.chat || "gpt-5.4");
  const proxyUrl = resolveProxyUrl(config);

  const responsesBody = JSON.stringify({
    model,
    input: [
      {
        role: "system",
        content:
          "You are writing an original Chinese modern fantasy novel. Do not use existing franchise names, characters, organizations, or direct plotlines. Maintain continuity, cinematic detail, and clean prose."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    max_output_tokens: 9000
  });

  try {
    const payload = await runCurlJson({
      url: `${baseUrl}/responses`,
      apiKey,
      body: responsesBody,
      proxyUrl
    });
    const text = extractResponseText(payload);
    if (text) {
      return text;
    }
  } catch (error) {
    if (/unauthorized|invalid api key|incorrect api key|401/i.test(error.message || "")) {
      throw error;
    }
    console.warn(`RESPONSES_FALLBACK=${error.message}`);
  }

  const chatBody = JSON.stringify({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are writing an original Chinese modern fantasy novel. Do not use existing franchise names, characters, organizations, or direct plotlines. Maintain continuity, cinematic detail, and clean prose."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    max_tokens: 9000,
    temperature: 0.8
  });

  const payload = await runCurlJson({
    url: `${baseUrl}/chat/completions`,
    apiKey,
    body: chatBody,
    proxyUrl
  });
  const text = extractResponseText(payload);
  if (!text) {
    throw new Error("Text model returned no chapter text.");
  }
  return text;
}

function parseOutline(outlineText) {
  const entries = [];
  const pattern = /^(\d+)\.\s+([^：:]+)[：:]\s*(.+)$/gm;
  let match;
  while ((match = pattern.exec(outlineText)) !== null) {
    entries.push({
      number: Number(match[1]),
      title: match[2].trim(),
      brief: match[3].trim()
    });
  }
  return entries;
}

function chapterPath(bookRoot, number) {
  return resolve(bookRoot, "chapters", `chapter-${String(number).padStart(3, "0")}.md`);
}

function existingChapterNumbers(bookRoot) {
  const chapterDir = resolve(bookRoot, "chapters");
  if (!existsSync(chapterDir)) {
    return [];
  }
  return readdirSync(chapterDir)
    .map((name) => name.match(/^chapter-(\d+)\.md$/)?.[1])
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
}

function recentContext(bookRoot, currentNumber) {
  const numbers = existingChapterNumbers(bookRoot)
    .filter((number) => number < currentNumber)
    .slice(-2);

  return numbers
    .map((number) => {
      const text = readText(chapterPath(bookRoot, number));
      return `Chapter ${number} excerpt:\n${text.slice(-1800)}`;
    })
    .join("\n\n");
}

function buildChapterPrompt({ bookRoot, chapter, outlineEntries }) {
  const bible = readText(resolve(bookRoot, "book-bible.md"));
  const visualBible = readText(resolve(bookRoot, "visual-bible.md"));
  const previous = recentContext(bookRoot, chapter.number);
  const nearby = outlineEntries
    .filter((entry) => entry.number >= chapter.number && entry.number <= chapter.number + 2)
    .map((entry) => `${entry.number}. ${entry.title}: ${entry.brief}`)
    .join("\n");

  return [
    "Write the next chapter in Chinese Markdown.",
    "Length target: 4200 to 5600 Chinese characters.",
    `Chapter: ${chapter.number}. ${chapter.title}`,
    `Chapter brief: ${chapter.brief}`,
    "Output only the chapter Markdown. Start with exactly one H1 heading.",
    "Do not summarize. Do not add notes. Do not mention prompts or outlines.",
    "Keep continuity with the recent context, but do not repeat scenes.",
    "Book bible:",
    bible,
    "Visual bible:",
    visualBible,
    "Nearby outline:",
    nearby,
    "Recent context:",
    previous || "(This is the opening sequence.)"
  ].join("\n\n");
}

function ensureChapterHeading(text, chapter) {
  const trimmed = String(text || "").trim();
  if (/^#\s+/.test(trimmed)) {
    return `${trimmed}\n`;
  }
  return `# 第${chapter.number}章 ${chapter.title}\n\n${trimmed}\n`;
}

function appendImagePlan(manifest, chapter) {
  const planned = Array.isArray(manifest.planned) ? manifest.planned : [];
  const id = `ch${String(chapter.number).padStart(3, "0")}-001`;
  if (planned.some((item) => item.id === id) || manifest?.styleAnchor?.id === id) {
    return manifest;
  }

  planned.push({
    id,
    chapter: chapter.number,
    caption: `图 ${chapter.number}-1 ${chapter.title}`,
    status: "planned",
    path: `images/${id}.png`,
    prompt:
      "Original modern fantasy novel illustration, cinematic realism, 4K landscape, rain-soaked coastal city and hidden academy atmosphere, cold cyan rain, warm amber interior lights, wet asphalt reflections, old copper highlights. Scene: " +
      `${chapter.title}; ${chapter.brief}. ` +
      "Keep the visual language consistent with the established style anchor. No text, no watermark, no existing franchise symbols, no anime exaggeration."
  });
  manifest.planned = planned;
  return manifest;
}

function runImageGeneration({ item, bookRoot, config }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const outputPath = resolve(bookRoot, item.path);
    const args = [
      "scripts/generate-novel-image.mjs",
      "--label",
      item.id,
      "--out",
      outputPath,
      "--size",
      String(config?.image?.size || "3840x2160"),
      "--quality",
      String(config?.image?.quality || "high"),
      "--stream",
      "--partial-images",
      "1",
      "--prompt",
      item.prompt
    ];

    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      rejectPromise(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error((stderr || stdout || `image generation exited ${code}`).trim()));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

async function generateChapters({ bookRoot, config, count }) {
  const outlineEntries = parseOutline(readText(resolve(bookRoot, "outline.md")));
  const progressPath = resolve(bookRoot, "progress.json");
  const manifestPath = resolve(bookRoot, "image-manifest.json");
  const progress = readJson(progressPath, {});
  let manifest = readJson(manifestPath, {});
  let generated = 0;

  for (const chapter of outlineEntries) {
    if (generated >= count) {
      break;
    }
    const path = chapterPath(bookRoot, chapter.number);
    if (existsSync(path)) {
      continue;
    }

    console.log(`CHAPTER_START=${chapter.number}`);
    const text = await callTextModel({
      config,
      prompt: buildChapterPrompt({ bookRoot, chapter, outlineEntries })
    });
    writeFileSync(path, ensureChapterHeading(text, chapter), "utf8");
    manifest = appendImagePlan(manifest, chapter);
    progress.lastCompletedChapter = chapter.number;
    progress.nextChapter = chapter.number + 1;
    progress.updatedAt = new Date().toISOString();
    writeJson(progressPath, progress);
    writeJson(manifestPath, manifest);
    generated += 1;
    console.log(`CHAPTER_DONE=${chapter.number}`);
  }

  return generated;
}

async function generateImages({ bookRoot, config, count }) {
  const manifestPath = resolve(bookRoot, "image-manifest.json");
  const manifest = readJson(manifestPath, {});
  const progressPath = resolve(bookRoot, "progress.json");
  const progress = readJson(progressPath, {});
  const items = [
    ...(manifest.styleAnchor ? [manifest.styleAnchor] : []),
    ...(Array.isArray(manifest.planned) ? manifest.planned : [])
  ];
  let generated = 0;

  for (const item of items) {
    if (generated >= count) {
      break;
    }
    if (item.status === "created" && existsSync(resolve(bookRoot, item.path))) {
      continue;
    }

    console.log(`IMAGE_START=${item.id}`);
    await runImageGeneration({ item, bookRoot, config });
    item.status = "created";
    item.metadata = item.path.replace(/\.[^.]+$/, ".json");
    progress.lastImageId = item.id;
    progress.updatedAt = new Date().toISOString();
    writeJson(manifestPath, manifest);
    writeJson(progressPath, progress);
    generated += 1;
    console.log(`IMAGE_DONE=${item.id}`);
  }

  return generated;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bookRoot = resolve(args.bookRoot || DEFAULT_BOOK_ROOT);
  const config = loadConfig(args.config || DEFAULT_CONFIG_PATH);
  const chapterCount = Number(args.chapters ?? 1);
  const imageCount = Number(args.images ?? 1);

  mkdirSync(resolve(bookRoot, "chapters"), { recursive: true });
  mkdirSync(resolve(bookRoot, "images"), { recursive: true });

  const chapters = chapterCount > 0
    ? await generateChapters({ bookRoot, config, count: chapterCount })
    : 0;
  const images = imageCount > 0
    ? await generateImages({ bookRoot, config, count: imageCount })
    : 0;

  console.log(`SUMMARY chapters=${chapters} images=${images}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
