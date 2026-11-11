# 定时任务（dsh-hermes-cron）

DSH 侧栏加一条 **定时任务**：整页列出任务、下次到点、执行账本，可新建/改 cron/启停/删除/手动跑脚本型任务，并把 stdout 投递到 Discord。

插件自带调度内核，**不依赖 hermes 或任何外部服务在线**。

## 装 / 卸

```powershell
git clone https://github.com/AkaneRanma/dsh-hermes-cron
cd dsh-hermes-cron
.\install.ps1            # 演练：只打印将改 profile 的哪两处
.\install.ps1 -Apply     # 写 profile/package.json（自动 .bak-hermescron-* 备份）
cd "$env:USERPROFILE\.dsh\profiles\desktop"; pnpm install
# 重启 DSH 生效
```

`install.ps1` 只动两处：`<DSH_HOME>/profiles/*/package.json` 的 `dependencies` 里加一条本地 link，以及插件列表里加 `dsh-hermes-cron`。改前自动备份，`-Remove` 按备份还原。

卸载：`.\install.ps1 -Apply -Remove` → `pnpm install` → 重启。

## 数据在哪、卸载 hermes 会怎样

| | 路径 | 谁执行 |
| --- | --- | --- |
| 插件自己的任务 | `<DSH_HOME>/schedule/jobs.json` | 本插件进程内 ticker |
| 自己的账本 | `<DSH_HOME>/schedule/executions.db` | 本插件写 |
| hermes 旧任务 | `%LOCALAPPDATA%\hermes\cron\jobs.json` | hermes gateway |

`<DSH_HOME>` 默认 `~/.dsh`，可用 `config.dataHome` 改到任意目录。

**自己的任务与 hermes 无关**：hermes 卸载、gateway 停掉、目录被删，面板照常工作。
只在「还没有自己的任务文件」时，面板才展示她的旧数据，用于一键接管（复制，不搬走）。

接管后两边会各跑一遍同一批任务：请去 hermes 侧停用这些任务，或停掉 gateway。

## 面板操作

顶部两个页签：**任务** / **消息平台**。

| 操作 | 行为 |
| --- | --- |
| + 新建任务 | 名称 + cron + 脚本 + 投递，cron 先校验再落盘 |
| 改 cron / 脚本 / 名称 → 保存 | 只改该条，写前备份、原子替换 |
| 停用 / 启用 | 只翻 `enabled`，ticker 跳过停用项 |
| 立即执行 | 只对脚本型（`no_agent` + `script`），返回 stdout/stderr |
| 删除 | 从任务文件移除该条 |
| 立刻检查一次 | 手动触发一次 tick，看哪些到点被执行 |
| 接管为我的任务 | 仅在 hermes 源下出现，复制她的任务到自己的文件 |

agent 型任务（需要模型与会话）本插件不执行，面板只显示、不提供运行按钮。

## 消息平台（Discord）

凭据存在 `<dataHome>/settings.json`，**面板保存即生效**，不需要重启；`cordis.patch.yml` 里的同名字段只作初值。

| 项 | 作用 |
| --- | --- |
| Bot 令牌 | 与任务里的 `deliver=discord:频道ID` 配合发消息；面板只显示打码后的尾四位 |
| Webhook | 整条 URL，配了就优先用它，连令牌都不用 |
| 默认频道 ID | 任务没填 `deliver` 时发这里；「发送测试消息」也用它 |
| 允许的用户 ID | 白名单，供以后接双向消息；投递不受影响 |
| 发送测试消息 | 立刻发一条到首个任务的频道，验证凭据可用 |

三者全清空时 `settings.json` 会被删除，回落到 `cordis.patch.yml` 的初值。

任务名另外记一份在 `<dataHome>/names.json`：任务被删掉后，「最近执行」里那些历史记录仍显示它当初的中文名，不会退化成一串 job_id。

## 调度契约

- ticker 每 `tickMs`（默认 20s）扫一遍：算出每条任务的最近到点时刻，`(job_id, scheduled_instant)` 唯一键保证同一分钟只跑一次。
- 到点超过 `maxLatenessSec`（默认 3600s）不再补跑，避免长时间关机后连着重放。
- 脚本按扩展名选解释器：`.py` → `pythonCommand`，`.mjs/.js/.cjs` → 当前 node，其它走 shell；超时 `timeoutMs`（默认 300s）强杀。
- 投递：配置 `discordWebhook`（整条 URL）优先；否则 `discordToken` + 任务 `deliver=discord:频道ID`（空的用「默认频道 ID」）；都没配则账本记 `skipped`，面板显示「未配置频道」。
- 消息长相：**脚本 stdout 原文直接发**，保留脚本自己的 Markdown（粗体、列表、`代码`、`>` 引用、链接都会正常渲染）；不套代码块，也不额外加任务名标题行 —— 套上代码块以后所有 Markdown 都变成字面量，就是一堆 `**` 和反引号。超过 1800 字按行自动切成多条，多出的段带「（续 2/3）」前缀。

## 写盘安全

- 只写自己的任务文件；hermes 的文件只读（接管除外）。
- 每次写入先复制到同目录 `backups/`，保留最近 10 份，再 `tmp + rename`。
- cron 表达式落盘前用内置 5 段解析器验范围与步长，非法值直接拒绝。
- `writable: false` 可整体降级为只读；账本表用 `PRIMARY KEY(job_id, scheduled_instant)` 防重复记账。

## 配置项（cordis.patch.yml）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dataHome` | 空 | 空 = `<DSH_HOME>/schedule` |
| `writable` | `true` | 面板是否可写 |
| `tickMs` | `20000` | 扫描间隔 |
| `maxLatenessSec` | `3600` | 补跑容差 |
| `pythonCommand` | `python` | `.py` 解释器 |
| `discordWebhook` / `discordToken` | 空 | 投递凭据 |

## 测试

```powershell
node test\client-smoke.mjs    # 客户端骨架：导出形状、两条 slot 是否注册
node test\e2e.mjs             # 宿主端到端：建任务 / 到点执行 / 账本 / 同一分钟不重复 / 手动跑 / 接管
node test\settings-e2e.mjs    # 凭据与默认频道：保存 -> 打码回读 -> 清空；删掉的任务仍记住名字
node test\deliver-format.mjs  # 投递格式：分片逻辑；配了凭据就真发一条到 Discord 核对渲染
```

前三个都在临时 `dataHome` 里跑，不碰真实配置、不发消息；只有最后一个会真的发。

## 已知边界

- 账本读写用 `node:sqlite`，需要宿主 Node >= 22.5；低版本时账本该栏报错，任务与 ticker 照常。
- 原生「自动化任务」页属于产品包 `dsh-client-ui-schedule`，第三方只能并列新增入口，无法插入页签；`ctx.remote.schedule.*` 也不可复用。
- 客户端除 `react` 外不 require 任何 `dsh-client-*` 包：抛错的组件会清空整个 slot 条目。
- Windows 上 `node:sqlite` 关闭时偶发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 告警，出现在进程退出阶段，不影响已完成的结果。

## License

MIT © AkaneRanma
