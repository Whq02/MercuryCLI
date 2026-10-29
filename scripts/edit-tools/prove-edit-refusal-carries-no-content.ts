#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, withoutTrailingReminders, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-edit-refusal-carries-no-content')
const KEEP = process.argv.includes('--keep')
const scratch = mkdtempSync(join(SCRATCH_ROOT, 'edit-refusal-content-'))
const work = join(scratch, 'work')
const outside = join(scratch, 'outside')
mkdirSync(work, { recursive: true })
mkdirSync(outside, { recursive: true })
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

const DENIED_CANARY = 'sk-test-DO-NOT-LEAK-1111'
const DENIED_SECOND = 'hunter2-DO-NOT-LEAK-2222'
const OUTSIDE_CANARY = 'CANARY-444-OUTSIDE'
const CHANGED_CANARY = 'CHANGED-BY-ANOTHER-SESSION-999'
const CANARIES = [DENIED_CANARY, DENIED_SECOND, OUTSIDE_CANARY, CHANGED_CANARY]

const denied = join(work, 'denied.env')
writeFileSync(denied, `API_KEY=${DENIED_CANARY}\nDB_PASS=${DENIED_SECOND}\nOTHER=plain\nMORE=plain\n`)
const outsideFile = join(outside, 'canary.txt')
writeFileSync(outsideFile, Array.from({ length: 20 }, (_, i) => (i === 14 ? `outside line 15: ${OUTSIDE_CANARY}` : `outside line ${i + 1}`)).join('\n') + '\n')
const moving = join(work, 'moving.ts')
const movingOriginal = Array.from({ length: 12 }, (_, i) => `const m${i + 1} = ${i + 1}`).join('\n') + '\n'
writeFileSync(moving, movingOriginal)
const movingFull = join(work, 'moving-full.ts')
writeFileSync(movingFull, movingOriginal)

const ASK = 'refusal-content-probe'
const seen: Record<string, SeenResult> = {}
let stage = 0
const fixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  const last = req.results[req.results.length - 1]
  if (req.step === 0) {
    stage = 1
    return [{ type: 'tool_use', name: 'Read', input: { file_path: denied } }]
  }
  switch (stage) {
    case 1:
      if (last) seen.deniedRead = last
      stage = 2
      return [{ type: 'tool_use', name: 'Edit', input: { file_path: denied, old_string: `DB_PASS=${DENIED_SECOND}`, new_string: 'DB_PASS=x' } }]
    case 2:
      if (last) seen.deniedEdit = last
      stage = 3
      return [{ type: 'tool_use', name: 'Edit', input: { file_path: denied, old_string: `DB_PASS=${DENIED_SECOND}`, new_string: 'DB_PASS=x' } }]
    case 3:
      if (last) seen.deniedRetry = last
      stage = 4
      return [{ type: 'tool_use', name: 'Edit', input: { file_path: denied, old_string: 'NOT-IN-THE-FILE-AT-ALL', new_string: 'x' } }]
    case 4:
      if (last) seen.deniedMissing = last
      stage = 5
      return [{ type: 'tool_use', name: 'Edit', input: { file_path: denied, old_string: '=plain', new_string: '=changed' } }]
    case 5:
      if (last) seen.deniedNotUnique = last
      stage = 6
      return [{ type: 'tool_use', name: 'Edit', input: { file_path: outsideFile, old_string: OUTSIDE_CANARY, new_string: 'x' } }]
    case 6:
      if (last) seen.outsideEdit = last
      stage = 7
      return [{ type: 'tool_use', name: 'Read', input: { file_path: moving, offset: 1, limit: 3 } }]
    case 7:
      if (last) seen.movingRead = last
      writeFileSync(moving, movingOriginal.replace('const m8 = 8', `const m8 = '${CHANGED_CANARY}'`))
      {
        const later = new Date(Date.now() + 120_000)
        utimesSync(moving, later, later)
      }
      stage = 8
      return [{ type: 'tool_use', name: 'Edit', input: { file_path: moving, old_string: `const m8 = '${CHANGED_CANARY}'`, new_string: 'const m8 = 8' } }]
    case 8:
      if (last) seen.movingEdit = last
      stage = 9
      return [{ type: 'tool_use', name: 'Read', input: { file_path: movingFull } }]
    case 9:
      if (last) seen.movingFullRead = last
      writeFileSync(movingFull, movingOriginal.replace('const m8 = 8', `const m8 = '${CHANGED_CANARY}'`))
      {
        const later = new Date(Date.now() + 120_000)
        utimesSync(movingFull, later, later)
      }
      stage = 10
      return [{ type: 'tool_use', name: 'Edit', input: { file_path: movingFull, old_string: `const m8 = '${CHANGED_CANARY}'`, new_string: 'const m8 = 8' } }]
    default:
      if (stage === 10 && last) seen.movingFullEdit = last
      stage = 11
      return [{ type: 'text', text: 'done' }]
  }
})

