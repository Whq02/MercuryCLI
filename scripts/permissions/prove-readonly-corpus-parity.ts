#!/usr/bin/env bun
// gate-watch: src/tools/BashTool/readOnlyValidation.ts src/utils/shell/readOnlyCommandValidation.ts src/tools/BashTool/bashPermissions.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const FIXTURE = join(ROOT, 'scripts', 'permissions', 'fixtures', 'readonly-corpus.json')
const RECORD = process.argv.includes('--record')
const SHOWN = 12

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'readonly-corpus-')))
const plain = join(scratch, 'plain')
const bareShaped = join(scratch, 'bare')
mkdirSync(plain)
mkdirSync(bareShaped)
writeFileSync(join(bareShaped, 'HEAD'), 'ref: refs/heads/main\n')
mkdirSync(join(scratch, 'home'))
const previousCwd = process.cwd()
process.chdir(plain)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { checkReadOnlyConstraints, cutPart, describeBashNotReadOnly, notReadOnlyClause } = await import('../../src/tools/BashTool/readOnlyValidation.js')

type Fixture = { verdicts: string[]; rows: Array<[string, number, number, number, number]> }
const SAME = -1
const OWN_TEXT = '"\u0001"'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().filter(key => record[key] !== undefined).map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}

async function verdictOf(command: string, cd: boolean): Promise<string> {
  const verdict = await checkReadOnlyConstraints({ command }, cd) as Record<string, unknown>
  const { updatedInput: _input, ...rest } = verdict
  return stable(rest)
}

async function describedOf(command: string): Promise<string> {
  const reason = await describeBashNotReadOnly(command)
  return stable(reason === null ? null : { reason, clause: notReadOnlyClause(reason) })
}

async function readings(command: string): Promise<[string, string, string, string]> {
  const own = JSON.stringify(cutPart(command))
  const fold = (reading: string): string => reading.replaceAll(own, OWN_TEXT)
  process.chdir(plain)
  const atPlain = [fold(await verdictOf(command, false)), fold(await verdictOf(command, true)), fold(await describedOf(command))] as const
  let atBareShape = ''
  if (/git/.test(command)) {
    process.chdir(bareShaped)
    atBareShape = fold(`${await verdictOf(command, false)}|${await describedOf(command)}`)
    process.chdir(plain)
    if (atBareShape === `${atPlain[0]}|${atPlain[2]}`) atBareShape = ''
  }
  return [atPlain[0], atPlain[1] === atPlain[0] ? '' : atPlain[1], atPlain[2], atBareShape]
}

const fixture: Fixture = existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture) : { verdicts: [], rows: [] }

if (RECORD) {
  const corpusPath = process.argv[process.argv.indexOf('--record') + 1]
  if (!corpusPath) throw new Error('--record needs the corpus path (a JSON array of commands)')
  const commands = [...new Set(JSON.parse(readFileSync(corpusPath, 'utf8')) as string[])].sort()
  const verdicts: string[] = []
  const index = new Map<string, number>()
  const intern = (text: string): number => {
    const known = index.get(text)
    if (known !== undefined) return known
    verdicts.push(text)
    index.set(text, verdicts.length - 1)
    return verdicts.length - 1
  }
  const rows: Fixture['rows'] = []
  for (const command of commands) {
    const [a, b, c, d] = await readings(command)
    rows.push([command, intern(a), b === '' ? SAME : intern(b), intern(c), d === '' ? SAME : intern(d)])
  }
  mkdirSync(join(ROOT, 'scripts', 'permissions', 'fixtures'), { recursive: true })
  writeFileSync(FIXTURE, `${JSON.stringify({ verdicts, rows })}\n`)
  console.log(`recorded ${rows.length} commands with ${verdicts.length} distinct readings into ${FIXTURE}`)
} else {
  check('the recorded corpus exists', fixture.rows.length > 0, FIXTURE)
  const readOnly = fixture.rows.filter(row => fixture.verdicts[row[1]]!.includes('"behavior":"allow"')).length
  console.log(`  corpus: ${fixture.rows.length} commands, ${fixture.verdicts.length} distinct readings, ${readOnly} read-only at cd=false`)
  const mismatches: string[] = []
  for (const [command, a, b, c, d] of fixture.rows) {
    const now = await readings(command)
    const expected = [fixture.verdicts[a]!, b === SAME ? '' : fixture.verdicts[b]!, fixture.verdicts[c]!, d === SAME ? '' : fixture.verdicts[d]!]
    const labels = ['verdict at cd=false', 'verdict at cd=true (where it differs)', 'reason and clause', 'verdict beside a bare-shaped folder (where it differs)']
    for (let i = 0; i < 4; i++) {
      if (now[i] !== expected[i]) mismatches.push(`${JSON.stringify(command)} — ${labels[i]}\n      recorded: ${expected[i]}\n      now:      ${now[i]}`)
    }
  }
  check(`every reading of the ${fixture.rows.length} commands is byte-identical to the recording`, mismatches.length === 0, `${mismatches.length} moved`)
  for (const line of mismatches.slice(0, SHOWN)) console.log(`    ${line}`)
  if (mismatches.length > SHOWN) console.log(`    … ${mismatches.length - SHOWN} more`)
}

process.chdir(previousCwd)
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-readonly-corpus-parity: ALL LAWS HOLD' : `\nprove-readonly-corpus-parity: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
