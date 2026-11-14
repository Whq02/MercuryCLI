import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function isolatedHome(script: string): string {
  const given = process.env.READ_VIEW_PROOF_HOME
  if (given) {
    if (homedir() !== given) throw new Error('The runtime did not take the proof home')
    return given
  }
  const base = process.env.MERCURY_TMPDIR ?? process.env.MERCURY_CONFIG_DIR
  if (!base) throw new Error('The proof needs its scratch home')
  mkdirSync(base, { recursive: true })
  const home = realpathSync(mkdtempSync(join(base, 'read-view-')))
  let status = 1
  try {
    const child = spawnSync(process.execPath, [script], { stdio: 'inherit', env: { ...process.env, HOME: home, USERPROFILE: home, READ_VIEW_PROOF_HOME: home, MERCURY_CONFIG_DIR: join(home, '.mercury'), MERCURY_TMPDIR: join(home, 'tmp') } })
    status = child.status ?? 1
  } finally { rmSync(home, { recursive: true, force: true }) }
  process.exit(status)
}

export async function readViewKit(home: string) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  process.env.MERCURY_BARE = '1'
  const src = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
  const { FileReadTool } = await import(`${src}/tools/FileReadTool/FileReadTool.ts`)
  const { getEmptyToolPermissionContext } = await import(`${src}/Tool.ts`)
  const { createFileStateCacheWithSizeLimit } = await import(`${src}/utils/fileStateCache.ts`)
  const { setCwdState, setOriginalCwd } = await import(`${src}/bootstrap/state.ts`)
  setCwdState(home)
  setOriginalCwd(home)
  let rules = getEmptyToolPermissionContext()
  const context = {
    readFileState: createFileStateCacheWithSizeLimit(100), userModified: false, updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(), nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(), messages: [], getAppState: () => ({ toolPermissionContext: rules }),
  }
  let passed = 0, failed = 0
  return {
    src, context, FileReadTool,
    deny(pattern: string) { rules = { ...rules, alwaysDenyRules: { session: [pattern] } } },
    async read(file_path: string, options: Record<string, unknown> = {}) {
      try {
        const input = { file_path, ...options }
        const valid = await FileReadTool.validateInput(input, context)
        if (!valid.result) return String(valid.message)
        const permission = await FileReadTool.checkPermissions(input, context)
        if (permission.behavior === 'deny') return String(permission.message)
        const reply = await FileReadTool.call(input, context)
        return String(FileReadTool.mapToolResultToToolResultBlockParam(reply.data, 'view').content)
      } catch (error) { return String(error) }
    },
    check(name: string, ok: boolean, detail = '') { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${detail}`}`) },
    finish() { console.log(`${passed}/${passed + failed} checks`); process.exitCode = failed ? 1 : 0 },
  }
}

export function cpuFixture() {
  const frame = (functionName: string, url = '', lineNumber = 0) => ({ functionName, url, lineNumber, columnNumber: 0, scriptId: '1' })
  return {
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2, 3, 6] },
      { id: 2, callFrame: frame('(idle)') },
      { id: 3, callFrame: frame('run', '/project/main.ts', 9), children: [4, 7] },
      { id: 4, callFrame: frame('hot', '/project/work.ts', 19), children: [5] },
      { id: 5, callFrame: frame('hot', '/project/work.ts', 19) },
      { id: 6, callFrame: frame('(garbage collector)') },
      { id: 7, callFrame: frame('hot', '/project/work.ts', 19) },
    ],
    startTime: 0, endTime: 10000, samples: [2, 4, 5, 6, 7], timeDeltas: [1000, 3000, 2000, 1000, 3000],
  }
}
