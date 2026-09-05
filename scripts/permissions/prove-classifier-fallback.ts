#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}
const j = (v: unknown): string => JSON.stringify(v)

console.log('— §1 the wrapper + chain (source pins) —')

const yolo = readFileSync('src/utils/permissions/yoloClassifier.ts', 'utf8')

t('classifyYoloActionWithFallback exported', yolo.includes('export async function classifyYoloActionWithFallback('))
t('fallback chain declared', /CLASSIFIER_FALLBACK_MODELS = \[\s*'claude-sonnet-5',\s*'claude-opus-5',\s*\] as const/.test(yolo))
t('chain is Haiku-free (the model rule)', !/haiku/i.test(yolo.slice(yolo.indexOf('CLASSIFIER_FALLBACK_MODELS'), yolo.indexOf('CLASSIFIER_FALLBACK_MODELS') + 400)))

console.log('— retry conditions (fail-closed contract intact) —')
const wrapper = yolo.slice(
  yolo.indexOf('export async function classifyYoloActionWithFallback'),
  yolo.indexOf('function getClassifierModelChain'),
)
t('no retry unless unavailable', wrapper.includes('if (!primary.unavailable || primary.transcriptTooLong || signal.aborted)'))
t('a fallback that is ALSO unavailable keeps falling through', wrapper.includes('if (!next.unavailable) return next'))
t('abort/too-long during fallback returns immediately', wrapper.includes('if (next.transcriptTooLong || signal.aborted) return next'))
t('exhausted chain returns the PRIMARY verdict (original fail-closed message)', /return primary\s*\}\s*$/m.test(wrapper))
const routedSource = readFileSync('src/utils/permissions/classifierRouted.ts', 'utf8')
t('same-model skip ignores the [1m]-style tag', routedSource.includes("m.replace(/\\[[^\\]]*\\]\\s*$/, '')"))
t('yoloClassifier walks with the shared base-model law', yolo.includes('const baseModel = classifierBaseModel'))

