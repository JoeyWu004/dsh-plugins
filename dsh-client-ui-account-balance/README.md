# dsh-client-ui-account-balance

在 DSH 桌面端**左侧栏底部**常驻显示账户余额，每 60 秒自动刷新，点击可立即刷新。

## 效果

- 位置：左栏底部（`sidebar.footer.action` 插槽），任何界面都可见
- 内容：`¥12.34`（多币种钱包会并列显示，币种符号自动取 ¥ / $）
- 刷新：每 60 秒一次；点击立即刷新；连接重连后立即刷新
- 悬浮提示：说明刷新策略；读取失败时显示原因

## 原理

余额数据**不需要自己抓**——宿主已经提供了 `account.getBalance` Remote：

```js
const result = await ctx.remote.account.getBalance({
  version, locale, timezoneOffsetSeconds,
})
// result.ok === true 时，result.value 是「余额结果对象」：
//   { status, value: [{ currency: 'CNY', balance: '12.34' }, ...], bonusWallets: [...] }
// 本插件同时兼容「直接返回钱包数组」的形状，以防版本差异。
```

本插件只做三件事：按 60 秒轮询调用它、按 Platform 的显示规则格式化（向下取整到分 / 亚分显示 `<¥0.01` / 千分位）、把结果渲染进插槽。只有赠送余额时显示「赠 ¥5.00」。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半边：空的 `apply()`，只为了让 loader 有一行可挂载的宿主插件 |
| `lib/client.js` | 浏览器半边：轮询余额并注册侧栏插槽组件（手写的 `__ModuleLoader__` bundle，无构建步骤） |
| `package.json` | 声明 `exports["./client"]` 与 `dsh.client` 元数据 |

## 安装

安装要做两件事：把插件目录放进目标 profile 的 `node_modules`，并在该 profile 的 `cordis.patch.yml` 末尾追加插入条目。

```powershell
# 以 desktop profile 为例；$env:USERPROFILE\.dsh 即 $DSH_HOME 的默认值
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
Copy-Item '.\dsh-client-ui-account-balance' (Join-Path $dshHome 'profiles\desktop\node_modules') -Recurse -Force
```

追加的插入条目：

```yaml
- insert:
    - id: ui-account-balance
      name: 'dsh-client-ui-account-balance'
```

安装后需要**重启桌面应用**才会加载。

## 卸载

删除 `cordis.patch.yml` 里那条 `insert` 条目，然后重启应用；profile 的 `node_modules` 与 `$DSH_HOME\plugins` 下的副本可一并删除。

## 维护提示

- 如果将来通过桌面端安装/更新其他插件导致本插件消失（profile 的 pnpm 可能清理未声明的包），把稳定副本重新复制回 profile 的 `node_modules` 即可：
  ```powershell
  Copy-Item "$env:USERPROFILE\.dsh\plugins\dsh-client-ui-account-balance" `
            "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\" -Recurse -Force
  ```
- 客户端身份元数据需要一个客户端版本号：优先读启动载荷 `__DSH_BOOT__`，读不到时回落到硬编码的 `0.2.0-rc.2`（编写时桌面端版本）。应用大版本升级后如有异常，改这一处即可。
