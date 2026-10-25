#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'engine-stop-')))
process.env.MERCURY_TMPDIR = join(scratch, 'tmp')
const LOG = join(scratch, 'engine.log')
writeFileSync(LOG, '')
process.env.FAKE_ENGINE_LOG = LOG

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const logged = (): string => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '')
const waitFor = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(50)
  }
  return pred()
}

const FAKE_SOURCE = `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
const note = (line: string): void => { if (process.env.FAKE_ENGINE_LOG) appendFileSync(process.env.FAKE_ENGINE_LOG, line + '\\n') }
const script = args[args.indexOf('-c') + 1] ?? ''
if (args.includes('-n')) {
  note('parse:' + script)
  setTimeout(() => process.exit(0), Number(process.env.FAKE_ENGINE_PARSE_MS ?? '0'))
} else if (!script.startsWith('IFS= read -r __brush_nonce')) {
  process.exit(1)
} else {
  let nonce: string | null = null
  let pending = ''
  const decode = (frame: string): string => {
    const bytes: number[] = []
    for (let i = 0; i < frame.length; i++) {
      if (frame[i] === '\\\\' && frame[i + 1] === '\\\\') { bytes.push(0x5c); i++ }
      else if (frame[i] === '\\\\' && frame[i + 1] === 'x') { bytes.push(parseInt(frame.slice(i + 2, i + 4), 16)); i += 3 }
      else bytes.push(frame.charCodeAt(i))
    }
    return Buffer.from(bytes).toString('utf8')
  }
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    pending += chunk
    let at: number
    while ((at = pending.indexOf('\\n')) !== -1) {
      const line = pending.slice(0, at)
      pending = pending.slice(at + 1)
      if (nonce === null) { nonce = line; continue }
      const command = decode(line)
      note('frame:' + command.replace(/\\n/g, ' '))
      if (command.includes('FAKE_HANG')) continue
      process.stdout.write(String.fromCharCode(1) + nonce + ' 0' + String.fromCharCode(2) + process.cwd() + String.fromCharCode(3))
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
`
const fakeSource = join(scratch, 'fake-engine.ts')
writeFileSync(fakeSource, FAKE_SOURCE)
const FAKE = join(scratch, process.platform === 'win32' ? 'fake-engine.exe' : 'fake-engine')
const built = spawnSync(process.execPath, ['build', '--compile', fakeSource, '--outfile', FAKE], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
check('a stand-in engine binary is compiled for this host (the brush pack is not needed)', built.status === 0 && existsSync(FAKE), `${built.status} ${(built.stderr ?? '').slice(0, 300)}`)

const { setCwd } = await import(join(ROOT, 'src/utils/Shell.ts'))
setCwd(scratch)
const engine = await import(join(ROOT, 'src/utils/shell/engineSession.ts'))

console.log('\n── a stop that lands on an engine command releases its session and keeps the command from running ──')
if (existsSync(FAKE)) {
  {
    const first = engine.runEngineCommand(FAKE, 'echo FAKE_HANG', { timeout: 60_000, signal: new AbortController().signal })
    check('the first command is in flight on the engine session', await waitFor(() => /frame:.*FAKE_HANG/.test(logged()), 15_000), logged().slice(-200))
    first.kill()
    const stopped = await first.result
    check('the stop settles the command as interrupted (137)', stopped.code === 137 && stopped.interrupted === true, JSON.stringify(stopped))
    const t0 = Date.now()
    const next = engine.runEngineCommand(FAKE, 'echo after-stop', { timeout: 60_000, signal: new AbortController().signal })
    const result = await Promise.race([next.result, sleep(20_000).then(() => null)])
    const ms = Date.now() - t0
    check("the owner's next command runs at once, not after the stopped command's 60s timeout", result !== null && result.code === 0 && ms < 15_000, result === null ? `still waiting after ${ms}ms` : `${ms}ms code ${result.code}`)
    check('…and carries the stop note, never the timeout note', result !== null && /after the command was stopped/.test(result.stderr) && !/hit its timeout/.test(result.stderr), result?.stderr ?? '(no result)')
  }
  await engine.endEngineSession()
  process.env.FAKE_ENGINE_PARSE_MS = '2500'
  {
    writeFileSync(LOG, '')
    const command = engine.runEngineCommand(FAKE, 'echo stopped-while-parsed', { timeout: 60_000, signal: new AbortController().signal })
    await waitFor(() => logged().includes('parse:'), 10_000)
    command.kill()
    const result = await command.result
    await sleep(4_000)
    check('a command stopped while the engine parses it settles as interrupted (137)', result.code === 137 && result.interrupted === true, JSON.stringify(result))
    check('…and never reaches the engine session afterwards', !/frame:.*stopped-while-parsed/.test(logged()), logged().slice(-300))
  }
  await engine.endEngineSession()
  {
    writeFileSync(LOG, '')
    const controller = new AbortController()
    const command = engine.runEngineCommand(FAKE, 'echo aborted-while-parsed', { timeout: 60_000, signal: controller.signal })
    await waitFor(() => logged().includes('parse:'), 10_000)
    controller.abort('stop')
    const result = await Promise.race([command.result, sleep(15_000).then(() => null)])
    await sleep(1_000)
    check('a command aborted while the engine parses it settles as aborted before execution (145)', result !== null && result.code === 145 && result.interrupted === true, JSON.stringify(result))
    check('…and never reaches the engine session afterwards', !/frame:.*aborted-while-parsed/.test(logged()), logged().slice(-300))
  }
  delete process.env.FAKE_ENGINE_PARSE_MS
  await engine.endEngineSession()
}

try {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(proofHome, { recursive: true, force: true })
} catch {
}
console.log(failures === 0 ? '\n✅ ENGINE STOP RELEASES THE SESSION' : `\n❌ ${failures} ENGINE STOP CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
