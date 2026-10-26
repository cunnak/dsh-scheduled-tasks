# dsh-scheduled-tasks（定时任务）

给 DSH 用的 WorkBuddy 式定时任务：每个任务 = 一个工作区 + 一条提示词 + 一套可选的
模型 / 专家 / 技能 / 连接器 / 重复规则；到点由 Host 侧自动新建会话并投递提示词。

## 界面

- 侧栏入口：左侧面板列表里的「定时任务」（与 插件 / 自动化任务 / 技能中心 / MCP连接器 / 论衡运行 并列）。
- 任务表单字段：任务名称、提示词、工作区、模型、专家（agent preset）、权限、技能（chip 多选）、
  连接器（chip 多选）、重复规则（一次性 / 固定间隔 / 每天）、执行时间。
- 列表区：任务卡（含工作区/模型/专家/权限/技能/连接器/下次运行时间）、立即运行、停用/启用、删除、运行历史。

### 权限

「权限」下拉的档位来自 Host 侧 `permissionPresets.names`，标签与聊天输入框的权限菜单一致：

| 机器值 | 标签 |
| --- | --- |
| `read-only` | 仅可查看 |
| `workspace-write` | 工作区内修改 |
| `danger-full-access` | 完全权限 |

留空 = 不改动新会话的权限（用当时的默认值）。派发时在 `sessionController.create` 之后、
`prompt` 之前调用 `permissionPresets.set(session, name)`；失败只记进该次运行的
`permissionError`，不会中断派发。

## Host 侧行为

- 调度：`ctx.timer.interval(15s)` 轮询，到期任务依次
  `sessionController.create({ workspaceId, cwd, agentPreset })` →
  `permissionPresets.set(session, permission)`（若任务指定了权限）→
  `selectModel({ sessionId, provider, model })` →
  `prompt({ requestId, sessionId, mode:'queue', content:[{type:'text',text}], clientTimeZone:'Asia/Shanghai' }, signal)`。
- 一次性任务派发后自动置 `enabled=false`；固定间隔以保存时刻为锚；每天按 Asia/Shanghai 计算下一次。
- 提示词里会追加技能/连接器偏好（「请优先使用以下技能…」「请优先使用这些连接器提供的工具…」）。
- 持久化：`~/.dsh/plugins/dsh-scheduled-tasks/state.json`（tmp + rename 原子写），运行记录保留最近 50 条。

## 数据接口

客户端通过同源 `POST /st-api/<method>` 调用 Host：

| method | 说明 |
| --- | --- |
| `ping` | 健康检查 |
| `list-workspaces` | 工作区列表（workspaceRegistry） |
| `list-models` | provider/model 扁平列表（llm） |
| `list-experts` | agent preset 列表 |
| `list-skills` | 技能列表（sessionSkillCatalog） |
| `list-permissions` | 权限预设列表（permissionPresets，含产品标签） |
| `list-connectors` | 已配置 MCP 连接器（读取 `~/.dsh/storages/mcp_connector.json`） |
| `list-tasks` / `list-runs` | 任务 / 运行记录 |
| `save-task` / `delete-task` / `set-enabled` / `run-now` | 增删改与立即执行 |

## 构建与安装（重要：ESM 缓存）

DSH 的插件 Loader 每个 entry 只 `import()` 一次，URL 按 realpath 计算；**原地改代码再
disable/enable 不会生效**。所以源码目录与安装目录分开：

```
dsh-scheduled-tasks/            # 源码（改这里）
.build/dsh-scheduled-tasks-<v>/ # 构建产物（装这个；版本号变了才是新 URL）
```

发版流程：

1. 改源码，`package.json` 里把 `version` 提升（如 1.3.0）。
2. `pwsh` 复制源码到 `.build/dsh-scheduled-tasks-<v>/`。
3. `plugin_manager` 先 `remove_bundle @local/dsh-scheduled-tasks`，再
   `install_bundle`（target = 构建目录的绝对路径）。
4. 刷新 GUI 验证 `/st-api/ping` 与面板。

> **注意：客户端面板（侧栏「定时任务」入口）只在 Host 启动时注册。** 重新安装 bundle 后
> Host 半会立刻生效（`/st-api/*` 可用），但客户端入口要重启一次 dsh 桌面应用才会出现。
> 只改 Host 逻辑（runtime.js）时按上面流程即可；改 client.js 同样需要重启。

## 安装（Release 包 / git 装配）

从 [Releases](https://github.com/cunnak/dsh-scheduled-tasks/releases) 下载
`dsh-scheduled-tasks-<version>.tgz`，解压得到插件目录（含 `runtime.js`、`client.js`、
`bundle-patch.yml`、`locale/`、`icon.svg`），然后按官方插件格式装配：

```bash
mkdir dsh-scheduled-tasks && tar -xzf dsh-scheduled-tasks-1.4.1.tgz -C dsh-scheduled-tasks --strip-components=1

# 方式一：本地目录装配（推荐，免构建）
dsh plugin --profile web add ./dsh-scheduled-tasks

# 方式二：git 装配
dsh plugin --profile web add github:cunnak/dsh-scheduled-tasks
```

也可以直接用 `bundle-patch.yml` 手工装配：把该文件内容合并进
`~/.dsh/profiles/web/cordis.patch.yml`（`insert` 一个 `id: dsh-scheduled-tasks` /
`name: @local/dsh-scheduled-tasks` 的条目），重启 dsh 后生效。

> 包名 `@local/dsh-scheduled-tasks` 与 bundle id `dsh-scheduled-tasks` 是官方格式的
> 固定身份，不要改；版本号只在 `package.json` 的 `version` 上推。

## 已知边界

- 时区固定 Asia/Shanghai（与 GUI 一致），未做可配置时区。
- 连接器只做「提示偏好」，不强制工具白名单。
- 站点需先被 DSH 认知（工作区注册表里存在）才能选。
