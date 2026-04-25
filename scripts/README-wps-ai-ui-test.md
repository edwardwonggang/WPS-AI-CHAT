# WPS AI UI Test

Use one entry point for WPS desktop testing:

```powershell
rtk powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\run-wps-ai-ui-test.ps1"
```

The runner creates a timestamped folder under `test-artifacts/wps-ai-ui/` with:

- `run.log`: full step log with timestamps.
- `status.json`: current status consumed by the popup.
- `summary.json`: table, code highlighting, heading, and body checks.
- `before-send.png`, `prompt-filled-before-submit.png`, `prompt-submitted.png`, `after-output.png`, and `stuck.png` when applicable. These are full-screen screenshots, not WPS-window-only captures.
- `captures/`: periodic screenshots while waiting for the taskpane and generated document output.

Rules for this test flow:

- Do not send ad hoc click commands first. Run the test runner so progress and failures are logged.
- The runner closes existing WPS Writer (`wps.exe`) windows before each run by default; it does not close WPS Spreadsheets (`et.exe`).
- The runner saves each test document as a unique ASCII `.docx` under the run folder to avoid reusing stale `文字文稿1` sessions.
- Keep `.ps1` defaults ASCII. Read prompt files with .NET UTF-8 APIs.
- Use recursive UI Automation traversal to find `CefBrowserWindow` or `KxJSCTPWidget`; single-call `FindFirst` can miss nested WPS/CEF panes.
- Submit prompts through the local relay test command by default. The taskpane fills the real textarea, waits briefly so the text is visible, then calls the same send path as the send button.
- Coordinate paste/send is only a fallback mode for manual diagnostics.
- Keep the status popup at the top-left of the screen so it does not cover the taskpane input at the bottom.
- Capture screenshots after fill and after submit; inspect those files before rerunning if no document output appears.
- If output does not appear before timeout, stop and inspect the log/screenshot instead of repeating the same send command.
- Leave the WPS document open after the run for manual inspection.
