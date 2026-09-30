# local-plugins —— DSH 本地自写插件（不随上游发布）

本目录存放本机自写的 DSH 插件源码副本。**注意：桌面端不会从这里加载插件。**

## 三个位置的分工

| 位置 | 角色 | 谁读它 |
|---|---|---|
| `D:\deepseek-harness\local-plugins\`（本目录） | **源码副本**，随仓库一起保管/查看 | 没人自动读；仅供阅读、备份、源码模式参考 |
| `C:\Users\Lenovo\.dsh\plugins\` | **稳定副本**（安装源） | 恢复脚本从这里复制 |
| `C:\Users\Lenovo\.dsh\profiles\<profile>\node_modules\` | **实际加载位置** | DSH 运行时（桌面端 / `dsh web` 等） |

桌面端自带一份打包的 dsh（位于 `desktop\resources\app.asar`），**不读本目录、也不读仓库源码**。插件必须出现在 profile 的 `node_modules` 里、并在该 profile 的 `cordis.patch.yml` 有注册条目，才会生效。

## 目录内容

| 插件 | 作用 | 入口 |
|---|---|---|
| `dsh-plugin-session-purge` | 两处删除入口：① 侧栏会话行「…」菜单里的红色「删除会话」——永久删除已归档的整个会话；② 助手消息操作条上（**复制按钮右侧**）的垃圾桶图标——**删除这一轮**，做法是先分叉出不含该轮的新会话再删除原会话，因此磁盘上不留痕。另有宿主模型工具 `session_purge_archived` / `session_drop_turn` 与命令 `/purge-session`、`/drop-turn`、`/turn-cut`、`/purge-session-any` | `lib/index.js`、`lib/client.js` |
| `dsh-client-ui-account-balance` | 侧栏底部常驻账户余额（每 60 秒刷新，点击立即刷新；读取 `remote.account.getBalance` 的 `value` / `bonusWallets` 两个字段） | `lib/index.js`、`lib/client.js` |

> 权威副本在 `C:\Users\Lenovo\.dsh\plugins\` 与开发工作区（`D:\我的北邮\本科毕业设计\dsh-plugin-*`）；本目录是随仓库保管的快照。四处内容应保持一致（可用哈希核对）。

## 让它们生效（或更新后恢复）

在普通 PowerShell 里运行工作区中的恢复脚本即可（幂等）：

```powershell
pwsh -File "D:\我的北邮\本科毕业设计\dsh-plugins-restore.ps1"
```

它会：① 从 `~/.dsh\plugins\` 复制插件到 profile 的 `node_modules`；② 检查并在缺失时补写 `cordis.patch.yml` 的 `insert` 条目（改动前自动备份）。

## 若要从源码模式（`pnpm dsh web`）加载

源码模式下 dsh 从仓库自己的 `node_modules` 解析包，因此还需：

1. 在仓库根执行 `pnpm install`（当前 `node_modules` 已清理过，必须先安装）；
2. 把本目录的包链接或复制进仓库可解析的位置，并在所用 profile 的 `cordis.patch.yml` 里加对应 `insert` 条目；
3. 重启该模式下的 dsh。

## 维护提示

- 本目录已加入 `.git/info/exclude`（本地忽略），因此不会污染 `git status`，也不会随 `git pull` 被覆盖或删除；
- 但 `git clean -xfd` 之类会删除未跟踪目录——**切勿**在未备份时对仓库执行它；
- 仓库更新（`git pull`）或你清理仓库时，本副本可能消失；真正的加载副本在 `~/.dsh`，不受影响。
