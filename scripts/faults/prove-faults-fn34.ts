import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dir
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const BUN = process.env.BUN ?? (process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun'))
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function runScenario(body: string): Record<string, unknown> {
  const scratch = mkdtempSync(join(tmpdir(), 'faults-fn34-'))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.NODE_ENV = 'development'
    delete process.env.MERCURY_HOME
    delete process.env.MERCURY_SKIP_PROMPT_HISTORY
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const fs = await import('node:fs')
    const path = await import('node:path')
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' },
    })
    if (res.status !== 0) throw new Error(`scenario failed (rc=${res.status}): ${(res.stderr || res.stdout).slice(-1500)}`)
    const line = res.stdout.trim().split('\n').pop() ?? '{}'
    return JSON.parse(line) as Record<string, unknown>
  } finally {
    try {
      chmodSync(home, 0o700)
    } catch {}
    rmSync(scratch, { recursive: true, force: true })
  }
}

{
  if (POSIX_MODES) {
    const r = runScenario(`
      const writer = await import(path.join(SRC, 'utils/sessionStorage/writer.ts'))
      const { getSessionId } = await import(path.join(SRC, 'bootstrap/state.ts'))
      const sessionId = getSessionId()
      const file = path.join(HOME, 'session.jsonl')
      const target = '00000000-0000-4000-8000-000000000011'
      writer.setSessionFileForTesting(file)
      writer.appendEntryToFile(file, {
        type: 'user', uuid: target, parentUuid: null, isSidechain: false, sessionId,
        timestamp: '2026-01-01T00:00:00.000Z', cwd: PROJECT, version: 'proof',
        message: { role: 'user', content: 'keep' },
      })
      fs.chmodSync(file, 0o400)
      try {
        await writer.removeTranscriptMessage(target)
        out.threw = null
      } catch (e) {
        out.threw = { code: e?.code ?? null, message: String(e?.message ?? e) }
      } finally {
        fs.chmodSync(file, 0o600)
      }
      out.stillPresent = fs.readFileSync(file, 'utf8').includes(target)
      writer.setSessionFileForTesting(path.join(HOME, 'absent.jsonl'))
      try {
        await writer.removeTranscriptMessage(target)
        out.absentThrew = null
      } catch (e) {
        out.absentThrew = String(e)
      }
    `)
    const threw = r.threw as { code: string | null; message: string } | null
    check('remove-readonly-rejects', threw !== null && (threw.code === 'EACCES' || threw.code === 'EPERM') && r.stillPresent === true && r.absentThrew === null, JSON.stringify(r))
  }
}

{
  if (POSIX_MODES) {
    const r = runScenario(`
      const { encodeTranscriptLine, resetTranscriptFormatCacheForTesting } = await import(path.join(SRC, 'utils/sessionStorage/vnext.ts'))
      const existing = path.join(HOME, 'existing.jsonl')
      fs.writeFileSync(existing, '{"schemaVersion":1,"creationOrdinal":"5"}\\n', { mode: 0o600 })
      fs.chmodSync(existing, 0o000)
      resetTranscriptFormatCacheForTesting()
      try {
        encodeTranscriptLine(existing, { type: 'user', uuid: '00000000-0000-4000-8000-000000000012' })
        out.threw = null
      } catch (e) {
        out.threw = { code: e?.code ?? null, message: String(e?.message ?? e) }
      } finally {
        fs.chmodSync(existing, 0o600)
      }
      const absent = path.join(HOME, 'fresh.jsonl')
      const fresh = encodeTranscriptLine(absent, { type: 'user', uuid: '00000000-0000-4000-8000-000000000013' })
      out.freshHasHeader = fresh.line.includes('mercury-transcript-header')
    `)
    const threw = r.threw as { code: string | null; message: string } | null
    check('vnext-unreadable-throws', threw !== null && (threw.code === 'EACCES' || threw.code === 'EPERM') && r.freshHasHeader === true, JSON.stringify(r))
  }
}
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
