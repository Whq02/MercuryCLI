#!/usr/bin/env bun
import { plugin } from 'bun'
import { proofHome } from '../lib/hermetic.ts'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_SHELL_ENGINE
delete process.env.MERCURY_SHELL_MAX_OUTPUT
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'output-skipped-')))
process.env.MERCURY_TMPDIR = join(SCRATCH, 'tmp')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { PowerShellTool } = await import('../../src/tools/PowerShellTool/PowerShellTool.tsx')
const { stripEmptyLines, formatOutput } = await import('../../src/tools/BashTool/utils.ts')
const { generatePreview, persistToolResult, PREVIEW_SIZE_CHARS } = await import('../../src/utils/toolResultStorage.ts')
const { formatFileSize } = await import('../../src/utils/format.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { getScratchpadDir } = await import('../../src/utils/permissions/filesystem.ts')
const { TaskOutput } = await import('../../src/utils/task/TaskOutput.ts')
const { getTaskOutputPath } = await import('../../src/utils/task/diskOutput.ts')
const { generateTaskId } = await import('../../src/Task.ts')

let appState = getDefaultAppState()
const toolContext = {
  options: { engineModel: 'claude-sonnet-5', tools: [], commands: [], mcpClients: [], mcpResources: {} },
  readFileState: new Map(),
  getAppState: () => appState,
  setAppState: (update: (state: typeof appState) => typeof appState) => {
    appState = update(appState)
  },
  abortController: new AbortController(),
  toolUseId: 'output-skipped',
} as never
type Out = { stdout: string; persistedOutputPath?: string; persistedOutputSize?: number }
type Mapper = { mapToolResultToToolResultBlockParam: (output: never, id: string) => { content: unknown } }
type Caller = { call: (input: never, context: never) => Promise<{ data: unknown }> }
const contentOf = (tool: Mapper, out: unknown, id: string): string => {
  const block = tool.mapToolResultToToolResultBlockParam(out as never, id)
  return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
}
async function runBash(command: string): Promise<{ out: Out; content: string }> {
  const result = await (BashTool as unknown as Caller).call({ command } as never, toolContext)
  return { out: result.data as Out, content: contentOf(BashTool as unknown as Mapper, result.data, 'output-skipped') }
}

type Parts = { head: string; figure: string; tail: string }
type Notice = Parts & { header: string; path: string }
const NOPARTS: Parts = { head: '', figure: '', tail: '' }
const NONE: Notice = { ...NOPARTS, header: '', path: '' }
const MARKER = /\n\u2026 \[([^\]]+?) skipped \u2014 full output persisted\] \u2026\n/
function splitPreview(preview: string): Parts | null {
  const m = MARKER.exec(preview)
  if (m === null) return null
  return { head: preview.slice(0, m.index), figure: m[1] as string, tail: preview.slice(m.index + m[0].length) }
}
function parseNotice(content: string): Notice | null {
  const m = /<persisted-output>\nOutput too large \(([^)]+)\)\. Full output saved to: ([^\n]+)\n\nPreview \(head \+ tail, ~2000 chars; long lines clamped\):\n([\s\S]*?)\n<\/persisted-output>/.exec(content)
  if (m === null) return null
  const parts = splitPreview(m[3] as string)
  return parts === null ? null : { ...parts, header: m[1] as string, path: m[2] as string }
}

const UNIT: Record<string, number> = { bytes: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }
const sizeBytes = (words: string): number => {
  const m = /^([\d.]+) ?(bytes|KB|MB|GB)$/.exec(words)
  return m === null ? Number.NaN : Number(m[1]) * (UNIT[m[2] as string] as number)
}
const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8')
const shownOf = (parts: Parts): number => bytesOf(parts.head) + bytesOf(parts.tail)
const windowOf = (out: { stdout: string }): number => out.stdout.replace(/^\s*\n/g, '').trimEnd().length
const readText = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function figureChecks(prefix: string, n: Notice, fileBytes: number, windowChars: number): void {
  const shown = shownOf(n)
  const left = formatFileSize(fileBytes - shown)
  check(`${prefix}the header states the size of the whole output`, n.header === formatFileSize(fileBytes), `${n.header} vs ${formatFileSize(fileBytes)}`)
  check(`${prefix}the skipped figure is the output size less the head and the tail the preview shows (${left})`, n.figure === left, `${n.figure} vs ${left}`)
  check(`${prefix}the figure and the bytes shown add up to the header's size, to the format's rounding`, Math.abs(sizeBytes(n.header) - sizeBytes(n.figure) - shown) <= 110, `${n.header} - ${n.figure} vs ${shown} bytes shown`)
  check(`${prefix}the figure is not the gap inside the already-windowed text the preview was cut from`, n.figure !== formatFileSize(windowChars - n.head.length - n.tail.length), `${n.figure} is the gap inside a ${windowChars}-character window`)
}

