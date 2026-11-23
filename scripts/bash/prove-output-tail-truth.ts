#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-tail-truth-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'config')
process.env.MERCURY_TMPDIR = join(SCRATCH, 'tmp')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })

let failures = 0
let checks = 0
const WHERE_BY_SECTION: Record<string, string> = {
  '1': 'change formatOutput in src/platform/shell/shellOutput.ts (head, tail and one middle notice)',
  '2': 'change generatePreview in src/engine/tool-dispatch/toolResultStorage.ts (head and tail preview)',
  '3': 'change formatOutput in src/platform/shell/shellOutput.ts so its result stays a bounded string',
  '4': 'change how TaskOutput.getStdout in src/engine/task-framework/taskOutput.ts reads a spilled file',
  '5': 'change the preExcerpted handling of formatOutput in src/platform/shell/shellOutput.ts',
  '7': 'change resizeShellImageOutput in src/platform/shell/shellOutput.ts (async size gate, no sync read)',
}
let sectionKey = ''
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} — ` : ''}to fix: ${WHERE_BY_SECTION[sectionKey] ?? ''}` : ''}`)
}
const section = (t: string): void => {
  sectionKey = /^§(\d+)/.exec(t)?.[1] ?? sectionKey
  console.log('\n' + '─'.repeat(72) + '\n' + t)
}

delete process.env.MERCURY_SHELL_MAX_OUTPUT
const { formatOutput } = await import('../../src/platform/shell/shellOutput.ts')
const { getMaxOutputLength } = await import('../../src/platform/shell/outputLimits.ts')
const { generatePreview, PREVIEW_SIZE_CHARS } = await import('../../src/engine/tool-dispatch/toolResultStorage.ts')

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
}


section('§3 the notebook path still receives a bounded string')
{
  const cap = getMaxOutputLength()
  const out = formatOutput('n\n'.repeat(cap))
  check('bounded', out.truncatedContent.length <= cap + 200 && typeof out.truncatedContent === 'string')
}

section('§4 the spilled-file read keeps the head and the tail, and names the file')
{
  const { TaskOutput } = await import('../../src/engine/task-framework/taskOutput.ts')
  const { getTaskOutputPath } = await import('../../src/engine/task-framework/diskOutput.ts')
  const { generateTaskId } = await import('../../src/engine/tasks/taskBase.ts')
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
  const smallId = generateTaskId('local_bash')
  const smallPath = getTaskOutputPath(smallId)
  writeFileSync(smallPath, 'a\nb\nc', 'utf8')
  const small = await new TaskOutput(smallId, null, true).getStdout()
  check('under the cap the spill read is byte-identical', small === 'a\nb\nc')
  rmSync(SCRATCH, { recursive: true, force: true })
}

section('§5 the second cut never eats the first cut’s honest notice')
{
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
  const eaten = formatOutput(preExcerpted)
  check('the unflagged cut still demonstrates the disease it prevents', !eaten.truncatedContent.includes('123456 bytes truncated') && /\[\d+ lines? truncated from the middle/.test(eaten.truncatedContent))
}



section('§7 the shell-image read is awaited — never a sync read on the tool’s async road')
{
  const { resizeShellImageOutput } = await import('../../src/platform/shell/shellOutput.ts')
  const dir = mkdtempSync(join(tmpdir(), 'shell-image-'))
  const big = join(dir, 'big.output')
  writeFileSync(big, '')
  truncateSync(big, 21 * 1024 * 1024)
  check('an over-cap spill file answers null through the size gate (a stat, never a read)', (await resizeShellImageOutput('data:image/png;base64,AAAA', big, undefined)) === null)
  check('a caller-provided size takes the same gate without touching the file', (await resizeShellImageOutput('data:image/png;base64,AAAA', join(dir, 'absent.output'), 21 * 1024 * 1024)) === null)
  check('a non-image stdout answers null', (await resizeShellImageOutput('plain text', undefined, undefined)) === null)
  let rejected = false
  try {
    await resizeShellImageOutput('data:image/png;base64,AAAA', join(dir, 'absent.output'), undefined)
  } catch {
    rejected = true
  }
  check('a vanished spill file still rejects (the sync shape threw — drop-in parity)', rejected)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  const spill = join(dir, 'image.output')
  writeFileSync(spill, `data:image/png;base64,${png.toString('base64')}`)
  const out = await resizeShellImageOutput('data:image/png;base64,TRUNCATED', spill, undefined)
  check('the spill file, not the capped stdout, is what gets decoded and re-encoded', typeof out === 'string' && out.startsWith('data:image/png;base64,') && Buffer.from(out.slice('data:image/png;base64,'.length), 'base64').equals(png), typeof out === 'string' ? out.slice(0, 40) : String(out))
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