let turn: { exitCode: number | null; stderr: string } = { exitCode: null, stderr: '' }
try {
  turn = await runScriptedTurn({
    runHome: join(scratch, 'home'),
    cwd: work,
    base: fixture.base,
    ask: ASK,
    timeoutMs: 120_000,
    extraArgv: ['--mode', 'default', '--block-tools', 'Read(denied.env)'],
  })
} finally {
  await fixture.close()
}

const show = (label: string, r: SeenResult | undefined, cap = 30): void => {
  console.log(`\n── ${label} ──`)
  if (!r) {
    console.log(`│ (no tool result reached the wire; run exit ${turn.exitCode ?? '?'}: ${turn.stderr.slice(-400)})`)
    return
  }
  console.log(`│ is_error: ${r.isError}`)
  const lines = r.text.split('\n')
  for (const line of lines.slice(0, cap)) console.log(`│ ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`)
  if (lines.length > cap) console.log(`│ … (${lines.length - cap} more lines)`)
}
show('Read of denied.env under the deny rule', seen.deniedRead, 6)
show('Edit of denied.env with no read', seen.deniedEdit)
show('the same Edit again', seen.deniedRetry)
show('Edit of denied.env with an old_string the file does not hold', seen.deniedMissing)
show('Edit of denied.env with an old_string the file holds twice', seen.deniedNotUnique)
show('Edit of a file outside the project with no read', seen.outsideEdit)
show('Edit of a file that changed after a windowed read', seen.movingEdit)
show('Edit of a file that changed after a full read', seen.movingFullEdit)

const textOf = (r: SeenResult | undefined): string => withoutTrailingReminders(r?.text ?? '').replace(/^<tool_use_error>/, '').replace(/<\/tool_use_error>$/, '')
const carriesEditManual = (r: SeenResult | undefined): boolean => (r?.text ?? '').includes('# Tool manual: Edit')
const carriesCanary = (text: string): string | null => CANARIES.find(c => text.includes(c)) ?? null
const numberedRows = (text: string): number => text.split('\n').filter(line => /^\s*\d+(?:→|\t)/.test(line)).length
const LAW = 'Read the file before editing it'

tally.section('A. a Read deny rule holds against the Edit tool: the refusal carries nothing of the file and records nothing')
tally.check('A1 the Read is refused by the rule', seen.deniedRead !== undefined && seen.deniedRead.isError && /denied by the rule Read\(denied\.env\)/.test(textOf(seen.deniedRead)), textOf(seen.deniedRead).slice(0, 200))
tally.check('A2 the Edit of the unread file is refused', seen.deniedEdit !== undefined && seen.deniedEdit.isError, textOf(seen.deniedEdit).slice(0, 200))
tally.check('A3 the refusal carries no line of the file (RED on the base: the touched lines and their neighbours were shown)', seen.deniedEdit !== undefined && carriesCanary(textOf(seen.deniedEdit)) === null && numberedRows(textOf(seen.deniedEdit)) === 0, `canary: ${carriesCanary(textOf(seen.deniedEdit))}; numbered rows: ${numberedRows(textOf(seen.deniedEdit))}`)
tally.check('A4 the refusal names the path and the reason and says what to do', textOf(seen.deniedEdit).startsWith(LAW) && textOf(seen.deniedEdit).includes(denied) && textOf(seen.deniedEdit).includes("was not read in this session"), textOf(seen.deniedEdit).slice(0, 300))
tally.check('A5 the refusal does not claim the lines count as read', !/count(s)? as read/.test(textOf(seen.deniedEdit)), textOf(seen.deniedEdit).slice(0, 300))
tally.check('A5b the Edit manual rides the first Edit result once, on first use, beside the refusal and never inside it; the later refusals carry none', carriesEditManual(seen.deniedEdit) && (seen.deniedEdit?.text ?? '').split('# Tool manual: Edit').length === 2 && !carriesEditManual(seen.deniedRetry) && !carriesEditManual(seen.deniedMissing) && !carriesEditManual(seen.deniedNotUnique), (seen.deniedEdit?.text ?? '').slice(-200))
tally.check('A6 the same Edit again is refused by the read law again — the refusal recorded nothing a retry could ride (RED on the base: the retry passed the read gate and reached the write permission)', seen.deniedRetry !== undefined && seen.deniedRetry.isError && textOf(seen.deniedRetry).startsWith(LAW) && carriesCanary(textOf(seen.deniedRetry)) === null && readFileSync(denied, 'utf8').includes(`DB_PASS=${DENIED_SECOND}`), textOf(seen.deniedRetry).slice(0, 200))
tally.check('A7 an old_string the file does not hold gets the same words as one it holds: no oracle on the content', seen.deniedMissing !== undefined && seen.deniedMissing.isError && textOf(seen.deniedMissing) === textOf(seen.deniedEdit), textOf(seen.deniedMissing).slice(0, 300))
tally.check('A8 an old_string the file holds twice gets the same words too: no match count, no line numbers (RED on the base: "Found 2 matches" with the rows)', seen.deniedNotUnique !== undefined && seen.deniedNotUnique.isError && textOf(seen.deniedNotUnique) === textOf(seen.deniedEdit), textOf(seen.deniedNotUnique).slice(0, 300))
tally.check('A9 the denied file is untouched', readFileSync(denied, 'utf8') === `API_KEY=${DENIED_CANARY}\nDB_PASS=${DENIED_SECOND}\nOTHER=plain\nMORE=plain\n`)

