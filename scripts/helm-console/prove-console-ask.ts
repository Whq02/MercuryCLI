#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'console-ask-proof-'))
delete process.env.MERCURY_CONSOLE_MODEL
delete process.env.MERCURY_MINERVA_MODEL
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN']) {
  delete process.env[key]
}

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' helm console ask — the slot law · the identity stamp · the sandbox')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { runConsoleAsk, consoleAskFraming, CONSOLE_ROLE } = await import(
  '../../src/utils/cockpit/helmConsoleAsk.ts'
)
const { resolveSubModel, setSubModel, subModelIdentityLine, SUB_MODEL_UNSET_HINT } = await import(
  '../../src/utils/model/subModelSlots.ts'
)
const { sideQuestionTurn, SIDE_QUESTION_FRAMING } = await import('../../src/utils/sideQuestion.ts')
const { providerDisplayName } = await import('../../src/services/providers/routeLaw.ts')

section('(1) UNSET console ⇒ the hint · zero wire requests · zero context reads · no usage')
{
  check('the console resolves UNSET on a fresh home', resolveSubModel('console').origin === 'unset')
  const realFetch = globalThis.fetch
  let wireCalls = 0
  globalThis.fetch = (async () => {
    wireCalls++
    throw new Error('the wire must never be reached by an unset console')
  }) as unknown as typeof fetch
  const context = new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`context read on an unset ask: ${String(prop)}`)
      },
    },
  ) as never
  let res: Awaited<ReturnType<typeof runConsoleAsk>> | null = null
  let thrown: unknown = null
  try {
    res = await runConsoleAsk({
      question: 'what model are you',
      context,
      abortController: new AbortController(),
      originRef: 'mercury://interview/fixture',
    })
  } catch (e) {
    thrown = e
  }
  globalThis.fetch = realFetch
  check('the ask settles (no throw — the context was never read)', thrown === null && res !== null, String(thrown))
  check(
    'the reply IS the hint, verbatim',
    res?.response === SUB_MODEL_UNSET_HINT,
    JSON.stringify(res?.response),
  )
  check('the hint is the ruling\'s words', SUB_MODEL_UNSET_HINT === 'use /submodels to pin one of the available model catalogues')
  check('no usage rides the entry (nothing was spent)', res !== null && res.usage === undefined)
  check('the parentage still echoes onto the entry', res?.originRef === 'mercury://interview/fixture')
  check('ZERO wire requests', wireCalls === 0, String(wireCalls))
}

