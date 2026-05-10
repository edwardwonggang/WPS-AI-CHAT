import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import process from "node:process";

const HOST = "127.0.0.1";
const PORT = Number(process.env.RENDER_SMOKE_PORT || 4300 + (process.pid % 1000));
const TARGET_URL = `http://${HOST}:${PORT}/render-smoke.html`;
const SERVER_WAIT_MS = 30000;
const EDGE_WAIT_MS = 20000;

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const useShell =
      options.shell ?? (process.platform === "win32" && /\.(cmd|bat)$/i.test(command));
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: process.env,
      shell: useShell,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stderr, stdout });
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code}\n${stdout}\n${stderr}`.trim()
        )
      );
    });
  });
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function resolveEdgePath() {
  const candidates =
    process.platform === "win32"
      ? [
          process.env["ProgramFiles(x86)"] && `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
          process.env.ProgramFiles && `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
          process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`
        ].filter(Boolean)
      : process.platform === "darwin"
        ? [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          ]
        : ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium"];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep searching.
    }
  }

  throw new Error("Unable to find Microsoft Edge or Chrome.");
}

function extractSmokeJson(html) {
  const match = html.match(/<script id="smoke-json" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) {
    throw new Error("smoke-json payload not found in dumped DOM.");
  }

  return JSON.parse(match[1]);
}

async function stopProcessTree(child) {
  if (!child?.pid) {
    return;
  }

  if (process.platform === "win32") {
    try {
      await runCommand("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { shell: false });
      return;
    } catch {
      // Fall through to regular kill.
    }
  }

  child.kill("SIGTERM");
}

async function main() {
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  await runCommand(npmBin, ["exec", "vite", "build"], { shell: true });

  const preview = spawn(
    npmBin,
    ["run", "preview", "--", "--host", HOST, "--port", String(PORT), "--strictPort"],
    {
      cwd: process.cwd(),
      env: process.env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  let previewStdout = "";
  let previewStderr = "";
  preview.stdout.on("data", (chunk) => {
    previewStdout += chunk.toString();
  });
  preview.stderr.on("data", (chunk) => {
    previewStderr += chunk.toString();
  });

  try {
    await waitForServer(TARGET_URL, SERVER_WAIT_MS);
    const edgePath = await resolveEdgePath();
    const { stdout } = await runCommand(edgePath, [
      "--headless=new",
      "--run-all-compositor-stages-before-draw",
      `--virtual-time-budget=${EDGE_WAIT_MS}`,
      "--dump-dom",
      TARGET_URL
    ], { shell: false });

    const summary = extractSmokeJson(stdout);
    for (const result of summary.results) {
      const chat = result.chatPassed ? "pass" : "fail";
      const wps = result.wpsPassed ? "pass" : "fail";
      console.log(`${result.id}: chat=${chat} wps=${wps}`);
    }

    if (!summary.allPassed) {
      process.exitCode = 1;
    }
  } finally {
    await stopProcessTree(preview);
    if (previewStdout.trim()) {
      console.error(previewStdout.trim());
    }
    if (previewStderr.trim()) {
      console.error(previewStderr.trim());
    }
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