console.log('— the unreadable verdict: one same-model re-ask, then its own outcome —')
const unreadableOwner = yolo.slice(yolo.indexOf('function unreadableVerdict('), yolo.indexOf('// The classifier call'))
t('the unreadable-verdict owner marks retryable AND unreadable', /retryable: true,\s*\n\s*unreadable: true,/.test(unreadableOwner))
t('…and carries the issues for the words', unreadableOwner.includes('verdictIssues: args.issues'))
t('…and dumps the evidence on the error-dump road', unreadableOwner.includes('writeErrorDump(args.evidence.dumpText'))
t('…logging the redacted line', unreadableOwner.includes('logForDebugging(args.evidence.logLine'))
t('the no-tool-block branch routes through the owner', /if \(!toolUse\) \{[\s\S]{0,700}return unreadableVerdict\(\{[\s\S]{0,120}reason: 'The classifier answered without a tool-use block — blocking for safety\.'/.test(yolo))
t('the schema-miss branch routes through the owner', /if \(!read\.ok\) \{[\s\S]{0,200}return unreadableVerdict\(\{[\s\S]{0,120}reason: 'The classifier response did not parse — blocking for safety\.'/.test(yolo))
t('exactly the owner sets retryable (the unavailable catch is NOT retryable)', (yolo.match(/retryable: true/g) ?? []).length === 1)
t('wrapper gates the retry on retryable + not-aborted', wrapper.includes('if (primary.retryable && !signal.aborted)'))
t('wrapper re-asks the SAME model', /const retry = await classifyYoloAction\([^)]*primary\.model,\s*\)/s.test(wrapper))
t('a second failure keeps the unreadable outcome (the retry stays one)', /if \(retry\.retryable\) \{[\s\S]{0,400}return retry\s*\}/.test(wrapper))
t('a healthy/unavailable retry replaces primary (ladder fallthrough)', wrapper.includes('primary = retry'))
t('parse retry sits BEHIND the flag gate (=0 restores immediate fail-close)', wrapper.indexOf('if (!classifierFallbackEnabled()) return primary') !== -1 && wrapper.indexOf('if (!classifierFallbackEnabled()) return primary') < wrapper.indexOf('primary.retryable'))
const resultType = readFileSync('src/types/permissions.ts', 'utf8')
t('result type carries retryable, unreadable and the issues', resultType.includes('retryable?: boolean') && resultType.includes('unreadable?: boolean') && resultType.includes('verdictIssues?: string[]'))
t('the routed transport marks its unparseable answer unreadable too', /unreadable: true,\s*\n\s*reason: 'Invalid classifier response - blocking for safety'/.test(routedSource))

console.log('— gate honesty —')
t('default-on gate', wrapper.includes('if (!classifierFallbackEnabled()) return primary') && yolo.includes("flagEnv('MERCURY_CLASSIFIER_FALLBACK') === '0'"))
const reg = readFileSync('src/substrate/flagRegistry.ts', 'utf8')
t('flag registered', reg.includes("env: 'MERCURY_CLASSIFIER_FALLBACK'"))

console.log('— call sites route through the wrapper —')
const wrapperBand = readFileSync('src/utils/permissions/decision/wrapper.ts', 'utf8')
const perms = readFileSync('src/utils/permissions/permissions.ts', 'utf8')
t('decision/wrapper.ts (the per-tool auto ask)', wrapperBand.includes('classifyYoloActionWithFallback(') && !/classifyYoloAction\(/.test(wrapperBand))
t('permissions.ts facade carries no direct classifier call', !perms.includes('classifyYoloAction'))
const agent = readFileSync('src/tools/AgentTool/agentToolUtils.ts', 'utf8')
t('agentToolUtils.ts carries NO classifier call (handback review removed)', !agent.includes('classifyYoloAction'))

console.log('— the model override plumbs to the API attempt —')
t('classifyYoloAction takes modelOverride', yolo.includes('modelOverride?: string,'))
t('override wins over getClassifierModel()', yolo.includes('const model = modelOverride ?? getClassifierModel()'))

console.log('— §2 the verdict reader at runtime —')

const shared = await import('../../src/utils/permissions/classifierShared.ts')
const { z } = await import('zod/v4')
const schema = z.object({ thinking: z.string(), shouldBlock: z.boolean(), reason: z.string() })
const block = (input: unknown): never => ({ type: 'tool_use', id: 'toolu_read', name: 'classify_result', input }) as never
const read = (input: unknown): ReturnType<typeof shared.readClassifierVerdict> => shared.readClassifierVerdict(block(input), schema, { booleanFields: ['shouldBlock'] })

const good = read({ thinking: 'routine', shouldBlock: false, reason: 'a routine read' })
t('a well-formed verdict reads (no re-encoding)', good.ok && good.data.shouldBlock === false && good.normalised === false, j(good))
const word = read({ thinking: 'x', shouldBlock: 'true', reason: 'r' })
t('a boolean spelled as a word reads as the boolean (normalised)', word.ok && word.data.shouldBlock === true && word.normalised === true, j(word))
const no = read({ thinking: 'x', shouldBlock: 'No', reason: 'r' })
t('…any case, yes/no included', no.ok && no.data.shouldBlock === false, j(no))
const escaped = read(JSON.stringify({ thinking: 'x', shouldBlock: true, reason: 'r' }))
t('a JSON-escaped input (the whole object in one string) reads (normalised)', escaped.ok && escaped.data.shouldBlock === true && escaped.normalised === true, j(escaped))
const missing = read({ shouldBlock: true, reason: 'r' })
t('a missing field is unreadable and the issue names the field', !missing.ok && missing.issues.length === 1 && missing.issues[0]!.startsWith('thinking:'), j(missing))
const wrongType = read({ thinking: 'x', shouldBlock: 1, reason: 'r' })
t('a wrong type is unreadable and the issue names the field and the type', !wrongType.ok && /^shouldBlock: .*boolean/.test(wrongType.issues[0] ?? ''), j(wrongType))
const maybe = read({ thinking: 'x', shouldBlock: 'maybe', reason: 'r' })
t('a non-boolean word stays unreadable (never guessed)', !maybe.ok && /^shouldBlock:/.test(maybe.issues[0] ?? ''), j(maybe))
const truncated = read('{"thinking":"x","shouldBl')
t('a truncated (non-JSON) string input is unreadable with its own issue', !truncated.ok && /^input: a string that is not JSON/.test(truncated.issues[0] ?? ''), j(truncated))
t('…and the raw input is kept as evidence', !truncated.ok && truncated.raw === '{"thinking":"x","shouldBl', j(truncated))
const array = read([1, 2])
t('a non-object input is unreadable', !array.ok, j(array))
t('the read never throws on a null input', (() => { try { return !read(null).ok } catch { return false } })())

const routed = await import('../../src/utils/permissions/classifierRouted.ts')
t('routed grammar: <block>yes / <block>no', routed.parseBlockVerdict('<block>yes</block>') === true && routed.parseBlockVerdict('<block>no') === false)
t('routed grammar tolerates <block>true / <block>false', routed.parseBlockVerdict('<block>true</block>') === true && routed.parseBlockVerdict('<block>false</block><reason>x</reason>') === false)
t('routed grammar tolerates a JSON-shaped verdict', routed.parseBlockVerdict('{"thinking":"x","shouldBlock":true,"reason":"r"}') === true && routed.parseBlockVerdict('Here: {"should_block": "no"}') === false)
t('routed grammar: prose stays unreadable', routed.parseBlockVerdict('Looks fine to me!') === null)

console.log('— §3 the real classify road over a loopback fixture —')

const home = mkdtempSync(join(tmpdir(), 'classifier-fallback-'))
seedFirstRun(home, [process.cwd()])
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TMPDIR = join(home, 'tmp')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

type Answer = { kind: 'verdict'; input: unknown } | { kind: 'text'; text: string }
const queue: Answer[] = []
const seen: Array<{ model: string; tools: string[]; toolChoice: unknown; stream: boolean }> = []
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    if (req.method !== 'POST' || !(req.url ?? '').includes('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    } catch {
      body = {}
    }
    const tools = Array.isArray(body.tools) ? (body.tools as Array<{ name?: string }>).map(tool => tool.name ?? '') : []
    seen.push({ model: String(body.model ?? ''), tools, toolChoice: body.tool_choice, stream: body.stream === true })
    const answer = queue.shift() ?? { kind: 'text', text: 'fixture script exhausted' }
    const n = seen.length
    const content =
      answer.kind === 'verdict'
        ? [{ type: 'tool_use', id: `toolu_fx_${n}`, name: 'classify_result', input: answer.input }]
        : [{ type: 'text', text: answer.text }]
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_fx_${n}` })
    res.end(
      JSON.stringify({
        id: `msg_fx_${n}`,
        type: 'message',
        role: 'assistant',
        model: String(body.model ?? ''),
        content,
        stop_reason: answer.kind === 'verdict' ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 30, output_tokens: 9 },
      }),
    )
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`

await import('../../src/utils/permissions/decision/wrapper.ts')
const classifier = await import('../../src/utils/permissions/yoloClassifier.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

const bashTool = { name: 'Bash', toAutoClassifierInput: (input: { command?: string }) => input.command ?? '' }
const tools = [bashTool] as never
const messages = [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'commit the probe' }] } }] as never
const action = classifier.formatActionForClassifier('Bash', { command: 'git commit --allow-empty -m probe' })
const context = { ...getEmptyToolPermissionContext(), mode: 'flow' } as never
const classify = (): ReturnType<typeof classifier.classifyYoloActionWithFallback> =>
  classifier.classifyYoloActionWithFallback(messages, action, tools, context, new AbortController().signal)
const MALFORMED = { thinking: 'The command writes a commit.', shouldBlock: 'maybe', reason: 'an unreadable verdict' }
const WELL_FORMED = { thinking: 'The command writes a commit.', shouldBlock: true, reason: 'writes to the repository history' }

try {
  queue.push({ kind: 'verdict', input: MALFORMED }, { kind: 'verdict', input: MALFORMED })
  const before = seen.length
  const exhausted = await classify()
  const asked = seen.slice(before)
  t('retry exhaustion: the classifier was asked exactly twice (the one same-model re-ask)', asked.length === 2 && asked[0]!.model === asked[1]!.model, j(asked))
  t('…each ask offered the verdict tool on the non-streaming side query', asked.every(a => a.tools.includes('classify_result') && !a.stream), j(asked))
  t('…the outcome is UNREADABLE and fail-closed, naming the model', exhausted.unreadable === true && exhausted.shouldBlock === true && exhausted.retryable === true && exhausted.model === asked[0]!.model, j(exhausted))
  t('…never unavailable (no chain walk for a readable-transport failure)', exhausted.unavailable !== true, j(exhausted))
  t('…the issues name the field', (exhausted.verdictIssues ?? []).some(issue => issue.startsWith('shouldBlock:')), j(exhausted.verdictIssues))
  const dumpPath = exhausted.errorDumpPath ?? ''
  t('…the evidence dump was written on the error-dump road', dumpPath !== '' && existsSync(dumpPath), dumpPath)
  const dump = dumpPath !== '' && existsSync(dumpPath) ? readFileSync(dumpPath, 'utf8') : ''
  t('…the dump names the model, the stop reason, the request id and the failing field, and keeps the raw input', dump.includes(`model: ${exhausted.model}`) && dump.includes('stop_reason: tool_use') && dump.includes('request id: req_fx_') && dump.includes('shouldBlock:') && dump.includes('"maybe"'), dump.slice(0, 500))
  t('…the dump sits under the home\'s temp root (never the box\'s)', dumpPath.startsWith(join(home, 'tmp')), dumpPath)
  if (process.platform !== 'win32' && dumpPath !== '' && existsSync(dumpPath)) {
    const { statSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    t('…the dump file is readable by the operator alone (0600)', (statSync(dumpPath).mode & 0o777) === 0o600, (statSync(dumpPath).mode & 0o777).toString(8))
    t('…and its directory too (0700)', (statSync(dirname(dumpPath)).mode & 0o777) === 0o700, (statSync(dirname(dumpPath)).mode & 0o777).toString(8))
  }

  queue.push({ kind: 'verdict', input: MALFORMED }, { kind: 'verdict', input: WELL_FORMED })
  const before2 = seen.length
  const recovered = await classify()
  t('a clean re-ask wins: two asks, the verdict read, not unreadable', seen.length - before2 === 2 && recovered.unreadable !== true && recovered.shouldBlock === true && recovered.reason === WELL_FORMED.reason, j(recovered))

  queue.push({ kind: 'verdict', input: { ...WELL_FORMED, shouldBlock: 'false' } })
  const before3 = seen.length
  const spelled = await classify()
  t('a boolean spelled as a word reads on the first ask (one ask, allowed)', seen.length - before3 === 1 && spelled.unreadable !== true && spelled.shouldBlock === false, j(spelled))

  queue.push({ kind: 'text', text: 'Looks fine to me.' }, { kind: 'text', text: 'Looks fine to me.' })
  const before4 = seen.length
  const prose = await classify()
  t('a prose answer with no verdict block is unreadable after the one re-ask', seen.length - before4 === 2 && prose.unreadable === true && prose.shouldBlock === true, j(prose))
  t('…and the issue names the missing block', (prose.verdictIssues ?? []).some(issue => issue.includes('no classify_result tool-use block')), j(prose.verdictIssues))
} finally {
  server.close()
}

console.log(failures ? '\n❌ CLASSIFIER-FALLBACK RED' : '\n✅ CLASSIFIER-FALLBACK GREEN')
process.exit(failures)
