#!/usr/bin/env bun
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
const { formatOutput } = await import('../../src/tools/BashTool/utils.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { normalizeToolInput } = await import('../../src/utils/api.ts')
const { getSimplePrompt } = await import('../../src/tools/BashTool/prompt.ts')
const { getScratchpadDir } = await import('../../src/utils/permissions/filesystem.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')

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
async function run(input: Record<string, unknown>): Promise<{ out: Out; content: string }> {
  const result = await BashTool.call(input as never, toolContext)
  const block = BashTool.mapToolResultToToolResultBlockParam(result.data as never, 'output-budget')
  return { out: result.data as Out, content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }
}
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
const validate = async (value: unknown): Promise<Verdict> => (await BashTool.validateInput({ command: 'true', max_output_chars: value } as never, toolContext)) as Verdict
for (const [raw, word] of [[' 2000 ', /string/], ['0', />0|greater than 0/], ['-5', />0|greater than 0/], ['2.5', /int/], ['ten', /string/]] as const) {
  const verdict = await validate(raw)
  check(`the serve road’s refusal channel (validateInput) refuses a raw ${JSON.stringify(raw)} exactly as the schema does`, verdict.result === false && (verdict.message ?? '').startsWith('max_output_chars: ') && word.test(verdict.message ?? ''), JSON.stringify(verdict))
}
check('…and admits what the schema admits', (await validate('2000.0')).result === true && (await validate(2000)).result === true && (await validate(undefined)).result === true)

section('§4b a FAILING command (the error road) takes the same window and the same clause')
const { formatError } = await import('../../src/utils/toolErrors.ts')
const failing = `cat ${JSON.stringify(fixture)}; exit 3`
async function fail(input: Record<string, unknown>): Promise<{ text: string; model: string }> {
  try {
    await BashTool.call(input as never, toolContext)
  } catch (error) {
    return { text: String((error as { stderr?: string }).stderr ?? ''), model: formatError(error) }
  }
  return { text: '(no throw)', model: '(no throw)' }
}
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

section('§5b a FAILING command over the cap: the thrown text takes the window and keeps the spill notice with its path')
const { TaskOutput } = await import('../../src/utils/task/TaskOutput.ts')
const bigFailing = `${bigCommand}; exit 3`
const SPILL_NOTICE = /\n\n\[(\d+) bytes truncated from the middle — the head and the tail of the output are shown; the complete output is saved at ([^\n]*?\.output)\]\n\n/
async function sinkExcerpt(text: string): Promise<string> {
  const path = SPILL_NOTICE.exec(text)?.[2] ?? ''
  const taskId = path.slice(path.lastIndexOf('/') + 1, -'.output'.length)
  return await new TaskOutput(taskId, null, true).getStdout()
}
const bigFailPlain = await fail({ command: bigFailing })
const sinkOwn = await sinkExcerpt(bigFailPlain.text)
check('omitted keeps today’s thrown bytes: the spill sink’s own excerpt (re-read from its file), then the exit line, nothing else', sinkOwn.length > 0 && bigFailPlain.text === `${sinkOwn.trimEnd()}\n\nExited with code 3`, `${bigFailPlain.text.length} chars vs sink ${sinkOwn.length}`)
check('…and the model text is today’s fixed error window, which loses the path (the base’s own loss)', bigFailPlain.model.length > 10_000 && bigFailPlain.model.length < 10_200 && /characters removed/.test(bigFailPlain.model) && !/saved at/.test(bigFailPlain.model), `${bigFailPlain.model.length} chars`)
const bigFailBudgeted = await fail({ command: bigFailing, max_output_chars: 2000 })
const budgetedNotice = SPILL_NOTICE.exec(bigFailBudgeted.text)
check('max_output_chars: 2000 → the thrown text is about 2 000 characters', bigFailBudgeted.text.length >= 1500 && bigFailBudgeted.text.length <= 2400, `${bigFailBudgeted.text.length} chars`)
check('…the head, ONE middle notice — the spill sink’s own, its path kept — and the exit line at the tail', bigFailBudgeted.text.startsWith('line 00001:') && budgetedNotice !== null && (bigFailBudgeted.text.match(/truncated from the middle/g) ?? []).length === 1 && existsSync(budgetedNotice?.[2] ?? '') && bigFailBudgeted.text.endsWith('\n\nExited with code 3') && !/clamped to/.test(bigFailBudgeted.text), `${bigFailBudgeted.text.slice(0, 60)} … ${bigFailBudgeted.text.slice(-200)}`)
if (budgetedNotice !== null) {
  const shownOutput = bigFailBudgeted.text.slice(0, budgetedNotice.index) + bigFailBudgeted.text.slice(budgetedNotice.index + budgetedNotice[0].length).replace(/\nExited with code 3$/, '')
  check('…and the notice’s byte count is honest: shown bytes + the count = the whole 90 000-byte output', Buffer.byteLength(shownOutput, 'utf8') + Number(budgetedNotice[1]) === 90_000, `${Buffer.byteLength(shownOutput, 'utf8')} shown + ${budgetedNotice[1]}`)
}
check('…and the model text carries it whole, with the path — no fixed-window marker', bigFailBudgeted.model.length < 2600 && !/characters removed/.test(bigFailBudgeted.model) && /saved at .*\.output/.test(bigFailBudgeted.model) && /exit code 3/.test(bigFailBudgeted.model), `${bigFailBudgeted.model.length} chars`)
const bigFailOver = await fail({ command: bigFailing, max_output_chars: 999_999 })
const bigFailOverSink = await sinkExcerpt(bigFailOver.text)
check('a value above the cap on this road: today’s bytes (the sink’s excerpt fits the cap) plus the clause, once', bigFailOver.text === `${bigFailOverSink.trimEnd()}\n\nExited with code 3\n${overClause}` && (bigFailOver.text.match(/clamped to/g) ?? []).length === 1, `${bigFailOver.text.length} chars; tail ${JSON.stringify(bigFailOver.text.slice(-140))}`)
const bigFailUnder = await fail({ command: bigFailing, max_output_chars: 10 })
check('a value below the floor on this road: a floor-sized window keeping the path, plus the clause', bigFailUnder.text.length <= floor + 400 && SPILL_NOTICE.test(bigFailUnder.text) && bigFailUnder.text.includes(underClause) && /Exited with code 3/.test(bigFailUnder.text), `${bigFailUnder.text.length} chars; tail ${JSON.stringify(bigFailUnder.text.slice(-200))}`)

section('§6 the seams: one owner for the cut, and the carry-through')
const bashSrc = readFileSync(join(ROOT, 'src/tools/BashTool/BashTool.tsx'), 'utf8')
check('the settled result is cut by formatOutput with the resolved window (spill-aware, one owner)', bashSrc.includes('formatOutput(out, { preExcerpted: result.outputFilePath !== undefined, maxLength: budget.effective })'))
check('the schema field rides the same coercion as timeout, and that one parser is the reader for a raw serve-road value', bashSrc.includes('const maxOutputCharsField = semanticNumber(z.number().int().positive().optional())') && bashSrc.includes('max_output_chars: maxOutputCharsField.describe(') && bashSrc.includes('resolveOutputBudget(readMaxOutputChars(input.max_output_chars))') && bashSrc.includes('const parsed = maxOutputCharsField.safeParse(input.max_output_chars)'))
check('the error throw applies the window only when a budget is given — the in-memory cut, or the spill-aware cut that keeps the sink’s notice — and carries the clause beside the scrub notice', bashSrc.includes('const thrown = budget.requested === undefined ? out : windowed ? formatOutput(out, { maxLength: budget.effective }).truncatedContent : formatExcerpt(out, budget.effective)') && bashSrc.includes("throw new ShellError('', [thrown, clause, sessionEnvNoticeForResult("))
check('the settled result carries the clause only where the window acts (never the settled spill road)', bashSrc.includes('const outputBudgetNotice = windowed ? clause : undefined'))
const apiSrc = readFileSync(join(ROOT, 'src/utils/api.ts'), 'utf8')
check('the normaliser’s rebuilt Bash input carries max_output_chars', apiSrc.includes('rebuilt.max_output_chars = parsed.max_output_chars'))

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