section('§1 the Bash tool end to end on seq 1 50000, 288 894 bytes of output')
mkdirSync(getScratchpadDir(), { recursive: true })
const seqBody = Array.from({ length: 50_000 }, (_, i) => `${i + 1}\n`).join('')
const seq = await runBash('seq 1 50000')
const seqParsed = parseNotice(seq.content)
check('the result is a persisted-output notice: header, preview line, head, skip marker, tail', seqParsed !== null, seq.content.slice(0, 160))
const sn = seqParsed ?? NONE
const seqSaved = readText(sn.path)
check('the notice names a saved file that holds the whole output, all 288 894 bytes', seqSaved === seqBody && bytesOf(seqSaved) === 288_894, `${bytesOf(seqSaved)} bytes at ${sn.path}`)
check('the preview head is the first lines of the output and its tail the last lines', seqBody.startsWith(`${sn.head}\n`) && seqBody.endsWith(`${sn.tail}\n`) && sn.head.startsWith('1\n2\n3\n') && sn.tail.endsWith('\n49999\n50000'), `${JSON.stringify(sn.head.slice(0, 12))} .. ${JSON.stringify(sn.tail.slice(-14))}`)
check('the preview still shows about 2 000 characters, head and tail together', sn.head.length + sn.tail.length >= 1800 && sn.head.length + sn.tail.length <= PREVIEW_SIZE_CHARS, String(sn.head.length + sn.tail.length))
figureChecks('', sn, 288_894, windowOf(seq.out))

section('§2 the Bash tool on a multi-byte output: the figure is in bytes, the unit the header is in')
const wideBody = Array.from({ length: 3_000 }, (_, i) => `ligne ${String(i + 1).padStart(5, '0')}: d\u00e9j\u00e0 vu \u2014 na\u00efve caf\u00e9 \u2713 \u65e5\u672c\u8a9e\n`).join('')
const widePath = join(SCRATCH, 'multibyte.txt')
writeFileSync(widePath, wideBody, 'utf8')
const wide = await runBash(`cat "${widePath.replace(/\\/g, '/')}"`)
const widParsed = parseNotice(wide.content)
check('the result is a persisted-output notice', widParsed !== null, wide.content.slice(0, 160))
const wn = widParsed ?? NONE
check(`the notice names a saved file that holds the whole output, all ${bytesOf(wideBody)} bytes`, readText(wn.path) === wideBody, wn.path)
check('the preview head is the first lines of the output and its tail the last lines', wideBody.startsWith(`${wn.head}\n`) && wideBody.endsWith(`${wn.tail}\n`), `${JSON.stringify(wn.head.slice(0, 30))} .. ${JSON.stringify(wn.tail.slice(-30))}`)
figureChecks('', wn, bytesOf(wideBody), windowOf(wide.out))
check('the figure counts bytes, not UTF-16 units', wn.figure !== formatFileSize(wideBody.length - wn.head.length - wn.tail.length) && shownOf(wn) > wn.head.length + wn.tail.length, `${wn.figure}`)