tally.section('B. a file outside the project, never read, in the default mode: the refusal carries nothing of it')
tally.check('B1 the Edit is refused', seen.outsideEdit !== undefined && seen.outsideEdit.isError, textOf(seen.outsideEdit).slice(0, 200))
tally.check('B2 the refusal carries no line of the file (RED on the base: lines 12-18 were shown)', seen.outsideEdit !== undefined && carriesCanary(textOf(seen.outsideEdit)) === null && numberedRows(textOf(seen.outsideEdit)) === 0, `canary: ${carriesCanary(textOf(seen.outsideEdit))}`)
tally.check('B3 the refusal names the path and leads with the law', textOf(seen.outsideEdit).startsWith(LAW) && textOf(seen.outsideEdit).includes(outsideFile), textOf(seen.outsideEdit).slice(0, 300))
tally.check('B4 the outside file is untouched', readFileSync(outsideFile, 'utf8').includes(`outside line 15: ${OUTSIDE_CANARY}`))

tally.section('C. a file that changed after the read: the refusal may say so, never the new lines')
tally.check('C1 the windowed Read landed', seen.movingRead !== undefined && !seen.movingRead.isError, textOf(seen.movingRead).slice(0, 200))
tally.check('C2 the Edit after the outside change is refused', seen.movingEdit !== undefined && seen.movingEdit.isError, textOf(seen.movingEdit).slice(0, 200))
tally.check('C3 the refusal carries no line of the changed file (RED on the base: the new lines 5-11 were shown)', seen.movingEdit !== undefined && carriesCanary(textOf(seen.movingEdit)) === null && numberedRows(textOf(seen.movingEdit)) === 0, `canary: ${carriesCanary(textOf(seen.movingEdit))}`)
tally.check('C4 the refusal says the file changed after the read', /changed after/.test(textOf(seen.movingEdit)) || /changed on disk after your last read/.test(textOf(seen.movingEdit)), textOf(seen.movingEdit).slice(0, 300))
tally.check('C5 the changed file is untouched by the refused edit', readFileSync(moving, 'utf8').includes(`const m8 = '${CHANGED_CANARY}'`))
const resultPart = (r: SeenResult | undefined): string => textOf(r).split('<system-reminder>')[0] ?? ''
tally.check('C6 after a full read the same change is refused as an unexpected modification whose own words carry no lines (the changed-file notice beside it belongs to a file this session read in full)', seen.movingFullEdit !== undefined && seen.movingFullEdit.isError && carriesCanary(resultPart(seen.movingFullEdit)) === null && /changed on disk after your last read/.test(resultPart(seen.movingFullEdit)), resultPart(seen.movingFullEdit).slice(0, 300))

tally.section('D. the whole wire: nothing of a protected file ever reached the model')
const wire = fixture.requests.flatMap(req => req.allTexts).join('\n')
const protectedCanary = [DENIED_CANARY, DENIED_SECOND, OUTSIDE_CANARY].find(c => wire.includes(c)) ?? null
tally.check('D1 no line of the denied file or the outside file appears in any text the model received', protectedCanary === null, `canary on the wire: ${protectedCanary}`)
tally.check('D2 the turn settled', turn.exitCode === 0, `exit ${turn.exitCode}: ${turn.stderr.slice(-300)}`)

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
