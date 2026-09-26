#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const PROOF = join(ROOT, 'scripts', 'tools', 'prove-parity2-bus.ts')
const LEG_BUDGET_MS = 2_000
const RETURN_BOUND_MS = 30_000
const FLOOD_BYTES = 300_000
const WORDS = `the child did not close within ${LEG_BUDGET_MS / 1000} s`

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'parity2-bus-child-wait-'))
const CHILD_ROOT = join(SCRATCH, 'children')
mkdirSync(CHILD_ROOT, { recursive: true })

const toml = (globalThis as { Bun?: { TOML?: { parse: (text: string) => unknown } } }).Bun?.TOML
const repoConfig = (toml?.parse(readFileSync(join(ROOT, 'bunfig.toml'), 'utf8')) ?? {}) as { preload?: unknown }
const repoPreloads = Array.isArray(repoConfig.preload) ? repoConfig.preload.map(p => resolve(ROOT, String(p))) : []
const holdScript = join(SCRATCH, 'hold.ts')
writeFileSync(
  holdScript,
  `
import { writeSync } from 'node:fs'
const main = String(Bun.main ?? '')
const mode = process.env.PARITY2_PIN_CHILD ?? ''
if (mode !== '' && main.startsWith(${JSON.stringify(CHILD_ROOT + '/')}) && main.endsWith('/child.ts')) {
  if (mode === 'exit') process.exit(0)
  if (mode === 'flood') {
    const chunk = Buffer.alloc(65536, 101)
    let written = 0
    while (written < ${FLOOD_BYTES}) written += writeSync(2, chunk)
    writeSync(2, '\\nFLOOD-END ' + written + '\\n')
  } else {
    writeSync(2, 'HOLD-ENGAGED\\n')
  }
  setTimeout(() => process.exit(9), 120000)
  await new Promise(() => {})
}
`,
)
const pinConfig = join(SCRATCH, 'bunfig.toml')
writeFileSync(pinConfig, `preload = ${JSON.stringify([...repoPreloads, holdScript])}\n`)

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Outcome = { returned: boolean; code: number | null; signal: string | null; elapsedMs: number; out: string }
const runProof = (mode: 'flood' | 'hold' | 'exit' | 'ordinary'): Promise<Outcome> =>
  new Promise(settle => {
    const started = Date.now()
    const env: Record<string, string | undefined> = { ...process.env, SCRATCHPAD: CHILD_ROOT }
    if (mode !== 'ordinary') {
      env.BUN_OPTIONS = `--config=${pinConfig}`
      env.PARITY2_PIN_CHILD = mode
      env.PARITY2_CHILD_CLOSE_BUDGET_MS = String(LEG_BUDGET_MS)
    }
    const proof = spawn(process.execPath, ['run', PROOF], { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    proof.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    proof.stderr.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    const endGroup = (): void => {
      if (proof.pid === undefined) return
      try { process.kill(-proof.pid, 'SIGKILL') } catch {}
    }
    let returned = true
    let done = false
    const finish = (code: number | null, signal: string | null): void => {
      if (done) return
      done = true
      endGroup()
      settle({ returned, code, signal, elapsedMs: Date.now() - started, out })
    }
    const bound = setTimeout(() => {
      returned = false
      endGroup()
      setTimeout(() => finish(null, 'SIGKILL'), 3_000)
    }, RETURN_BOUND_MS)
    proof.on('close', (code, signal) => { clearTimeout(bound); finish(code, signal) })
  })

const lastLine = (out: string): string => out.trimEnd().split('\n').at(-1) ?? ''
const pidOf = (out: string): number | undefined => {
  const m = /the child \(pid (\d+)\) was ended/.exec(out)
  return m ? Number(m[1]) : undefined
}
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}
const capturedBytes = (out: string): number => Number(/its stderr \((\d+) bytes captured/.exec(out)?.[1] ?? -1)

const returns = (name: string, o: Outcome): void =>
  t(
    `${name}: prove-parity2-bus returns within ${RETURN_BOUND_MS / 1000} s`,
    o.returned,
    o.returned ? `returned in ${o.elapsedMs} ms, exit ${o.code}` : `the proof did not return within ${RETURN_BOUND_MS / 1000} s — its real-child leg waits on 'close' with no bound; the proof was ended with SIGKILL; its last line: ${JSON.stringify(lastLine(o.out))}`,
  )

const judgeHeld = (name: string, o: Outcome): void => {
  returns(name, o)
  t(`${name}: the leg fails with the words "${WORDS}"`, o.out.includes(WORDS), o.out.includes(WORDS) ? '' : 'the words never printed')
  t(`${name}: the proof exits 1 — a bounded red, not a suite kill`, o.code === 1, `exit ${o.code}${o.signal ? ` signal ${o.signal}` : ''}`)
  const pid = pidOf(o.out)
  t(`${name}: the held child is ended on the bound`, pid !== undefined && !alive(pid), pid === undefined ? 'no "the child (pid N) was ended" line' : `pid ${pid} ${alive(pid) ? 'still alive' : 'gone'}`)
}

const [flood, hold, exit] = await Promise.all([runProof('flood'), runProof('hold'), runProof('exit')])

returns('a child that closes at once', exit)
t('a child that closes at once: the leg observes the close it would have missed', exit.out.includes('PASS  the child exits 0 through the real graceful shutdown — exit 0'), lastLine(exit.out))
t('a child that closes at once: the proof reaches its verdict', /\n(ALL GREEN|FAILURES)\n?$/.test(exit.out), lastLine(exit.out))

judgeHeld('a child that overfills stderr and waits', flood)
t(
  'a child that overfills stderr and waits: the stderr pipe is drained — every flood byte is counted and the tail is printed',
  capturedBytes(flood.out) >= FLOOD_BYTES && flood.out.includes('FLOOD-END'),
  `${capturedBytes(flood.out)} bytes captured (>= ${FLOOD_BYTES} expected)${flood.out.includes('FLOOD-END') ? ', FLOOD-END printed' : ', FLOOD-END never printed'}`,
)

judgeHeld('a child that never closes', hold)
t('a child that never closes: its captured stderr is printed on the bound', hold.out.includes('HOLD-ENGAGED'), hold.out.includes('HOLD-ENGAGED') ? '' : 'HOLD-ENGAGED never printed')

const ordinary = await runProof('ordinary')
returns('the ordinary child', ordinary)
t('the ordinary child: the leg completes through the real graceful shutdown', ordinary.out.includes('PASS  the child exits 0 through the real graceful shutdown'), lastLine(ordinary.out))
t('the ordinary child: every streamed byte arrives', ordinary.out.includes('PASS  a slow reader still receives every streamed byte'), lastLine(ordinary.out))
t('the ordinary child: the terminal frame still arrives last', ordinary.out.includes('PASS  the terminal result frame arrives last'))
t('the ordinary child: the bound never fires', !ordinary.out.includes('the child did not close within'))

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures ? '\nFAILURES' : '\nALL GREEN')
process.exit(failures)
