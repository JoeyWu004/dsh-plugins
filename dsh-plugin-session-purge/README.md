# dsh-plugin-session-purge

给 DSH 加一套**会话清理**能力。DSH 0.2.0-rc.2 只提供「归档 / 取消归档」，没有删除入口，也没有「删掉某一轮」的办法，本插件补上这些。

> ⚠️ **本插件会永久删除数据，且不可撤销**——包括磁盘日志、搬迁备份与投影缓存；其中 `/purge-session-any` 按 id 删除、**不检查归档状态**。请先确认目标再操作。
>
> **非官方声明**：本插件是第三方非官方扩展，与 DeepSeek 官方无关，不由官方提供支持或担保。软件按「原样」提供，不提供任何明示或默示的担保，使用风险自负，完整条款见 [LICENSE](../LICENSE)。

## 功能一览

### 界面入口（客户端半边）

| 入口 | 位置 | 作用 |
|---|---|---|
| **删除会话** | 会话行「…」菜单，「归档」之后 | 永久删除**已归档**的整个会话；未归档时该项置灰并显示「删除会话（需先归档）」 |
| **移动到工作台…** | 同一菜单 | 把会话移入另一个工作台；界面立即生效，磁盘搬迁在下次启动完成 |
| **删除这一轮** | 助手消息操作条，**复制按钮右侧**的垃圾桶图标 | 最后一轮 → 磁盘真删；非最后一轮 → 自动降级为「移出上下文」 |

> 第三个按钮还有一条**兜底渲染路径**：只调工具、没有最终文字输出的轮次没有操作条，插件会在每轮末尾的插槽补上同一个按钮；组件会先测量同一轮内是否已存在主按钮，避免出现两个垃圾桶。

### 模型工具与命令（宿主半边）

| 模型工具 | 对应命令 | 作用 |
|---|---|---|
| `session_purge_archived` | `/purge-session <会话id>` | 删除已归档会话（工具支持批量与 dry-run） |
| `session_move_workspace` | `/move-session <会话id> <工作台id>` | 移动到另一个工作台（工具传 `list=true` 可列出工作台） |
| `session_attach_workspace` | `/attach-session <会话id>` | 把会话挂回 cwd 匹配的工作区（分叉后修复「未分组」） |
| `session_drop_turn` | `/drop-turn <轮号>` | 把某一轮移出模型上下文 |
| — | `/turn-cut <轮号>` | 「真删某一轮」第一步：报告分叉截断点 |
| — | `/purge-session-any <会话id>` | 按 id 直接删除会话，**不看归档状态**（「真删某一轮」的收尾） |

客户端插件无法注册新的 Remote 域（那需要构建期 typert 代码生成），但**既有的 `commands` 域是客户端可调的**——内置的 `/plan off` 芯片走的正是同一条路径。所以界面入口都通过命令间接驱动宿主。

用法示例（对 agent 说）：

```
先看一下已归档的会话，然后删掉它们
```

`session_purge_archived` 是两步：先 `confirm: false` 拿到计划（会话 id、所属工作区、日志目录、体积、文件数），确认后再 `confirm: true` 执行。

## 删除一个会话到底做了什么

`/purge-session` 与 `session_purge_archived` 共用同一套实现，按顺序执行五件事：

1. **删磁盘日志目录** —— `<dshHome>/sessions/<项目目录>/<会话id>/`（整个目录，含 `session.jsonl.zstd`）
2. **删搬迁备份** —— `<dshHome>/session-backups/<会话id>-backup-*/`。这些是「移动到工作台」留下的**完整日志副本**；不一起清掉，「日志已删除」就不成立
3. **删投影缓存** —— `ctx.sessionProjectionCache.table.delete(id)`（存储域上的正规删除，写穿到介质、更新内存并发出变更事件），再删掉 `<dshHome>/storages/session_projcache/sessions/<id>.json`
4. **从工作区记账摘下** —— `entity.detachSession(id)`
5. **清掉归档标记** —— `registry.unarchiveSession(id)`

删完立刻补一次幽灵巡检（见下）：删除期间该会话可能仍活在宿主内存里，把缓存行写回来。

`<dshHome>` 取 `$DSH_HOME`，未设置时为 `~/.dsh`。

## 幽灵行巡检

DSH 的展示层从**投影缓存**渲染会话行。只删日志与记账而不管缓存，已删会话会以「未分组」幽灵行复活——所以本插件维护一次定时对账：**磁盘上已经没有对应目录**的缓存行会被删除。

触发时机：启动时（等投影缓存域表就绪，最多 15 秒）、每次删除之后、以及其后每 20 秒一次。

判据只有一条（磁盘上有没有目录；工作区记账只用于日志标注），但配了两道保护，避免把「没扫到」误当成「已删除」：

- 磁盘扫描**不完整**（`sessions` 根目录或任一项目目录读不出来）→ 本轮跳过，不清理
- 扫到 **0 个**会话却有缓存行 → 判据不可信，本轮跳过

巡检日志写在 `<dshHome>/session-purge.log`：启动、删除后、有实际清理时才记账，空闲的定时轮次不写；文件超过 1 MB 轮转为 `session-purge.log.1`。

