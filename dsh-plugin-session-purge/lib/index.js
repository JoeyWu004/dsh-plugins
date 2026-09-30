/**
 * 宿主侧插件：永久删除「已归档会话」。
 *
 * 对外提供两个入口，共用同一套删除实现：
 *   1. 模型工具 `session_purge_archived` —— agent 可直接调用（支持批量、dry-run）
 *   2. 命令 `/purge-session <会话id>` —— 供客户端「…」菜单点击后通过
 *      `ctx.remote.commands.execute()` 触发
 *
 * 背景：DSH 0.2.0-rc.2 的 Remote API 只有 archiveSession / unarchiveSession，
 * 没有删除会话的入口；持久层也没有 delete API。因此本插件直接执行四件事：
 *   1. 删除磁盘上的会话日志目录（<dshHome>/sessions/<项目>/<会话id>/）
 *   2. 删除该会话的投影缓存行（sessionProjectionCache 的域表，写穿到介质）
 *   3. 从所属工作区的记账里摘下该会话（workspaceRegistry 实体的 detachSession）
 *   4. 清掉归档标记（workspaceRegistry.unarchiveSession）
 *
 * 另有一次启动对账：把「日志已不存在且无任何工作区归属」的历史缓存行删掉，
 * 用于清理旧版本删除留下的「未分组」幽灵。
 */

import { appendFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'session-purge'

/** 需要的宿主服务：工具注册表、工作区注册表、命令注册表。 */
export const inject = ['tools', 'workspaceRegistry', 'commands']

/** 客户端菜单使用的命令名（不带斜杠）。 */
const COMMAND_NAME = 'purge-session'

/** 对话页「移除本轮」按钮使用的命令名（不带斜杠）。 */
const DROP_TURN_COMMAND = 'drop-turn'

/** 「真删此轮」第一步：报告分叉截断点。 */
const TURN_CUT_COMMAND = 'turn-cut'

/** 「真删此轮」最后一步：按 id 直接删除一个会话（不限归档状态）。 */
const PURGE_ANY_COMMAND = 'purge-session-any'

/** 把分叉出来的新会话挂回调用者所属的工作区（否则它会掉进「未分组」）。 */
const ATTACH_COMMAND = 'attach-session'

/**
 * DSH 配置根目录。
 * @returns `$DSH_HOME`，未设置时回落到 `~/.dsh`。
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured !== '' ? configured : path.join(homedir(), '.dsh')
}

/**
 * 有界递归统计一个目录的文件数与总字节数。
 * @param dir - 目标目录。
 * @param depth - 当前递归深度（超过 4 层不再下探）。
 * @returns 文件数与字节数。
 */
async function measure(dir, depth = 0) {
  let bytes = 0
  let files = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { bytes, files }
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < 4) {
        const nested = await measure(child, depth + 1)
        bytes += nested.bytes
        files += nested.files
      }
      continue
    }
    try {
      const info = await stat(child)
      bytes += info.size
      files += 1
    } catch {
      // 并发消失的文件直接忽略
    }
  }
  return { bytes, files }
}

/**
 * 在 `<dshHome>/sessions/<项目目录>/<会话id>` 定位该会话的日志目录。
 * @param sessionId - 会话 id。
 * @returns 命中的日志目录列表。
 */
async function locateLogs(sessionId) {
  const root = path.join(dshHome(), 'sessions')
  const found = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = path.join(root, project.name, sessionId)
    let info
    try {
      info = await stat(candidate)
    } catch {
      continue
    }
    if (!info.isDirectory()) continue
    const size = await measure(candidate)
    found.push({ project: project.name, dir: candidate, bytes: size.bytes, files: size.files })
  }
  return found
}

/**
 * 人类可读的字节数。
 * @param bytes - 字节数。
 * @returns 带单位的文本。
 */
