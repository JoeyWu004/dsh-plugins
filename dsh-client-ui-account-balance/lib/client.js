/**
 * 浏览器半边：在左侧栏底部常驻显示账户余额。
 *
 * 数据来源是宿主已有的 `account.getBalance` Remote（由 dsh-api-account-controller
 * 提供、dsh-deepseek-account-platform 实现），本插件只做取数、格式化与展示。
 *
 * 说明：客户端插件是运行时按需加载的独立 bundle，必须手写这个
 * `window.__ModuleLoader__.load({ id, factory })` 包装，不能依赖打包器。
 */
window.__ModuleLoader__.load({
	id: "dsh-client-ui-account-balance",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

		let react = require("react")
		let react_jsx_runtime = require("react/jsx-runtime")

		//#region 常量与格式化

		/** 刷新间隔：60 秒。 */
		const REFRESH_MS = 60_000

		/**
		 * 复刻 Platform Web 的余额显示规则：整分两位小数、亚分显示为 <¥0.01、
		 * 负数绝对值小于一分显示 0.01、千分位分组。
		 * @param amount - 接口返回的十进制余额字符串。
		 * @param symbol - 货币符号。
		 * @returns 可直接展示的余额文本。
		 */
		function formatBalance(amount, symbol) {
			const value = Number(amount)
			if (!Number.isFinite(value)) return symbol + "--"
			if (value === 0) return symbol + "0.00"
			if (value < 0) {
				return "-" + symbol + (value > -0.01 ? "0.01" : addCommas(Math.abs(value).toFixed(2)))
			}
			if (value < 0.01) return "<" + symbol + "0.01"
			// 向下取整到分，与 Platform 的 roundDown 一致。
			return symbol + addCommas((Math.floor(value * 100) / 100).toFixed(2))
		}

		/** 给定点小数字符串加千分位。 */
		function addCommas(text) {
			const parts = text.split(".")
			return Number(parts[0]).toLocaleString() + "." + parts[1]
		}

		/** 货币代码到符号。 */
		function symbolOf(currency) {
			return currency === "CNY" ? "¥" : "$"
		}

		/**
		 * 构造 account Remote 需要的调用方身份元数据。
		 * 宿主据此派生 Platform 请求头，因此字段形状必须与内置账户插件一致。
		 * @param locale - 当前生效的界面语言。
		 * @param version - 客户端构建版本。
		 * @returns Remote 方法携带的身份对象。
		 */
		function accountClientMetadata(locale, version) {
			if (version === undefined || version === "") {
				throw new Error("account-balance: this client build carries no version")
			}
			return {
				version,
				locale,
				timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
			}
		}

		/**
		 * 解析客户端版本：优先取启动载荷，最后回落到本插件编写时的桌面端版本。
		 * @returns 非空版本字符串。
		 */
		function resolveClientVersion() {
			const boot = globalThis.__DSH_BOOT__
			const candidates = [
				boot && boot.version,
				boot && boot.clientVersion,
				boot && boot.release && boot.release.version,
			]
			for (const value of candidates) {
				if (typeof value === "string" && value !== "") return value
			}
			return "0.2.0-rc.2"
		}

		//#endregion

		//#region 余额数据源

		/**
		 * 一个可订阅的余额快照源。轮询由 apply 的 effect 负责启动与回收，
		 * 组件只负责订阅，因此组件反复挂载不会产生多个定时器。
		 * @param ctx - 客户端插件上下文。
		 * @param version - 客户端版本字符串。
		 * @returns 读取、订阅与快照读取接口。
		 */
		function createBalanceSource(ctx, version) {
			let snapshot = { status: "loading", wallets: undefined, bonusWallets: undefined, error: undefined }
			const listeners = new Set()

			const publish = (next) => {
				snapshot = next
				for (const listener of listeners) listener(snapshot)
			}

			/** 读取一次余额；任何失败都落到 error 状态，绝不抛给调用方。 */
			const read = async () => {
				try {
					const identity = accountClientMetadata(ctx.locale.getSnapshot().active, version)
					const result = await ctx.remote.account.getBalance(identity)
					if (!result || result.ok !== true) throw new Error("account balance request failed")
					const payload = result.value
					// 宿主返回的是「余额结果对象」：{ status, value: Wallet[], bonusWallets: Wallet[] }。
					// 内置账户界面读的正是 payload.value 与 payload.bonusWallets；
					// 这里同时兼容「直接返回钱包数组」的形状，避免版本差异再次踩坑。
					if (payload === null || payload === undefined) {
						publish({ status: "signed-out", wallets: [], bonusWallets: [], error: undefined })
						return
					}
					const wallets = Array.isArray(payload)
						? payload
						: Array.isArray(payload.value) ? payload.value : []
					const bonusWallets = Array.isArray(payload.bonusWallets) ? payload.bonusWallets : []
					publish({ status: "ready", wallets, bonusWallets, error: undefined })
				} catch (error) {
					const message = error && error.message ? error.message : String(error)
					publish({ status: "error", wallets: undefined, bonusWallets: undefined, error: message })
				}
			}

			const subscribe = (listener) => {
				listeners.add(listener)
				listener(snapshot)
				return () => {
					listeners.delete(listener)
				}
			}

			return { read, subscribe, getSnapshot: () => snapshot }
		}

		//#endregion

		//#region 展示组件

		/**
		 * 侧栏底部的余额指示器。点击立即刷新一次。
		 * @param props - 由 slot 注入的余额数据源与刷新回调。
		 * @returns 一行余额文本。
		 */
		function BalanceIndicator(props) {
			const [state, setState] = react.useState(props.source.getSnapshot())

			react.useEffect(() => {
				return props.source.subscribe(setState)
			}, [props.source])

			let text
			let hint
			if (state.status === "signed-out") {
				text = "未登录"
				hint = "尚未登录 DeepSeek 账号，无法读取余额"
			} else if (state.status === "ready") {
				const wallets = Array.isArray(state.wallets) ? state.wallets : []
				const bonus = (Array.isArray(state.bonusWallets) ? state.bonusWallets : [])
					.filter((wallet) => Number(wallet.balance) > 0)
				if (wallets.length > 0) {
					text = wallets.map((wallet) => formatBalance(wallet.balance, symbolOf(wallet.currency))).join("  ")
					hint = "账户余额 · 每 60 秒自动刷新 · 点击立即刷新"
				} else if (bonus.length > 0) {
					text = "赠 " + bonus.map((wallet) => formatBalance(wallet.balance, symbolOf(wallet.currency))).join("  ")
					hint = "仅有赠送余额 · 每 60 秒自动刷新 · 点击立即刷新"
				} else {
					text = "余额不可用"
					hint = "账号已登录，但平台未返回钱包余额（充值钱包与赠送钱包都为空）"
				}
			} else if (state.status === "error") {
				text = "余额读取失败"
				hint = state.error ? "余额读取失败：" + state.error : "余额读取失败"
			} else {
				text = "余额 …"
				hint = "正在读取账户余额"
			}

			return react_jsx_runtime.jsx("span", {
				role: "button",
				tabIndex: 0,
				title: hint,
				onClick: props.onRefresh,
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") props.onRefresh()
				},
				style: {
					display: "inline-flex",
					alignItems: "center",
					cursor: "pointer",
					fontSize: "12px",
					lineHeight: "20px",
					opacity: state.status === "ready" ? 0.78 : 0.55,
					whiteSpace: "nowrap",
					userSelect: "none",
				},
				children: text,
			})
		}

		//#endregion

		//#region 插件入口

		/** 需要的客户端服务：插槽注册表、语言、Remote 与 account Remote。 */
		const inject = ["slots", "locale", "remote", "remote.account"]

		/**
		 * 注册余额指示器并启动轮询。
		 * @param ctx - 客户端插件上下文。
		 */
		function apply(ctx) {
			try {
				const version = resolveClientVersion()
				const source = createBalanceSource(ctx, version)

				// 轮询随插件生命周期回收；重连后立刻重读一次。
				ctx.effect(() => {
					void source.read()
					const timer = setInterval(() => {
						void source.read()
					}, REFRESH_MS)
					return () => clearInterval(timer)
				}, "account-balance: balance polling lifetime")

				ctx.on("connection/reset", () => {
					void source.read()
				})

				ctx.slots.inject("sidebar.footer.action", () =>
					ctx.slots.register(
						{
							name: "sidebar.footer.action",
							id: "account-balance",
							inject: () => ({
								source,
								onRefresh: () => {
									void source.read()
								},
							}),
						},
						BalanceIndicator,
					),
				)
			} catch (error) {
				// 展示层插件绝不能让组装失败。
				console.error("account-balance: apply failed", error)
			}
		}

		//#endregion

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
