# Anna Analysis

项目代码与日志 AI 分析平台。当前分支已将后端迁移到 Node.js/TypeScript，并接入 Cursor SDK。

## 功能

- 管理后台录入项目，并同时维护 Android GitLab 仓库和 C++ GitLab 仓库。
- 一个项目可以只绑定一个仓库，也可以绑定两个仓库；分析时只使用选中的仓库。
- GitLab 访问 Token 使用全局配置。
- 代码通过管理后台手动同步、新建项目自动同步，以及每天 0 点起每 2 小时定时同步；分析时由 Cursor SDK Agent 自行决定是否检索仓库。
- 仅支持 Cursor SDK，通过 Cursor Agent 在本地仓库目录中分析代码。
- 支持上传日志；未上传日志时直接按代码分析。
- 保存分析历史，并支持删除和清空。
- 提供基础 SSE 流式接口 `/api/analyze/stream`，现有前端仍默认使用非流式 `/api/analyze`。

## 启动

开发环境（推荐，始终使用最新功能）：

```bash
npm install
npm run dev
```

生产/本地长期运行前请先构建：

```bash
npm install
npm run build
npm start
```

注意：若直接运行过期的 `node dist/server.js` 而未 `npm run build`，会出现 Agent 分析失败。分析失败时请优先改用 `npm run dev` 并刷新页面。

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

Cursor API Key 由后端固定配置，不在管理后台录入。可以使用环境变量：

```bash
set CURSOR_API_KEY=你的 Cursor API Key
```

可选环境变量：

```bash
# 云端 Agent（服务器本地环境不稳定时使用）
set CURSOR_AGENT_RUNTIME=cloud

# 关闭两阶段分析（默认开启：先调研再写结论）
set ANALYSIS_TWO_PHASE=0
```

管理后台不再手动新增模型；系统会通过 Cursor SDK 自动获取可用模型，并允许选择默认模型。

如果没有可调用模型，系统会返回本地关键词检索摘要，方便先验证项目、仓库、日志和代码索引流程。

## 分析工作区

同一项目的 Android / C++ 仓库会同步到统一目录 `data/workspaces/project_<id>/`（`android/`、`cpp/`、`uploads/`），Agent 只面对一个工作区根目录，行为更接近 Cursor IDE。

分析前会自动校验代码是否已同步、文件数量是否足够，并提示仓库是否缺少 `.cursor/rules`。

同步代码时会为片段建立 **SQLite FTS5 全文索引**，排查类问题预检索时优先使用 FTS（按相关性排序），无结果时回退到关键词匹配。

## GitLab 仓库

后台保存项目时可以填写 Android 仓库和 C++ 仓库。只填一个仓库时，分析工作台只会显示并分析这个仓库；两个都填时，默认可同时分析两个仓库。

GitLab 访问 Token 在管理后台全局配置一次。私有 HTTPS GitLab 仓库同步时，系统会统一按 `oauth2:<token>` 的方式拼接克隆地址。

## 旧版 Python 后端

`app/` 目录保留了迁移前的 FastAPI 后端代码，当前 Node/TypeScript 后端入口是 `src/server.ts`。
