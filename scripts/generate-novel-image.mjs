import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

const DEFAULT_CONFIG_PATH = "server/novel.config.local.json";
const FALLBACK_CONFIG_PATH = "server/novel.config.example.json";
const RELAY_CONFIG_PATH = "server/relay.config.json";
const CURL_BIN = process.platform === "win32" ? "curl.exe" : "curl";
const DEFAULT_PROMPT =
  "Original modern fantasy novel illustration, rain-soaked academy gate at night, distant bronze clock tower, cinematic 4K composition, no text, no watermark.";

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

function readJsonFile(path) {
  try {
    if (!existsSync(path)) {
      return {};
    }

    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read JSON config ${path}: ${error.message}`);
  }
}

function loadConfig(configPath) {
  const localConfig = readJsonFile(configPath);
  if (Object.keys(localConfig).length > 0) {
    return localConfig;
  }

  return readJsonFile(FALLBACK_CONFIG_PATH);
}

function resolveProxyUrl(config) {
  const relayConfig = readJsonFile(RELAY_CONFIG_PATH);
  return String(
    config?.openai?.proxyUrl ||
      config?.proxyUrl ||
      relayConfig?.proxyUrl ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      ""
  ).trim();
}

function trimTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function resolveOutputPath(args, config) {
  const configuredDir =
    args.outDir ||
    config?.image?.outputDir ||
    "test-artifacts/novel-book/images";
  const outputDir = resolve(configuredDir);
  mkdirSync(outputDir, { recursive: true });

  if (args.out) {
    return resolve(args.out);
  }

  const safeLabel = String(args.label || "image-test")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "image-test";
  const format = String(args.format || config?.image?.outputFormat || "png")
    .trim()
    .toLowerCase();
  return resolve(outputDir, `${safeLabel}.${format}`);
}

async function fetchImageUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Failed to fetch image URL: HTTP ${response.status} ${message}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function runCurlText({ url, apiKey, body, proxyUrl, stream = false }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = ["-sS"];
    if (stream) {
      args.push("-N");
    }

    args.push(
      "-f",
      "-X",
      "POST",
      "-H",
      `Authorization: Bearer ${apiKey}`,
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      "@-"
    );

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
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }

      rejectPromise(new Error((stderr || stdout || `curl exited with code ${code}`).trim()));
    });

    curl.stdin.end(body);
  });
}

async function runCurlJson(options) {
  const text = await runCurlText(options);
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`curl returned non-JSON image response: ${error.message}`);
  }
}

function parseSseEvents(text) {
  const events = [];
  const blocks = String(text || "").split(/\r?\n\r?\n/);

  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();

    if (!data || data === "[DONE]") {
      continue;
    }

    try {
      events.push(JSON.parse(data));
    } catch {
      // Ignore non-JSON stream keepalive frames.
    }
  }

  return events;
}

function imagePayloadFromStreamText(text) {
  const events = parseSseEvents(text);
  let lastImage = null;

  for (const event of events) {
    if (event?.b64_json) {
      lastImage = event.b64_json;
      continue;
    }

    const nested = extractBase64FromResponse(event);
    if (nested) {
      lastImage = nested;
    }
  }

  if (!lastImage) {
    return {
      output: [],
      streamEvents: events.map((event) => event?.type || "unknown")
    };
  }

  return {
    data: [{ b64_json: lastImage }],
    streamEvents: events.map((event) => event?.type || "unknown")
  };
}

async function postImageGeneration({ endpoint, apiKey, requestBody, proxyUrl }) {
  const body = JSON.stringify(requestBody);
  const isStreaming = requestBody?.stream === true;

  if (isStreaming && proxyUrl) {
    const text = await runCurlText({
      url: endpoint,
      apiKey,
      body,
      proxyUrl,
      stream: true
    });
    return {
      payload: imagePayloadFromStreamText(text),
      transport: "curl-stream"
    };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body
    });

    const rawText = await response.text();
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : {};
    } catch {
      payload = { raw: rawText };
    }

    if (!response.ok) {
      const message = payload?.error?.message || rawText || response.statusText;
      throw new Error(`HTTP ${response.status} ${message}`);
    }

    return {
      payload: isStreaming ? imagePayloadFromStreamText(rawText) : payload,
      transport: isStreaming ? "fetch-stream" : "fetch"
    };
  } catch (error) {
    if (!proxyUrl) {
      throw error;
    }
  }

  return {
    payload: await runCurlJson({
      url: endpoint,
      apiKey,
    body,
      proxyUrl,
      stream: isStreaming
    }),
    transport: isStreaming ? "curl-stream" : "curl"
  };
}

function extractBase64FromResponse(payload) {
  const firstData = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (firstData?.b64_json) {
    return firstData.b64_json;
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of output) {
    if (item?.type === "image_generation_call" && item?.result) {
      return item.result;
    }
    if (item?.b64_json) {
      return item.b64_json;
    }
  }

  return null;
}

function extractImageUrlFromResponse(payload) {
  const firstData = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (firstData?.url) {
    return firstData.url;
  }

  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config || DEFAULT_CONFIG_PATH;
  const config = loadConfig(configPath);
  const apiKeyEnv = String(config?.openai?.apiKeyEnv || "OPENAI_API_KEY");
  const apiKey = String(process.env[apiKeyEnv] || "");

  if (!apiKey.trim()) {
    throw new Error(`${apiKeyEnv} is not set. Set it in the process environment before running image generation.`);
  }

  const baseUrl = trimTrailingSlash(
    args.baseUrl ||
      config?.openai?.baseUrl ||
      process.env.OPENAI_BASE_URL ||
      process.env.OPENAI_API_BASE_URL ||
      "https://api.openai.com/v1"
  );
  const model = String(args.model || process.env.OPENAI_IMAGE_MODEL || config?.models?.image || "gpt-image-2");
  const prompt = String(args.prompt || process.env.OPENAI_IMAGE_PROMPT || DEFAULT_PROMPT);
  const size = String(args.size || process.env.OPENAI_IMAGE_SIZE || config?.image?.size || "3840x2160");
  const quality = String(args.quality || process.env.OPENAI_IMAGE_QUALITY || config?.image?.quality || "medium");
  const format = String(args.format || config?.image?.outputFormat || "png").toLowerCase();
  const outputPath = resolveOutputPath({ ...args, format }, config);
  const proxyUrl = resolveProxyUrl(config);
  const stream = args.stream === true || process.env.OPENAI_IMAGE_STREAM === "1";
  const partialImages = Math.max(
    1,
    Math.min(3, Number(args["partial-images"] || process.env.OPENAI_IMAGE_PARTIAL_IMAGES || 1))
  );

  mkdirSync(dirname(outputPath), { recursive: true });

  const requestBody = {
    model,
    prompt,
    n: 1,
    size,
    quality,
    output_format: format
  };

  if (stream) {
    requestBody.stream = true;
    requestBody.partial_images = partialImages;
  }

  const endpoint = `${baseUrl}/images/generations`;
  const { payload, transport } = await postImageGeneration({
    endpoint,
    apiKey,
    requestBody,
    proxyUrl
  });

  const b64 = extractBase64FromResponse(payload);
  const imageUrl = extractImageUrlFromResponse(payload);
  let bytes = null;

  if (b64) {
    bytes = Buffer.from(b64, "base64");
  } else if (imageUrl) {
    bytes = await fetchImageUrl(imageUrl);
  } else {
    throw new Error("Image generation response did not contain b64_json, result, or url image data.");
  }

  writeFileSync(outputPath, bytes);

  const metadataPath = `${outputPath.slice(0, -extname(outputPath).length)}.json`;
  writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        image: outputPath,
        metadata: metadataPath,
        baseUrl,
        model,
        size,
        quality,
        outputFormat: format,
        prompt,
        bytes: bytes.length,
        transport,
        stream,
        partialImages: stream ? partialImages : 0,
        streamEvents: payload?.streamEvents || [],
        createdAt: new Date().toISOString()
      },
      null,
      2
    )
  );

  console.log(`IMAGE=${outputPath}`);
  console.log(`META=${metadataPath}`);
  console.log(`MODEL=${model}`);
  console.log(`SIZE=${size}`);
  console.log(`QUALITY=${quality}`);
  console.log(`TRANSPORT=${transport}`);
  console.log(`STREAM=${stream ? "true" : "false"}`);
  console.log(`BYTES=${bytes.length}`);
  console.log(`FILE=${basename(outputPath)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
