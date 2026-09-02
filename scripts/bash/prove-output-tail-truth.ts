#!/usr/bin/env bun
// ============================================================================
//  scripts/bash/prove-output-tail-truth.ts — a long shell output keeps its
//  VERDICT: the model sees the head AND the tail.
//
//  A build or test run states its result at the end — the failing test,
//  the exit summary, "error TS…". The in-memory cut (formatOutput) kept the
//  head only and the persisted-output preview sliced the head only while its
//  own label promised "head + tail", so the model learned the verdict only
//  by re-running or reading the file. Pins:
//    §1 formatOutput past the cap keeps the first lines AND the last lines
//       around ONE middle notice that says what was cut; under the cap it is
//       byte-identical; an image output is untouched.
//    §2 the persisted-output preview (generatePreview) carries head + tail —
//       the label's promise — and BOTH shell mappers use it (the PowerShell
//       family kept a head-only slice under the same label).
//    §2b the PowerShell family applies the same in-memory cut (formatOutput)
//       Bash does — its call returned the raw accumulator to the model.
//    §3 the notebook path still receives a bounded string.
//    §4 the SPILLED-FILE read (TaskOutput in file mode) keeps the head and
//       the tail too — it returned the first budget of bytes alone, cut
//       mid-line with no notice and no pointer (TASK-014 w4-f01-01: the
//       ledger's T4 failing on Windows through the spill sink).
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// A scratch temp root BEFORE the module chain loads — the task-output
// directory memoizes on first touch.
const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-tail-truth-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'config')
process.env.MERCURY_TMPDIR = join(SCRATCH, 'tmp')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

delete process.env.BASH_MAX_OUTPUT_LENGTH
const { formatOutput } = await import('../../src/tools/BashTool/utils.ts')
const { getMaxOutputLength } = await import('../../src/utils/shell/outputLimits.ts')
const { generatePreview, PREVIEW_SIZE_CHARS } = await import('../../src/utils/toolResultStorage.ts')

section('§1 formatOutput keeps the head and the tail')
{
  const cap = getMaxOutputLength()
  const lines: string[] = []
  for (let i = 1; lines.join('\n').length < cap * 3; i++) lines.push(`line ${i}: ${'x'.repeat(40)}`)
  lines.push('FAIL src/thing.test.ts > the verdict lives at the tail')
  lines.push('Tests: 1 failed, 412 passed')
  const content = lines.join('\n')
  const out = formatOutput(content)
  check('the result is bounded near the cap', out.truncatedContent.length <= cap + 200, String(out.truncatedContent.length))
  check('the FIRST line survives', out.truncatedContent.startsWith('line 1:'))
  check('the LAST lines survive — the verdict reaches the model', out.truncatedContent.endsWith('Tests: 1 failed, 412 passed') && out.truncatedContent.includes('FAIL src/thing.test.ts'))
  check('exactly one middle notice states what was cut', (out.truncatedContent.match(/truncated from the middle/g) ?? []).length === 1 && /\[\d+ lines? truncated from the middle/.test(out.truncatedContent))
  check('the total line count is the true count', out.totalLines === lines.length, `${out.totalLines} vs ${lines.length}`)
  const small = 'a\nb\nc'
  check('under the cap the output is byte-identical', formatOutput(small).truncatedContent === small)
  const image = 'data:image/png;base64,iVBORw0KGgo='
  check('an image output is untouched', formatOutput(image).isImage === true && formatOutput(image).truncatedContent === image)
}

section('§2 the persisted-output preview carries head + tail, and the Bash mapper uses it')
{
  const body = `${'head line\n'.repeat(400)}${'middle line\n'.repeat(400)}tail verdict: FAILED\n`
  const { preview, hasMore } = generatePreview(body, PREVIEW_SIZE_CHARS)
  check('the preview keeps the head', preview.startsWith('head line'))
  check('the preview keeps the tail', preview.includes('tail verdict: FAILED'))
  check('the preview names the skipped middle', /skipped — full output persisted/.test(preview) && hasMore)
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'BashTool', 'BashTool.tsx'), 'utf8')
  check('the Bash mapper builds its preview with generatePreview, never a head slice', /generatePreview\(stdout, PREVIEW_SIZE_CHARS\)/.test(src) && !/preview: stdout\.slice\(0, 2000\)/.test(src))
  // The second shell family is the same law, not a second spelling.
  const ps = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'PowerShellTool', 'PowerShellTool.tsx'), 'utf8')
  check('the PowerShell mapper builds its preview with generatePreview, never a head slice', /generatePreview\(stdout, PREVIEW_SIZE_CHARS\)/.test(ps) && !/preview: stdout\.slice\(0, 2000\)/.test(ps) && !/\.slice\(0, 2000\)/.test(ps))
  check('…imported from the one preview owner (toolResultStorage), beside the large-result message builder', /import \{[^}]*generatePreview[^}]*PREVIEW_SIZE_CHARS[^}]*\} from '\.\.\/\.\.\/utils\/toolResultStorage\.js'/.test(ps))
}

