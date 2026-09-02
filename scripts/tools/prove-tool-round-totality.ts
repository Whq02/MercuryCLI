#!/usr/bin/env bun
// ============================================================================
//  prove-tool-round-totality — whatever the wire hands the executor, the
//  round settles every id exactly once and the process stays alive.
//
//  The tool-call gate (src/services/providers/toolCallGate.ts) bounces
//  schema-failing calls on the non-Anthropic wires; the executor
//  (src/services/tools/toolExecution.ts) is the LAST line for everything
//  else — the Anthropic wire's own placeholder class, a resumed transcript,
//  a hostile value inside a legal shape. The law under proof:
//
//   1. THE EXECUTOR IS TOTAL: for every block shape the wire can legally
//      produce — `{}`, null, a string, an array, missing required fields,
//      wrong types, nested unknown keys, control bytes and NUL inside string
//      fields, a megabyte in a string field, a tool name the pool does not
//      carry, two blocks under one id — runTools yields exactly ONE
//      tool_result per block id, never rejects, and the answers for calls
//      that could not run say so (is_error, a reason).
//   2. RESULT BYTES ARE TOTAL: a tool whose output carries terminal control
//      bytes, NUL and a megabyte of text settles as an ordinary result the
//      transcript can carry.
//   3. A CANCELLED ROUND ANSWERS EVERY ID: three parallel calls on a slow
//      tool, aborted mid-flight — every id is paired (interrupt-shaped),
//      the not-yet-started calls included; the serial branch too.
//   4. RENDER-PATH TOTALITY, THE REACHABLE FAMILY: every built-in's render
//      hooks (use · queued · rejected · tag · summary · activity ·
//      classifier · name · auto-classifier input · error · progress) take
//      what the wire can carry for a tool_use input — the `{}` placeholder,
//      wrong-typed fields, nested unknown keys, control bytes and NUL, a
//      megabyte string — without throwing; a throwing hook here is the
//      class that ended the process on a `{}` tool_use. (null/undefined/
//      scalar inputs are pinned for the classifier hooks by
//      prove-tool-input-tolerance; a tool_use block's input is always an
//      object on every wire and in every persisted transcript.)
//   5. THE SEAMS ARE GUARDED: every transcript/classifier call site of a
//      render hook outside src/tools either validates the input first or
//      wraps the call — a hook that still throws costs one row, never the
//      process (structural).
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const SCRATCH = mkdtempSync(join(tmpdir(), 'tool-round-totality-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.MERCURY_TEAMS_DIR = join(SCRATCH, 'teams')
delete process.env.MERCURY_HOME
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  checks++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — tool round totality exceeded 180s')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { getAllBaseTools } = await import('../../src/tools.ts')
const { runTools } = await import('../../src/services/tools/toolOrchestration.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
type AnyMsg = Record<string, unknown> & { type?: string }

const WORK = join(SCRATCH, 'work')
mkdirSync(WORK, { recursive: true })
writeFileSync(join(WORK, 'plain.txt'), 'plain contents\n')
bootstrap.setCwdState(WORK)

const CONTROL = 'a\x00b\x1b[2J\x07c\r\n​😀'
const MEGA = 'x'.repeat(1_000_000)

const baseTools = getAllBaseTools()
t('the registry resolved a real catalogue', baseTools.length > 20, `${baseTools.length} tools`)

function makeCtx(tools: readonly unknown[]): { ctx: Record<string, unknown>; abort: AbortController } {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  const abort = new AbortController()
  const ctx: Record<string, unknown> = {
    abortController: abort,
    options: {
      commands: [],
      tools,
      mainLoopModel: 'claude-opus-4-8',
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
  return { ctx, abort }
}
const allowAll = (async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } })) as never

type Settled = { id: string; text: string; isError: boolean }
async function round(
  blocks: Array<{ id: string; name: string; input: unknown }>,
  tools: readonly unknown[],
  abortAfterMs?: number,
): Promise<{ results: Settled[]; threw: string | undefined; yields: number }> {
  const { ctx, abort } = makeCtx(tools)
  const parent = createAssistantMessage({ content: blocks.map(b => ({ type: 'tool_use', ...b })) as never })
  const results: Settled[] = []
  let threw: string | undefined
  let yields = 0
  if (abortAfterMs !== undefined) setTimeout(() => abort.abort(), abortAfterMs)
  try {
    for await (const update of runTools(blocks as never, [parent], allowAll, ctx as never)) {
      yields++
      const m = update.message as AnyMsg | undefined
      if (!m || m.type !== 'user') continue
      const content = (m.message as { content?: unknown } | undefined)?.content
      if (!Array.isArray(content)) continue
      for (const b of content as AnyMsg[]) {
        if (b.type !== 'tool_result') continue
        const raw = b.content
        results.push({
          id: String(b.tool_use_id),
          text: typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(x => String((x as AnyMsg).text ?? '')).join('') : '',
          isError: b.is_error === true,
        })
      }
    }
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  return { results, threw, yields }
}
const answeredOnce = (results: Settled[], ids: string[]): boolean =>
  ids.every(id => results.filter(r => r.id === id).length === 1) && results.length === ids.length

// —— 1. the executor is total ————————————————————————————————————————
console.log('── 1. the executor is total over hostile blocks ──')
{
  const hostile: Array<{ label: string; name: string; input: unknown }> = [
    { label: 'Read {}', name: 'Read', input: {} },
    { label: 'Read null', name: 'Read', input: null },
    { label: 'Read string', name: 'Read', input: 'not an object' },
    { label: 'Read array', name: 'Read', input: [1, 2] },
    { label: 'Read wrong type', name: 'Read', input: { file_path: 42 } },
    { label: 'Read nested unknown keys', name: 'Read', input: { file_path: join(WORK, 'plain.txt'), extra: { deep: { deeper: [1, { x: null }] } } } },
    { label: 'Read control bytes in path', name: 'Read', input: { file_path: join(WORK, CONTROL) } },
    { label: 'Read a megabyte path', name: 'Read', input: { file_path: join(WORK, MEGA) } },
    { label: 'Edit missing required', name: 'Edit', input: { file_path: join(WORK, 'plain.txt') } },
    { label: 'Edit control bytes', name: 'Edit', input: { file_path: join(WORK, 'plain.txt'), old_string: CONTROL, new_string: 'x' } },
    { label: 'Write NUL in path', name: 'Write', input: { file_path: join(WORK, 'nul\x00name.txt'), content: 'x' } },
    { label: 'Grep hostile regex', name: 'Grep', input: { pattern: '(', path: WORK } },
    { label: 'Grep control bytes', name: 'Grep', input: { pattern: CONTROL, path: WORK } },
    { label: 'Glob a megabyte pattern', name: 'Glob', input: { pattern: MEGA, path: WORK } },
    { label: 'Bash {}', name: 'Bash', input: {} },
    { label: 'Bash wrong type', name: 'Bash', input: { command: ['ls'] } },
    { label: 'Agent {}', name: 'Agent', input: {} },
    { label: 'Agent wrong types', name: 'Agent', input: { description: 1, prompt: null, subagent_type: {} } },
    { label: 'StructuredOutput {}', name: 'StructuredOutput', input: {} },
    { label: 'Recall {}', name: 'Recall', input: {} },
    { label: 'Retain {}', name: 'Retain', input: {} },
    { label: 'unknown tool', name: 'NoSuchToolAnywhere', input: { anything: 1 } },
    { label: 'empty tool name', name: '', input: {} },
  ]
  let i = 0
  for (const h of hostile) {
    const id = `tu_hostile_${++i}`
    const r = await round([{ id, name: h.name, input: h.input }], baseTools)
    t(`${h.label}: settles exactly one tool_result, never throws`, r.threw === undefined && answeredOnce(r.results, [id]), `threw=${r.threw ?? 'no'} results=${r.results.map(x => x.id).join(',')}`)
    const only = r.results[0]
    if (only && only.isError) {
      t(`${h.label}: the refusal names a reason`, only.text.length > 0 && only.text !== '<tool_use_error></tool_use_error>', only.text.slice(0, 80))
    }
  }
  // Two blocks under one id: the executor answers each block (the wire
  // gate refuses the duplicate on every dialect that can carry one; the
  // Anthropic API never emits one) — never a rejection, never a lost block.
  const dup = await round(
    [
      { id: 'tu_dup', name: 'Read', input: { file_path: join(WORK, 'plain.txt') } },
      { id: 'tu_dup', name: 'Read', input: { file_path: join(WORK, 'missing.txt') } },
    ],
    baseTools,
  )
  t('two blocks under one id: both settle, the round never rejects', dup.threw === undefined && dup.results.length === 2 && dup.results.every(r => r.id === 'tu_dup'), `threw=${dup.threw ?? 'no'} results=${dup.results.length}`)
  // A whole hostile round in parallel: every id answered exactly once.
  const ids = hostile.map((_, k) => `tu_par_${k}`)
  const par = await round(hostile.map((h, k) => ({ id: ids[k]!, name: h.name, input: h.input })), baseTools)
  t('the whole hostile family in ONE round: every id answered exactly once, no rejection', par.threw === undefined && answeredOnce(par.results, ids), `threw=${par.threw ?? 'no'} answered=${par.results.length}/${ids.length}`)
}

// —— 2. result bytes are total ————————————————————————————————————————
console.log('── 2. result bytes are total ──')
{
  const r = await round([{ id: 'tu_bytes', name: 'Bash', input: { command: "printf 'A\\033[2J\\007\\000B\\r\\n'; head -c 200000 /dev/zero | tr '\\0' 'y'" } }], baseTools)
  t('a result carrying control bytes, NUL and 200k bytes settles as one ordinary tool_result', r.threw === undefined && answeredOnce(r.results, ['tu_bytes']) && !r.results[0]!.isError, `threw=${r.threw ?? 'no'} err=${String(r.results[0]?.isError)} ${r.results[0]?.text.slice(0, 60)}`)
  t('…and the transcript row carries the bytes (the escape did not eat the result)', (r.results[0]?.text ?? '').includes('B') && (r.results[0]?.text.length ?? 0) > 1000, String(r.results[0]?.text.length))
}

// —— 3. a cancelled round answers every id ————————————————————————————
console.log('── 3. a cancelled round answers every id ──')
{
  const slow = (name: string, concurrencySafe: boolean): unknown => ({
    name,
    async description() {
      return 'slow rig tool'
    },
    async prompt() {
      return 'slow rig tool'
    },
    inputSchema: z.object({ text: z.string() }),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => concurrencySafe,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: { text: string }, context: { abortController: AbortController }) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 400)
        context.abortController.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
      if (context.abortController.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      return { data: `slow:${input.text}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  })
  for (const [label, safe] of [
    ['parallel (concurrent batch)', true],
    ['serial (non-concurrency-safe)', false],
  ] as const) {
    const tools = [slow('SlowTool', safe)]
    const ids = ['tu_c1', 'tu_c2', 'tu_c3']
    const r = await round(ids.map(id => ({ id, name: 'SlowTool', input: { text: id } })), tools, 60)
    t(`${label}: an abort mid-round still answers every id exactly once`, r.threw === undefined && answeredOnce(r.results, ids), `threw=${r.threw ?? 'no'} answered=${r.results.map(x => x.id).join(',')}`)
    t(`${label}: every answer is error-shaped (nothing claims success after the abort)`, r.results.every(x => x.isError), r.results.map(x => `${x.id}:${x.isError}`).join(','))
  }
}

// —— 4. render-path totality, the reachable family ——————————————————————
console.log('── 4. render-path totality over the reachable hostile family ──')
{
  const FAMILY: Array<[string, unknown]> = [
    ['{}', {}],
    ['nested unknown keys', { extra: { deep: { deeper: [1, { x: null }] } }, file_path: 3, command: false, pattern: [] }],
    ['control bytes in every string field', { file_path: CONTROL, command: CONTROL, pattern: CONTROL, path: CONTROL, prompt: CONTROL, description: CONTROL, content: CONTROL, old_string: CONTROL, new_string: CONTROL, url: CONTROL, query: CONTROL }],
    ['a megabyte in every string field', { file_path: MEGA, command: MEGA, pattern: MEGA, path: MEGA, prompt: MEGA, description: MEGA, content: MEGA, old_string: MEGA, new_string: MEGA, url: MEGA, query: MEGA }],
  ]
  const INPUT_HOOKS = ['renderToolUseMessage', 'renderToolUseQueuedMessage', 'renderToolUseRejectedMessage', 'renderToolUseTag', 'getToolUseSummary', 'getActivityDescription', 'userFacingName', 'isSearchOrReadCommand', 'toAutoClassifierInput'] as const
  const options = { verbose: false, theme: 'dark', columns: 80 }
  const throws: string[] = []
  for (const tool of baseTools) {
    const record = tool as unknown as Record<string, unknown>
    for (const hook of INPUT_HOOKS) {
      const fn = record[hook]
      if (typeof fn !== 'function') continue
      for (const [label, input] of FAMILY) {
        try {
          ;(fn as (input: unknown, options: unknown) => unknown).call(tool, input, options)
        } catch (error) {
          throws.push(`${tool.name}.${hook}(${label}): ${(error as Error).message.slice(0, 80)}`)
        }
      }
    }
    // The error renderer meets thrown errors and error strings alike.
    const errorHook = record.renderToolUseErrorMessage
    if (typeof errorHook === 'function') {
      for (const [label, err] of [['Error', new Error(CONTROL)], ['string', CONTROL], ['{}', {}], ['null', null]] as const) {
        try {
          ;(errorHook as (error: unknown, options: unknown) => unknown).call(tool, err, options)
        } catch (error) {
          throws.push(`${tool.name}.renderToolUseErrorMessage(${label}): ${(error as Error).message.slice(0, 80)}`)
        }
      }
    }
    // Progress renderers meet a progress list that may be empty or hostile.
    const progressHook = record.renderToolUseProgressMessage
    if (typeof progressHook === 'function') {
      for (const [label, progress] of [['[]', []], ['hostile entries', [{ data: null }, { data: CONTROL }, {}]]] as const) {
        try {
          ;(progressHook as (progress: unknown, options: unknown) => unknown).call(tool, progress, options)
        } catch (error) {
          throws.push(`${tool.name}.renderToolUseProgressMessage(${label}): ${(error as Error).message.slice(0, 80)}`)
        }
      }
    }
  }
  t('no built-in render-path hook throws on the reachable hostile family', throws.length === 0, `${throws.length} throws: ${throws.slice(0, 6).join(' | ')}`)
  if (throws.length > 0) for (const line of throws) console.log(`    ${line}`)
}

// —— 5. the seams are guarded ————————————————————————————————————————
console.log('── 5. the seams are guarded (structural) ──')
{
  const { readFileSync } = await import('node:fs')
  const ROOT = join(import.meta.dir, '..', '..')
  const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
  const row = read('src/components/messages/AssistantToolUseMessage.tsx')
  const gate = row.indexOf('if (!parsedInput.success) return null')
  const call = row.indexOf('tool.renderToolUseMessage?.(parsedInput.data')
  t('the transcript row validates the input before rendering the tool use', gate !== -1 && call !== -1 && gate < call)
  t('…and wraps the render in a catch (a throwing hook costs one row)', /try \{\s*useMessage =\s*tool\.renderToolUseMessage/.test(row))
  const collapsed = read('src/components/messages/CollapsedReadSearchContent.tsx')
  t('the collapsed read/search row wraps the render in a catch', /try \{[^}]*tool\.renderToolUseMessage\?\.\(entry\.input/.test(collapsed))
  const yolo = read('src/utils/permissions/yoloClassifier.ts')
  t('the auto-mode classifier wraps every projection call in a catch', (yolo.match(/toAutoClassifierInput\?\.\(/g) ?? []).length >= 2 && (yolo.match(/try \{\s*(value =|const value =)\s*tool\.toAutoClassifierInput/g) ?? []).length >= 2)
  const messages = read('src/components/Messages.tsx')
  t('every transcript row still sits in the per-row boundary', /<SentryErrorBoundary>\s*<MessageRow/.test(messages))
  const display = read('src/utils/file.ts')
  t('getDisplayPath is total over non-string and NUL-bearing paths', /if \(typeof filePath !== 'string'\)/.test(display) && /try \{\s*relativePath = getAbsoluteAndRelativePaths\(filePath\)\.relativePath/.test(display))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? `\nALL GREEN (${checks} checks)` : `\n${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
