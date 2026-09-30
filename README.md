# dsh-plugins

两个自写的 DSH（DeepSeek Harness，0.2.0-rc.2）插件。

| 插件 | 作用 |
|---|---|
| [`dsh-plugin-session-purge`](./dsh-plugin-session-purge/) | 会话清理：删除已归档会话、删除某一轮、把会话移动到另一个工作台 |
| [`dsh-client-ui-account-balance`](./dsh-client-ui-account-balance/) | 侧栏底部的账户余额指示器（60 秒刷新，点击立即刷新） |

两个插件都是**手写 `lib/`，没有构建步骤**：`lib/index.js` 是宿主半边，`lib/client.js` 是浏览器半边（手写的 `__ModuleLoader__` bundle，不依赖打包器）。改完直接生效。

## 仓库结构

```
dsh-plugin-session-purge/       插件一（package.json / README.md / lib/）
dsh-client-ui-account-balance/  插件二
deploy.ps1                      把两个插件部署到本机 DSH（见下）
tools/dsh-ghost-cleanup.mjs     投影缓存幽灵行清理（兜底工具，默认 dry-run）
README.md                       本文件
LICENSE                         MIT
```

## 安装

DSH 只从**目标 profile 的 `node_modules`** 加载插件，并且要求该 profile 的 `cordis.patch.yml` 里有对应条目。以 `desktop` profile 为例：

```powershell
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$modules = Join-Path $dshHome 'profiles\desktop\node_modules'

Copy-Item '.\dsh-plugin-session-purge'      $modules -Recurse -Force
Copy-Item '.\dsh-client-ui-account-balance' $modules -Recurse -Force
```

然后在 `$dshHome\profiles\desktop\cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: session-purge
      name: 'dsh-plugin-session-purge'
- insert:
    - id: ui-account-balance
      name: 'dsh-client-ui-account-balance'
```

**重启桌面应用**才会加载。

### 用 deploy.ps1

仓库里的 `deploy.ps1` 把上面的步骤包成一条命令：从本仓库读插件，写到 `$DSH_HOME\plugins`（稳定副本）与 profile 的 `node_modules`，并自动补齐 `cordis.patch.yml` 里缺失的注册条目（改动前备份为 `.bak`）。

```powershell
pwsh -File .\deploy.ps1                 # 默认 desktop
pwsh -File .\deploy.ps1 -Profile web    # 其他 profile
```

幂等，而且是**镜像**语义：源头的文件覆盖到目标，源头没有的多余文件会被删除（**源头里存在的文件永不删除**）。运行中执行是安全的，但同样需要**重启应用**才生效。

## 维护说明

本仓库是这两个插件的**唯一源头**；`$DSH_HOME\plugins`（稳定副本，DSH 升级重装依赖后可从它恢复）与 profile 的 `node_modules`（真正被加载的位置）都是它的产物。改动只在这里做，然后跑一次 `deploy.ps1`、重启应用；三处内容可用哈希核对是否一致。

桌面端自带一份打包的 dsh（`desktop\resources\app.asar`），**既不读本仓库、也不读其余任何源码目录**——只有 profile 的 `node_modules` 生效。

`tools/dsh-ghost-cleanup.mjs` 是兜底工具：投影缓存的索引文件由宿主内存持有，运行期间改动会被覆盖，所以它**必须在 DSH 完全退出后**运行（默认 dry-run，`--apply` 才真正清理，且会先备份索引）。正常情况下插件自带的定时巡检已经自动处理，用不到它。

`deploy.ps1` 的消息刻意全用 ASCII：Windows PowerShell 5.1 会把无 BOM 的 UTF-8 脚本按 ANSI 解码，中文提示会变成乱码。

### 从源码模式（`pnpm dsh web`）加载

源码模式下 dsh 从仓库自己的 `node_modules` 解析包，因此还需：

1. 在仓库根执行 `pnpm install`；
2. 把这些包链接或复制进仓库可解析的位置，并在所用 profile 的 `cordis.patch.yml` 里加对应 `insert` 条目；
3. 重启该模式下的 dsh。

## 依赖

两个插件都依赖 DSH 自身的包：

- `@deepseek-ai/cordis`（插件框架）
- `@deepseek-ai/dsh-tools`（`session-purge` 用它注册模型工具）
- 客户端半边通过 `dsh.client` 元数据声明要注入的服务

它们不发布到 npm（`"private": true`），请直接从本仓库复制进 profile 使用。

## 许可

MIT，见 [LICENSE](./LICENSE)。
