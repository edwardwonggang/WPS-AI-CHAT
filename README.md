# WPS AI

这是一个从零重建的 WPS 文字加载项项目，目标是：

- 在 WPS 中作为任务窗格插件使用
- 支持配置 `OpenRouter` 或 `NVIDIA Build` 的 OpenAI 兼容接口
- 将模型流式输出实时写入 WPS 正文

## 开发

```bash
npm install
npm run dev
```

## 在 WPS 中调试

```bash
npm run debug
```

前提是本机已安装支持 `wpsjs debug` 的 WPS 客户端。

## 构建

```bash
npm run build
```

构建后 `dist/` 中会包含：

- `manifest.xml`
- `ribbon.xml`
- 任务窗格页面和资源

## 项目结构

- `src/ribbon`
  功能区入口和任务窗格创建逻辑
- `src/taskpane/App.jsx`
  主界面、配置和流式生成流程
- `src/taskpane/ai.js`
  OpenRouter / NVIDIA Build 接口封装和 SSE 解析
- `src/taskpane/wps.js`
  WPS 文档读写桥接

## 写入策略

生成开始时，插件会记录当前选区的 `Start/End`。

- 勾选“直接覆盖当前选区”时：
  会先清空原选区，再把流式文本持续覆写到同一锚点区域。
- 取消勾选时：
  会在当前光标位置持续插入并刷新同一段落区域。

这样可以避免逐 token 插入导致光标漂移和正文碎片化。
