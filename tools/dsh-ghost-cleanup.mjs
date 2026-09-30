#!/usr/bin/env node
/**
 * DSH 幽灵会话清理脚本。
 *
 * 背景：DSH 0.2.0-rc.2 没有删除会话的正规 API，插件删除会话时只能清掉磁盘日志、
 * 工作区记账与归档标记；而展示层的**投影缓存**（session_projcache）仍保留着那些
 * 会话的条目，于是已删会话会在界面上以「未分组 / 已归档」的幽灵行复活。
 *
 * 投影缓存的索引文件由宿主进程内存持有，运行期间修改会被覆盖，所以本脚本
 * **必须在 DSH 完全退出后**运行。它会：
 *   1. 扫描 <dshHome>/sessions，收集真实存在的会话 id
 *   2. 从 session_projcache.json 的 sessions 表里删除所有日志已不存在的条目
 *   3. 删除对应的 <dshHome>/storages/session_projcache/sessions/<id>.json 孤儿文件
 *   4. 全程只动投影缓存；日志、工作区记账、凭据一概不碰
 *
 * 用法：先完全退出 DeepSeek Harness，然后在任意 PowerShell 里执行
 *     node "<本脚本路径>"            # 预览（默认 dry-run，不做任何改动）
 *     node "<本脚本路径>" --apply    # 真正清理（会先备份索引）
 */

import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const apply = process.argv.includes('--apply')
const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
  ? process.env.DSH_HOME
  : path.join(homedir(), '.dsh')

const sessionsRoot = path.join(dshHome, 'sessions')
const cacheRoot = path.join(dshHome, 'storages', 'session_projcache')
const cacheIndex = path.join(dshHome, 'storages', 'session_projcache.json')
const cacheFiles = path.join(cacheRoot, 'sessions')

/** 应用是否仍在运行。 */
function appRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH', { encoding: 'utf8' })
    return out.includes('DeepSeek Harness.exe')
  } catch {
    return false
  }
}

/** 真实存在于磁盘上的会话 id 集合。 */
function existingSessionIds() {
  const ids = new Set()
  if (!existsSync(sessionsRoot)) return ids
  for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = path.join(sessionsRoot, project.name)
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (session.isDirectory()) ids.add(session.name)
    }
  }
  return ids
}

console.log(`DSH 配置根: ${dshHome}`)
if (appRunning()) {
  console.error('✗ 检测到 DeepSeek Harness 仍在运行。')
  console.error('  投影缓存索引由宿主内存持有，运行期间修改会被覆盖——请先完全退出应用。')
  process.exit(1)
}
if (!existsSync(cacheIndex)) {
  console.error(`✗ 找不到投影缓存索引: ${cacheIndex}`)
  process.exit(1)
}

const existing = existingSessionIds()
console.log(`磁盘上现存会话: ${existing.size} 个`)

const document = JSON.parse(readFileSync(cacheIndex, 'utf8'))
const table = document?.tables?.sessions ?? {}
const stale = Object.keys(table).filter((id) => !existing.has(id))

console.log(`索引中的会话条目: ${Object.keys(table).length} 个`)
console.log(`其中日志已不存在（幽灵）: ${stale.length} 个`)
for (const id of stale) console.log(`  - ${id}`)

const orphanFiles = existsSync(cacheFiles)
  ? readdirSync(cacheFiles).filter((name) => name.endsWith('.json') && !existing.has(name.slice(0, -5)))
  : []
console.log(`孤儿缓存文件: ${orphanFiles.length} 个`)
for (const name of orphanFiles) console.log(`  - ${name}`)

if (stale.length === 0 && orphanFiles.length === 0) {
  console.log('\n没有需要清理的内容。')
  process.exit(0)
}

if (!apply) {
  console.log('\n（预览模式，未做任何改动。加 --apply 真正清理）')
  process.exit(0)
}

const backup = `${cacheIndex}.bak-${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}`
copyFileSync(cacheIndex, backup)
console.log(`\n已备份索引: ${backup}`)

for (const id of stale) delete table[id]
writeFileSync(cacheIndex, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
console.log(`已从索引移除 ${stale.length} 个幽灵条目`)

let removedFiles = 0
for (const name of orphanFiles) {
  rmSync(path.join(cacheFiles, name), { force: true })
  removedFiles += 1
}
console.log(`已删除 ${removedFiles} 个孤儿缓存文件`)

const size = statSync(cacheIndex).size
console.log(`清理后索引大小: ${(size / 1024).toFixed(1)} KB`)
console.log('\n完成。重新打开 DeepSeek Harness 即可。')