section('(2) a pinned console rides the stamped identity + the console ROLE in the user turn')
{
  const reads = {
    options: () => [{ value: 'opus', label: 'Opus 4.8', description: '' }],
    presences: () => [{ id: 'anthropic', available: true, credentialed: true, credentialLabel: 'Claude subscription (max)' }],
    providers: () => [] as never,
  } as never
  const wrote = setSubModel('console', 'opus', reads)
  const pin = resolveSubModel('console')
  check('the pick lands as a saved pin', wrote.ok && pin.origin === 'saved', JSON.stringify([wrote, pin]))
  if (pin.origin !== 'unset') {
    const framing = consoleAskFraming(pin)
    const identity = subModelIdentityLine('console', pin)
    check('the framing OPENS with the identity line (the one writer)', framing.startsWith(identity))
    check(
      'the identity line carries the resolved model id, quoted, and the wire display name',
      identity.includes(`model id "${pin.model}"`) && identity.includes(`via the ${providerDisplayName(pin.route)} wire`),
      identity,
    )
    check('…as a harness-stamped fact', identity.includes('stamped by the Mercury harness'))
    check('the framing carries the console ROLE verbatim', framing.endsWith(CONSOLE_ROLE))
    check(
      'the role: questions about the session and the project',
      CONSOLE_ROLE.includes('answers the operator\'s questions ABOUT this session and this project'),
    )
    check(
      'the role: not the main agent — its work is never claimed as the console\'s own',
      CONSOLE_ROLE.includes('not Mercury\'s main agent') && CONSOLE_ROLE.includes('never as your own'),
    )
    check('the role: no tools, no follow-up turn', CONSOLE_ROLE.includes('You have no tools') && CONSOLE_ROLE.includes('no follow-up turn'))
    check(
      'the role: states itself when asked',
      CONSOLE_ROLE.includes('When asked what your job or role is') && CONSOLE_ROLE.includes('you are the console, answering questions about the session and the project'),
    )
    const turn = sideQuestionTurn('what model are you', framing)
    check(
      'the user turn wraps framing + question in ONE system-reminder',
      turn.startsWith('<system-reminder>\n') &&
        turn.includes(framing) &&
        turn.endsWith('\nSide question: what model are you\n</system-reminder>'),
    )
    check(
      'the framing never re-spells the id: the turn names it exactly once per identity line',
      (turn.match(new RegExp(`model id "${pin.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g')) ?? []).length === 1,
    )
  }
  check(
    'the /btw turn is the shared framing + the question (unchanged shape)',
    sideQuestionTurn('q') === `<system-reminder>\n${SIDE_QUESTION_FRAMING}\nSide question: q\n</system-reminder>`,
  )
  check(
    'the /btw framing still says separate agent · no tools · single response',
    SIDE_QUESTION_FRAMING.includes('separate lightweight agent') &&
      SIDE_QUESTION_FRAMING.includes('You have no tools') &&
      SIDE_QUESTION_FRAMING.includes('single response'),
  )
  process.env.MERCURY_CONSOLE_MODEL = 'kimi-k3'
  const envPin = resolveSubModel('console')
  check(
    'an env pin\'s id rides the framing (the resolver decides, never the saved pick)',
    envPin.origin === 'env' && consoleAskFraming(envPin).includes('model id "kimi-k3"'),
  )
  delete process.env.MERCURY_CONSOLE_MODEL
  setSubModel('console', null, reads)
}

section('(3) the sandbox boundary — source pins at the owners')
{
  const ask = read('src/utils/cockpit/helmConsoleAsk.ts')
  const unsetReturn = ask.indexOf("if (slot.origin === 'unset')")
  check('the unset answer is decided BEFORE the context is read', unsetReturn !== -1 && unsetReturn < ask.indexOf('getMessagesAfterCompactBoundary('))
  check('…and BEFORE any activity stamp (no wake for a hint)', unsetReturn < ask.indexOf('noteCritterRealActivity()'))
  check('the fork call carries the console framing', /framing: consoleAskFraming\(slot\)/.test(ask))
  check('the console engine imports no tool executor and no permission channel', !ask.includes('toolExecution') && !ask.includes('useCanUseTool') && !ask.includes('permissions/'))

  const side = read('src/utils/sideQuestion.ts')
  check('the fork\'s canUseTool is a constant DENY', /canUseTool: async \(_tool, _input\) =>[\s\S]*?behavior: 'deny'/.test(side))
  check('ONE turn, no cache write', side.includes('maxTurns: 1') && side.includes('skipCacheWrite: true'))
  check(
    'the framing rides the USER turn (createUserMessage), never a systemPrompt field',
    side.includes('createUserMessage({ content: sideQuestionTurn(question, framing) })') && !/systemPrompt:/.test(side),
  )
  check('the fork shares no app-state setter and no abort controller with the parent', !side.includes('shareSetAppState') && !side.includes('shareAbortController'))

  const fork = read('src/utils/forkedAgent.ts')
  check(
    'the fork context avoids permission prompts (a cloned state, prompts suppressed) and gets a no-op setter by default',
    fork.includes('shouldAvoidPermissionPrompts: true') && fork.includes("overrides.shareSetAppState ? parentContext.setAppState : () => {}"),
  )
  check(
    'the fork records a SIDECHAIN transcript under its own agent id (never the main chain)',
    fork.includes('recordSidechainTranscript(messages, agentId)') && fork.includes('createAgentId(label)'),
  )
  const writer = read('src/utils/sessionStorage/writer.ts')
  check(
    'recordSidechainTranscript inserts with the sidechain flag set',
    /insertMessageChain\(\s*cleanMessagesForLogging\(messages\),\s*true,/.test(writer),
  )

  const toolExec = read('src/services/tools/toolExecution.ts')
  const nonAllow = toolExec.indexOf("if (decision.behavior !== 'allow') {")
  const executeStep = toolExec.indexOf('const decisionUpdatedInput = (decision as { updatedInput?: AnyObject }).updatedInput')
  check(
    'a denied tool call returns BEFORE the execution steps (the non-allow return precedes the updated-input adoption)',
    nonAllow !== -1 && executeStep !== -1 && nonAllow < executeStep && toolExec.slice(nonAllow, executeStep).includes('return'),
  )

  const minerva = read('src/utils/tabula/minerva.ts')
  check('Minerva dispatches through queryWithModel only (no fork, no tool loop)', (minerva.match(/queryWithModel\(/g) ?? []).length === 2 && !minerva.includes('runForkedAgent') && !minerva.includes('canUseTool'))
  const core = read('src/services/providers/anthropic/streamCore.ts')
  const qwm = core.slice(core.indexOf('export async function queryWithModel('))
  check(
    'queryWithModel sends NO tools and an EMPTY permission context',
    qwm.includes('tools: [],') && qwm.includes('getEmptyToolPermissionContext()'),
  )
  const console_ = read('src/utils/cockpit/helmConsole.ts')
  check(
    'the console store keeps answers out of the main conversation (no transcript writer, no message push)',
    !console_.includes('sessionStorage') && !console_.includes('recordTranscript') && !console_.includes('addMessage'),
  )
}

console.log('')
if (failures > 0) {
  console.error(`prove-console-ask: ${failures} failure(s)`)
  process.exit(1)
}
console.log('prove-console-ask: all green')
