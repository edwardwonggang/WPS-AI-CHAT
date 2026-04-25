const RELAY_RUN_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\WPS AI Relay";

function getActiveXConstructor() {
  if (typeof window !== "undefined" && typeof window.ActiveXObject === "function") {
    return window.ActiveXObject;
  }

  if (typeof ActiveXObject === "function") {
    return ActiveXObject;
  }

  return null;
}

function getWScriptShell() {
  const ActiveX = getActiveXConstructor();
  if (!ActiveX) {
    return null;
  }

  try {
    return new ActiveX("WScript.Shell");
  } catch {
    return null;
  }
}

export function tryStartLocalRelay() {
  const shell = getWScriptShell();
  if (!shell) {
    return false;
  }

  try {
    const command = String(shell.RegRead(RELAY_RUN_KEY) ?? "").trim();
    if (!command) {
      return false;
    }

    shell.Run(command, 0, false);
    return true;
  } catch {
    return false;
  }
}
