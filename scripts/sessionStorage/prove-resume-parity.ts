import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
const stable = (value: any): any => {
  if (value instanceof Map) return [...value].map(([key, item]) => [key, stable(item)])
  if (value instanceof Set) return [...value]
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}
const check = (name: string, holds: boolean): void => {
  console.log(`${holds ? 'PASS' : 'FAIL'} ${name}`)
  if (!holds) process.exitCode = 1
}
const mode = process.argv[2]

if (mode === '--compare') {
  const old = JSON.parse(readFileSync(resolve(process.argv[3]!), 'utf8'))
  const next = JSON.parse(readFileSync(resolve(process.argv[4]!), 'utf8'))
  check('resume parity corpus cardinality', old.sessions.length === next.sessions.length && old.projects.length === next.projects.length)
  for (let index = 0; index < old.sessions.length; index++) {
    check(`resume parity session ${index + 1} entry order, content, facts, leaves and snapshots`, isDeepStrictEqual(old.sessions[index], next.sessions[index]))
  }
  check('resume parity project listing rows, labels and order', isDeepStrictEqual(old.projects, next.projects))
  const changed = structuredClone(old.sessions)
  changed[0].entries[0].digest = 'changed'
  check('resume parity detects a changed entry digest', !isDeepStrictEqual(old.sessions, changed))
} else {
  const root = mkdtempSync(join(tmpdir(), 'resume-parity-'))
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  mkdirSync(home)
  mkdirSync(cwd)
  process.env.MERCURY_CONFIG_DIR = home
  delete process.env.MERCURY_HOME
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
  process.chdir(cwd)
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const { loadTranscriptFile } = await import('../../src/utils/sessionStorage/loading.js')
  const { buildConversationChain } = await import('../../src/utils/sessionStorage/chain.js')
  const { getSessionFilesLite, enrichLogs, loadAllLogsFromSessionFile, getLastSessionLog } = await import('../../src/utils/sessionStorage/logs.js')
  const { _resetTranscriptReaderForTesting } = await import('../../src/utils/sessionStorage/transcriptReader.js')
  const { switchSession } = await import('../../src/bootstrap/state.js')
  const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.js')
  const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.js')
  const { loadInitialMessages } = await import('../../src/cli/headless/resume.js')
  const { loadConversationForResume } = await import('../../src/utils/conversationRecovery.js')
  const resumeDigest = (result: any, persisted: Set<string>): string => {
    if (result === null) return digest(null)
    const minted = new Map<string, string>()
    for (const row of result.messages) {
      if (!persisted.has(row.uuid)) minted.set(row.uuid, `<minted-${minted.size}>`)
    }
    const normalize = (value: any): any => {
      if (Array.isArray(value)) return value.map(normalize)
      if (value && typeof value === 'object') {
        const normalized = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))
        const id = minted.get(value.uuid)
        if (id !== undefined) {
          normalized.uuid = id
          normalized.timestamp = '<minted-at>'
          if (value.message?.id !== undefined) normalized.message = { ...normalized.message, id }
        }
        return normalized
      }
      return value
    }
    return snap(normalize(result))
  }
  const spellings = [...new Set([realpathSync(root), root])].sort((a, b) => b.length - a.length)
  const neutral = (value: any): any => {
    if (typeof value === 'string') return spellings.reduce((text, spelling) => text.split(spelling).join('<scratch>'), value)
    if (Array.isArray(value)) return value.map(neutral)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'displayPath' && typeof item === 'string' ? neutral(item.replace(/^(?:\.\.\/)+/, '<up>/')) : neutral(item)]))
    return value
  }
  const snap = (value: unknown): string => digest(neutral(stable(value)))
  try {
    if (mode === '--capture') {
      cpSync(resolve(process.argv[3]!), join(home, 'projects'), { recursive: true, preserveTimestamps: true })
    } else {
      const project = getProjectDir(cwd)
      mkdirSync(project, { recursive: true })
      const sessionId = '00000000-0000-4000-8000-000000000001'
      const entries = [
        { type: 'user', uuid: '00000000-0000-4000-8000-000000000002', parentUuid: null, isSidechain: false, sessionId, cwd, version: 'proof', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'saved prompt' } },
        { type: 'assistant', uuid: '00000000-0000-4000-8000-000000000003', parentUuid: '00000000-0000-4000-8000-000000000002', isSidechain: false, sessionId, cwd, version: 'proof', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', model: '', id: 'proof-reply', content: [{ type: 'text', text: 'saved reply' }] } },
        { type: 'custom-title', sessionId, customTitle: 'saved title' },
        { type: 'tag', sessionId, tag: 'saved tag' },
        { type: 'worktree-state', sessionId, worktreeSession: null },
      ]
      const path = join(project, `${sessionId}.jsonl`)
      writeFileSync(path, entries.map(entry => encodeTranscriptLine(path, entry).line).join(''))
      const fold = await loadTranscriptFile(path)
      check('resume parity synthetic entries remain byte-equivalent', snap([...fold.messages.values()]) === snap(entries.slice(0, 2)))
      check('resume parity synthetic leaf and metadata', fold.leafUuids.has(entries[1]!.uuid as never) && fold.customTitles.get(sessionId) === 'saved title' && fold.tags.get(sessionId) === 'saved tag' && fold.worktreeStates.get(sessionId) === null)
    }
    const projectsRoot = join(home, 'projects')
    const sessions: unknown[] = []
    const projects: unknown[] = []
    for (const directory of readdirSync(projectsRoot).sort()) {
      const project = join(projectsRoot, directory)
      if (!statSync(project).isDirectory()) continue
      const files = readdirSync(project).filter(name => /^[0-9a-f-]{36}\.jsonl$/.test(name)).sort()
      if (files.length === 0) continue
      const lite = await getSessionFilesLite(project)
      const listing = await enrichLogs(lite, 0, lite.length)
      projects.push({ id: digest(directory), rows: listing.logs.map(row => ({ session: row.sessionId, digest: snap({ ...row, created: undefined }) })) })
      for (const file of files) {
        const path = join(project, file)
        _resetTranscriptReaderForTesting()
        const before = digest(readFileSync(path).toString('utf8'))
        const fold = await loadTranscriptFile(path)
        const warm = await loadTranscriptFile(path)
        check(`resume parity warm read ${sessions.length + 1}`, snap(warm) === snap(fold))
        const entries = [...fold.messages].map(([id, row]) => ({ id, type: row.type, digest: snap(row) }))
        const chains = [...fold.leafUuids].map(id => ({ id, rows: buildConversationChain(fold.messages, fold.messages.get(id)!).map(row => ({ id: row.uuid, type: row.type, digest: snap(row) })) }))
        const allLeaves = await loadAllLogsFromSessionFile(path)
        const sessionId = basename(file, '.jsonl')
        switchSession(sessionId as never, project)
        const resumed = await getLastSessionLog(sessionId as never)
        if (readFileSync(path, 'utf8').includes('[screenshot not kept in the conversation file')) throw new Error('A fixture needs external screenshot assets; copy them into the proof home first')
        const conversation = await loadConversationForResume(sessionId, undefined)
        const headless = await loadInitialMessages(() => {}, {
          continue: undefined, resume: sessionId, resumeSessionAt: undefined, forkSession: undefined, outputFormat: 'rows',
        })
        const persisted = new Set<string>()
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (!line.trim()) continue
          const record = JSON.parse(line)
          const id = record.annotations?.uuid ?? record.payload?.fields?.uuid
          if (typeof id === 'string') persisted.add(id)
        }
        const { messages: _, ...metadata } = fold
        check(`resume parity read-only file ${sessions.length + 1}`, before === digest(readFileSync(path).toString('utf8')))
        sessions.push({ id: sessionId, entries, chains, metadata: snap(metadata), leaves: snap(allLeaves), resumed: snap(resumed), conversation: resumeDigest(conversation, persisted), headless: resumeDigest(headless, persisted) })
      }
    }
    check('resume parity corpus is nonempty', sessions.length > 0)
    if (mode === '--capture') {
      const output = resolve(process.argv[4]!)
      writeFileSync(output, JSON.stringify({ sessions, projects }, null, 2) + '\n', { mode: 0o600 })
    }
    console.log(`resume parity: ${sessions.length} sessions, ${projects.length} projects; only digests leave the reader`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
if (process.exitCode) process.exit(1)
