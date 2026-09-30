/**
 * 浏览器半边，两个入口：
 *
 * 1. 会话行「…」菜单里的「删除会话」（与「重命名 / 归档」并列，红色危险色）；
 * 2. 助手消息操作条上的垃圾桶图标——**紧挨复制按钮右侧**，用来真删这一轮。
 *
 * 两者都通过宿主命令生效（`ctx.remote.commands.execute`），commands 域是既有的
 * Remote，第三方客户端插件无需构建期代码生成即可调用。真删还用到内置的
 * `remote.session.fork` 与 `uiWorkspace.openSession`。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-session-purge",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

		let react = require("react")
		let react_jsx_runtime = require("react/jsx-runtime")
		// primitives 是被各客户端 bundle 共享依赖的库，不是独立客户端插件；
		// 这里容错获取，拿不到时相关 UI 静默不渲染，绝不影响其余界面。
		let primitives
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives")
		} catch (error) {
			console.error("[session-purge] primitives unavailable:", error)
			primitives = undefined
		}

		/** 会话行「…」菜单的插槽名（由 ui-workspace 声明）。 */
		const MENU_SLOT = "sidebar.workspaces.session.menu.item"
		/** 助手消息操作条插槽：内容渲染在复制按钮之后、分支按钮之前。 */
		const ACTION_SLOT = "conversation.chat.assistant-actions"
		/** 每一轮末尾的插槽：仅用作兜底（见兜底按钮的 CSS 规则）。 */
		const TURN_SLOT = "conversation.chat.turnTail"
		/** 主按钮标记；兜底按钮靠它判断"这一轮已经有主按钮了"。 */
		const MAIN_ATTR = "data-dsh-purge-action"
		/** 兜底按钮标记。 */
		const FALLBACK_ATTR = "data-dsh-purge-fallback"
		/** 宿主注册的命令名（不带斜杠）。 */
		const COMMAND = "purge-session"
		const DROP_COMMAND = "drop-turn"
		const TURN_CUT_COMMAND = "turn-cut"
		const PURGE_ANY_COMMAND = "purge-session-any"
		const ATTACH_COMMAND = "attach-session"
		/** 排序：内置项 pin=100 / rename=200 / fork=300 / archive=400，本项排在最后。 */
		const ORDER = 500
		/** 给自定义图标按钮加悬停反馈用的一次性样式 id。 */
		const STYLE_ID = "dsh-session-purge-actions"
		/** 本页隐藏轮次的持久化键（按会话 id 分组，仅存本机浏览器）。 */
		const HIDDEN_KEY = "dsh-session-purge:hidden-turns"
		/** 隐藏轮次的样式元素 id。 */
		const HIDDEN_STYLE_ID = "dsh-session-purge-hidden-turns"

		/** 需要的客户端服务：插槽注册表、commands Remote、session Remote（分叉用）。 */
		const inject = ["slots", "remote", "remote.commands", "remote.session"]

		/**
		 * 注入一次性样式：让自定义图标按钮有与内置按钮一致的悬停/禁用反馈。
		 *
		 * 注意：**不要**在这里控制 `display`。按钮的布局写在组件的 inline style 里，
		 * 而 inline style 优先级高于样式表，样式表里的 display 规则不会生效
		 * （曾经用 `:has()` 隐藏兜底按钮，正是因此完全失效、导致两个垃圾桶同时出现）。
		 * 兜底按钮的显示与否改由组件自身判断（见 DeleteTurnFallbackButton）。
		 */
		function ensureActionStyles() {
			if (typeof document === "undefined") return
			if (document.getElementById(STYLE_ID) !== null) return
			const style = document.createElement("style")
			style.id = STYLE_ID
			style.textContent = [
				`[${MAIN_ATTR}],[${FALLBACK_ATTR}]{opacity:.6;transition:opacity 80ms}`,
				`[${MAIN_ATTR}]:hover:not(:disabled),[${FALLBACK_ATTR}]:hover:not(:disabled){opacity:1}`,
				`[${MAIN_ATTR}]:disabled,[${FALLBACK_ATTR}]:disabled{opacity:.3;cursor:default}`,
			].join("")
			document.head.appendChild(style)
		}

		/**
		 * 从被点击的元素向上找到所属轮次。
		 *
		 * 不依赖插槽 props：内置对话节点带 `data-chat-turn="<轮号>"`，
		 * 操作条就在该节点内部，因此从 DOM 反查最稳。
		 * @param event - React 点击事件。
		 * @returns 轮号，取不到时 undefined。
		 */
		function turnOfEvent(event) {
			const holder = event?.currentTarget?.closest?.("[data-chat-turn]") ?? null
			if (holder === null) return undefined
			const value = Number(holder.getAttribute("data-chat-turn"))
			return Number.isSafeInteger(value) ? value : undefined
		}

		/**
		 * 从 DOM 读取当前会话 id——内置快捷键逻辑用的也是这个属性。
		 * @returns 会话 id，读不到时 undefined。
		 */
		function currentSessionId() {
			if (typeof document === "undefined") return undefined
			const holder = document.querySelector("[data-conversation-session]")
			const value = holder?.dataset?.conversationSession
			return typeof value === "string" && value !== "" ? value : undefined
		}

		/**
		 * 当前是否有轮次正在生成（此时不允许删除，避免打断运行中的 agent）。
		 * @returns 是否有运行中的轮次。
		 */
		function turnRunning() {
			return typeof document !== "undefined" && document.querySelector("[data-chat-running]") !== null
		}

		/**
		 * 读取本机记录的「已移出上下文」轮次。
		 * @returns 形如 `{ [sessionId]: number[] }` 的对象。
		 */
		function loadHiddenTurns() {
			try {
				const raw = window.localStorage.getItem(HIDDEN_KEY)
				if (raw === null || raw === "") return {}
				const parsed = JSON.parse(raw)
				return parsed !== null && typeof parsed === "object" ? parsed : {}
			} catch {
				return {}
			}
		}

		/**
		 * 按会话作用域注入 CSS，隐藏被移出上下文的轮次。
		 *
		 * 选择器带 `[data-conversation-session]` 前缀，因此不会误伤其他会话里同号的轮次。
		 */
		function renderHiddenCss() {
			if (typeof document === "undefined") return
			let style = document.getElementById(HIDDEN_STYLE_ID)
			if (style === null) {
				style = document.createElement("style")
				style.id = HIDDEN_STYLE_ID
				document.head.appendChild(style)
			}
			const selectors = []
			for (const [sessionId, turns] of Object.entries(loadHiddenTurns())) {
				if (!Array.isArray(turns)) continue
				for (const turn of turns) {
					selectors.push(`[data-conversation-session="${sessionId}"] [data-chat-turn="${turn}"]`)
				}
			}
			style.textContent = selectors.length === 0 ? "" : `${selectors.join(",")}{display:none !important}`
		}

		/**
		 * 把某一轮记入本页隐藏集并立即生效。
		 * @param sessionId - 会话 id。
		 * @param turn - 轮号。
		 */
		function hideTurnLocally(sessionId, turn) {
			const map = loadHiddenTurns()
			const turns = Array.isArray(map[sessionId]) ? map[sessionId] : []
			if (!turns.includes(turn)) turns.push(turn)
			map[sessionId] = turns
			try {
				window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(map))
			} catch {
				// 存储不可用时只影响持久性，本次隐藏仍然生效
			}
			renderHiddenCss()
		}

		/**
		 * 丢弃某个会话里排队中的待发送消息（输入框上方 QueueDock 的那些条目）。
		 *
		 * 队列由驱动写入会话事件（`agent/inbox/spliced`）后投影而来，分叉会把它一起
		 * 复制到新会话——于是"删除某一轮"之后，该轮之前排队的消息会出现在新会话的
		 * 输入框上方。这里在新会话建立后立即清掉，避免它被误发出去。
		 * @param ctx - 客户端插件上下文。
		 * @param sessionId - 目标会话 id。
		 * @returns 成功清除的条数。
		 */
		async function dropQueuedItems(ctx, sessionId) {
			const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined
			const binding = sessions !== undefined && typeof sessions.binding === "function" ? sessions.binding(sessionId) : undefined
			const face = binding?.session?.projections?.faceOf?.("inbox")
			const inbox = typeof face?.getSnapshot === "function" ? face.getSnapshot() : undefined
			if (inbox === null || inbox === undefined) return 0
			const items = [...(inbox["next-turn"] ?? []), ...(inbox["next-step"] ?? [])]
			let removed = 0
			for (const item of items) {
				const itemId = item !== null && typeof item === "object" ? item.id : undefined
				if (typeof itemId !== "string") continue
				try {
					const result = await ctx.remote.session.updateQueue({ sessionId, itemId, action: { kind: "remove" } })
					if (result.ok) removed += 1
					else console.warn("[session-purge] 清除排队消息失败:", result.error.code, result.error.message)
				} catch (error) {
					console.warn("[session-purge] 清除排队消息抛出:", error)
				}
			}
			return removed
		}

		/**
		 * 注册两个 UI 入口。
		 * @param ctx - 客户端插件上下文。
		 */
		function apply(ctx) {
			ensureActionStyles()
			// 页面加载即应用历史隐藏记录（选择器按会话作用域，不需跟踪当前会话）。
			renderHiddenCss()

			/**
			 * 提示一条信息，缺少 alert 时退回 console。
			 * @param message - 提示内容。
			 */
			const notify = (message) => {
				const alertFn = typeof window !== "undefined" ? window.alert : undefined
				if (typeof alertFn === "function") alertFn(message)
				else console.error("[session-purge]", message)
			}

			//#region 入口一：会话行「…」菜单

			/**
			 * 二次确认后触发宿主命令，永久删除已归档会话。
			 * @param sessionId - 目标会话 id。
			 * @param displayTitle - 行上显示的标题，仅用于确认文案。
			 */
			const runPurge = async (sessionId, displayTitle) => {
				const label = displayTitle === undefined || displayTitle === "" ? sessionId : displayTitle
				const confirmFn = typeof window !== "undefined" ? window.confirm : undefined
				if (typeof confirmFn === "function" && !confirmFn(`永久删除已归档会话「${label}」？\n\n该操作不可撤销，会话日志会被删除。`)) {
					return
				}
				try {
					const result = await ctx.remote.commands.execute(sessionId, `/${COMMAND} ${sessionId}`, [])
					if (result.ok) return
					notify(`删除失败：${result.error.code}: ${result.error.message}`)
				} catch (error) {
					console.error("[session-purge] command threw:", error)
				}
			}

			/**
			 * 菜单项组件。插槽按 `{ sessionId, displayTitle }` 渲染，并注入菜单开关状态。
			 * @param props - 插槽属性与注入的菜单状态钩子。
			 * @returns 一行菜单项，或因原语缺失而不渲染。
			 */
			const PurgeSessionMenuItem = (props) => {
				if (primitives === undefined || primitives.MenuItemButton === undefined || primitives.IconTrashOutlineRegular === undefined) {
					return null
				}
				const closeMenu = typeof props.useMenuOpenState === "function"
					? props.useMenuOpenState()[1]
					: undefined
				return react_jsx_runtime.jsx(primitives.MenuItemButton, {
					icon: react_jsx_runtime.jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
					// 原语内置的危险色（跟随主题的红色），比自己写 style 更规范。
					danger: true,
					onSelect: () => {
						if (typeof closeMenu === "function") closeMenu(false)
						void runPurge(props.sessionId, props.displayTitle)
					},
					children: "删除会话",
				})
			}

			ctx.slots.inject(MENU_SLOT, () =>
				ctx.slots.register({ name: MENU_SLOT, id: "purge-session", order: ORDER }, PurgeSessionMenuItem))

			//#endregion

			//#region 入口二：复制按钮旁边的删除按钮

			/**
			 * 轻量路径：把该轮移出模型上下文，并在本页隐藏它（磁盘日志保留）。
			 *
			 * 用于**非最后一轮**——真删只能作用于最后一轮（分叉只保留目标轮之前的前缀，
			 * 否则目标轮之后的对话会一并丢失，这正是"对话被截断"的成因）。
			 * @param turn - 轮号。
			 * @returns 是否成功。
			 */
			const runShadowTurn = async (turn) => {
				const sessionId = currentSessionId()
				if (sessionId === undefined) {
					notify("找不到当前会话，无法移除本轮。")
					return false
				}
				try {
					const result = await ctx.remote.commands.execute(sessionId, `/${DROP_COMMAND} ${turn}`, [])
					if (!result.ok) {
						notify(`移除失败：${result.error.code}: ${result.error.message}`)
						return false
					}
					const outcome = result.value === undefined ? undefined : result.value.result
					if (outcome === undefined || outcome.kind === "error") {
						notify(`移除失败：${outcome === undefined ? "无返回" : outcome.text}`)
						return false
					}
					hideTurnLocally(sessionId, turn)
					notify(
						`第 ${turn} 轮不是最后一轮，真删会把 ${turn} 之后的对话一起丢掉，` +
							`因此改为「移出上下文」：\n\n· 模型不再看到这一轮\n· 本页已隐藏这一轮\n· 磁盘日志保留（不删历史）\n\n` +
							`若一定要磁盘不留痕，请先删掉它之后的轮次，再删这一轮。`,
					)
					return true
				} catch (error) {
					console.error("[session-purge] shadow turn threw:", error)
					notify(`移除失败：${error instanceof Error ? error.message : String(error)}`)
					return false
				}
			}

			/**
			 * 真删流程：① 问宿主取分叉截断点 ② 内置分叉出新会话（不含该轮）
			 * ③ 切到新会话 ④ 原会话变冷后按 id 从磁盘删掉它。
			 *
			 * 之所以绕一圈：`seq` 是位置索引，直接抠掉中间事件会让后续所有引用错位，
			 * 所以 DSH 只能靠"分叉 + 删除原会话"实现磁盘层面的真删。
			 * @param turn - 轮号。
			 */
			const runNukeTurn = async (turn) => {
				const sessionId = currentSessionId()
				if (sessionId === undefined) {
					notify("找不到当前会话，无法删除本轮。")
					return
				}
				const confirmFn = typeof window !== "undefined" ? window.confirm : undefined
				if (typeof confirmFn === "function" && !confirmFn(
					`删除第 ${turn} 轮？\n\n· 若它是最后一轮 → 磁盘真删：新建一个不含该轮的会话并删除原会话（不留痕）\n· 若它后面还有对话 → 只做「移出上下文」：模型与本页不再显示它，磁盘保留（因为真删会连带丢掉后面的对话）\n\n不可撤销。`,
				)) {
					return
				}
				try {
					// ① 截断点：该轮第一条事件的前一个 seq
					const cutResult = await ctx.remote.commands.execute(sessionId, `/${TURN_CUT_COMMAND} ${turn}`, [])
					if (!cutResult.ok) {
						notify(`删除失败：${cutResult.error.code}: ${cutResult.error.message}`)
						return
					}
					const cutOutcome = cutResult.value === undefined ? undefined : cutResult.value.result
					if (cutOutcome === undefined || cutOutcome.kind !== "success") {
						const text = cutOutcome === undefined ? "无返回" : cutOutcome.text
						// 宿主判定"不是最后一轮"：降级为「移出上下文」，绝不做会截断对话的真删。
						if (typeof text === "string" && text.includes("NOT_LAST_TURN")) {
							await runShadowTurn(turn)
							return
						}
						notify(`删除失败：${text}`)
						return
					}
					const match = /cut=(\d+)/.exec(cutOutcome.text)
					if (match === null) {
						notify(`删除失败：无法解析截断点（${cutOutcome.text}）`)
						return
					}
					const atSeq = Number(match[1])

					// ② 用内置分叉（含 agent 组装与工作区归属）
					const forkResult = await ctx.remote.session.fork({ sessionId, atSeq })
					if (!forkResult.ok) {
						notify(`删除失败（分叉）：${forkResult.error.code}: ${forkResult.error.message}`)
						return
					}
					const childId = forkResult.value === undefined ? undefined : forkResult.value.sessionId
					if (childId === undefined) {
						notify("删除失败：分叉没有返回新会话 id。")
						return
					}

					// ②.5 把新会话挂回原会话所属的工作区。
					// 分叉只继承 cwd，不会自动进入工作区记账，不挂就会掉进「未分组」。
					// 必须切走之前调用：此时调用者仍是原会话，宿主才能解析出正确的工作区归属。
					const attachResult = await ctx.remote.commands.execute(sessionId, `/${ATTACH_COMMAND} ${childId}`, [])
					if (!attachResult.ok) {
						console.warn("[session-purge] attach failed:", attachResult.error.code, attachResult.error.message)
					} else {
						const attachOutcome = attachResult.value === undefined ? undefined : attachResult.value.result
						if (attachOutcome !== undefined && attachOutcome.kind === "error") {
							console.warn("[session-purge] attach refused:", attachOutcome.text)
						}
					}

					// ②.6 清掉新会话继承来的排队消息。
					// 队列是 `agent/inbox/spliced` 事件投影出来的，分叉复制日志前缀时会
					// 一并带来——于是那条"待发送"的消息会挂在输入框上方（看起来像是自动
					// 引用了被删的那一轮）。不处理的话它还会被发出去，所以这里直接丢弃。
					const queued = await dropQueuedItems(ctx, childId)
					if (queued > 0) console.log(`[session-purge] 已清掉新会话继承的 ${queued} 条排队消息`)

					// ③ 切到新会话，让原会话变冷
					const navigation = typeof ctx.get === "function" ? ctx.get("uiWorkspace") : undefined
					if (navigation !== undefined && typeof navigation.openSession === "function") {
						navigation.openSession(childId)
					} else {
						notify(`已新建不含该轮的会话 ${childId}，请手动打开它。`)
						return
					}

					// ④ 删原会话（在新会话里执行，宿主会拒绝删除正在执行该命令的会话）
					const purgeResult = await ctx.remote.commands.execute(childId, `/${PURGE_ANY_COMMAND} ${sessionId}`, [])
					if (!purgeResult.ok) {
						notify(`新会话已就绪，但删除原会话失败：${purgeResult.error.code}: ${purgeResult.error.message}`)
						return
					}
					const purgeOutcome = purgeResult.value === undefined ? undefined : purgeResult.value.result
					if (purgeOutcome !== undefined && purgeOutcome.kind === "error") {
						notify(`新会话已就绪，但删除原会话失败：${purgeOutcome.text}`)
						return
					}
					console.log("[session-purge]", purgeOutcome === undefined ? "已删除原会话" : purgeOutcome.text)
				} catch (error) {
					console.error("[session-purge] delete-turn threw:", error)
					notify(`删除失败：${error instanceof Error ? error.message : String(error)}`)
				}
			}

			/**
			 * 操作条上的删除按钮：图标样式与内置复制/分支按钮一致，位置紧随复制按钮。
			 * 轮号从 DOM 反查，不依赖插槽 props。
			 * @param props - 插槽属性（本组件不使用）。
			 * @returns 一个图标按钮。
			 */
			/**
			 * 每秒刷新一次"本轮是否仍在生成"，让按钮的禁用态能自己更新。
			 * @returns 是否有轮次正在生成。
			 */
			const useTurnBusy = () => {
				const [busy, setBusy] = react.useState(turnRunning())
				react.useEffect(() => {
					const timer = setInterval(() => setBusy(turnRunning()), 1000)
					return () => clearInterval(timer)
				}, [])
				return busy
			}

			/**
			 * 图标按钮本体：样式与内置复制/分支按钮一致（24×24、透明底、继承颜色）。
			 * @param props - `attr` 标记属性；`innerRef` 供兜底按钮测量自身位置。
			 * @returns 一个图标按钮（有 Tooltip 原语时套上悬停提示）。
			 */
			const PurgeIconButton = ({ attr, innerRef }) => {
				const busy = useTurnBusy()
				if (primitives === undefined || primitives.IconTrashOutlineRegular === undefined) return null
				const label = busy ? "本轮仍在生成，结束后才能删除" : "删除这一轮（磁盘不留痕）"
				const onClick = (event) => {
					const turn = turnOfEvent(event)
					if (turn === undefined) {
						notify("无法确定轮号（DOM 里找不到 data-chat-turn），已取消。")
						return
					}
					void runNukeTurn(turn)
				}
				const button = react_jsx_runtime.jsx("button", {
					type: "button",
					[attr]: "",
					ref: innerRef,
					disabled: busy,
					"aria-label": label,
					title: label,
					onClick,
					style: {
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						width: "24px",
						height: "24px",
						padding: "0",
						border: "none",
						background: "transparent",
						color: "inherit",
						cursor: busy ? "default" : "pointer",
					},
					children: react_jsx_runtime.jsx(primitives.IconTrashOutlineRegular, {}),
				})
				// 有 Tooltip 原语时用悬停提示（与内置复制/分支按钮一致），否则退回 title。
				if (primitives.Tooltip === undefined) return button
				return react_jsx_runtime.jsx(primitives.Tooltip, { label, side: "bottom", children: button })
			}

			/**
			 * 主按钮：注册进操作条，渲染位置紧挨复制按钮右侧
			 * （ui-chat 把 assistant-actions 放在复制与分支之间）。
			 * @returns 图标按钮。
			 */
			const DeleteTurnMainButton = () => react_jsx_runtime.jsx(PurgeIconButton, { attr: MAIN_ATTR })

			/**
			 * 兜底按钮：只调工具、没有最终文字输出的轮次没有 messageId，
			 * ui-chat 会整个跳过 assistant-actions 插槽，那些轮次由这里接管。
			 *
			 * 挂载后测量同一轮（`data-chat-turn` 祖先）内是否已经存在主按钮，有则自己不渲染，
			 * 因此不会出现"两个垃圾桶"。这里刻意用 React 判断而不是 CSS：
			 * 按钮的 display 写在 inline style 上，样式表规则压不过它。
			 * @returns 图标按钮，或 null。
			 */
			const DeleteTurnFallbackButton = () => {
				const innerRef = react.useRef(null)
				const [needed, setNeeded] = react.useState(true)
				react.useLayoutEffect(() => {
					const check = () => {
						const holder = innerRef.current === null ? null : innerRef.current.closest("[data-chat-turn]")
						setNeeded(holder !== null && holder.querySelector(`[${MAIN_ATTR}]`) === null)
					}
					check()
					const timer = setInterval(check, 1000)
					return () => clearInterval(timer)
				}, [])
				if (!needed) return null
				return react_jsx_runtime.jsx(PurgeIconButton, { attr: FALLBACK_ATTR, innerRef })
			}

			// 主按钮：紧挨复制按钮右侧。
			ctx.slots.inject(ACTION_SLOT, () =>
				ctx.slots.register({
					name: ACTION_SLOT,
					id: "purge-turn",
					order: ORDER,
					// 与内置插件（message-feedback / plan / deliverables）保持一致的注册形状：
					// 该插槽 scope 为 session，内置实现都带 inject。
					inject: () => ({}),
				}, DeleteTurnMainButton))

			// 兜底按钮：接管没有操作条的轮次。
			ctx.slots.inject(TURN_SLOT, () =>
				ctx.slots.register({ name: TURN_SLOT, id: "purge-turn-fallback", order: ORDER }, DeleteTurnFallbackButton))

			//#endregion
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
