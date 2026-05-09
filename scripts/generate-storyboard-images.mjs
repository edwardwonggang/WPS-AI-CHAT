import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_BOOK_ROOT = "test-artifacts/novel-book";
const DEFAULT_STORYBOARD = "storyboard-prompts.json";
const DEFAULT_CONFIG = "server/novel.config.local.json";

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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function flattenPrompts(storyboard) {
  return (storyboard.batches || []).flatMap((batch) => batch.prompts || []);
}

function updateBatchStatuses(storyboard) {
  for (const batch of storyboard.batches || []) {
    const prompts = batch.prompts || [];
    batch.promptCount = prompts.length;
    batch.createdCount = prompts.filter((item) => item.status === "created").length;
    batch.failedCount = prompts.filter((item) => item.status === "failed").length;
    batch.status = batch.createdCount === prompts.length
      ? "created"
      : batch.failedCount > 0
        ? "partial"
        : "planned";
  }
  storyboard.createdCount = flattenPrompts(storyboard).filter((item) => item.status === "created").length;
  storyboard.failedCount = flattenPrompts(storyboard).filter((item) => item.status === "failed").length;
  storyboard.updatedAt = new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function errorMessage(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function shouldInclude(item, args) {
  const chapterFrom = args["chapter-from"] ? Number(args["chapter-from"]) : null;
  const chapterTo = args["chapter-to"] ? Number(args["chapter-to"]) : null;
  if (chapterFrom !== null && item.chapter < chapterFrom) {
    return false;
  }
  if (chapterTo !== null && item.chapter > chapterTo) {
    return false;
  }
  if (args.type && item.type !== args.type) {
    return false;
  }
  if (args.id && item.id !== args.id) {
    return false;
  }
  return true;
}

function generateOne({ item, outputPath, storyboard, configPath }) {
  return new Promise((resolvePromise, rejectPromise) => {
    mkdirSync(dirname(outputPath), { recursive: true });

    const args = [
      "scripts/generate-novel-image.mjs",
      "--config",
      configPath,
      "--out",
      outputPath,
      "--label",
      item.id,
      "--size",
      String(storyboard.size || "2048x1152"),
      "--quality",
      String(storyboard.quality || "medium"),
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bookRoot = resolve(args.bookRoot || DEFAULT_BOOK_ROOT);
  const storyboardPath = resolve(bookRoot, args.storyboard || DEFAULT_STORYBOARD);
  const configPath = args.config || DEFAULT_CONFIG;
  const storyboard = readJson(storyboardPath);
  const count = Number(args.count ?? 1);
  const retries = Math.max(1, Number(args.retries ?? 3));
  const retryDelayMs = Math.max(0, Number(args["retry-delay-ms"] ?? 15000));
  const stopOnError = args["stop-on-error"] === true;
  const force = args.force === true;
  const dryRun = args["dry-run"] === true;
  const prompts = flattenPrompts(storyboard).filter((item) => shouldInclude(item, args));

  let generated = 0;
  let failed = 0;
  let processed = 0;
  let skipped = 0;

  for (const item of prompts) {
    if (processed >= count) {
      break;
    }

    const outputPath = resolve(bookRoot, item.path);
    const metadataPath = item.path.replace(/\.[^.]+$/, ".json");
    const exists = existsSync(outputPath);
    if (!force && exists && item.status === "created") {
      skipped += 1;
      continue;
    }
    if (!force && exists) {
      item.status = "created";
      item.metadata = metadataPath;
      item.updatedAt = new Date().toISOString();
      skipped += 1;
      continue;
    }

    console.log(`IMAGE_START=${item.id}`);
    if (dryRun) {
      console.log(`DRY_RUN_OUT=${outputPath}`);
      generated += 1;
      processed += 1;
      continue;
    }

    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        console.log(`IMAGE_ATTEMPT=${item.id}:${attempt}/${retries}`);
        await generateOne({ item, outputPath, storyboard, configPath });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        console.log(`IMAGE_RETRYABLE_ERROR=${item.id}:${attempt}/${retries}:${errorMessage(error)}`);
        if (attempt < retries && retryDelayMs > 0) {
          await sleep(retryDelayMs);
        }
      }
    }

    processed += 1;
    if (lastError) {
      item.status = "failed";
      item.error = errorMessage(lastError);
      item.failedAt = new Date().toISOString();
      item.attempts = retries;
      failed += 1;
      updateBatchStatuses(storyboard);
      writeJson(storyboardPath, storyboard);
      console.log(`IMAGE_FAILED=${item.id}`);
      if (stopOnError) {
        throw lastError;
      }
      continue;
    }

    item.status = "created";
    delete item.error;
    delete item.failedAt;
    item.metadata = metadataPath;
    item.updatedAt = new Date().toISOString();
    item.attempts = (item.attempts || 0) + 1;
    updateBatchStatuses(storyboard);
    writeJson(storyboardPath, storyboard);
    generated += 1;
    console.log(`IMAGE_DONE=${item.id}`);
  }

  updateBatchStatuses(storyboard);
  writeJson(storyboardPath, storyboard);
  console.log(`SUMMARY generated=${generated} failed=${failed} skipped=${skipped} processed=${processed} total=${prompts.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
