# Anna Analysis

项目代码与日志 AI 分析平台 MVP。

## 功能

- 管理后台一次录入项目、Android GitLab 仓库和 C++ GitLab 仓库。
- 一个项目可绑定 Android、C++ 两个仓库，也可以只填写其中一个。
- GitLab 访问 Token 使用全局配置，所有仓库同步共用同一个 Token。
- 手动同步仓库并建立代码索引。
- 管理 OpenAI-compatible AI 模型配置。
- 分析前选择项目、仓库和模型。
- 支持功能实现分析、日志问题分析、代码审查、影响范围分析。
- 支持上传日志并结合代码检索结果分析。
- 保存最近分析历史。

## 启动

```bash
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

打开：

```text
http://127.0.0.1:8000
```

## 模型配置

后台的模型接口按 OpenAI-compatible 协议调用。

示例：

- Base URL: `https://api.openai.com/v1`
- Model ID: `gpt-4.1`

如果不配置 `base_url`、`api_key` 或 `model_name`，系统会返回本地关键词检索摘要，方便先验证项目、仓库、日志和代码索引流程。

## GitLab 仓库

后台保存项目时同时填写 Android 仓库和 C++ 仓库。只填一个仓库时，分析工作台只会显示并检索这个仓库；两个都填时，分析工作台会默认勾选两个仓库，AI 分析会同时检索两个仓库的代码。

GitLab 访问 Token 在管理后台全局配置一次。私有仓库同步时，系统会对所有 HTTPS GitLab 地址统一按 `oauth2:<token>` 的方式拼接克隆地址。

当前版本为 MVP，同步是手动触发；生产环境建议后续补充 Token 加密、权限隔离、队列化索引、向量检索和审计日志。