section('§2b the PowerShell family applies the in-memory head + tail cut Bash does')
{
  const ps = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'PowerShellTool', 'PowerShellTool.tsx'), 'utf8')
  const bash = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'BashTool', 'BashTool.tsx'), 'utf8')
  check('PowerShell imports formatOutput from the Bash utils (one cut, two shells)', /import \{[^}]*\bformatOutput\b[^}]*\} from '\.\.\/BashTool\/utils\.js'/.test(ps))
  check(
    '…and its settled result hands the model the formatOutput cut (spill-aware), never the raw accumulator',
    ps.includes('stdout: formatOutput(out, { preExcerpted: result.outputFilePath !== undefined }).truncatedContent,') &&
      !/^\s*stdout: out, stderr, interrupted: result\.interrupted, isImage,/m.test(ps),
  )
  check(
    'Bash still cuts the same way (the law has one owner: formatOutput, spill-aware)',
    bash.includes('const formatted = formatOutput(out, { preExcerpted: result.outputFilePath !== undefined })') && bash.includes('stdout: formatted.truncatedContent,'),
  )
  // POISON: the throw paths keep the raw output (an error's own text is the
  // verdict; the cut belongs to the settled result only) — on both shells.
  check('the error throws still carry the un-cut output on both shells', /throw new ShellError\(out, annotated, result\.code, result\.interrupted\)/.test(ps) && /throw new ShellError\('', out, result\.code, result\.interrupted\)/.test(bash))
}

section('§3 the notebook path still receives a bounded string')
{
  const cap = getMaxOutputLength()
  const out = formatOutput('n\n'.repeat(cap))
  check('bounded', out.truncatedContent.length <= cap + 200 && typeof out.truncatedContent === 'string')
}

section('§4 the spilled-file read keeps the head and the tail, and names the file')
{
  const { TaskOutput } = await import('../../src/utils/task/TaskOutput.ts')
  const { getTaskOutputPath } = await import('../../src/utils/task/diskOutput.ts')
  const { generateTaskId } = await import('../../src/Task.ts')
  const cap = getMaxOutputLength()
  const id = generateTaskId('local_bash')
  const path = getTaskOutputPath(id)
  mkdirSync(dirname(path), { recursive: true })
  const lines: string[] = []
  for (let i = 1; lines.join('\n').length < cap * 3; i++) lines.push(`line ${i}: ${'y'.repeat(40)}`)
  lines.push('FAIL src/thing.test.ts > the verdict lives at the tail')
  lines.push('Tests: 1 failed, 412 passed')
  const body = lines.join('\n')
  writeFileSync(path, body, 'utf8')
  const out = new TaskOutput(id, null, true)
  const read = await out.getStdout()
  // Re-toothed: the excerpt fits
  // the budget WHOLE, its own notice included — it used to come back over
  // the cap by the notice's length (cap+306 vs a cap+300 slack).
  check('the file read fits the cap, notice included', read.length <= cap, String(read.length))
  check('the FIRST line survives the spill read', read.startsWith('line 1:'))
  check('the LAST lines survive the spill read — the verdict reaches the model', read.endsWith('Tests: 1 failed, 412 passed') && read.includes('FAIL src/thing.test.ts'))
  check('exactly one middle notice, counting bytes and naming the file', (read.match(/truncated from the middle/g) ?? []).length === 1 && /\[\d+ bytes truncated from the middle[^\]]*saved at /.test(read) && read.includes(path))
  const noticeBytes = Number((/\[(\d+) bytes truncated/.exec(read) ?? [])[1] ?? '-1')
  check('the omitted count is the bytes not shown', noticeBytes > 0 && noticeBytes < Buffer.byteLength(body, 'utf8'))
  const noticeAt = read.indexOf('\n\n[')
  const beforeNotice = read.slice(0, noticeAt)
  const afterNotice = read.slice(read.indexOf(']\n\n', noticeAt) + 3)
  check('the head closes on a complete line (snapped to a newline)', /line \d+: y{40}$/.test(beforeNotice), JSON.stringify(beforeNotice.slice(-60)))
  check('the tail opens on a line start (snapped to a newline)', /^line \d+: y{40}/.test(afterNotice), JSON.stringify(afterNotice.slice(0, 60)))
  check('a stale head-only read shape is gone from TaskOutput', !/this\.fileRedundant = result\.bytesRead === result\.bytesTotal\n\s*this\.fileSize = result\.bytesTotal\n\s*return result\.content/.test(readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'task', 'TaskOutput.ts'), 'utf8')))
  // Under the cap the read is byte-identical and carries no notice.
  const smallId = generateTaskId('local_bash')
  const smallPath = getTaskOutputPath(smallId)
  writeFileSync(smallPath, 'a\nb\nc', 'utf8')
  const small = await new TaskOutput(smallId, null, true).getStdout()
  check('under the cap the spill read is byte-identical', small === 'a\nb\nc')
  rmSync(SCRATCH, { recursive: true, force: true })
}

