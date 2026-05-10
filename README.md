# WPS AI

WPS 文字加载项，在文档正文中以流式方式调用大模型写作。

## 特性

- 支持 **OpenRouter** 和 **NVIDIA Build** 两个中转站，可同时配置并随时切换
- 每个中转站独立保存 `Base URL` / `API Key` / `默认模型`
- 模型列表可从中转站自动获取，并支持首包延迟基准测试
- 可配置 HTTP 代理，留空时自动使用系统代理
- **Windows 和 macOS 均可使用**：相同的前端 + 本地 Node.js relay
- 流式输出实时写入 WPS 正文，同时在任务窗格中渲染 Markdown

## 开发

```bash
npm install
npm run dev           # 启动前端开发服务器（Vite）
npm run relay         # 启动本地 relay（端口 3888）
```

## 构建

```bash
npm run build
```

构建产物在 `dist/`，包含：

- `manifest.xml`、`ribbon.xml`
- 任务窗格页面、图标等资源

## 安装到本地 WPS

### Windows

```powershell
npm run build:win
```

会把 `dist/` 复制到 `%APPDATA%\kingsoft\wps\jsaddons\wps-ai_<version>\`，更新 `publish.xml`，并把 relay 注册到开机启动。

### macOS

```bash
npm run build:mac
```

会把 `dist/` 复制到 `~/Library/Application Support/Kingsoft/wps/jsaddons/wps-ai_<version>/`，更新 `publish.xml`，后台启动 relay，并生成登录自启 `launchd` plist。

需要启用自启：

```bash
launchctl load ~/Library/LaunchAgents/com.wps-ai.relay.plist
```

## 设置界面

点击任务窗格右上角的齿轮图标打开设置：

1. **当前使用**：选择本次对话使用哪个中转站
2. **OpenRouter / NVIDIA Build 两个标签页**：分别配置 `Base URL`、`API Key`、`默认模型`
3. **网络与代理**：留空使用系统代理；填 URL 使用指定代理；填 `direct` 强制直连
4. **高级选项**：Temperature、最大输出长度、System Prompt、选区上下文、替换选区等

## 模型基准测试

点击任务窗格的 🧪 图标打开模型列表：

- 顶部切换 provider
- **刷新模型列表**：从中转站拉取最新模型
- **开始基准测试**：逐个模型调用一次 `chat/completions`，测量首 token 延迟
- 点击 **使用** 即把该模型设为当前 provider 的默认模型

## 代理优先级

每次请求的代理解析顺序：

1. 前端设置中的 `proxyUrl`（`direct` 或 URL）
2. relay 的 `server/relay.config.json` 中的 `proxyUrl`
3. 环境变量 `HTTPS_PROXY` / `HTTP_PROXY`
4. macOS `scutil --proxy` / Windows 注册表中的系统代理

## 项目结构

```
src/
  ribbon/          WPS 功能区入口
  taskpane/
    App.jsx        主界面、设置、模型列表、流式生成
    ai.js          两个 provider 的统一 API 封装
    wps.js         WPS 正文写入桥接（聊天区样式独立）
    styles.css     任务窗格样式
  shared/
    relay.js       在 Windows 上通过 ActiveX 拉起 relay（macOS 下静默失败）
server/
  relay.mjs                本地 relay（支持 OpenRouter + NVIDIA）
  install-local-addon.ps1  Windows 安装脚本
  install-local-addon.sh   macOS 安装脚本
  start-relay.ps1          Windows 启动 relay
```
