#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'scratchpad-temp-')))
process.env.MERCURY_TMPDIR = tempRoot
delete process.env.MERCURY_CONCOURSE_WORKER

const { getScratchpadDir, getMercuryTempDir, getProjectTempDir } = await import('../../src/utils/permissions/filesystem.ts')
const { getOriginalCwd, getSessionId } = await import('../../src/bootstrap/state.ts')
const scratchpad = await import('../../src/utils/scratchpad.ts')
const prompts = await import('../../src/constants/prompts.ts')
const { injectTurnReceipts, isScratchpadPath } = await import('../../src/utils/cockpit/turnReceipt.ts')
const { runCleanupFunctions } = await import('../../src/utils/cleanupRegistry.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}

section('§1 the prompt names the scratchpad, in Mercury\'s words')
const dir = getScratchpadDir()
const main = await prompts.computeSimpleEnvInfo('claude-opus-5')
const sub = await prompts.computeEnvInfo('claude-opus-5')
check('the main environment block names the directory', main.includes(`Scratchpad directory: ${dir}`), main)
check('…and says what it is for and what it is not', main.includes('temporary files') && main.includes('instead of a system temp directory or the project tree') && main.includes('swept when the session ends'))
check('the sub-agent environment block names it too, inside <env>', /<env>[\s\S]*Scratchpad directory: /.test(sub) && sub.includes(dir), sub)
check('composing the prompt creates the directory, so the first write there lands', existsSync(dir))
check('the line carries no borrowed product name', !/claude|anthropic/i.test((main.split('Scratchpad directory:')[1] ?? '').split('\n')[0] ?? ''))

section('§2 the directory lies outside the project and under the temp root')
check('the scratchpad is under the temp root Mercury owns', dir.startsWith(getMercuryTempDir()) && dir.startsWith(tempRoot))
check('…and not under the working directory, so git status never sees it', !dir.startsWith(getOriginalCwd()))
check('the daemon derives the same directory from the session\'s cwd and id', scratchpad.scratchpadDirFor(getOriginalCwd(), getSessionId()) === dir, scratchpad.scratchpadDirFor(getOriginalCwd(), getSessionId()))
check('a second session in the same project gets its own', scratchpad.scratchpadDirFor(getOriginalCwd(), 'other-session') !== dir && scratchpad.scratchpadDirFor(getOriginalCwd(), 'other-session').startsWith(getProjectTempDir()))

section('§3 the receipt counts an edit under the scratchpad, and only there')
const rows = injectTurnReceipts(
  [
    { type: 'user', uuid: 'p1', message: { role: 'user', content: 'build the thing' } },
    { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }, toolUseResult: { filePath: join(dir, 'notes.md'), structuredPatch: [{ lines: ['+one'] }] } },
    { type: 'user', uuid: 'r2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2' }] }, toolUseResult: { filePath: join(getOriginalCwd(), 'scratchpad', 'notes.md'), structuredPatch: [{ lines: ['+two'] }] } },
    { type: 'user', uuid: 'r3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3' }] }, toolUseResult: { filePath: join(getOriginalCwd(), 'src', 'app.ts'), structuredPatch: [{ lines: ['+three'] }] } },
  ] as never,
  getMercuryTempDir(),
) as Array<{ type: string; counts?: { scratchpadEdits: number; fileEdits: number } }>
const receipt = rows.find(r => r.type === 'turn_receipt')
check('one scratchpad edit for the file under the scratchpad', receipt?.counts?.scratchpadEdits === 1, JSON.stringify(receipt?.counts))
check("two file edits: a project folder named scratchpad is the project's, not the session's", receipt?.counts?.fileEdits === 2, JSON.stringify(receipt?.counts))
check('the Windows spelling counts under a Windows temp root', isScratchpadPath('C:\\Users\\x\\AppData\\Local\\Temp\\mercury\\proj\\s1\\scratchpad\\a.txt', 'C:\\Users\\x\\AppData\\Local\\Temp\\mercury\\'))
check('a path under the temp root without the segment is not a scratchpad edit', !isScratchpadPath(join(getProjectTempDir(), getSessionId(), 'tasks', 'x.output'), getMercuryTempDir()))

section('§4 the sweep is lease-exact: this session\'s scratchpad, under the temp root, and nothing else')
writeFileSync(join(dir, 'helper.sh'), 'echo hi\n')
const outside = mkdtempSync(join(tmpdir(), 'not-a-scratchpad-'))
const refused = scratchpad.sweepScratchpadDir(outside)
check('a directory outside the temp root is refused, with the reason', refused.swept === false && refused.refusal.includes('outside the temp root') && existsSync(outside))
const sibling = join(getProjectTempDir(), getSessionId(), 'tasks')
mkdirSync(sibling, { recursive: true })
const notScratchpad = scratchpad.sweepScratchpadDir(sibling)
check('a sibling that is not the scratchpad is refused', notScratchpad.swept === false && existsSync(sibling))
const swept = scratchpad.sweepOwnScratchpad()
check('the session\'s own scratchpad is swept', swept.swept === true && !existsSync(dir))
check('…and the session\'s other temp files stay', existsSync(sibling))
rmSync(outside, { recursive: true, force: true })

section('§5 the sweep rides the session\'s end')
scratchpad._resetScratchpadSweepForTesting()
process.env.MERCURY_CONCOURSE_WORKER = '1'
check('a runner the daemon hosts does not arm its own sweep (the daemon sweeps at the record\'s end)', scratchpad.armScratchpadSweep() === false && scratchpad.scratchpadSweptByDaemon())
delete process.env.MERCURY_CONCOURSE_WORKER
check('a process that is its own session arms the sweep once', scratchpad.armScratchpadSweep() === true && scratchpad.armScratchpadSweep() === false)
scratchpad.ensureScratchpadDir()
writeFileSync(join(dir, 'capture.txt'), 'x\n')
await runCleanupFunctions()
check('the registered cleanup sweeps the scratchpad at exit', !existsSync(dir))
const supervisor = readFileSync(join(ROOT, 'src/daemon/concourseSupervisor.ts'), 'utf8')
check('the daemon sweeps a settled session\'s scratchpad, derived from its record', supervisor.includes('sweepScratchpadDir(scratchpadDirFor(settledRec.worktreePath ?? settledRec.workspaceId, settledRec.sessionId))'))
const init = readFileSync(join(ROOT, 'src/entrypoints/init.ts'), 'utf8')
check('the entry layer arms the sweep beside the shutdown hooks', init.includes('armScratchpadSweep()'))
for (const [file, needle] of [
  ['src/components/Messages.tsx', 'injectTurnReceipts(collapsed, getMercuryTempDir())'],
  ['src/components/concourse/workerTranscriptFold.ts', 'injectTurnReceipts(grouped, getMercuryTempDir())'],
]) check(`${file} hands the receipt the temp root`, readFileSync(join(ROOT, file!), 'utf8').includes(needle!))

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
