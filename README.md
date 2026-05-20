# Anna Analysis

项目代码与日志 AI 分析平台。当前分支已将后端迁移到 Node.js/TypeScript，并接入 Cursor SDK。

## 功能

- 管理后台录入项目，并同时维护 Android GitLab 仓库和 C++ GitLab 仓库。
- 一个项目可以只绑定一个仓库，也可以绑定两个仓库；分析时只使用选中的仓库。
- GitLab 访问 Token 使用全局配置。
- 发送分析前可自动同步仓库并建立本地代码索引。
- 支持 `cursor` provider，通过 Cursor SDK 让 Agent 在本地仓库目录中分析代码。
- 兼容 `openai-compatible` provider，保留原有模型调用方式。
- 支持上传日志；未上传日志时直接按代码分析。
- 保存分析历史，并支持删除和清空。
- 提供基础 SSE 流式接口 `/api/analyze/stream`，现有前端仍默认使用非流式 `/api/analyze`。

## 启动

```bash
npm install
npm run dev
```

默认地址：

```text
http://127.0.0.1:8765
```

构建生产版本：

```bash
npm run build
npm start
```

## Cursor 模型配置

在管理后台新增模型时：

- 供应商：`cursor`
- API Key：填写 Cursor API Key
- 模型 ID：例如 `composer-2`
- Base URL：留空

如果供应商填写为 `openai-compatible`，则继续使用 OpenAI Chat Completions 兼容协议：

- Base URL：例如 `https://api.openai.com/v1`
- API Key：对应模型服务的 API Key
- 模型 ID：例如 `gpt-4.1`

如果没有可调用模型，系统会返回本地关键词检索摘要，方便先验证项目、仓库、日志和代码索引流程。

## GitLab 仓库

后台保存项目时可以填写 Android 仓库和 C++ 仓库。只填一个仓库时，分析工作台只会显示并分析这个仓库；两个都填时，默认可同时分析两个仓库。

GitLab 访问 Token 在管理后台全局配置一次。私有 HTTPS GitLab 仓库同步时，系统会统一按 `oauth2:<token>` 的方式拼接克隆地址。

## 旧版 Python 后端

`app/` 目录保留了迁移前的 FastAPI 后端代码，当前 Node/TypeScript 后端入口是 `src/server.ts`。
