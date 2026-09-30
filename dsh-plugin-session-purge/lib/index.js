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

import { appendFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
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

/** 把会话移动到另一个工作台（真移动：界面立即生效，磁盘变更排队到下次启动）。 */
const MOVE_COMMAND = 'move-session'

/** 待执行的移动记录文件名（放在 DSH 配置根下）。 */
const PENDING_MOVES_FILENAME = 'session-moves.json'

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

/** `session-purge.log` 的轮转阈值：超过就留一份 `.1` 再重开。 */
const LOG_MAX_BYTES = 1024 * 1024

/**
 * 日志超过阈值时轮转一次（当前文件改名为 `.1`，覆盖上一份）。
 * 巡检日志按月累积，不轮转会无限增长。
 */
async function rotateLogIfLarge() {
  const file = path.join(dshHome(), 'session-purge.log')
  try {
    const info = await stat(file)
    if (info.size < LOG_MAX_BYTES) return
    await rm(`${file}.1`, { force: true })
    await rename(file, `${file}.1`)
  } catch {
    // 文件不存在或轮转失败都不影响功能
  }
}

/**
 * 列出磁盘上现存的会话 id 集合（`<dshHome>/sessions/<项目>/<会话id>`）。
 *
 * 比逐个 locateLogs 便宜得多（只有两层 readdir），适合周期性巡检。
 *
 * **返回 `undefined` 表示这次扫描不可信**（根目录或某个项目目录读不出来）。
 * 调用方必须据此放弃本轮清理：「没扫到」不等于「会话已被删除」，把两者当成
 * 一回事，一次瞬时读取失败就会让巡检删光所有缓存行。
 * @returns 会话 id 集合；任一层读取失败时 undefined。
 */
async function listOnDiskSessions() {
  const root = path.join(dshHome(), 'sessions')
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  const ids = new Set()
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let sessions
    try {
      sessions = await readdir(path.join(root, project.name), { withFileTypes: true })
    } catch {
      // 单个项目目录读不出来就是「视图不完整」，不能当成「这里的会话都没了」。
      return undefined
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
  if (onDisk === undefined) {
    await logLine(`reconcile(${reason}): 磁盘扫描不完整，本轮跳过（不清理）`)
    return 0
  }
  if (onDisk.size === 0 && ids.length > 0) {
    await logLine(`reconcile(${reason}): 磁盘扫到 0 个会话但缓存有 ${ids.length} 行，判据不可信，本轮跳过`)
    return 0
  }
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
  // 健康的一轮不记日志：定时巡检每 20 秒一次，无条件记账会让日志每天涨几千行。
  // 启动与删除后这两次仍然记录，保留可诊断性。
  if (removed > 0 || reason !== 'timer') {
    await logLine(
      `reconcile(${reason}): 缓存行 ${ids.length}，磁盘会话 ${onDisk.size}，工作区记账 ${accounted.size}，清理 ${removed}` +
        (removedIds.length > 0 ? ` -> ${removedIds.join(', ')}` : ''),
    )
  }
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
  // 备份要在删日志之前一起处理：它是完整副本，漏掉就等于会话没被真正删除。
  const backups = await purgeSessionBackups(sessionId)
  if (backups.dirs > 0) {
    await logLine(`delete(${sessionId}): 已一并清理 ${backups.dirs} 个搬迁备份`)
  }
  const bytes = logs.reduce((total, log) => total + log.bytes, 0) + backups.bytes
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
  return { bytes, logDirs: logs.map((log) => log.dir), backupDirs: backups.dirs }
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

//#region 移动到其他工作台

/**
 * 复刻 DSH 的会话目录名算法（`dsh-session-persistence-jsonl` 的 `projectKey`）。
 *
 * 必须逐字符一致：持久层用 `sessionDir(root, cwd, id) = root/<projectKey(cwd)>/<id>`
 * 定位会话，改了 cwd 就得把目录搬到对应的新名字下，否则重启后会话会变成空的。
 * @param cwd - 会话的项目目录。
 * @returns 单层、文件系统安全、人类可读的项目目录名。
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** 会话根目录。 */
function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

/**
 * 搬迁备份的根目录，**必须留在 `sessions` 树之外**。
 *
 * DSH 枚举会话时会把项目目录下的每个子目录都当成一个会话目录
 * （`listSessionDirs`），并读取其中日志的头部；备份是原会话的完整副本，
 * 头部里的 id 与原会话相同，一旦留在 `sessions` 树内就会出现同一个 id
 * 对应两个目录，触发 `duplicate JSONL session id ... appears in multiple
 * project directories`，使**整份会话列表加载失败**——界面上看起来就是
 * 「所有会话都不见了」。
 * @returns 备份根目录绝对路径。
 */
function backupsRoot() {
  return path.join(dshHome(), 'session-backups')
}

/**
 * 找出某个会话在搬迁时留下的备份目录（`<会话id>-backup-<时间戳>`）。
 * @param sessionId - 目标会话 id。
 * @returns 备份目录绝对路径列表。
 */
async function locateSessionBackups(sessionId) {
  let entries
  try {
    entries = await readdir(backupsRoot(), { withFileTypes: true })
  } catch {
    return []
  }
  const prefix = `${sessionId}-backup-`
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(backupsRoot(), entry.name))
}

/**
 * 删除某个会话的全部搬迁备份。
 *
 * 备份是原会话日志的**完整副本**，删除会话时必须一并清掉：只删 `sessions/` 下的
 * 目录，工具描述里"The session log is gone"就不成立——备份里还留着整份内容。
 * @param sessionId - 目标会话 id。
 * @returns 删除的目录数与字节数。
 */
async function purgeSessionBackups(sessionId) {
  const dirs = await locateSessionBackups(sessionId)
  let bytes = 0
  for (const dir of dirs) {
    bytes += (await measure(dir)).bytes
    await rm(dir, { recursive: true, force: true })
  }
  return { dirs: dirs.length, bytes }
}

/**
 * 在磁盘上定位某个会话的目录。
 * @param sessionId - 会话 id。
 * @returns 目录绝对路径；找不到时 undefined。
 */
async function locateSessionDir(sessionId) {
  let projects
  try {
    projects = await readdir(sessionsRoot(), { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = path.join(sessionsRoot(), project.name, sessionId)
    try {
      if ((await stat(candidate)).isDirectory()) return candidate
    } catch {
      // 换下一个项目目录继续找
    }
  }
  return undefined
}

/** DSH 的规范日志文件名（去掉压缩后缀后）：v0 是 `session.jsonl`，其余是 `session.vN.jsonl`。 */
const LOG_FILENAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/u

/**
 * 取目录里最新一代的日志文件。
 *
 * 两点必须与 DSH 的 `resolveGenerationInDirectory` 对齐：
 * - 代次按**数值**比较，不是字典序（字典序里 `session.v10` 排在 `session.v4` 前面）；
 * - 压缩后缀优先 `.zstd`（DSH 默认），只有不存在 `.zstd` 时才回落到未压缩的 `.jsonl`。
 * 只认 `.zstd` 会让 `compression: 'none'` 的部署在搬迁时改不到头部 cwd，
 * 结果目录搬了、头还是旧路径，重启后该会话从工作区里消失。
 * @param dir - 会话目录。
 * @returns `{ path, compressed }`；没有日志时 undefined。
 */
function newestLogFile(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  for (const compressed of [true, false]) {
    let best
    for (const name of names) {
      const isCompressed = name.endsWith('.zstd')
      if (isCompressed !== compressed) continue
      const match = LOG_FILENAME.exec(isCompressed ? name.slice(0, -'.zstd'.length) : name)
      if (match === null) continue
      const version = match[1] === undefined ? 0 : Number(match[1])
      if (!Number.isSafeInteger(version)) continue
      if (best === undefined || version > best.version) best = { name, version }
    }
    if (best !== undefined) return { path: path.join(dir, best.name), compressed }
  }
  return undefined
}

/** 待执行移动记录的文件路径。 */
function pendingMovesPath() {
  return path.join(dshHome(), PENDING_MOVES_FILENAME)
}

/**
 * 读取待执行移动记录。
 * @returns `{ [sessionId]: { from, to, workspaceId, title, requestedAt } }`。
 */
function readPendingMoves() {
  try {
    const parsed = JSON.parse(readFileSync(pendingMovesPath(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 写回待执行移动记录。
 * @param moves - 记录对象。
 */
function writePendingMoves(moves) {
  try {
    writeFileSync(pendingMovesPath(), `${JSON.stringify(moves, null, 2)}\n`, 'utf8')
  } catch {
    // 落盘失败只影响“重启后生效”，本次界面效果不受影响
  }
}

/** zstd 帧魔数（日志是多帧追加写的）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 按魔数切帧并逐帧解压，拼回完整 JSONL 文本。
 * @param buffer - 日志文件字节。
 * @returns 解压后的文本。
 */
function decodeSessionLog(buffer) {
  const starts = []
  let index = buffer.indexOf(ZSTD_MAGIC, 0)
  while (index >= 0) {
    starts.push(index)
    index = buffer.indexOf(ZSTD_MAGIC, index + 4)
  }
  if (starts.length === 0) return buffer.toString('utf8')
  let text = ''
  for (let i = 0; i < starts.length; i += 1) {
    const to = i + 1 < starts.length ? starts[i + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(starts[i], to)).toString('utf8')
    } catch {
      // 尾帧可能不完整，忽略
    }
  }
  return text
}

/**
 * 把会话日志首行（会话头记录）里的 cwd 改写成新路径。
 *
 * 头记录只写一次、之后都是追加，所以冷会话下改写是安全的。
 *
 * 重写必须保持帧结构：DSH 读取端要求**首个 zstd 帧恰好只有头部一行**
 * （`assertZstdHeaderFrame`，见 dsh-session-persistence-jsonl）。若把解压出的
 * 全部内容重新压成单帧，这份日志会被判为「首帧不是恰好一行头部」而整体损坏，
 * 该会话从此既列不出来也打不开。所以头部单独成帧，其余内容另起一帧。
 * @param file - 日志文件路径。
 * @param newCwd - 新的 cwd。
 * @param compressed - 该日志是否为 zstd 分帧编码（DSH 的 `compression` 配置）。
 */
function rewriteSessionHeaderCwd(file, newCwd, compressed) {
  const text = decodeSessionLog(readFileSync(file))
  const lines = text.split('\n')
  const headerIndex = lines.findIndex((line) => line.trim() !== '')
  if (headerIndex < 0) throw new Error('日志为空')
  const header = JSON.parse(lines[headerIndex])
  if (header.type !== 'session') throw new Error('首行不是会话头记录')
  header.cwd = newCwd
  const headerLine = `${JSON.stringify(header)}\n`
  const rest = lines.slice(0, headerIndex).concat(lines.slice(headerIndex + 1)).join('\n')
  // 未压缩部署下整份日志是纯 JSONL，头部就是第一行，不能写成 zstd 帧。
  writeFileSync(file, compressed
    ? Buffer.concat([
        zstdCompressSync(Buffer.from(headerLine, 'utf8')),
        zstdCompressSync(Buffer.from(rest, 'utf8')),
      ])
    : Buffer.from(headerLine + rest, 'utf8'))
}

/**
 * 用工作区域表直接改归属（绕过 `attachSession` 的 cwd 校验，仅在校验必然失败时使用）。
 * @param registry - 工作区注册表服务。
 * @param sessionId - 会话 id。
 * @param targetWorkspaceId - 目标工作台 id；undefined 表示从所有工作台移除。
 */
async function reassignWorkspaceRecords(registry, sessionId, targetWorkspaceId) {
  const table = registry.table
  if (table === undefined || typeof table.update !== 'function') throw new Error('工作区域表不可用')
  for (const entity of registry.list()) {
    const raw = Array.isArray(entity.record?.sessionIds) ? entity.record.sessionIds : []
    const has = raw.includes(sessionId)
    const shouldHave = targetWorkspaceId !== undefined && entity.id === targetWorkspaceId
    if (has === shouldHave) continue
    await table.update(entity.id, (record) => {
      const ids = Array.isArray(record.sessionIds) ? record.sessionIds : []
      const next = shouldHave ? [sessionId, ...ids.filter((id) => id !== sessionId)] : ids.filter((id) => id !== sessionId)
      return { ...record, sessionIds: next, updatedAt: new Date().toISOString() }
    })
  }
}

/**
 * 把会话移动到目标工作台。
 *
 * 两种情形：
 * - 会话 cwd 与目标路径一致 → 走内置 `attachSession`（零风险，立即完成）。
 * - 不一致 → 真移动：立即更新内存路径索引与工作台记账（界面马上生效），
 *   并把“搬目录 + 改写头部 cwd”排队到下次启动（那时会话是冷的，动文件才安全）。
 * @param registry - 工作区注册表服务。
 * @param sessionId - 会话 id。
 * @param targetKey - 目标工作台 id 或路径。
 * @returns `{ ok, pending, text }`。
 */
async function moveSessionToWorkspace(registry, sessionId, targetKey) {
  let entities = []
  try {
    entities = typeof registry.list === 'function' ? registry.list() : []
  } catch (error) {
    return { ok: false, pending: false, text: `读取工作台失败：${String(error)}` }
  }
  const target = entities.find((entity) => entity.id === targetKey || entity.path === targetKey)
  if (target === undefined) {
    const known = entities.map((entity) => `${entity.title ?? entity.path}`).join('、')
    return { ok: false, pending: false, text: `找不到工作台「${targetKey}」。现有工作台：${known}` }
  }
  let header
  try {
    header = await registry.readSessionHeader(sessionId)
  } catch (error) {
    return { ok: false, pending: false, text: `读取会话头部失败：${String(error)}` }
  }
  if (header === null || header === undefined) {
    return { ok: false, pending: false, text: `找不到会话 ${sessionId} 的头部记录` }
  }
  const label = target.title ?? target.path

  let current = header.cwd
  try {
    current = await realpath(header.cwd)
  } catch {
    // cwd 解析不了就按原值比较
  }
  if (current === target.path) {
    try {
      for (const entity of entities) {
        if (entity.id === target.id) continue
        if (Array.isArray(entity.record?.sessionIds) && entity.record.sessionIds.includes(sessionId) && typeof entity.detachSession === 'function') {
          await entity.detachSession(sessionId)
        }
      }
      await target.attachSession(sessionId)
      await logLine(`move(${sessionId}): cwd 与目标一致，直接用内置挂载到「${label}」`)
      return { ok: true, pending: false, text: `已把会话移入工作台「${label}」（路径本来就匹配，无需搬文件）。` }
    } catch (error) {
      return { ok: false, pending: false, text: `挂载失败：${String(error)}` }
    }
  }

  try {
    await registry.indexHeader({ ...header, cwd: target.path })
    await reassignWorkspaceRecords(registry, sessionId, target.id)
  } catch (error) {
    return { ok: false, pending: false, text: `更新索引/记账失败：${String(error)}` }
  }
  const moves = readPendingMoves()
  moves[sessionId] = {
    from: header.cwd,
    to: target.path,
    workspaceId: target.id,
    title: label,
    requestedAt: new Date().toISOString(),
  }
  writePendingMoves(moves)
  await logLine(`move(${sessionId}): 界面已移入「${label}」，磁盘变更待下次启动（${header.cwd} -> ${target.path}）`)
  return {
    ok: true,
    pending: true,
    text:
      `已把会话移入工作台「${label}」，界面上立即生效。\n\n` +
      `磁盘上的真正搬迁（会话目录 + 日志头部 cwd）会在下次启动应用时自动完成，并先备份原目录。`,
  }
}

/**
 * 启动时执行排队的移动。
 *
 * 只有会话处于冷状态（没被打开）才动它的文件；否则留到下次启动再试。
 * @param ctx - 宿主插件上下文。
 * @param registry - 工作区注册表服务。
 * @returns 本次完成的移动数。
 */
async function applyPendingMoves(ctx, registry) {
  const moves = readPendingMoves()
  const ids = Object.keys(moves)
  if (ids.length === 0) return 0
  await logLine(`move: 发现 ${ids.length} 条待执行移动`)
  let applied = 0
  for (const sessionId of ids) {
    const move = moves[sessionId]
    try {
      if (move === null || typeof move !== 'object' || typeof move.to !== 'string' || move.to === '') {
        delete moves[sessionId]
        continue
      }
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      if (sessions !== undefined && typeof sessions.get === 'function' && sessions.get(sessionId) !== undefined) {
        await logLine(`move(${sessionId}): 跳过——会话正在使用中，下次启动再试`)
        continue
      }
      const dir = await locateSessionDir(sessionId)
      if (dir === undefined) {
        await logLine(`move(${sessionId}): 找不到会话目录，放弃这条记录`)
        delete moves[sessionId]
        continue
      }
      const targetDir = path.join(sessionsRoot(), projectKey(move.to), sessionId)
      const moving = path.resolve(dir) !== path.resolve(targetDir)
      // 先确认能定位到日志文件，再决定动不动目录：否则可能搬了目录却改不了头部，
      // 留下一个「目录在新路径、头部还是旧 cwd」的会话，DSH 打开它会直接报标识不符。
      const sourceLog = newestLogFile(dir)
      if (sourceLog === undefined) {
        throw new Error(`会话目录里找不到日志文件，放弃搬迁：${dir}`)
      }
      if (moving) {
        // 备份必须落在 sessions 树之外：留在树内会让同一个会话 id 出现两次，
        // 使 DSH 的会话枚举整体抛错（见 backupsRoot 的说明）。
        mkdirSync(backupsRoot(), { recursive: true })
        const backup = path.join(backupsRoot(), `${path.basename(dir)}-backup-${Date.now()}`)
        cpSync(dir, backup, { recursive: true })
        mkdirSync(path.dirname(targetDir), { recursive: true })
        renameSync(dir, targetDir)
        await logLine(`move(${sessionId}): 目录已搬迁 ${dir} -> ${targetDir}（备份 ${backup}）`)
      }
      try {
        rewriteSessionHeaderCwd(path.join(targetDir, path.basename(sourceLog.path)), move.to, sourceLog.compressed)
      } catch (error) {
        // 头部没改成就把目录放回去：宁可不搬，也不留下一个自相矛盾的会话。
        if (moving) {
          try {
            renameSync(targetDir, dir)
            await logLine(`move(${sessionId}): 改写头部失败，目录已回滚：${String(error)}`)
          } catch (rollbackError) {
            await logLine(`move(${sessionId}): 改写头部失败且回滚失败：${String(error)} / ${String(rollbackError)}`)
          }
        }
        throw error
      }
      await logLine(`move(${sessionId}): 日志头部 cwd 已改写为 ${move.to}`)
      let header
      try {
        header = await registry.readSessionHeader(sessionId)
      } catch {
        header = undefined
      }
      await registry.indexHeader({ ...(header ?? { id: sessionId }), id: sessionId, cwd: move.to })
      await reassignWorkspaceRecords(registry, sessionId, move.workspaceId)
      delete moves[sessionId]
      applied += 1
      await logLine(`move(${sessionId}): 完成，已归入「${move.title ?? move.workspaceId}」`)
    } catch (error) {
      await logLine(`move(${sessionId}): 失败 ${String(error)}`)
    }
  }
  writePendingMoves(moves)
  return applied
}

//#endregion

/**
 * 注册模型工具与 `/purge-session` 命令。
 * @param ctx - 宿主插件上下文。
 */
export function apply(ctx) {
  const registry = ctx.workspaceRegistry
  /** 投影缓存服务；它缺席时删除依然进行，只是少了缓存行清理。 */
  let projectionCache

  // 巡检日志按月累积，启动时先看看要不要轮转。
  void rotateLogIfLarge()

  // 启动时先执行排队的「移动到工作台」：此刻会话大多还是冷的，动它的文件才安全。
  void applyPendingMoves(ctx, registry)
    .then(async (applied) => {
      if (applied > 0) console.log(`[session-purge] applied ${applied} pending session move(s)`)
    })
    .catch(async (error) => {
      await logLine(`move: 启动执行待办移动时抛出 ${String(error)}`)
    })

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
        // 搬迁备份也会被一并删除，所以必须计入计划：不写进来就会少报体积和文件数。
        const backupDirs = await locateSessionBackups(sessionId)
        let backupBytes = 0
        let backupFiles = 0
        for (const backupDir of backupDirs) {
          const size = await measure(backupDir)
          backupBytes += size.bytes
          backupFiles += size.files
        }
        targets.push({
          sessionId,
          logs,
          backupDirs,
          bytes: logs.reduce((total, log) => total + log.bytes, 0) + backupBytes,
          files: logs.reduce((total, log) => total + log.files, 0) + backupFiles,
          workspace: entity?.title ?? entity?.path ?? '(未记账)',
        })
      }

      const plannedTargets = targets.map((target) => ({
        sessionId: target.sessionId,
        workspace: target.workspace,
        logDir: [
          ...(target.logs.length > 0 ? target.logs.map((log) => log.dir) : ['(未找到日志目录)']),
          ...target.backupDirs.map((dir) => `${dir}（搬迁备份）`),
        ].join('; '),
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

  // ── 2c. 模型工具：把会话移动到另一个工作台 ──────────────────────────────
  ctx.tools.register(defineTool({
    name: 'session_move_workspace',
    description: [
      'Move one Session into another workspace (the session row menu does this through the same code).',
      'A Session belongs to the workspace whose path equals its cwd, so a cross-workspace move has two halves:',
      'the in-memory path index and workspace accounting change immediately (the UI moves right away),',
      'while the on-disk half — relocating the session directory and rewriting the stored header cwd — is queued and applied at the next app start, when the session is cold, with a backup of the original directory.',
      'When the cwd already matches the target workspace path, the built-in attach is used and nothing is queued.',
      'Call with list=true first to see the available workspace ids.',
    ].join(' '),
    parameters: {
      list: {
        type: 'boolean',
        required: true,
        description: 'true returns the workspace list (id, title, path) and does nothing else.',
      },
      sessionId: {
        type: 'string',
        required: true,
        description: 'Session id to move; ignored when list=true.',
      },
      workspace: {
        type: 'string',
        required: true,
        description: 'Target workspace id or path; ignored when list=true.',
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
    async execute(args) {
      if (args.list === true) {
        let entities = []
        try {
          entities = registry.list()
        } catch (error) {
          return { summary: `读取工作台失败：${String(error)}` }
        }
        const lines = entities.map((entity) => `- ${entity.title ?? '(无标题)'}\n    id: ${entity.id}\n    path: ${entity.path}`)
        return { summary: `现有工作台 ${entities.length} 个：\n${lines.join('\n')}` }
      }
      const outcome = await moveSessionToWorkspace(registry, String(args.sessionId), String(args.workspace))
      return { summary: outcome.text }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.list === true ? 'List workspaces' : `Move ${args.sessionId} to ${args.workspace}`,
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

    // 把会话移动到另一个工作台（会话行「…」菜单的「移动到工作台…」走这里）。
    yield ctx.commands.register({
      definitionId: 'dsh-plugin-session-purge/move-session',
      name: MOVE_COMMAND,
      description: 'Move one session into another workspace',
      input: { hint: '[session id] [workspace id]' },
      handler: async (invocation) => {
        const parts = invocation.rawInput.trim().split(/\s+/u).filter((part) => part !== '')
        if (parts.length < 2) {
          return { kind: 'error', text: `用法：/${MOVE_COMMAND} <会话id> <工作台id>` }
        }
        const [sessionId, targetKey] = parts
        const outcome = await moveSessionToWorkspace(registry, sessionId, targetKey)
        return outcome.ok ? { kind: 'success', text: outcome.text } : { kind: 'error', text: outcome.text }
      },
    })
  }, 'session-purge command lifecycle')
}
