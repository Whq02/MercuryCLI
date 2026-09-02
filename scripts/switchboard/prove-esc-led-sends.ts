// prove-esc-led-sends — the ESC-led chord law for every PTY drive.
//
// The class this pins: a driven arrow that "never reaches Mercury". The byte
// tap on the built bundle read every ESC-led chord whole at
// App.handleReadable; what had gone missing was the ESC in the PROVER'S OWN
// SEND — a raw 0x1b typed into a string literal is invisible in review and
// one editor sweep away from becoming a bare '[B', which then reads on
// screen as "arrows dead on the whole concourse" (the
// concourse arrow-key class). Two legs, each with a poison control:
//
//   L1  the tree law — no raw C0 control byte (other than \t \n \r) in any
//       scripts/**/*.{ts,py,sh} source: chords are spelled '\x1b[B'.
//       Poison: a scratch file holding a raw ESC trips the same scanner.
//   L2  the rig round trip — vshot delivers '\x1b[B', '\x1b[A' and
//       '\x1b[1;2D' whole to a raw-mode node child in a real PTY.
//       Poison: a bare '[B' send arrives as 5b42 — the class's own
//       signature — so the leg discriminates.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const ESC = '\x1b'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── L1: the tree law ──────────────────────────────────────────────────────
/** The raw C0 control bytes a drive source must not carry: everything below
 *  0x20 except HT, LF and CR. Returns the 1-based line numbers that carry one. */
export function rawControlLines(source: Buffer): number[] {
  const hits: number[] = []
  let line = 1
  for (let i = 0; i < source.length; i++) {
    const b = source[i]!
    if (b === 0x0a) {
      line++
      continue
    }
    if (b < 0x20 && b !== 0x09 && b !== 0x0d) {
      if (hits[hits.length - 1] !== line) hits.push(line)
    }
  }
  return hits
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'fixtures') continue
      yield* walk(p)
    } else if (/\.(ts|py|sh)$/.test(name)) {
      yield p
    }
  }
}

console.log('L1 the tree law: drive sources spell every chord, never a raw control byte')
const offenders: string[] = []
let scanned = 0
for (const file of walk(join(REPO, 'scripts'))) {
  scanned++
  const lines = rawControlLines(readFileSync(file))
  if (lines.length > 0) offenders.push(`${file.slice(REPO.length + 1)}:${lines.join(',')}`)
}
check(`no scripts source carries a raw C0 control byte (${scanned} files scanned)`, offenders.length === 0, offenders.join(' · '))
// Poison control: the scanner itself trips on a raw ESC.
const poison = Buffer.concat([Buffer.from("const DOWN = '"), Buffer.from([0x1b]), Buffer.from("[B'\nconst ok = '\\x1b[B'\n")])
check('poison: a source holding a raw ESC is flagged at its line', JSON.stringify(rawControlLines(poison)) === '[1]', JSON.stringify(rawControlLines(poison)))
check('control: the escaped spelling is clean', rawControlLines(Buffer.from("const DOWN = '\\x1b[B'\n")).length === 0)

// ── L2: the rig round trip ────────────────────────────────────────────────
console.log('L2 the rig round trip: vshot delivers ESC-led chords whole to a raw-mode PTY child')
const scratch = join(tmpdir(), `esc-led-sends-${process.pid}`)
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
const tapPath = join(scratch, 'child-bytes.log')
const childScript =
  "process.stdin.setRawMode(true); process.stdin.on('data', d => require('fs').appendFileSync(process.env.ESC_TAP, d.toString('hex') + '\\n'))"
function roundTrip(tag: string, sends: string[]): string[] {
  rmSync(tapPath, { force: true })
  const out = join(scratch, `${tag}.json`)
  const cfg = {
    argv: ['node', '-e', childScript],
    cols: 80,
    rows: 24,
    total: 4 + sends.length * 2,
    sends: sends.map((data, i) => ({ atTick: 3 + i * 2, data })),
    out,
  }
  const cfgPath = join(scratch, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(60_000), env: { ...process.env, ESC_TAP: tapPath } })
  if (res.status !== 0) throw new Error(`vshot ${tag} failed (${res.status}): ${(res.stderr ?? '').slice(-400)}`)
  return existsSync(tapPath) ? readFileSync(tapPath, 'utf8').trim().split('\n').filter(Boolean) : []
}
const whole = roundTrip('whole', [`${ESC}[B`, `${ESC}[A`, `${ESC}[1;2D`])
check('↓ arrives as 1b5b42 (ESC intact)', whole[0] === '1b5b42', JSON.stringify(whole))
check('↑ arrives as 1b5b41', whole[1] === '1b5b41', JSON.stringify(whole))
check('⇧← arrives as 1b5b313b3244', whole[2] === '1b5b313b3244', JSON.stringify(whole))
// Poison control: the bare send (the class's signature) arrives without ESC.
const bare = roundTrip('bare', ['[B'])
check("poison: a bare '[B' send arrives as 5b42 — the very signature the class wore", bare[0] === '5b42', JSON.stringify(bare))
rmSync(scratch, { recursive: true, force: true })

console.log(failures === 0 ? 'ESC-LED SEND LAWS HOLD' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