section('§5 the second cut never eats the first cut’s honest notice')
{
  // A spilled result reaches the Bash mapper ALREADY excerpted by
  // TaskOutput: head + its true byte-count-and-path notice + tail, a hair
  // over the cap by that notice's own length. The pre-fix second cut
  // sliced the honest notice into its "middle" and REPLACED it with a
  // fabricated count of that slice — "[2 lines truncated]" for a run that
  // dropped ~59,500 lines (the 2 was the eaten notice's newline wrapper;
  // the box measured it verbatim on the 5,000- and 60,000-line runs).
  const cap = getMaxOutputLength()
  const spillPath = '/tmp/task-output/task-x.output'
  const upstreamNotice = `\n\n[123456 bytes truncated from the middle — the head and the tail of the output are shown; the complete output is saved at ${spillPath}]\n\n`
  const head = `line 1: ${'h'.repeat(40)}\n`.repeat(Math.ceil((cap * 0.6) / 49))
  const tail = `line N: ${'t'.repeat(40)}\n`.repeat(Math.ceil((cap * 0.4) / 49))
  const preExcerpted = head + upstreamNotice + tail
  check('the fixture is over the cap by about the notice (the box’s exact shape)', preExcerpted.length > cap && preExcerpted.length < cap + 600, String(preExcerpted.length))
  const kept = formatOutput(preExcerpted, { preExcerpted: true })
  check('a pre-excerpted result passes through WHOLE', kept.truncatedContent === preExcerpted)
  check('…so the upstream byte count and the spill path survive as the one notice', kept.truncatedContent.includes('123456 bytes truncated') && kept.truncatedContent.includes(spillPath) && !/\[\d+ lines? truncated from the middle/.test(kept.truncatedContent))
  // POISON (the pre-fix cut, kept as the mechanism's own witness): without
  // the flag the same string is re-cut, the honest notice lands in the new
  // middle and a tiny fabricated line count replaces it.
  const eaten = formatOutput(preExcerpted)
  check('the unflagged cut still demonstrates the disease it prevents', !eaten.truncatedContent.includes('123456 bytes truncated') && /\[\d+ lines? truncated from the middle/.test(eaten.truncatedContent))
}
// NEEDS-REAL-BOX (the reviewer's drill): the 60,000-line Bash run through
// `-p --output-format stream-json` — the tool result's one notice counts
// BYTES and names the spill file; no "[2 lines truncated]" appears.

section('§5 spill finalization never blocks the thread (awaited async, both twins)')
{
  // The off-lining block runs only for spilled (large-by-construction)
  // outputs, and its link fallback COPIES the file — a sync spelling froze
  // the whole cockpit for the copy's duration before the model continued.
  // Call-shaped: the sync verbs must not return, and the awaited road must
  // stay spelled out.
  for (const rel of ['src/tools/BashTool/BashTool.tsx', 'src/tools/PowerShellTool/PowerShellTool.tsx'] as const) {
    const src = readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')
    check(`${rel}: no sync stat/truncate/link/copy anywhere`, !/\b(?:statSync|truncateSync|linkSync|copyFileSync)\s*\(/.test(src))
    check(`${rel}: the off-lining block awaits its link and its copy fallback`, src.includes('await link(') && src.includes('await copyFile('))
  }
}

section('§6 one completion promise per command; the quiet timer dies on finish')
{
  // The progress loop races completion against progress every iteration —
  // one shared promise, or each tick piles another handler on the result;
  // and a command that beats the quiet window must clear the window's timer
  // (a burst of fast commands otherwise leaves a live timer behind each).
  for (const rel of ['src/tools/BashTool/BashTool.tsx', 'src/tools/PowerShellTool/PowerShellTool.tsx'] as const) {
    const src = readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')
    check(`${rel}: exactly ONE completion .then per run`, src.split(".then(() => 'done'").length === 2)
    check(`${rel}: the quiet timer is cleared when the command wins`, src.includes('clearTimeout(quietTimerHandle)'))
  }
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
