# 1.4.1 — 2026-10-26

新增**权限（permission preset）**选择：每个定时任务可以指定新建会话时使用的权限档位，与聊天输入框的权限菜单同一套语义。

## 新增

- **任务表单新增「权限」下拉**：`仅可查看` / `工作区内修改` / `完全权限`，外加「（不修改，用默认权限）」。
  标签与产品 UI 完全一致（`packages/client/ui-permission-presets/src/client/locales.ts` 的
  `preset.readOnly` / `preset.workspaceWrite` / `preset.fullAccess`）。
- **新增 `POST /st-api/list-permissions`**：返回 Host 侧 `permissionPresets.names` 的实际可用预设，
  并按产品规则做本地化（只有 host 名仍等于机器值或库存英文名时才用内置标签，否则原样透出）。
- **派发时应用权限**：`sessionController.create` 之后、`prompt` 之前，用
  `permissionPresets.set(session, name)` 把预设折叠成 sandbox / approval 事件。
  应用失败不中断派发——错误写进该次运行记录的 `permissionError`，任务照常执行。
- **任务卡展示**：元信息行显示「· 权限 工作区内修改」，用标签而非机器值。
- **运行记录**：`runs[]` 增加 `permission` / `permissionError` 字段。

## 变更

- `save-task` 校验权限名：不在 `permissionPresets.names` 里直接拒绝（避免存进去、到点才失败）。

## 安装

```bash
dsh plugin --profile web add <解压目录>
# 或
dsh plugin --profile web add github:cunnak/dsh-scheduled-tasks
```

## 资产

- `dsh-scheduled-tasks-1.4.1.tgz` — npm pack 产物（含 `runtime.js`、`client.js`、`bundle-patch.yml`、`locale/`、`icon.svg`、`README.md`、`LICENSE`）

## 已知边界

- 时区固定 `Asia/Shanghai`，未做可配置时区。
- 连接器只做「提示偏好」，不强制工具白名单。
- 站点需先被 DSH 认知（工作区注册表里存在）才能选。
- 客户端面板入口与 `client.js` 内容只在 Host 启动时进入 boot graph；重新安装 bundle 后需重启一次 dsh 桌面应用（Host 半 `/st-api/*` 立即可用）。