section('§3 both shells on a spilled CRLF output, 1..50000 as PowerShell writes it (338 894 bytes)')
const crlfBody = Array.from({ length: 50_000 }, (_, i) => `${i + 1}\r\n`).join('')
const crlfId = generateTaskId('local_bash')
const crlfPath = getTaskOutputPath(crlfId)
mkdirSync(dirname(crlfPath), { recursive: true })
writeFileSync(crlfPath, crlfBody)
check('the fixture file is 338 894 bytes', statSync(crlfPath).size === 338_894, String(statSync(crlfPath).size))
const crlfWindow = await new TaskOutput(crlfId, null, true).getStdout()
const crlfOut = {
  stdout: formatOutput(stripEmptyLines(`${crlfWindow.trimEnd()}\n`), { preExcerpted: true }).truncatedContent,
  stderr: '',
  interrupted: false,
  persistedOutputPath: crlfPath,
  persistedOutputSize: statSync(crlfPath).size,
}
check('the spill reader hands the tool a window of about 30 000 characters, line ends already normalised', crlfOut.stdout.length > 20_000 && crlfOut.stdout.length < 30_000 && !crlfOut.stdout.includes('\r'), String(crlfOut.stdout.length))
for (const [name, tool] of [['Bash', BashTool], ['PowerShell', PowerShellTool]] as const) {
  const parsed = parseNotice(contentOf(tool as unknown as Mapper, crlfOut, `crlf-${name}`))
  check(`${name}: the result is a persisted-output notice`, parsed !== null)
  const cn = parsed ?? NONE
  const headRaw = cn.head.replace(/\n/g, '\r\n')
  const tailRaw = cn.tail.replace(/\n/g, '\r\n')
  check(`${name}: the preview head and tail are the first and last lines of the output`, crlfBody.startsWith(`${headRaw}\r\n`) && crlfBody.endsWith(`${tailRaw}\r\n`), `${JSON.stringify(cn.head.slice(0, 12))} .. ${JSON.stringify(cn.tail.slice(-14))}`)
  figureChecks(`${name}: `, cn, 338_894, windowOf(crlfOut))
  const leftOut = 338_894 - bytesOf(headRaw) - bytesOf(tailRaw)
  check(`${name}: the figure is within 1 KB of the bytes the preview leaves out of the CRLF file (the shown lines' carriage returns are the only difference)`, Math.abs(sizeBytes(cn.figure) - leftOut) <= 1024, `${cn.figure} vs ${leftOut} bytes`)
}

section('§4 generatePreview: the third argument is the size of the output the content was cut from')
const rows = Array.from({ length: 5_000 }, (_, i) => `row ${String(i).padStart(4, '0')}`).join('\n')
const bare = splitPreview(generatePreview(rows, PREVIEW_SIZE_CHARS).preview) ?? NOPARTS
check('without the size the figure is the gap in the content itself, as the persist road has always stated it', bare.figure === formatFileSize(rows.length - bare.head.length - bare.tail.length), bare.figure)
const persisted = await persistToolResult(rows, 'output-skipped-whole')
const persistedParts = 'error' in persisted ? NOPARTS : (splitPreview(persisted.preview) ?? NOPARTS)
check('the persist road, which holds the whole content, still states the size less the head and the tail', !('error' in persisted) && persistedParts.figure === formatFileSize(persisted.originalSize - shownOf(persistedParts)), persistedParts.figure)
const sized = splitPreview(generatePreview(rows, PREVIEW_SIZE_CHARS, 1_000_000).preview) ?? NOPARTS
check('given the output size the figure is that size less the head and the tail shown', sized.figure === formatFileSize(1_000_000 - shownOf(sized)), sized.figure)
const kanji = splitPreview(generatePreview('\u6f22'.repeat(6_000), PREVIEW_SIZE_CHARS, 18_000).preview) ?? NOPARTS
check('the figure is in bytes: 1 200 + 800 three-byte characters shown of 18 000 bytes leave 11.7KB', kanji.figure === '11.7KB', kanji.figure)
const floored = splitPreview(generatePreview(rows, PREVIEW_SIZE_CHARS, 10).preview) ?? NOPARTS
check('a size smaller than what the preview shows reads 0 bytes, never a negative', floored.figure === '0 bytes', floored.figure)
const short = generatePreview('short text', PREVIEW_SIZE_CHARS, 999_999)
check('content that fits the preview is shown whole with no skip marker, whatever size is given', short.preview === 'short text' && short.hasMore === false, JSON.stringify(short))

for (const dir of [SCRATCH, proofHome]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    continue
  }
}
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