function human(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/**
 * 列出当前归档集合。
 * @param registry - 工作区注册表服务。
 * @returns 归档会话 id 数组。
 */
function archivedIds(registry) {
  return Array.isArray(registry.archivedSessionIds) ? [...registry.archivedSessionIds] : []
}

/**
 * 通过投影缓存的域表删除一行——这是写穿到介质的正规删除
 * （持久化、内存、变更事件一起走，见 dsh-storage-domain 的 table.delete）。
 * @param cache - `ctx.sessionProjectionCache` 服务（可能尚未就绪）。
 * @param sessionId - 目标会话 id。
 * @returns 是否确实删掉了一行。
 */
async function deleteCacheRow(cache, sessionId) {
  const table = cache?.table
  if (table === undefined || typeof table.delete !== 'function') return false
  try {
    return await table.delete(sessionId) === true
  } catch {
    // 缓存清理失败不能影响删除主体；下次启动的对账会再试一次。
    return false
  }
}

/**
 * 追加一行巡检日志到 `<dshHome>/session-purge.log`。
 *
 * 桌面端的宿主日志不易查看，所以关键判断自己落盘一份，便于事后定位。
 * @param message - 日志内容。
 */
async function logLine(message) {
  try {
    await appendFile(path.join(dshHome(), 'session-purge.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    // 记不下日志不影响功能
  }
}

/**
 * 列出磁盘上现存的会话 id 集合（`<dshHome>/sessions/<项目>/<会话id>`）。
 *
 * 比逐个 locateLogs 便宜得多（只有两层 readdir），适合周期性巡检。
 * @returns 会话 id 集合。
 */
async function listOnDiskSessions() {
  const root = path.join(dshHome(), 'sessions')
  const ids = new Set()
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return ids
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let sessions
    try {
      sessions = await readdir(path.join(root, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (session.isDirectory()) ids.add(session.name)
    }
  }
  return ids
}

/**
 * 幽灵行巡检：删除「日志目录已不存在**且**不被任何工作区记账」的缓存行。
 * 这是清掉「未分组/未分类」幽灵的关键——仅凭日志缺失还不够，
 * 必须同时确认没有工作区还认领这个会话，避免误删。
 *
 * 注意：删除动作发生在会话仍活在宿主内存时，宿主可能把缓存行写回来，
 * 所以除了启动时，删除之后与定时周期都要再巡检一次（见 apply 中的定时器）。
 * @param cache - `ctx.sessionProjectionCache` 服务。
 * @param registry - 工作区注册表服务。
 * @param reason - 触发来源，仅用于日志。
 * @returns 清理掉的缓存行数。
 */
async function reconcileGhostRows(cache, registry, reason) {
  const table = cache?.table
  if (table === undefined || typeof table.keys !== 'function') {
    await logLine(`reconcile(${reason}): 跳过——投影缓存域表不可用`)
    return 0
  }
  let ids = []
  try {
    ids = [...table.keys()]
  } catch (error) {
    await logLine(`reconcile(${reason}): 读取缓存行失败：${String(error)}`)
    return 0
  }
  const accounted = new Set()
  try {
    for (const entity of registry.list()) {
      for (const id of entity.sessionIds ?? []) accounted.add(id)
    }
  } catch (error) {
    // 拿不到记账就退化为不清理，宁可不删。
    await logLine(`reconcile(${reason}): 读取工作区记账失败，本次跳过：${String(error)}`)
    return 0
  }
  const onDisk = await listOnDiskSessions()
  let removed = 0
  const removedIds = []
  for (const id of ids) {
    // 判据只用「磁盘上有没有这个会话目录」：
    // 活着的会话一定有目录，目录没了就说明会话已被删除，缓存行必然是残留。
    // 不能再用工作区记账做前置条件——宿主内存里的记账可能仍留着已删会话的 id
    // （磁盘上的 workspace.json 已无），那会让幽灵行永远清不掉。
    if (onDisk.has(id)) continue
    const wasAccounted = accounted.has(id)
    if (await deleteCacheRow(cache, id)) removed += 1
    await rm(path.join(dshHome(), 'storages', 'session_projcache', 'sessions', `${id}.json`), { force: true })
    removedIds.push(wasAccounted ? `${id}(记账残留)` : id)
  }
  await logLine(
    `reconcile(${reason}): 缓存行 ${ids.length}，磁盘会话 ${onDisk.size}，工作区记账 ${accounted.size}，清理 ${removed}` +
      (removedIds.length > 0 ? ` -> ${removedIds.join(', ')}` : ''),
  )
  return removed
}

/**
 * 真正的删除：日志目录 → 投影缓存文件 → 工作区记账 → 归档标记。
 *
 * 投影缓存（session_projcache）是展示层派生状态：不清它，已删会话会在界面上以
 * 「未分组」幽灵行复活。其索引文件 session_projcache.json 由宿主内存持有，
 * 只能在应用关闭时清理（见 README 的幽灵清理脚本）。
 * @param registry - 工作区注册表服务。
 * @param sessionId - 目标会话 id。
 * @returns 释放的字节数与日志目录。
 */
async function deleteArchivedSession(registry, sessionId, cache) {
  const logs = await locateLogs(sessionId)
  const bytes = logs.reduce((total, log) => total + log.bytes, 0)
  for (const log of logs) {
    await rm(log.dir, { recursive: true, force: true })
  }
  await deleteCacheRow(cache, sessionId)
  const cacheFile = path.join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  await rm(cacheFile, { force: true })
  let entities = []
  try {
    entities = typeof registry.list === 'function' ? registry.list() : []
  } catch {
    entities = []
  }
  const entity = entities.find((entry) => Array.isArray(entry.sessionIds) && entry.sessionIds.includes(sessionId))
  if (entity !== undefined && typeof entity.detachSession === 'function') {
    await entity.detachSession(sessionId)
  }
  await registry.unarchiveSession(sessionId)
  // 删除期间该会话可能仍活在宿主内存里，缓存行会被写回来：立刻补一次巡检，
  // 再交给定时巡检兜底（幽灵行 = 磁盘无日志 且 无工作区记账）。
  void reconcileGhostRows(cache, registry, 'after-delete').catch(async (error) => {
    await logLine(`after-delete 巡检抛出：${String(error)}`)
  })
  return { bytes, logDirs: logs.map((log) => log.dir) }
}

/**
 * 把某个会话挂进工作区。
 *
 * 背景：`session.fork` 出来的子会话只继承 cwd，**不会**自动进入工作区记账，
 * 于是会显示为「未分组／未分类」。这里复用工作区实体的 `attachSession`——
 * 它自身会校验「子会话 header 里的 cwd」与「该工作区路径」一致，所以挨个尝试
 * 也只有唯一匹配的那个工作区会接受，不会挂错。
 *
 * 优先尝试调用者会话所属的工作区（正常流程），再回退到逐个尝试（修复历史遗留）。
 * @param registry - 工作区注册表服务。
 * @param callerId - 调用该操作的会话 id（可能不在任何工作区，例如刚分叉的子会话）。
 * @param targetId - 要挂载的会话 id。
 * @returns `{ ok, text }`。
 */
async function attachSessionToWorkspace(registry, callerId, targetId) {
  let entities = []
  try {
    entities = typeof registry.list === 'function' ? registry.list() : []
  } catch (error) {
    return { ok: false, text: `读取工作区失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const owner = entities.find((entry) => Array.isArray(entry.sessionIds) && entry.sessionIds.includes(callerId))
  const ordered = owner === undefined ? [...entities] : [owner, ...entities.filter((entry) => entry !== owner)]
  for (const entity of ordered) {
    const label = entity.title ?? entity.path ?? '未命名'
    if (Array.isArray(entity.sessionIds) && entity.sessionIds.includes(targetId)) {
      return { ok: true, text: `会话 ${targetId} 已经挂在工作区「${label}」里，无需处理。` }
    }
    if (typeof entity.attachSession !== 'function') continue
    try {
      await entity.attachSession(targetId)
      await logLine(`attach: 已把 ${targetId} 挂到工作区「${label}」`)
      return { ok: true, text: `已把会话 ${targetId} 挂回工作区「${label}」。` }
    } catch {
      // cwd 不匹配的工作区会拒绝，继续试下一个
    }
  }
  return { ok: false, text: `没有任何工作区接受会话 ${targetId}（通常意味着它的 cwd 与所有工作区都不一致）。` }
}

/** 能进入模型可见表面的事件类型（与 dsh-session 的 SURFACE_EVENT_TYPES 一致）。 */
const SURFACE_EVENT_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/**
 * 找出某一轮在事件日志中的 seq 区间。
 *
 * 日志是只追加的事件流，每个带 `data.turn` 的事件都属于某一轮；
 * 该轮的区间取这些事件 seq 的最小值与最大值（作为替换的遮蔽范围），
 * 而 `sourceEventSeqs` 只收集其中的**表面事件**——与内置压缩的传法一致。
 * @param session - 宿主侧 Session 实例。
 * @param turn - 轮号（从 1 开始）。
 * @returns `{ start, end, seqs, allSeqs }`，找不到该轮时返回 undefined。
 */
function turnSeqRange(session, turn) {
  let end
  try {
    end = Number(session.seq)
  } catch {
    return undefined
  }
  const allSeqs = []
  const surfaceSeqs = []
  for (let seq = 0; seq < end; seq += 1) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      continue
    }
    const data = event?.data
    if (data === null || typeof data !== 'object' || data.turn !== turn) continue
    allSeqs.push(seq)
    if (SURFACE_EVENT_TYPES.has(event.type)) surfaceSeqs.push(seq)
  }
  if (allSeqs.length === 0) return undefined
  return {
    start: allSeqs[0],
    end: allSeqs[allSeqs.length - 1],
    seqs: surfaceSeqs.length > 0 ? surfaceSeqs : allSeqs,
    allSeqs,
  }
}

/**
 * 日志里最大的轮号。
 *
 * 「分叉 + 删原会话」这种真删只能作用于**最后一轮**：分叉只保留截断点之前的前缀，
 * 若目标轮之后还有对话，它们会随之丢失。所以删除前必须先确认目标就是最后一轮。
 * @param session - 宿主侧 Session 实例。
 * @returns 最大轮号；读不到任何 turn 时返回 undefined。
 */
function maxTurnInLog(session) {
  let end
  try {
    end = Number(session.seq)
  } catch {
    return undefined
  }
  let max
  for (let seq = 0; seq < end; seq += 1) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      continue
    }
    const data = event?.data
    if (data === null || typeof data !== 'object') continue
    if (typeof data.turn === 'number' && (max === undefined || data.turn > max)) max = data.turn
  }
  return max
}

/**
 * 把某一轮从模型上下文中移除。
 *
 * 做法是 DSH 的「表面替换」：追加一条 user/message 占位，并带上
 * `surfaceOp: { op: 'replace', startSeq, endSeq }`，让该区间不再进入
 * 模型可见表面（内置的上下文压缩用的正是这套机制）。事件日志本身
 * **保持只追加**，不删除任何历史；追加时会当场校验，非法则抛错且日志不变。
 * @param session - 宿主侧 Session 实例。
 * @param turn - 轮号。
 * @param confirm - false 只报告区间；true 才真正追加替换事件。
 * @returns `{ kind, turn, startSeq, endSeq, eventCount, summary }`。
 */
function dropTurnFromContext(session, turn, confirm) {
  const range = turnSeqRange(session, turn)
  if (range === undefined) {
    return { kind: 'error', turn, startSeq: 0, endSeq: 0, eventCount: 0, summary: `日志里找不到第 ${turn} 轮的事件。` }
  }
  const base = { turn, startSeq: range.start, endSeq: range.end, eventCount: range.seqs.length }
  if (confirm !== true) {
    return {
      kind: 'dry-run',
      ...base,
      summary: `第 ${turn} 轮覆盖 seq ${range.start}–${range.end}（${range.seqs.length} 个事件）。未做改动——确认后传 confirm=true。`,
    }
  }
  try {
    session.append('user/message', {
      role: 'user',
      content: [{ type: 'text', text: `（第 ${turn} 轮对话已从上下文中移除）` }],
    }, {
      surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end },
      sourceEventSeqs: range.seqs,
    })
  } catch (error) {
    return {
      kind: 'error',
      ...base,
      summary: `移除失败（会话未改动）：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return {
    kind: 'dropped',
    ...base,
    summary: `已把第 ${turn} 轮移出模型上下文（遮蔽 seq ${range.start}–${range.end}，共 ${range.seqs.length} 个事件）。`,
  }
}

/**
 * 注册模型工具与 `/purge-session` 命令。
 * @param ctx - 宿主插件上下文。
 */
export function apply(ctx) {
  const registry = ctx.workspaceRegistry
  /** 投影缓存服务；它缺席时删除依然进行，只是少了缓存行清理。 */
  let projectionCache

  // 缓存服务就绪后：等它的域表真正建好再对账一次，并把服务交给删除路径复用。
  ctx.inject(['sessionProjectionCache'], (scope) => {
    projectionCache = scope.sessionProjectionCache
    const waitForTable = async (remaining) => {
      if (projectionCache?.table !== undefined) return true
      if (remaining <= 0) return false
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return waitForTable(remaining - 1)
    }
    void waitForTable(15)
      .then(async (ready) => {
        if (!ready) {
          await logLine('startup: 投影缓存域表 15 秒内未就绪，本次巡检跳过（定时巡检仍会重试）')
          return
        }
        const removed = await reconcileGhostRows(projectionCache, registry, 'startup')
        if (removed > 0) console.log(`[session-purge] startup reconcile removed ${removed} ghost projection-cache row(s)`)
      })
      .catch(async (error) => {
        await logLine(`startup 巡检抛出：${String(error)}`)
      })

    // 定时巡检：删除发生在会话仍活于宿主内存时，宿主可能把缓存行写回来，
    // 因此需要周期性再扫（幽灵行 = 磁盘无日志目录 且 无任何工作区记账）。
    ctx.effect(() => {
      let busy = false
      const timer = setInterval(() => {
        if (busy) return
        busy = true
        void reconcileGhostRows(projectionCache, registry, 'timer')
          .catch(async (error) => {
            await logLine(`timer 巡检抛出：${String(error)}`)
          })
          .finally(() => {
            busy = false
          })
      }, 20000)
      return () => clearInterval(timer)
    }, 'session-purge ghost janitor')
  })

  // ── 1. 模型工具：批量、可 dry-run ───────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'session_purge_archived',
    description: [
      'Permanently delete ARCHIVED sessions: remove their on-disk logs, detach them from their workspace, and clear their archive flag.',
      'This is destructive and cannot be undone, and there is no trash — the session log is gone.',
      'Only sessions currently in the archive set are eligible; active, pinned, or merely unarchived sessions are never touched, and the calling session never deletes itself.',
      'Call with confirm=false first to review the exact targets, then call again with confirm=true to execute.',
    ].join(' '),
    parameters: {
      confirm: {
        type: 'boolean',
        required: true,
        description: 'false returns the deletion plan without touching anything; true actually deletes.',
      },
      sessionIds: {
        type: 'array',
        description: 'Optional subset of archived session ids to purge. Omit to target every archived session.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dryRun: { type: 'boolean', required: true },
          archivedCount: { type: 'integer', required: true },
          summary: { type: 'string', required: true },
          targets: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                workspace: { type: 'string', required: true },
                logDir: { type: 'string', required: true },
                logBytes: { type: 'integer', required: true },
                fileCount: { type: 'integer', required: true },
              },
            },
          },
          deleted: { type: 'array', required: true, items: { type: 'string' } },
          skipped: { type: 'array', required: true, items: { type: 'string' } },
          failures: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.summary,
          ...value.targets.map((target) =>
            `- ${target.sessionId} · ${target.workspace} · ${target.fileCount} 个文件 · ${human(target.logBytes)}\n  ${target.logDir}`),
          ...(value.failures.length > 0 ? ['失败：', ...value.failures.map((failure) => `- ${failure}`)] : []),
        ].join('\n'),
      }],
    },
    async execute(args, exec) {
      const archived = archivedIds(registry)
      const requested = Array.isArray(args.sessionIds)
        ? args.sessionIds.filter((id) => typeof id === 'string' && id !== '')
        : undefined
      const selected = requested === undefined ? archived : archived.filter((id) => requested.includes(id))
      const skipped = requested === undefined ? [] : requested.filter((id) => !archived.includes(id))

      const callerId = exec?.agent?.session?.id
      let entities = []
      try {
        entities = typeof registry.list === 'function' ? registry.list() : []
      } catch {
        entities = []
      }

      const targets = []
      for (const sessionId of selected) {
        if (callerId !== undefined && sessionId === callerId) {
          skipped.push(sessionId)
          continue
        }
        const entity = entities.find((entry) => Array.isArray(entry.sessionIds) && entry.sessionIds.includes(sessionId))
        const logs = await locateLogs(sessionId)
        targets.push({
          sessionId,
          logs,
          bytes: logs.reduce((total, log) => total + log.bytes, 0),
          files: logs.reduce((total, log) => total + log.files, 0),
          workspace: entity?.title ?? entity?.path ?? '(未记账)',
        })
      }

      const plannedTargets = targets.map((target) => ({
        sessionId: target.sessionId,
        workspace: target.workspace,
        logDir: target.logs.length > 0 ? target.logs.map((log) => log.dir).join('; ') : '(未找到日志目录)',
        logBytes: target.bytes,
        fileCount: target.files,
      }))

      if (args.confirm !== true) {
        const totalBytes = targets.reduce((total, target) => total + target.bytes, 0)
        const totalFiles = targets.reduce((total, target) => total + target.files, 0)
        return {
          dryRun: true,
          archivedCount: archived.length,
          targets: plannedTargets,
          deleted: [],
          skipped,
          failures: [],
          summary: plannedTargets.length === 0
            ? `没有可删除的已归档会话（当前归档集合 ${archived.length} 个）。未做任何改动。`
            : `计划删除 ${plannedTargets.length} 个已归档会话，共 ${human(totalBytes)} / ${totalFiles} 个文件。未做任何改动——确认后请再调用一次并传 confirm=true。`,
        }
      }

      const deleted = []
      const failures = []
      for (const target of targets) {
        try {
          await deleteArchivedSession(registry, target.sessionId, projectionCache)
          deleted.push(target.sessionId)
        } catch (error) {
          failures.push(`${target.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      const freedBytes = targets
        .filter((target) => deleted.includes(target.sessionId))
        .reduce((total, target) => total + target.bytes, 0)
      return {
        dryRun: false,
        archivedCount: archived.length,
        targets: plannedTargets,
        deleted,
        skipped,
        failures,
        summary: [
          `已删除 ${deleted.length} 个已归档会话，释放 ${human(freedBytes)}。`,
          failures.length > 0 ? `${failures.length} 个失败：${failures.join(' | ')}` : '',
          skipped.length > 0 ? `跳过 ${skipped.length} 个（不在归档集合中或为当前会话）。` : '',
        ].filter((part) => part !== '').join(' '),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.confirm === true ? 'Purge archived sessions' : 'Review archived sessions',
      kind: 'other',
      rawInput: args,
    }),
  }))

  // ── 2. 模型工具：把某一轮从上下文移除（表面替换） ──────────────────────
  ctx.tools.register(defineTool({
    name: 'session_drop_turn',
    description: [
      'Remove ONE conversation turn from the model context by appending a surface replacement that shadows that turn.',
      'The session log stays append-only — nothing is deleted, and the human transcript keeps the turn; only the model-visible surface loses it.',
      'Use this when the user says a message or turn was a mistake and should stop polluting the context.',
      'Call with confirm=false first to see the exact seq range, then confirm=true to apply it.',
    ].join(' '),
    parameters: {
      turn: {
        type: 'integer',
        required: true,
        description: 'The 1-based turn number to remove, as shown in the conversation.',
      },
      confirm: {
        type: 'boolean',
        required: true,
        description: 'false reports the seq range without changing anything; true appends the replacement.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          turn: { type: 'integer', required: true },
          startSeq: { type: 'integer', required: true },
          endSeq: { type: 'integer', required: true },
          eventCount: { type: 'integer', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) {
        return { kind: 'error', turn: args.turn, startSeq: 0, endSeq: 0, eventCount: 0, summary: '没有可用的会话（该工具必须在 agent 会话内调用）。' }
      }
      return dropTurnFromContext(session, args.turn, args.confirm === true)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.confirm === true ? `Drop turn ${args.turn} from context` : `Review turn ${args.turn}`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  // ── 2b. 模型工具：把会话挂回工作区（修复掉进「未分组」的分叉会话）──────
  ctx.tools.register(defineTool({
    name: 'session_attach_workspace',
    description: [
      'Attach one Session to the workspace whose path matches that Session cwd.',
      'Forked sessions inherit the parent cwd but are NOT added to the workspace accounting, so they land under the ungrouped ("未分组") list; use this to put one back.',
      'The workspace entity validates the session cwd itself, so only the matching workspace accepts.',
    ].join(' '),
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'The session id to attach, e.g. the id returned by a fork.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { summary: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const callerId = exec?.agent?.session?.id
      const outcome = await attachSessionToWorkspace(registry, callerId, String(args.sessionId))
      return { summary: outcome.text }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Attach ${args.sessionId} to its workspace`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  // ── 3. 命令：客户端「…」菜单的删除项走这里 ──────────────────────────────
  ctx.effect(function* () {
    yield async () => {}
    yield ctx.commands.register({
      definitionId: 'dsh-plugin-session-purge',
      name: COMMAND_NAME,
      description: 'Permanently delete one archived session (invoked from the session row menu)',
      input: { hint: '[session id]' },
      handler: async (invocation) => {
        const targetId = invocation.rawInput.trim()
        if (targetId === '') {
          return { kind: 'error', text: `用法：/${COMMAND_NAME} <会话id>` }
        }
        if (!archivedIds(registry).includes(targetId)) {
          return { kind: 'error', text: `会话 ${targetId} 不在归档集合中，未删除（只能删除已归档会话）。` }
        }
        try {
          const result = await deleteArchivedSession(registry, targetId, projectionCache)
          return {
            kind: 'success',
            text: `已永久删除归档会话 ${targetId}，释放 ${human(result.bytes)}。`,
          }
        } catch (error) {
          return {
            kind: 'error',
            text: `删除 ${targetId} 失败：${error instanceof Error ? error.message : String(error)}`,
          }
        }
      },
    })

    yield ctx.commands.register({
      definitionId: 'dsh-plugin-session-purge/drop-turn',
      name: DROP_TURN_COMMAND,
      description: 'Remove one conversation turn from the model context (invoked from the turn footer button)',
      input: { hint: '[turn number]' },
      handler: async (invocation) => {
        const turn = Number(invocation.rawInput.trim())
        if (!Number.isSafeInteger(turn) || turn < 1) {
          return { kind: 'error', text: `用法：/${DROP_TURN_COMMAND} <轮号>` }
        }
        const session = invocation.agent?.session
        if (session === undefined) {
          return { kind: 'error', text: '没有可用的会话' }
        }
        const outcome = dropTurnFromContext(session, turn, true)
        return outcome.kind === 'dropped'
          ? { kind: 'success', text: outcome.summary }
          : { kind: 'error', text: outcome.summary }
      },
    })

    // 「真删此轮」第一步：告诉客户端该在哪个 seq 分叉（截断点 = 该轮首事件的前一个 seq）。
    yield ctx.commands.register({
      definitionId: 'dsh-plugin-session-purge/turn-cut',
      name: TURN_CUT_COMMAND,
      description: 'Report the exact event seq to fork at so that one turn is excluded',
      input: { hint: '[turn number]' },
      handler: async (invocation) => {
        const turn = Number(invocation.rawInput.trim())
        if (!Number.isSafeInteger(turn) || turn < 1) {
          return { kind: 'error', text: `用法：/${TURN_CUT_COMMAND} <轮号>` }
        }
        const session = invocation.agent?.session
        if (session === undefined) return { kind: 'error', text: '没有可用的会话' }
        const range = turnSeqRange(session, turn)
        if (range === undefined) return { kind: 'error', text: `日志里找不到第 ${turn} 轮的事件` }
        if (range.start <= 0) {
          return { kind: 'error', text: `第 ${turn} 轮是该会话的第一条内容，之前没有可保留的历史，无法用分叉方式真删。` }
        }
        // 真删 = 在目标轮之前分叉 + 删原会话，因此只能作用于最后一轮：
        // 否则目标轮之后的对话会一起消失（这正是"对话被截断"的成因）。
        const maxTurn = maxTurnInLog(session)
        if (maxTurn !== undefined && turn < maxTurn) {
          return {
            kind: 'error',
            text:
              `NOT_LAST_TURN:第 ${turn} 轮之后还有第 ${turn + 1}–${maxTurn} 轮对话，` +
              `真删会把它们一起丢掉，所以只允许真删最后一轮。`,
          }
        }
        return { kind: 'success', text: `cut=${range.start - 1}` }
      },
    })

    // 「真删此轮」最后一步：原会话已切走（变冷），按 id 从磁盘删除它。
    yield ctx.commands.register({
      definitionId: 'dsh-plugin-session-purge/purge-any',
      name: PURGE_ANY_COMMAND,
      description: 'Permanently delete one session from disk regardless of its archive state',
      input: { hint: '[session id]' },
      handler: async (invocation) => {
        const targetId = invocation.rawInput.trim()
        if (targetId === '') return { kind: 'error', text: `用法：/${PURGE_ANY_COMMAND} <会话id>` }
        if (invocation.agent?.session?.id === targetId) {
          return { kind: 'error', text: '拒绝删除正在执行该命令的会话——请先切到新会话再删除原会话。' }
        }
        try {
          const result = await deleteArchivedSession(registry, targetId, projectionCache)
          return {
            kind: 'success',
            text: `已从磁盘删除会话 ${targetId}（含日志与投影缓存，释放 ${human(result.bytes)}）`,
          }
        } catch (error) {
          return {
            kind: 'error',
            text: `删除 ${targetId} 失败：${error instanceof Error ? error.message : String(error)}`,
          }
        }
      },
    })
    // 「真删此轮」的收尾：把分叉出来的新会话挂回工作区，否则它会掉进「未分组」。
    yield ctx.commands.register({
      definitionId: 'dsh-plugin-session-purge/attach-session',
      name: ATTACH_COMMAND,
      description: 'Attach one session to the workspace matching its cwd (used right after a fork)',
      input: { hint: '[session id]' },
      handler: async (invocation) => {
        const targetId = invocation.rawInput.trim()
        if (targetId === '') return { kind: 'error', text: `用法：/${ATTACH_COMMAND} <会话id>` }
        const callerId = invocation.agent?.session?.id
        const outcome = await attachSessionToWorkspace(registry, callerId, targetId)
        return outcome.ok ? { kind: 'success', text: outcome.text } : { kind: 'error', text: outcome.text }
      },
    })
  }, 'session-purge command lifecycle')
}