若在插件缺失期间产生了幽灵（例如手工删过日志），可**完全退出应用后**跑兜底脚本：

```powershell
node tools/dsh-ghost-cleanup.mjs           # 预览（dry-run）
node tools/dsh-ghost-cleanup.mjs --apply   # 清理（自动备份索引）
```

## 删除某一轮

**最后一轮 → 磁盘真删**（分叉 + 删原会话）：

1. `/turn-cut` 报告该轮首事件的前一个 `seq`；若该轮之后还有对话，返回 `NOT_LAST_TURN`
2. 内置 `session.fork` 在截断点分叉出不含该轮的新会话
3. `/attach-session` 把新会话挂回原工作区（分叉只继承 cwd，不挂会掉进「未分组」）
4. 清掉新会话从原会话继承来的**排队消息**（有界等待最多 5 秒：等新会话进入客户端列表、inbox 投影就绪；否则这些消息会挂在输入框上方并被误发）
5. 切到新会话，再用 `/purge-session-any` 删掉原会话（宿主拒绝删除正在执行命令的会话）

**非最后一轮 → 只能降级为「移出上下文」**：追加一条 `user/message` 占位并带 `surfaceOp: { op: 'replace', startSeq, endSeq }`，让该区间不再进入模型可见表面。**日志保持只追加**，不删除任何历史；客户端另外在本页隐藏这一轮（localStorage + CSS，仅本机本浏览器生效）。

之所以要绕这一圈：`seq` 是位置索引，直接抠掉中间事件会让后续所有引用错位。而分叉只保留截断点**之前**的前缀，所以真删只能作用于最后一轮——否则目标轮之后的对话会一起丢。

## 移动到工作台

会话归属于「路径等于它 cwd」的工作区，所以跨工作台移动分两半：

- **界面立即生效**：更新内存路径索引与工作台记账
- **磁盘下次启动完成**：搬目录 + 改写日志头部的 `cwd`，并先把原目录完整备份到 `<dshHome>/session-backups/`

备份**刻意放在 `sessions` 树之外**：DSH 枚举会话时会把项目目录下的每个子目录都当成一个会话目录，备份是原会话的完整副本、头部 id 相同，留在树内就会让同一个 id 出现两个目录，DSH 的会话枚举整体抛错——界面上表现为**「所有会话都不见了」**。

启动执行时的几个约束：

- 正在使用中的会话会被跳过，留到下次启动
- 只认**最高代次**的日志（按数值比较，支持 `.jsonl.zstd` 与未压缩的 `.jsonl`）
- 先确认能定位到日志文件再动目录；改写头部失败会把目录**回滚**回去，不留「目录在新路径、头部还是旧 cwd」的自相矛盾状态
- 头部改写保持帧结构：首个 zstd 帧必须**恰好只有头部一行**（`assertZstdHeaderFrame`），否则整份日志会被 DSH 判为损坏

## 安全边界

- 删除类操作**只处理归档集合内**的会话（`workspaceRegistry.archivedSessionIds`）；未归档、置顶、活跃的会话不碰；模型工具还**永不删除调用方自己**所在的会话
- `session_purge_archived` **默认 dry-run**：必须显式传 `confirm: true` 才会删除
- **例外**：`/purge-session-any` 按 id 删除、不看归档状态，只拒绝删除正在执行命令的会话——它是「真删某一轮」的收尾，**id 传错就会永久删除**
- 删除失败不会中断整批：单个会话记入 `failures`，其余继续
- 全程只动 `sessions/`、`session-backups/`、`storages/session_projcache/` 与工作区记账，不碰凭据

## 安装

把插件目录放进目标 profile 的 `node_modules`，并在该 profile 的 `cordis.patch.yml` 末尾追加插入条目：

```yaml
- insert:
    - id: session-purge
      name: 'dsh-plugin-session-purge'
```

```powershell
# 以 desktop profile 为例；$env:USERPROFILE\.dsh 即 $DSH_HOME 的默认值
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
Copy-Item '.\dsh-plugin-session-purge' (Join-Path $dshHome 'profiles\desktop\node_modules') -Recurse -Force
```

**重启桌面应用**才会加载。仓库根目录的 `deploy.ps1` 会把两个插件一起部署到 `$DSH_HOME\plugins` 与 profile 的 `node_modules`，并自动补齐上面的注册条目。

`lib/` 是**手写源码**：没有 `src/`、没有构建步骤，改完直接生效。

## 卸载

删掉 `cordis.patch.yml` 里那条 `insert` 条目，重启应用；profile 的 `node_modules` 与 `$DSH_HOME\plugins` 下的副本可一并删除。

插件运行期间产生的文件（都在 `<dshHome>` 下）：`session-purge.log`（巡检日志）、`session-moves.json`（待执行的移动，平时是 `{}`）、`session-backups/`（搬迁备份）。

## 依赖

- `@deepseek-ai/dsh-tools` 的 `defineTool`
- 宿主服务：`tools`、`workspaceRegistry`、`commands`；可选的 `sessionProjectionCache`（缺席时删除照做，只是少了缓存行清理）
- 客户端服务：`slots`、`remote`、`remote.commands`、`remote.session`
