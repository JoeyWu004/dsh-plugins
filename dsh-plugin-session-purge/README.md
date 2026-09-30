# dsh-plugin-session-purge

给 DSH 加一个**永久删除已归档会话**的能力。DSH 0.2.0-rc.2 只提供「归档 / 取消归档」，没有删除入口，本插件补上这一块。

本插件提供**两个入口**，共用同一套删除实现：

| 入口 | 位置 | 触发方式 |
|---|---|---|
| **会话行「…」菜单项** | 「重命名 / 归档」同一菜单，排在其后（order 500） | 鼠标点击 → 确认 → 宿主命令 |
| **模型工具** `session_purge_archived` | agent 工具 | 对 agent 说「删除已归档的会话」 |

链路：菜单项点击 → `window.confirm` 二次确认 → `ctx.remote.commands.execute(sessionId, '/purge-session <会话id>', [])` → 宿主命令执行删除。

> 为什么能这么做：客户端插件无法注册新的 Remote 域（那需要构建期 typert 代码生成），但**既有的 `commands` 域是客户端可调的**——内置的 `/plan off` 芯片走的正是同一条路径。所以菜单项通过命令间接驱动宿主删除。


## 用法

装好并重启桌面应用后，在任何会话里对 agent 说：

```
先看一下已归档的会话，然后删掉它们
```

agent 会调用 `session_purge_archived`：

| 参数 | 说明 |
|---|---|
| `confirm` | **必填**。`false` 只返回删除计划、不动任何数据；`true` 才真正执行 |
| `sessionIds` | 可选。只删除指定的归档会话 id；省略则针对全部归档会话 |

典型两步：

1. `session_purge_archived({ confirm: false })` → 返回计划（会话 id、所属工作区、日志目录、体积、文件数）
2. `session_purge_archived({ confirm: true })` → 执行并返回释放的空间

## 它到底做了什么

对每个目标会话执行三步：

1. **删除磁盘上的会话日志**：`<dshHome>/sessions/<项目目录>/<会话id>/`（整个目录，含 `session.jsonl.zstd`）
2. **从工作区记账中摘下**：`workspaceRegistry` 实体的 `detachSession(sessionId)`
3. **清掉归档标记**：`workspaceRegistry.unarchiveSession(sessionId)`

`<dshHome>` 取 `$DSH_HOME`，未设置时用 `~/.dsh`。

## 安全边界

- **只处理归档集合内**的会话：`workspaceRegistry.archivedSessionIds`；未归档、置顶、活跃的会话一律不碰
- **永不删除调用方自己所在的会话**（会跳过并计入 skipped）
- **默认 dry-run**：必须显式传 `confirm: true` 才会删除
- **不做缓存改动**：`~/.dsh/storages/session_projcache/` 下的投影缓存保留（惰性、体积小、不会被会话列表引用）
- 失败不会中断整批：单个会话失败记入 `failures`，其余继续

## 安装位置

| 位置 | 用途 |
|---|---|
| `C:\Users\Lenovo\.dsh\profiles\desktop\node_modules\dsh-plugin-session-purge\` | 被 loader 解析的位置 |
| `C:\Users\Lenovo\.dsh\plugins\dsh-plugin-session-purge\` | 稳定副本，供重新安装 |

并在 `C:\Users\Lenovo\.dsh\profiles\desktop\cordis.patch.yml` 追加：

```yaml
- insert:
    - id: session-purge
      name: 'dsh-plugin-session-purge'
```

## 彻底删除：四个动作 + 启动对账

删除一个会话会依次完成：

1. 删除磁盘日志目录 `<dshHome>/sessions/<项目>/<会话id>/`
2. **删除投影缓存行**：`ctx.sessionProjectionCache.table.delete(id)`——这是存储域上的正规删除，写穿到介质、更新内存并发出变更事件
3. 从工作区记账摘下：`entity.detachSession(id)`
4. 清掉归档标记：`registry.unarchiveSession(id)`

**启动对账**：插件在启动时扫描投影缓存表，删除「日志目录已不存在**且**不被任何工作区记账」的行。这条规则同时满足两个条件才动手，因此不会误删仍被认领的会话；它专用于清理早期版本删除后留下的「未分组」幽灵行。

> 为什么需要第 2 步与对账：DSH 的展示层从投影缓存渲染会话行，缓存索引由宿主内存持有并写回磁盘。只删日志与记账（早期版本的行为）会让已删会话以「未分组」幽灵行复活。

### 后备手段

若在插件缺失期间产生了幽灵（例如手工删过日志），可在**完全退出应用后**运行工作区里的脚本兜底：

```powershell
node "D:\我的北邮\本科毕业设计\dsh-ghost-cleanup.mjs"           # 预览（dry-run）
node "D:\我的北邮\本科毕业设计\dsh-ghost-cleanup.mjs" --apply    # 清理（自动备份索引）
```

## 卸载

删除 `cordis.patch.yml` 里那条 `insert` 条目（备份为 `cordis.patch.yml.bak`），重启应用；两个 node_modules 副本可一并删除。

## 依赖

- `@deepseek-ai/dsh-tools` 的 `defineTool`（在 `~/.dsh/profiles/node_modules` 中已存在，向上解析即可）
- 宿主服务：`tools`、`workspaceRegistry`
