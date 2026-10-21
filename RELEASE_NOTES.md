# 1.3.3 — 2026-10-21

首个公开发布版本：把本地「定时任务」插件按 DSH 官方插件发布格式整理后上传 GitHub 并打出 Release。

## 功能

- **WorkBuddy 式定时任务**：每个任务 = 一个工作区 + 一条提示词 + 一套可选的模型 / 专家 / 技能 / 连接器 / 重复规则；到点由 Host 侧自动新建会话并投递提示词。
- **重复规则**：一次性 / 固定间隔 / 每天三种；所有墙钟时间按 `Asia/Shanghai` 解释（与 GUI 一致）。
- **侧栏入口**：左侧面板列表「定时任务」，与 插件 / 自动化任务 / 技能中心 / MCP 连接器 / 论衡运行 并列。
- **任务表单**：任务名称、提示词、工作区、模型、专家（agent preset）、技能（chip 多选）、连接器（chip 多选）、重复规则、执行时间。
- **任务管理**：立即运行、停用/启用、删除、运行历史（保留最近 50 条）。
- **Host 侧调度**：`ctx.timer.interval(15s)` 轮询，到期任务依次 `sessionController.create` → `selectModel` → `prompt(mode:'queue', signal)`。
- **持久化**：`~/.dsh/plugins/dsh-scheduled-tasks/state.json`，tmp + rename 原子写。
- **客户端 RPC**：同源 `POST /st-api/<method>`，含 `ping` / `list-workspaces` / `list-models` / `list-experts` / `list-skills` / `list-connectors` / `list-tasks` / `list-runs` / `save-task` / `delete-task` / `set-enabled` / `run-now`。
- **双语**：`locale/zh.json`、`locale/en.json`。

## 安装

见 [README](README.md)「安装（Release 包 / git 装配）」一节，支持：

```bash
dsh plugin --profile web add <解压目录>
# 或
dsh plugin --profile web add github:cunnak/dsh-scheduled-tasks
```

## 资产

- `dsh-scheduled-tasks-1.3.3.tgz` — npm pack 产物（含 `runtime.js`、`client.js`、`bundle-patch.yml`、`locale/`、`icon.svg`、`README.md`、`LICENSE`）

## 已知边界

- 时区固定 `Asia/Shanghai`，未做可配置时区。
- 连接器只做「提示偏好」，不强制工具白名单。
- 站点需先被 DSH 认知（工作区注册表里存在）才能选。
- 客户端面板入口只在 Host 启动时注册，重新安装 bundle 后需重启一次 dsh 桌面应用。
