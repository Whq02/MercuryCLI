#!/usr/bin/env bun
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
delete process.env.BASH_MAX_OUTPUT_LENGTH
if (!(process.env.SHELL ?? '').includes('bash') && existsSync('/bin/bash')) process.env.SHELL = '/bin/bash'
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'output-budget-')))
process.env.MERCURY_TMPDIR = join(SCRATCH, 'tmp')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })
const SHIM_DIR = join(SCRATCH, 'pwsh-shim')
mkdirSync(SHIM_DIR)
writeFileSync(join(SHIM_DIR, 'pwsh'), [
  '#!/bin/bash',
  'assembled=$4',
  "body=${assembled#*$'\\n'}",
  "body=${body#*$'\\n'}",
  "body=${body%$'\\n; $mc = '*}",
  "record=${assembled##*WriteAllText(\\'}",
  "record=${record%%\\'*}",
  '/bin/bash -c "$body"',
  'code=$?',
  'printf \'%s\' "$PWD" > "$record"',
  'exit $code',
  '',
].join('\n'))
chmodSync(join(SHIM_DIR, 'pwsh'), 0o755)
process.env.PATH = `${SHIM_DIR}:${process.env.PATH ?? ''}`

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

const limits = (await import('../../src/utils/shell/outputLimits.ts')) as Record<string, unknown>
const getMaxOutputLength = limits.getMaxOutputLength as () => number
const cap = getMaxOutputLength()
const defaultCap = limits.BASH_MAX_OUTPUT_DEFAULT as number
const floor = typeof limits.BASH_MAX_OUTPUT_FLOOR === 'number' ? (limits.BASH_MAX_OUTPUT_FLOOR as number) : NaN
type Budget = { effective: number; requested?: number; clampedTo?: string }
const resolveOutputBudget = limits.resolveOutputBudget as ((requested: number | undefined) => Budget) | undefined
const bashUtils = (await import('../../src/tools/BashTool/utils.ts')) as Record<string, unknown>
const formatOutput = bashUtils.formatOutput as (content: string, opts?: { preExcerpted?: boolean; maxLength?: number }) => { totalLines: number; truncatedContent: string }
const outputBudgetClause = bashUtils.outputBudgetClause as (budget: Budget) => string | undefined
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { normalizeToolInput } = await import('../../src/utils/api.ts')
const { getSimplePrompt } = await import('../../src/tools/BashTool/prompt.ts')
const { getScratchpadDir } = await import('../../src/utils/permissions/filesystem.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const toolErrors = (await import('../../src/utils/toolErrors.ts')) as Record<string, unknown>
const formatError = toolErrors.formatError as (error: unknown) => string
const formatZodValidationError = toolErrors.formatZodValidationError as (toolName: string, error: unknown, inputSchema?: unknown) => string
const windowedError = toolErrors.windowedError as (<E extends Error>(error: E) => E) | undefined
const cutAroundSpillNotice = toolErrors.cutAroundSpillNotice as ((content: string, maxLength: number) => string | null) | undefined
const { ShellError } = await import('../../src/utils/errors.ts')

const LINE_WIDTH = 50
const VERDICT = 'Tests: 1 failed, 412 passed'.padEnd(LINE_WIDTH - 1, '.')
function makeBody(bytesWithNewline: number): string {
  const count = Math.floor(bytesWithNewline / LINE_WIDTH)
  const lines: string[] = []
  for (let i = 1; i < count; i++) lines.push(`line ${String(i).padStart(5, '0')}: ${'x'.repeat(LINE_WIDTH - 13)}`)
  lines.push(VERDICT)
  return lines.join('\n')
}
const lineCount = (text: string): number => text.split('\n').length
const bare = (text: string): string => text.replace(/\n\[session env scrubbed[^\n]*\]$/, '')
const thirtyK = makeBody(30_000)
check('the fixture is a 30 000-byte output once its final newline is counted', thirtyK.length === 29_999 && lineCount(thirtyK) === 600 && thirtyK.length <= cap, String(thirtyK.length))

section('§1 the schema and the wire: max_output_chars is a lawful optional field')
type Parsed = { success: boolean; data?: { max_output_chars?: number }; error?: { issues: { message: string }[] } }
const schema = BashTool.inputSchema as unknown as { safeParse: (value: unknown) => Parsed }
const accepted = schema.safeParse({ command: 'true', max_output_chars: 2000 })
check('the strict schema accepts max_output_chars: 2000', accepted.success && accepted.data?.max_output_chars === 2000, accepted.success ? JSON.stringify(accepted.data) : (accepted.error?.issues ?? []).map(i => i.message).join('; '))
const quoted = schema.safeParse({ command: 'true', max_output_chars: '2000' })
check('a quoted decimal literal coerces the way timeout does', quoted.success && quoted.data?.max_output_chars === 2000, quoted.success ? JSON.stringify(quoted.data) : (quoted.error?.issues ?? []).map(i => i.message).join('; '))
for (const bad of [0, -5, 2.5, 'ten']) check(`a value with no lawful reading keeps a typed refusal (${JSON.stringify(bad)})`, !schema.safeParse({ command: 'true', max_output_chars: bad }).success)
check('omitted stays lawful', schema.safeParse({ command: 'true' }).success)
const json = BashTool.inputJSONSchema as unknown as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
const projected = json.properties?.max_output_chars
check('the JSON projection carries the field as an optional integer', projected?.type === 'integer' && !(json.required ?? []).includes('max_output_chars'), JSON.stringify(projected))
check('its description names the cap, the floor and the clamp', (projected?.description ?? '').includes(String(cap)) && (projected?.description ?? '').includes(String(floor)) && /clamp/.test(projected?.description ?? ''), projected?.description ?? '(absent)')
let normalized: Record<string, unknown> | null = null
let normalizeError = ''
try {
  normalized = normalizeToolInput(BashTool as never, { command: 'true', max_output_chars: 2000 }) as Record<string, unknown>
} catch (error) {
  normalizeError = String(error).replace(/\s+/g, ' ').slice(0, 160)
}
check('the tool-input normaliser keeps max_output_chars on its way to execution', normalized?.max_output_chars === 2000, normalizeError || JSON.stringify(normalized))
const prompt = getSimplePrompt(null)
check('the Bash prompt tells the model when to use the field', prompt.includes('`max_output_chars`') && /huge log|only the (beginning|head) and the (verdict|tail)/i.test(prompt))

section('§2 the format honours a per-call window: head + tail around the middle notice, the true line count')
const cut = formatOutput(thirtyK, { maxLength: 2000 })
check('a 30 000-character output under a 2 000 window comes back about 2 000 characters', cut.truncatedContent.length >= 1500 && cut.truncatedContent.length <= 2200, String(cut.truncatedContent.length))
check('the head survives', cut.truncatedContent.startsWith('line 00001:'))
check('the tail — the verdict — survives', cut.truncatedContent.endsWith(VERDICT))
const notices = cut.truncatedContent.match(/\[(\d+) lines? truncated from the middle — the head and the tail of the output are shown\]/g) ?? []
check('exactly one middle notice, today’s wording', notices.length === 1, cut.truncatedContent.slice(0, 200))
check('the total line count is the true count of the whole output', cut.totalLines === 600, String(cut.totalLines))
const shownLines = cut.truncatedContent.split('\n').filter(line => line.startsWith('line ') || line === VERDICT).length
const dropped = Number((/\[(\d+) lines? truncated/.exec(cut.truncatedContent) ?? [])[1] ?? '-1')
check('the notice counts exactly the lines not shown', dropped > 0 && shownLines + dropped === 600, `${shownLines} shown + ${dropped} dropped`)
check('omitted keeps today’s bytes byte for byte', formatOutput(thirtyK).truncatedContent === thirtyK && formatOutput(thirtyK).totalLines === 600)
check('the cap as the window is byte-identical to omitted', formatOutput(thirtyK, { maxLength: cap }).truncatedContent === thirtyK)
const preExcerpted = `${'h'.repeat(100)}\n\n[123 bytes truncated from the middle — saved at /x.output]\n\n${'t'.repeat(100)}`
check('a spilled (pre-excerpted) result still passes through whole, whatever the window', formatOutput(preExcerpted, { preExcerpted: true, maxLength: 64 }).truncatedContent === preExcerpted)

section('§3 the resolver: clamped to the operator’s cap and to the floor, and says which')
check('the floor is one named constant, above the notice and below the default cap', Number.isInteger(floor) && floor >= 256 && floor < defaultCap, String(floor))
check('omitted resolves to the cap, unclamped', resolveOutputBudget?.(undefined).effective === cap && resolveOutputBudget?.(undefined).clampedTo === undefined, JSON.stringify(resolveOutputBudget?.(undefined)))
check('2000 resolves to 2000, unclamped', resolveOutputBudget?.(2000).effective === 2000 && resolveOutputBudget?.(2000).clampedTo === undefined)
check('999999 clamps to the cap and says maximum', resolveOutputBudget?.(999_999).effective === cap && resolveOutputBudget?.(999_999).clampedTo === 'maximum', JSON.stringify(resolveOutputBudget?.(999_999)))
check('10 clamps up to the floor and says minimum', resolveOutputBudget?.(10).effective === floor && resolveOutputBudget?.(10).clampedTo === 'minimum', JSON.stringify(resolveOutputBudget?.(10)))
check('the cap itself and the floor itself pass unclamped', resolveOutputBudget?.(cap).clampedTo === undefined && resolveOutputBudget?.(floor).clampedTo === undefined)
check('the resolver reads numbers only — a raw string is not its business', resolveOutputBudget?.('2000' as never).requested === undefined && resolveOutputBudget?.('2000' as never).effective === cap)
process.env.BASH_MAX_OUTPUT_LENGTH = '100'
check('an operator cap under the floor lowers the floor to it (the cap is the law)', resolveOutputBudget?.(10).effective === 100 && resolveOutputBudget?.(10).clampedTo === 'minimum' && resolveOutputBudget?.(2000).effective === 100 && resolveOutputBudget?.(2000).clampedTo === 'maximum', JSON.stringify(resolveOutputBudget?.(10)))
delete process.env.BASH_MAX_OUTPUT_LENGTH

section('§4 the Bash tool end to end on the system shell: the inline window, the clause, today’s bytes')
let appState = getDefaultAppState()
const toolContext = {
  options: { mainLoopModel: 'claude-sonnet-5', tools: [], commands: [], mcpClients: [], mcpResources: {} },
  readFileState: new Map(),
  getAppState: () => appState,
  setAppState: (update: (state: typeof appState) => typeof appState) => {
    appState = update(appState)
  },
  abortController: new AbortController(),
  toolUseId: 'output-budget',
} as never
type Out = { stdout: string; persistedOutputPath?: string; persistedOutputSize?: number }
type ShellTool = { call: (input: never, context: never) => Promise<{ data: unknown }>; mapToolResultToToolResultBlockParam: (output: never, id: string) => { content: unknown }; validateInput: (input: never, context: never) => Promise<unknown> }
async function runWith(tool: ShellTool, input: Record<string, unknown>): Promise<{ out: Out; content: string }> {
  const result = await tool.call(input as never, toolContext)
  const block = tool.mapToolResultToToolResultBlockParam(result.data as never, 'output-budget')
  return { out: result.data as Out, content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }
}
const run = (input: Record<string, unknown>): Promise<{ out: Out; content: string }> => runWith(BashTool as unknown as ShellTool, input)
const fixture = join(SCRATCH, 'thirty-k.txt')
writeFileSync(fixture, `${thirtyK}\n`)
check('the fixture file is exactly 30 000 bytes', statSync(fixture).size === 30_000, String(statSync(fixture).size))
const command = `cat ${JSON.stringify(fixture)}`
const budgeted = await run({ command, max_output_chars: 2000 })
check('max_output_chars: 2000 → the inline result is about 2 000 characters', budgeted.out.stdout.length >= 1500 && budgeted.out.stdout.length <= 2200, `${budgeted.out.stdout.length} chars`)
check('…head and tail around one middle notice', budgeted.out.stdout.startsWith('line 00001:') && budgeted.out.stdout.endsWith(VERDICT) && (budgeted.out.stdout.match(/truncated from the middle/g) ?? []).length === 1, budgeted.out.stdout.slice(0, 120))
check('…the output fit the cap, so nothing was spilled and no file is named', budgeted.out.persistedOutputPath === undefined)
check('…and no clamp clause (2000 lies within the window)', !/clamped to/.test(budgeted.content))
const plain = await run({ command })
check('omitted keeps today’s bytes byte for byte', plain.out.stdout === thirtyK, `${plain.out.stdout.length} chars`)
check('…and carries no clause', !/max_output_chars/.test(plain.content))
const over = await run({ command, max_output_chars: 999_999 })
check('a value above the cap clamps to it: the bytes are those of the omitted call', over.out.stdout === plain.out.stdout, `${over.out.stdout.length} chars`)
const overClause = `[max_output_chars clamped to ${cap} chars (the maximum)]`
const underClause = `[max_output_chars clamped to ${floor} chars (the minimum)]`
check('…and the result says so in one clause', over.content.includes(overClause), over.content.slice(-240))
const under = await run({ command, max_output_chars: 10 })
check('a value below the floor clamps up: a floor-sized window', under.out.stdout.length >= floor / 2 && under.out.stdout.length <= floor + 200, `${under.out.stdout.length} chars`)
check('…and the result says so in one clause', under.content.includes(underClause), under.content.slice(-240))
check('…still the head, the notice and the verdict', under.out.stdout.startsWith('line 00001:') && under.out.stdout.endsWith(VERDICT) && /truncated from the middle/.test(under.out.stdout), `${under.out.stdout.slice(0, 80)} … ${under.out.stdout.slice(-60)}`)
const rawQuoted = await run({ command, max_output_chars: '2000' })
check('a raw quoted "2000" handed straight to the tool (the serve road parses nothing) still gets the window', rawQuoted.out.stdout.length >= 1500 && rawQuoted.out.stdout.length <= 2200 && !/clamped to/.test(rawQuoted.content), `${rawQuoted.out.stdout.length} chars`)
const rawDecimal = await run({ command, max_output_chars: '2000.0' })
check('a raw "2000.0" reads as the schema reads it: 2000', rawDecimal.out.stdout.length >= 1500 && rawDecimal.out.stdout.length <= 2200 && !/clamped to/.test(rawDecimal.content), `${rawDecimal.out.stdout.length} chars`)
type Verdict = { result: boolean; message?: string }
const validateWith = async (tool: ShellTool, value: unknown): Promise<Verdict> => (await tool.validateInput({ command: 'true', max_output_chars: value } as never, toolContext)) as Verdict
const validate = (value: unknown): Promise<Verdict> => validateWith(BashTool as unknown as ShellTool, value)
for (const [raw, word] of [[' 2000 ', /string/], ['0', />0|greater than 0/], ['-5', />0|greater than 0/], ['2.5', /int/], ['ten', /string/]] as const) {
  const verdict = await validate(raw)
  check(`the serve road’s refusal channel (validateInput) refuses a raw ${JSON.stringify(raw)} exactly as the schema does`, verdict.result === false && (verdict.message ?? '').startsWith('max_output_chars: ') && word.test(verdict.message ?? ''), JSON.stringify(verdict))
}
check('…and admits what the schema admits', (await validate('2000.0')).result === true && (await validate(2000)).result === true && (await validate(undefined)).result === true)

section('§4b a FAILING command (the error road) takes the same window and the same clause')
const failing = `cat ${JSON.stringify(fixture)}; exit 3`
type Thrown = { text: string; stdout: string; model: string }
async function failWith(tool: ShellTool, input: Record<string, unknown>): Promise<Thrown> {
  try {
    await tool.call(input as never, toolContext)
  } catch (error) {
    return { text: String((error as { stderr?: string }).stderr ?? ''), stdout: String((error as { stdout?: string }).stdout ?? ''), model: formatError(error) }
  }
  return { text: '(no throw)', stdout: '(no throw)', model: '(no throw)' }
}
const fail = (input: Record<string, unknown>): Promise<Thrown> => failWith(BashTool as unknown as ShellTool, input)
const expectedRaw = `${thirtyK}\n\nExited with code 3`
const failPlain = await fail({ command: failing })
const failSuffix = failPlain.text.startsWith(expectedRaw) ? failPlain.text.slice(expectedRaw.length) : '(prefix differs)'
check('omitted keeps today’s thrown bytes: the whole output, the exit line, no notice, no clause', failPlain.text.startsWith(expectedRaw) && (failSuffix === '' || /session env/i.test(failSuffix)) && !/truncated from the middle|max_output_chars/.test(failPlain.text), `${failPlain.text.length} chars; suffix ${JSON.stringify(failSuffix.slice(0, 80))}`)
check('…and the model text is today’s fixed error window (head, a removed-characters marker, tail)', failPlain.model.length > 10_000 && failPlain.model.length < 10_200 && /characters removed/.test(failPlain.model), `${failPlain.model.length} chars`)
const failBudgeted = await fail({ command: failing, max_output_chars: 2000 })
check('max_output_chars: 2000 → the thrown text is about 2 000 characters', failBudgeted.text.length >= 1500 && failBudgeted.text.length <= 2300, `${failBudgeted.text.length} chars`)
check('…head, one middle notice, and the exit line at the tail', failBudgeted.text.startsWith('line 00001:') && (failBudgeted.text.match(/truncated from the middle/g) ?? []).length === 1 && /Exited with code 3/.test(failBudgeted.text) && !/clamped to/.test(failBudgeted.text), `${failBudgeted.text.slice(0, 80)} … ${failBudgeted.text.slice(-80)}`)
check('…and the model text carries it whole — no fixed-window marker', failBudgeted.model.length < 2500 && !/characters removed/.test(failBudgeted.model) && /exit code 3/.test(failBudgeted.model), `${failBudgeted.model.length} chars`)
const failOver = await fail({ command: failing, max_output_chars: 999_999 })
check('a value above the cap on the error road: the cap is the window (this fixture plus its exit line is 19 characters over it, so one line goes with a notice), then the clause', failOver.text.startsWith('line 00001:') && (failOver.text.match(/\[1 line truncated from the middle/g) ?? []).length === 1 && /Exited with code 3/.test(failOver.text) && failOver.text.endsWith(`${overClause}${failSuffix}`) && failOver.text.length <= cap + 200 + overClause.length + failSuffix.length, `${failOver.text.length} chars; tail ${JSON.stringify(failOver.text.slice(-120))}`)
const failUnder = await fail({ command: failing, max_output_chars: 10 })
check('a value below the floor on the error road: a floor-sized window plus the clause', failUnder.text.length >= floor / 2 && failUnder.text.length <= floor + 260 && failUnder.text.includes(underClause) && /truncated from the middle/.test(failUnder.text) && /Exited with code 3/.test(failUnder.text), `${failUnder.text.length} chars; tail ${JSON.stringify(failUnder.text.slice(-160))}`)

section('§4c the error window honours the budget: a window above the fixed 10 000 holds through formatError, up to the cap')
const failWide = await fail({ command: failing, max_output_chars: 20_000 })
check('max_output_chars: 20000 on a 30 000-character failing command → the thrown text is about 20 000 characters', failWide.text.length >= 19_500 && failWide.text.length <= 20_300, `${failWide.text.length} chars`)
check('…and the model text carries it whole: head, one middle notice, the exit line — no fixed-window marker', failWide.model.length >= 19_500 && failWide.model.length <= 20_400 && !/characters removed/.test(failWide.model) && (failWide.model.match(/truncated from the middle/g) ?? []).length === 1 && /Exited with code 3/.test(failWide.model), `${failWide.model.length} chars`)
check('a value above the cap on the error road: the model text is the whole cap-sized window plus the clause, once', failOver.model.length >= cap - 300 && failOver.model.length <= cap + 400 && !/characters removed/.test(failOver.model) && (failOver.model.match(/clamped to/g) ?? []).length === 1, `${failOver.model.length} chars`)
const twelveK = makeBody(12_000)
const twelveFixture = join(SCRATCH, 'twelve-k.txt')
writeFileSync(twelveFixture, `${twelveK}\n`)
const failFits = await fail({ command: `cat ${JSON.stringify(twelveFixture)}; exit 3`, max_output_chars: 15_000 })
check('a 15 000 window over a 12 000-character failing output: the whole text, no notice, no marker (the window holds even when nothing was cut)', failFits.model.length > 12_000 && failFits.model.length < 12_400 && !/truncated from the middle|characters removed/.test(failFits.model) && bare(failFits.model).endsWith('Exited with code 3'), `${failFits.model.length} chars`)
check('omitted on the error road still takes today’s fixed window (no budget asked, none applied)', failPlain.model.length > 10_000 && failPlain.model.length < 10_200 && /characters removed/.test(failPlain.model), `${failPlain.model.length} chars`)

section('§5 the spill road is untouched: the file holds the whole output; the excerpt and its notice are today’s')
mkdirSync(getScratchpadDir(), { recursive: true })
const big = makeBody(cap * 3)
const bigFixture = join(SCRATCH, 'over-cap.txt')
writeFileSync(bigFixture, `${big}\n`)
const bigCommand = `cat ${JSON.stringify(bigFixture)}`
const spilled = await run({ command: bigCommand, max_output_chars: 2000 })
check('an output over the cap is persisted, and the persisted file holds the WHOLE output', spilled.out.persistedOutputPath !== undefined && readFileSync(spilled.out.persistedOutputPath, 'utf8') === `${big}\n`, spilled.out.persistedOutputPath ?? '(no path)')
check('the excerpt is the spill sink’s own: bytes counted, the file named, within the cap', /\[\d+ bytes truncated from the middle[^\]]*saved at /.test(spilled.out.stdout) && spilled.out.stdout.length <= cap, `${spilled.out.stdout.length} chars`)
check('the model’s result is the persisted-output message with its head + tail preview', spilled.content.includes('Full output saved to:') && spilled.content.includes('Preview (head + tail'), spilled.content.slice(0, 200))
const spilledPlain = await run({ command: bigCommand })
const withoutPaths = (text: string): string => text.replace(/\S+\.output/g, 'PATH')
check('…byte-identical to the same call without the field, but for the task id in the path', withoutPaths(spilledPlain.out.stdout) === withoutPaths(spilled.out.stdout), `${spilledPlain.out.stdout.length} vs ${spilled.out.stdout.length}`)
const spilledOver = await run({ command: bigCommand, max_output_chars: 999_999 })
check('a value above the cap on the spill road adds no clause: the window played no part', !/clamped to/.test(spilledOver.content) && withoutPaths(spilledOver.out.stdout) === withoutPaths(spilledPlain.out.stdout), spilledOver.content.slice(-200))

section('§5b a FAILING command over the cap: the thrown text takes the window and keeps the spill notice with its path — and so does the model text, at any budget')
const { TaskOutput } = await import('../../src/utils/task/TaskOutput.ts')
const bigFailing = `${bigCommand}; exit 3`
const SPILL_NOTICE = /\n\n\[(\d+) bytes truncated from the middle — the head and the tail of the output are shown; the complete output is saved at ([^\n]*?\.output)\]\n\n/
const HEADLINE = 'Shell command failed (exit code 3)\n'
async function sinkExcerpt(text: string): Promise<string> {
  const path = SPILL_NOTICE.exec(text)?.[2] ?? ''
  const taskId = path.slice(path.lastIndexOf('/') + 1, -'.output'.length)
  return await new TaskOutput(taskId, null, true).getStdout()
}
function shownBytes(text: string, notice: RegExpExecArray): number {
  const output = text.slice(0, notice.index) + text.slice(notice.index + notice[0].length)
  return Buffer.byteLength(bare(output).replace(/\nExited with code 3$/, '').replace(HEADLINE, ''), 'utf8')
}
const bigFailPlain = await fail({ command: bigFailing })
const sinkOwn = await sinkExcerpt(bigFailPlain.text)
check('omitted keeps today’s thrown bytes: the spill sink’s own excerpt (re-read from its file), then the exit line, nothing else', sinkOwn.length > 0 && bigFailPlain.text === `${sinkOwn.trimEnd()}\n\nExited with code 3`, `${bigFailPlain.text.length} chars vs sink ${sinkOwn.length}`)
const plainNotice = SPILL_NOTICE.exec(bigFailPlain.model)
const noticeLength = (notice: RegExpExecArray | null): number => notice?.[0].length ?? 0
check('…and the model text, cut to the fixed error window, keeps the spill notice with its path (the path is never cut away)', bigFailPlain.model.length > 9_000 && bigFailPlain.model.length < 10_200 + noticeLength(plainNotice) && plainNotice !== null && existsSync(plainNotice?.[2] ?? '') && !/characters removed/.test(bigFailPlain.model) && bigFailPlain.model.startsWith(`${HEADLINE}line 00001:`) && bare(bigFailPlain.model).endsWith('Exited with code 3'), `${bigFailPlain.model.length} chars; ${JSON.stringify(bigFailPlain.model.slice(4_990, 5_060))}`)
if (plainNotice !== null) check('…with an honest count: shown bytes + the count = the whole 90 000-byte output', shownBytes(bigFailPlain.model, plainNotice) + Number(plainNotice[1]) === 90_000, `${shownBytes(bigFailPlain.model, plainNotice)} shown + ${plainNotice[1]}`)
const bigFailBudgeted = await fail({ command: bigFailing, max_output_chars: 2000 })
const budgetedNotice = SPILL_NOTICE.exec(bigFailBudgeted.text)
check('max_output_chars: 2000 → the thrown text is about 2 000 characters', bigFailBudgeted.text.length >= 1500 && bigFailBudgeted.text.length <= 2200 + noticeLength(budgetedNotice), `${bigFailBudgeted.text.length} chars`)
check('…the head, ONE middle notice — the spill sink’s own, its path kept — and the exit line at the tail', bigFailBudgeted.text.startsWith('line 00001:') && budgetedNotice !== null && (bigFailBudgeted.text.match(/truncated from the middle/g) ?? []).length === 1 && existsSync(budgetedNotice?.[2] ?? '') && bigFailBudgeted.text.endsWith('\n\nExited with code 3') && !/clamped to/.test(bigFailBudgeted.text), `${bigFailBudgeted.text.slice(0, 60)} … ${bigFailBudgeted.text.slice(-200)}`)
if (budgetedNotice !== null) check('…and the notice’s byte count is honest: shown bytes + the count = the whole 90 000-byte output', shownBytes(bigFailBudgeted.text, budgetedNotice) + Number(budgetedNotice[1]) === 90_000, `${shownBytes(bigFailBudgeted.text, budgetedNotice)} shown + ${budgetedNotice[1]}`)
check('…and the model text carries it whole, with the path — no fixed-window marker', bigFailBudgeted.model.length < 2300 + noticeLength(budgetedNotice) && !/characters removed/.test(bigFailBudgeted.model) && /saved at .*\.output/.test(bigFailBudgeted.model) && /exit code 3/.test(bigFailBudgeted.model), `${bigFailBudgeted.model.length} chars`)
const bigFailWide = await fail({ command: bigFailing, max_output_chars: 20_000 })
const wideNotice = SPILL_NOTICE.exec(bigFailWide.model)
check('max_output_chars: 20000 on this road → the model text is about 20 000 characters, whole, with the sink’s notice and its path', bigFailWide.model.length >= 19_500 && bigFailWide.model.length <= 20_300 + noticeLength(wideNotice) && wideNotice !== null && existsSync(wideNotice?.[2] ?? '') && !/characters removed/.test(bigFailWide.model) && bare(bigFailWide.model).endsWith('Exited with code 3'), `${bigFailWide.model.length} chars`)
if (wideNotice !== null) check('…with an honest count through both cuts', shownBytes(bigFailWide.model, wideNotice) + Number(wideNotice[1]) === 90_000, `${shownBytes(bigFailWide.model, wideNotice)} shown + ${wideNotice[1]}`)
const bigFailOver = await fail({ command: bigFailing, max_output_chars: 999_999 })
const bigFailOverSink = await sinkExcerpt(bigFailOver.text)
check('a value above the cap on this road: today’s bytes (the sink’s excerpt fits the cap) plus the clause, once', bigFailOver.text === `${bigFailOverSink.trimEnd()}\n\nExited with code 3\n${overClause}` && (bigFailOver.text.match(/clamped to/g) ?? []).length === 1, `${bigFailOver.text.length} chars; tail ${JSON.stringify(bigFailOver.text.slice(-140))}`)
check('…and the model text carries the whole excerpt, its path and the clause — no fixed-window marker', bigFailOver.model.length > cap - 400 && !/characters removed/.test(bigFailOver.model) && SPILL_NOTICE.test(bigFailOver.model) && (bigFailOver.model.match(/clamped to/g) ?? []).length === 1, `${bigFailOver.model.length} chars`)
const bigFailUnder = await fail({ command: bigFailing, max_output_chars: 10 })
const underNotice = SPILL_NOTICE.exec(bigFailUnder.text)
check('a value below the floor on this road: a floor-sized window keeping the path, plus the clause', underNotice !== null && bigFailUnder.text.length <= floor + 200 + noticeLength(underNotice) + underClause.length && bigFailUnder.text.includes(underClause) && /Exited with code 3/.test(bigFailUnder.text), `${bigFailUnder.text.length} chars; tail ${JSON.stringify(bigFailUnder.text.slice(-200))}`)

section('§6 the seams: one owner for the cut, the field and the carry-through')
const bashSrc = readFileSync(join(ROOT, 'src/tools/BashTool/BashTool.tsx'), 'utf8')
const utilsSrc = readFileSync(join(ROOT, 'src/tools/BashTool/utils.ts'), 'utf8')
const psSrc = readFileSync(join(ROOT, 'src/tools/PowerShellTool/PowerShellTool.tsx'), 'utf8')
const fieldPath = join(ROOT, 'src/tools/BashTool/maxOutputChars.ts')
const fieldSrc = existsSync(fieldPath) ? readFileSync(fieldPath, 'utf8') : ''
check('the settled result is cut by formatOutput with the resolved window (spill-aware, one owner)', bashSrc.includes('formatOutput(out, { preExcerpted: result.outputFilePath !== undefined, maxLength: budget.effective })'))
check('the field, its reader and its refusal have one owner the two shells share — a leaf of zod and semanticNumber alone, so a tool building its schema at module load never meets it half-evaluated — riding the same coercion as timeout', fieldSrc.includes('export const maxOutputCharsField = semanticNumber(z.number().int().positive().optional())') && (fieldSrc.match(/^import /gm) ?? []).length === 2 && fieldSrc.includes("from 'zod/v4'") && fieldSrc.includes("from '../../utils/semanticNumber.js'") && bashSrc.includes('max_output_chars: maxOutputCharsField.describe(describeMaxOutputChars())') && bashSrc.includes('resolveOutputBudget(readMaxOutputChars(input.max_output_chars))') && bashSrc.includes('refuseMaxOutputChars(input.max_output_chars)') && bashSrc.includes("from './maxOutputChars.js'") && psSrc.includes("from '../BashTool/maxOutputChars.js'"), fieldSrc === '' ? 'no src/tools/BashTool/maxOutputChars.ts' : '')
check('the error throw applies the window only when a budget is given — the in-memory cut, or the spill-aware cut — carries the clause beside the scrub notice, and declares the error windowed so the fixed error window stands aside', bashSrc.includes('const thrown = budget.requested === undefined ? out : windowed ? formatOutput(out, { maxLength: budget.effective }).truncatedContent : formatExcerpt(out, budget.effective)') && bashSrc.includes("const error = new ShellError('', [thrown, clause, sessionEnvNoticeForResult(") && bashSrc.includes('throw budget.requested === undefined ? error : windowedError(error)'))
check('the settled result carries the clause only where the window acts (never the settled spill road)', bashSrc.includes('const outputBudgetNotice = windowed ? clause : undefined'))
const apiSrc = readFileSync(join(ROOT, 'src/utils/api.ts'), 'utf8')
check('the normaliser’s rebuilt Bash input carries max_output_chars', apiSrc.includes('rebuilt.max_output_chars = parsed.max_output_chars'))
check('the PowerShell tool takes the same field, the same resolve, the same windowed throw, the same settled cut and the same refusal', psSrc.includes('max_output_chars: maxOutputCharsField.describe(describeMaxOutputChars())') && psSrc.includes('resolveOutputBudget(readMaxOutputChars(input.max_output_chars))') && psSrc.includes('throw budget.requested === undefined ? error : windowedError(error)') && psSrc.includes('formatOutput(out, { preExcerpted: result.outputFilePath !== undefined, maxLength: budget.effective })') && psSrc.includes('refuseMaxOutputChars(input.max_output_chars)') && psSrc.includes('const outputBudgetNotice = windowed ? clause : undefined'))

section('§7 formatError alone: the fixed window still guards an unwindowed error; a windowed error passes whole; a spill notice is never cut away')
const wide = 'w'.repeat(20_000)
const fixed = formatError(new ShellError('', wide, 3, false))
check('an unwindowed 20 000-character shell error takes today’s fixed window', fixed.length === 10_034 && /\[10035 characters removed\]/.test(fixed), `${fixed.length} chars`)
const passed = windowedError === undefined ? '(absent)' : formatError(windowedError(new ShellError('', wide, 3, false)))
check('the same error declared windowed by its tool passes whole', passed.length === 20_035 && !/characters removed/.test(passed), passed === '(absent)' ? 'windowedError is not exported' : `${passed.length} chars`)
check('a non-shell error keeps the fixed window', formatError(new Error('e'.repeat(20_000))).length === 10_034)
const spillNoticeText = '\n\n[80000 bytes truncated from the middle — the head and the tail of the output are shown; the complete output is saved at /spill/task.output]\n\n'
const spilledText = `${'H'.repeat(9_000)}${spillNoticeText}${'T'.repeat(9_000)}`
const spilledModel = formatError(new ShellError('', spilledText, 3, false))
const spilledNotice = /\[(\d+) bytes truncated from the middle[^\]]*saved at \/spill\/task\.output\]/.exec(spilledModel)
check('a shell error carrying a spill notice past the fixed window keeps the notice and its path, within the window', spilledNotice !== null && !/characters removed/.test(spilledModel) && spilledModel.length <= 10_400 && spilledModel.startsWith(HEADLINE), `${spilledModel.length} chars; ${JSON.stringify(spilledModel.slice(4_990, 5_060))}`)
check('…and its count stays honest: shown bytes + the count = the whole output', spilledNotice !== null && (spilledModel.match(/H/g) ?? []).length + (spilledModel.match(/T/g) ?? []).length + Number(spilledNotice?.[1] ?? 0) === 98_000, `${(spilledModel.match(/H/g) ?? []).length} + ${(spilledModel.match(/T/g) ?? []).length} shown + ${spilledNotice?.[1] ?? '(no notice)'}`)
check('the spill-aware cut is one exported function the tools’ error roads share', cutAroundSpillNotice !== undefined && cutAroundSpillNotice('x'.repeat(50), 10) === null && cutAroundSpillNotice(spilledText, 10_000) !== null && utilsSrc.includes('cutAroundSpillNotice(content, maxLength) ?? formatOutput(content, { maxLength }).truncatedContent'), cutAroundSpillNotice === undefined ? 'cutAroundSpillNotice is not exported' : '')

section('§8 PowerShell parity: the same field, the same words, the same window and clause — the tool driven end to end through a pwsh shim on PATH that runs the command with bash')
const { PowerShellTool } = await import('../../src/tools/PowerShellTool/PowerShellTool.tsx')
const { getPrompt: getPowerShellPrompt } = await import('../../src/tools/PowerShellTool/prompt.ts')
const psSchema = PowerShellTool.inputSchema as unknown as { safeParse: (value: unknown) => Parsed }
const psAccepted = psSchema.safeParse({ command: 'true', max_output_chars: 2000 })
check('the PowerShell schema accepts max_output_chars: 2000', psAccepted.success && psAccepted.data?.max_output_chars === 2000, psAccepted.success ? JSON.stringify(psAccepted.data) : `${(psAccepted.error?.issues ?? []).map(i => i.message).join('; ')} → ${formatZodValidationError('PowerShell', psAccepted.error, PowerShellTool.inputSchema).replace(/\n/g, ' ')}`)
for (const bad of [0, -5, 2.5, 'ten']) check(`PowerShell keeps a typed refusal for ${JSON.stringify(bad)}`, !psSchema.safeParse({ command: 'true', max_output_chars: bad }).success)
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
const psJson = zodToJsonSchema(PowerShellTool.inputSchema as never) as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
const psProjected = psJson.properties?.max_output_chars
check('the PowerShell projection carries the field as an optional integer', psProjected?.type === 'integer' && !(psJson.required ?? []).includes('max_output_chars'), JSON.stringify(psProjected ?? null))
check('…with the very description Bash offers (one owner of the words)', psProjected?.description !== undefined && psProjected.description === projected?.description, (psProjected?.description ?? '(absent)').slice(0, 120))
const bulletOf = (text: string): string => /^- The optional `max_output_chars`.*$/m.exec(text)?.[0] ?? ''
const psPrompt = await getPowerShellPrompt()
check('the PowerShell prompt carries the max_output_chars bullet, byte-identical to the Bash bullet', bulletOf(psPrompt) !== '' && bulletOf(psPrompt) === bulletOf(prompt), bulletOf(psPrompt).slice(0, 120) || '(absent)')
const psValidate = (value: unknown): Promise<Verdict> => validateWith(PowerShellTool as unknown as ShellTool, value)
const psRefused = await psValidate(' 2000 ')
check('PowerShell’s validateInput refuses a raw " 2000 " with the schema’s words', psRefused.result === false && (psRefused.message ?? '').startsWith('max_output_chars: '), JSON.stringify(psRefused))
check('…and admits 2000, "2000.0" and omitted', (await psValidate(2000)).result === true && (await psValidate('2000.0')).result === true && (await psValidate(undefined)).result === true)
const runPs = (input: Record<string, unknown>): Promise<{ out: Out; content: string }> => runWith(PowerShellTool as unknown as ShellTool, input)
const failPs = (input: Record<string, unknown>): Promise<Thrown> => failWith(PowerShellTool as unknown as ShellTool, input)
const psBudgeted = await runPs({ command, max_output_chars: 2000 })
check('PowerShell: max_output_chars: 2000 → the inline result is about 2 000 characters, head + one notice + verdict, no clause', psBudgeted.out.stdout.length >= 1500 && psBudgeted.out.stdout.length <= 2200 && psBudgeted.out.stdout.startsWith('line 00001:') && psBudgeted.out.stdout.endsWith(VERDICT) && (psBudgeted.out.stdout.match(/truncated from the middle/g) ?? []).length === 1 && !/clamped to/.test(psBudgeted.content), `${psBudgeted.out.stdout.length} chars; ${psBudgeted.out.stdout.slice(0, 80)}`)
const psPlain = await runPs({ command })
check('PowerShell: omitted keeps today’s bytes byte for byte, no clause', psPlain.out.stdout === thirtyK && !/max_output_chars/.test(psPlain.content), `${psPlain.out.stdout.length} chars`)
const psOver = await runPs({ command, max_output_chars: 999_999 })
check('PowerShell: a value above the cap clamps to it — the bytes of the omitted call and the clause, once', psOver.out.stdout === thirtyK && (psOver.content.match(/clamped to/g) ?? []).length === 1 && psOver.content.includes(overClause), `${psOver.out.stdout.length} chars; ${psOver.content.slice(-120)}`)
const psUnder = await runPs({ command, max_output_chars: 10 })
check('PowerShell: a value below the floor clamps up to a floor-sized window and says so', psUnder.out.stdout.length >= floor / 2 && psUnder.out.stdout.length <= floor + 200 && psUnder.content.includes(underClause) && psUnder.out.stdout.endsWith(VERDICT), `${psUnder.out.stdout.length} chars; ${psUnder.content.slice(-120)}`)
const psFailPlain = await failPs({ command: failing })
const psFailSuffix = psFailPlain.text.startsWith(thirtyK) ? psFailPlain.text.slice(thirtyK.length) : '(prefix differs)'
check('PowerShell: omitted keeps the thrown bytes ONCE — the output in stderr, nothing doubled into stdout', psFailPlain.stdout === '' && psFailPlain.text.startsWith(thirtyK) && (psFailSuffix === '' || /session env/i.test(psFailSuffix)), `stdout ${psFailPlain.stdout.length} chars; stderr ${psFailPlain.text.length} chars`)
check('…and the model text is today’s fixed error window with an honest removed count', psFailPlain.model.length === 10_034 && psFailPlain.model.includes(`[${HEADLINE.length + psFailPlain.text.length - 10_000} characters removed]`), `${psFailPlain.model.length} chars; ${/\[\d+ characters removed\]/.exec(psFailPlain.model)?.[0] ?? '(no marker)'}`)
const psFailBudgeted = await failPs({ command: failing, max_output_chars: 2000 })
check('PowerShell: max_output_chars: 2000 on the error road → about 2 000 thrown characters, head + one notice + verdict, the model text whole', psFailBudgeted.text.length >= 1500 && psFailBudgeted.text.length <= 2300 && psFailBudgeted.text.startsWith('line 00001:') && (psFailBudgeted.text.match(/truncated from the middle/g) ?? []).length === 1 && bare(psFailBudgeted.text).endsWith(VERDICT) && psFailBudgeted.model.length < 2500 && !/characters removed/.test(psFailBudgeted.model), `${psFailBudgeted.text.length} thrown / ${psFailBudgeted.model.length} model chars`)
const psFailWide = await failPs({ command: failing, max_output_chars: 20_000 })
check('PowerShell: a 20 000 budget on the error road holds through formatError — about 20 000 characters, no fixed-window marker', psFailWide.model.length >= 19_500 && psFailWide.model.length <= 20_400 && !/characters removed/.test(psFailWide.model) && (psFailWide.model.match(/truncated from the middle/g) ?? []).length === 1, `${psFailWide.model.length} chars`)
const psFailOver = await failPs({ command: failing, max_output_chars: 999_999 })
check('PowerShell: a value above the cap on the error road: today’s bytes plus the clause once, the model text whole', psFailOver.text === `${thirtyK}\n${overClause}${psFailSuffix}` && !/characters removed/.test(psFailOver.model) && (psFailOver.model.match(/clamped to/g) ?? []).length === 1 && psFailOver.model.length > cap, `${psFailOver.text.length} thrown / ${psFailOver.model.length} model chars; tail ${JSON.stringify(psFailOver.text.slice(-100))}`)

section('§9 one function mints every clamp clause')
const ceiling = (await import('../../src/utils/waitCeiling.ts')) as Record<string, unknown>
const clampWait = ceiling.clampWait as (parameter: string, requested: number, floor: number, ceiling: number, unit: string) => { value: number; clause: string | null }
const clampClause = ceiling.clampClause as ((parameter: string, value: number, bound: 'maximum' | 'minimum', unit: string) => string) | undefined
check('the Bash clause is clampWait’s own grammar inside brackets, above the cap', outputBudgetClause({ effective: cap, requested: 999_999, clampedTo: 'maximum' }) === `[${clampWait('max_output_chars', 999_999, floor, cap, 'chars').clause}]` && overClause === `[${clampWait('max_output_chars', 999_999, floor, cap, 'chars').clause}]`)
check('…and below the floor', outputBudgetClause({ effective: floor, requested: 10, clampedTo: 'minimum' }) === `[${clampWait('max_output_chars', 10, floor, cap, 'chars').clause}]` && outputBudgetClause({ effective: 2000, requested: 2000 }) === undefined)
check('clampClause is the one mint: clampWait’s clauses are its words, byte for byte', clampClause !== undefined && clampWait('seconds', 999, 1, 300, 's').clause === clampClause('seconds', 300, 'maximum', 's') && clampWait('timeout', -1, 0, 600_000, 'ms').clause === clampClause('timeout', 0, 'minimum', 'ms') && clampClause('seconds', 300, 'maximum', 's') === 'seconds clamped to 300 s (the maximum)', clampClause === undefined ? 'clampClause is not exported' : '')
const ceilingSrc = readFileSync(join(ROOT, 'src/utils/waitCeiling.ts'), 'utf8')
check('the words are written once, in waitCeiling.ts; the Bash utils mint nothing of their own', (ceilingSrc.match(/clamped to/g) ?? []).length === 1 && !/clamped to/.test(utilsSrc) && utilsSrc.includes("clampClause('max_output_chars', budget.effective, budget.clampedTo, 'chars')"), `${(ceilingSrc.match(/clamped to/g) ?? []).length} in waitCeiling.ts, ${(utilsSrc.match(/clamped to/g) ?? []).length} in utils.ts`)

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
