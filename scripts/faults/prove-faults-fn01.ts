#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runSubprocess(
  body: string,
  opts?: { allowNonZero?: boolean },
): { status: number | null; stdout: string; stderr: string; out: Record<string, unknown> } {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn01-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n__OUT__' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' },
    })
    if (!opts?.allowNonZero && res.status !== 0) {
      throw new Error(`scenario exited ${res.status}: ${res.stderr.slice(-1200)}`)
    }
    const marker = res.stdout.lastIndexOf('__OUT__')
    const out = marker >= 0 ? (JSON.parse(res.stdout.slice(marker + 7).trim()) as Record<string, unknown>) : {}
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, out }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\nsessionsVerb.ts — unreadable projects dir or project store rejects instead of saying absent')
if (!POSIX_MODES) skip('sessionsVerb unreadable dirs', 'chmod 0000 needs non-root POSIX')
else {
  const r = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const paths = await import(path.join(SRC, 'utils/sessionStorage/paths.ts'))
    const verb = await import(path.join(SRC, 'cli/sessionsVerb.ts'))
    const sid = '11111111-1111-4111-8111-111111111111'
    const absentSid = '99999999-9999-4999-8999-999999999999'
    const projectsDir = paths.getProjectsDir()
    const store = paths.getProjectDir(PROJECT)
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(path.join(store, sid + '.jsonl'), '{"type":"user"}\\n')
    const runDelete = async id => {
      const errLines = []
      try {
        const rc = await verb.sessionsDeleteCli(id, { yes: true }, {
          out: () => {},
          err: line => errLines.push(line),
          interactive: false,
          ask: async () => false,
        })
        return { threw: null, rc, errLines }
      } catch (e) {
        return { threw: { code: e?.code ?? null, message: String(e?.message ?? e) }, rc: null, errLines }
      }
    }
    out.absentControl = await runDelete(absentSid)
    fs.chmodSync(projectsDir, 0o000)
    try {
      out.unreadableProjects = await runDelete(sid)
    } finally {
      fs.chmodSync(projectsDir, 0o700)
    }
    fs.chmodSync(store, 0o000)
    try {
      out.unreadableStore = await runDelete(sid)
    } finally {
      fs.chmodSync(store, 0o700)
    }
  `)
  const absent = r.out.absentControl as { threw: unknown; rc: number | null; errLines: string[] }
  const proj = r.out.unreadableProjects as { threw: { code: string | null } | null; rc: number | null; errLines: string[] }
  const store = r.out.unreadableStore as { threw: { code: string | null } | null; rc: number | null; errLines: string[] }
  check('sessionsVerb: absent session on readable store still returns rc 1', absent.threw === null && absent.rc === 1, JSON.stringify(absent))
  check('sessionsVerb: unreadable projects dir rejects with EACCES instead of saying absent', proj.threw?.code === 'EACCES' && proj.errLines.length === 0, JSON.stringify(proj))
  check('sessionsVerb: unreadable project store rejects with EACCES instead of saying absent', store.threw?.code === 'EACCES' && store.errLines.length === 0, JSON.stringify(store))
}

console.log('\ninputDoor.ts — unreadable transcript rejects instead of answering not-duplicate')
if (!POSIX_MODES) skip('inputDoor unreadable transcript', 'chmod 0200 needs non-root POSIX')
else {
  const r = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const state = await import(path.join(SRC, 'bootstrap/state.ts'))
    const loading = await import(path.join(SRC, 'utils/sessionStorage/loading.ts'))
    const door = await import(path.join(SRC, 'cli/headless/inputDoor.ts'))
    const sid = state.getSessionId()
    const file = loading.sessionFilePath(sid)
    const ports = {
      driver: { isRunning: () => false, kick: () => {} },
      getAppState: () => ({ tasks: {}, mcp: { commands: [] } }),
      live: { sessionInitialized: false },
      localCommandInput: () => false,
      missionLineOf: () => null,
      options: {},
      receivedUuids: new Set(),
      setAppState: () => {},
    }
    const absentAnswer = await door.acceptInput({ kind: 'prompt', content: 'first', id: '11111111-1111-4111-8111-111111111111' }, ports)
    out.absentAccepted = absentAnswer.accepted
    const logs = await import(path.join(SRC, 'utils/sessionStorage/logs.ts'))
    logs.clearSessionMessagesCache()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{"type":"user","uuid":"22222222-2222-4222-8222-222222222222"}\\n', { mode: 0o600 })
    fs.chmodSync(file, 0o200)
    try {
      const res = await door.acceptInput({ kind: 'prompt', content: 'second', id: '22222222-2222-4222-8222-222222222222' }, ports)
      out.unreadable = { threw: null, res }
    } catch (e) {
      out.unreadable = { threw: { code: e?.code ?? null, message: String(e?.message ?? e) }, res: null }
    } finally {
      fs.chmodSync(file, 0o600)
    }
  `)
  const unreadable = r.out.unreadable as { threw: { code: string | null } | null; res: unknown }
  check('inputDoor: absent transcript still accepts a new message id', r.out.absentAccepted === true, JSON.stringify(r.out))
  check('inputDoor: unreadable transcript rejects with EACCES instead of accepting', unreadable.threw?.code === 'EACCES', JSON.stringify(unreadable))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
