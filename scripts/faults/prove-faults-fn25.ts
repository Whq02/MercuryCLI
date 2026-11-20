#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dir
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'prove-faults-fn25-')))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as { MACRO?: { VERSION: string } }).MACRO = { VERSION: '1.0.0' }

function runSub(body: string): Record<string, unknown> {
  const subHome = realpathSync(mkdtempSync(join(scratch, 'sub-home-')))
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(subHome)}
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n__PROOF_JSON__' + JSON.stringify(out))
    process.exit(0)
  `
  const res = spawnSync(BUN, ['-e', src], {
    encoding: 'utf8',
    env: { ...process.env, MERCURY_CONFIG_DIR: subHome, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file' },
  })
  if (res.status !== 0) throw new Error(`sub failed (${res.status}): ${res.stderr.slice(-1000)}`)
  const line = res.stdout.split('\n').reverse().find(l => l.startsWith('__PROOF_JSON__'))
  return JSON.parse((line ?? '__PROOF_JSON__{}').slice('__PROOF_JSON__'.length)) as Record<string, unknown>
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { resolveAgentCwd } = await import('../../src/tools/AgentTool/agent/cwd.ts')

{
  const dir = join(scratch, 'cwd-loop')
  mkdirSync(dir, { recursive: true })
  const loopA = join(dir, 'a')
  const loopB = join(dir, 'b')
  symlinkSync(loopB, loopA)
  symlinkSync(loopA, loopB)
  let thrown: (Error & { code?: string }) | null = null
  try {
    resolveAgentCwd(loopA, getEmptyToolPermissionContext())
  } catch (error) {
    thrown = error as Error & { code?: string }
  }
  check(
    'agent/cwd: non-ENOENT stat failure throws real errno instead of claiming cwd does not exist',
    thrown !== null && thrown.code === 'ELOOP' && !thrown.message.includes('cwd does not exist'),
    thrown ? `${thrown.code ?? 'no-code'}: ${thrown.message}` : 'did not throw',
  )
  let missing: Error | null = null
  try {
    resolveAgentCwd(join(dir, 'absent'), getEmptyToolPermissionContext())
  } catch (error) {
    missing = error as Error
  }
  check(
    'agent/cwd: ENOENT still reports cwd does not exist',
    missing !== null && missing.message.includes('cwd does not exist'),
    missing ? missing.message : 'did not throw',
  )
}

{
  const r = runSub(`
    const { mock } = await import('bun:test')
    const path = await import('node:path')
    const storagePath = path.join(SRC, 'utils/sessionStorage.ts')
    const realStorage = await import(storagePath)
    let readCalls = 0
    let writeCalls = 0
    mock.module(storagePath, () => ({
      ...realStorage,
      getAgentTranscript: async () => ({
        messages: [{ type: 'user', uuid: '00000000-0000-4000-8000-000000000001', message: { role: 'user', content: 'hi' } }],
        contentReplacements: [],
      }),
      readAgentMetadata: async () => {
        readCalls++
        if (readCalls <= 2) return { agentType: 'mercury-crew', description: 'demo' }
        throw Object.assign(new Error('EIO: sidecar unreadable'), { code: 'EIO' })
      },
      writeAgentMetadata: async () => {
        writeCalls++
      },
    }))
    const runAgentPath = path.join(SRC, 'tools/AgentTool/runAgent.ts')
    const realRunAgent = await import(runAgentPath)
    mock.module(runAgentPath, () => ({
      ...realRunAgent,
      runAgent: async function* () {},
    }))
    const { resumeAgentBackground } = await import(path.join(SRC, 'tools/AgentTool/resumeAgent.ts'))
    const { getEmptyToolPermissionContext } = await import(path.join(SRC, 'Tool.ts'))
    const state = { toolPermissionContext: getEmptyToolPermissionContext(), tasks: {}, mcp: { tools: [], clients: [] } }
    const ctx = {
      getAppState: () => state,
      setAppState: fn => { Object.assign(state, fn(state)) },
      setAppStateForTasks: fn => { Object.assign(state, fn(state)) },
      abortController: new AbortController(),
      readFileState: new Map(),
      messages: [],
      options: { tools: [], mcpClients: [], mcpResources: {}, agentDefinitions: { activeAgents: [], allAgents: [] }, engineModel: 'claude-fable-5-1' },
    }
    const res = await resumeAgentBackground({ agentId: 'agent-eio-resume', prompt: 'go', toolUseContext: ctx })
    out.readCalls = readCalls
    out.writeCalls = writeCalls
    out.note = res.note ?? ''
  `)
  check(
    'resumeAgent: readAgentMetadata EIO skips overwrite and reports recordNote',
    r.readCalls === 3 && r.writeCalls === 0 && typeof r.note === 'string' && r.note.includes('could not be saved') && r.note.includes('EIO'),
    JSON.stringify(r),
  )
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
