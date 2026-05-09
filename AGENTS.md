# Project Rules

## WPS Editing Area vs AI Chat Area

This project has two separate rendering surfaces:

- WPS document body editing area: implemented through the WPS writer bridge, primarily `src/taskpane/wps.js`.
- AI chat/taskpane display area: implemented through React/CSS preview rendering, primarily `src/taskpane/StreamingMarkdown.jsx` and `src/taskpane/styles.css`.

When the user asks to change WPS editing area rendering, WPS body rendering, document body formatting, paper formatting, Word/WPS document output, or inserted-content formatting:

- Modify only the WPS document writer/rendering path unless the user explicitly asks to change the AI chat display area.
- Do not modify `.bubble-markdown`, `StreamingMarkdown.jsx`, chat bubble CSS, taskpane preview CSS, or any AI conversation display styles for that request.
- Treat AI chat display rendering and WPS document body rendering as separate products with separate acceptance criteria.

When the user asks to restore or preserve AI chat rendering:

- Verify `src/taskpane/styles.css` has no unintended chat-rendering diff before finishing.
- Keep WPS document body formatting changes in `src/taskpane/wps.js` if they are still requested.

## Command Review Requirement

Before every shell command:

- For non-trivial Windows PowerShell commands, use the `windows-powershell` skill guidance first.
- Read the exact command string before executing it.
- Check which files, directories, processes, or generated artifacts the command can affect.
- Prefer read-only inspection commands before write, copy, build, install, or process-control commands.
- For commands that can modify files or installed WPS add-in resources, confirm the target path is the intended project path or WPS add-in path.
- Do not run broad copy/remove/build/install commands by habit; verify the command matches the current user request.

## RTK

Read `C:\Users\10297441.WIN-9DOP5T7GHM7\.codex\RTK.md` before running shell commands.

For non-interactive shell commands, use `rtk` by default.

If a command can reasonably run through `rtk`, it must run through `rtk`.

Only bypass `rtk` when exact byte-for-byte output matters, the command is tiny and trivial, the command is interactive, or `rtk` would change command semantics.

If an `rtk` command fails, diagnose and fix the `rtk` command usage first. Do not immediately fall back to the equivalent raw shell command.

## Project Build Commands

Do not use `rtk npm run build` in this project unless the user explicitly asks to test that exact package script.

This package script combines Vite build, local WPS add-in installation, and relay startup. In Codex it can time out even after the build and install have already succeeded.

For normal build/install verification in this project, use the known-good split sequence:

```powershell
rtk proxy npx vite build
rtk powershell -NoProfile -ExecutionPolicy Bypass -File ".\server\install-local-addon.ps1"
```

After installing, verify the add-in target directly:

```powershell
rtk powershell -NoProfile -Command "`$target = Join-Path `$env:APPDATA 'kingsoft\wps\jsaddons\wps-ai_1.0.4'; Get-ChildItem -LiteralPath `$target -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 8 FullName,LastWriteTime,Length"
```

For render-only validation, use:

```powershell
rtk npm run test:render-smoke
```
