#!/usr/bin/env bun
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
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
if (!(process.env.SHELL ?? '').includes('bash') && existsSync('/bin/bash')) process.env.SHELL = '/bin/bash'

let failures = 0
const sessionEnvFixHint = 'change src/platform/substrate/envStamps.ts (sessionEnvStamps, scrubSessionEnvStamps, stampSpawnReceipt, spawnSelfStamped), the exec scrub in src/platform/shell/shellExec.ts, or src/tools/kit/sessionEnvNotice.ts (sessionEnvNoticeForResult), whichever the failed label names'
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ' — ' + (detail ? detail + ' | ' : '') + sessionEnvFixHint : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const poisoned = process.env.MERCURY_PROOF_POISON_SCRUB === '1'
delete process.env.MERCURY_PROOF_POISON_SCRUB

for (const name of Object.keys(process.env)) {
  if (name.startsWith('MERCURY_') && !['MERCURY_CONFIG_DIR', 'MERCURY_CREDENTIAL_STORE'].includes(name)) delete process.env[name]
}

const { FLAG_REGISTRY, getFlagSpec, setFlagEnv, deleteFlagEnv, selfWrittenFlagEnv } = await import('../../src/platform/substrate/flagRegistry.ts')
const { SPAWN_STAMP_RECEIPT, sessionEnvStamps, scrubSessionEnvStamps, spawnSelfStamped, stampSpawnReceipt } = await import(
  '../../src/platform/substrate/envStamps.ts'
)

console.log('============================================================')
console.log(' Tool shell — the session env scrub')
console.log('============================================================')

section('§1 attribution: four carriers, and an operator pin stays')
const receiptRow = getFlagSpec(SPAWN_STAMP_RECEIPT)
check('the spawn receipt is a registered self-stamped value row', receiptRow?.kind === 'value' && receiptRow.selfStamped === true)
check('MERCURY_ENTRYPOINT is self-stamped (the boot identity row)', getFlagSpec('MERCURY_ENTRYPOINT')?.selfStamped === true)

const planted: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  MERCURY_ENTRYPOINT: 'cli',
  MERCURY_BOOT_ENV_APPLIED: JSON.stringify({ MERCURY_GODOT_TOOLS: '1', MERCURY_SKIP_PERMISSIONS: '1' }),
  MERCURY_GODOT_TOOLS: '1',
  MERCURY_SKIP_PERMISSIONS: '0',
  MERCURY_SEATS: '2',
  MERCURY_MODEL: 'claimed-later',
  MERCURY_MODEL_LANES: '1',
}
stampSpawnReceipt(planted, ['MERCURY_SEATS', 'MERCURY_MODEL'])
planted.MERCURY_MODEL = 'a-claim-rewrote-it'
const receipt = spawnSelfStamped(planted)
check('the spawn receipt names the stamped variables with the values written', receipt.get('MERCURY_SEATS') === '2' && receipt.get('MERCURY_MODEL') === 'claimed-later')
stampSpawnReceipt(planted, ['MERCURY_WORKER_PARENT_PID'])
check('a receipt stamped again merges (an ancestor\'s names survive a child\'s spawn)', spawnSelfStamped(planted).has('MERCURY_SEATS'), [...spawnSelfStamped(planted).keys()].join(','))
check('a name whose value is absent is not recorded', !spawnSelfStamped(planted).has('MERCURY_WORKER_PARENT_PID'))

const stamps = sessionEnvStamps(planted)
check('the self-stamped row is a stamp', stamps.includes('MERCURY_ENTRYPOINT'))
check('the receipts themselves are stamps', stamps.includes('MERCURY_BOOT_ENV_APPLIED') && stamps.includes(SPAWN_STAMP_RECEIPT))
check("the boot receipt's intact copy is a stamp", stamps.includes('MERCURY_GODOT_TOOLS'))
check("a boot-applied row whose value diverged from the receipt is a pin (something set it on purpose)", !stamps.includes('MERCURY_SKIP_PERMISSIONS'))
check("the spawner's names are stamps by name, whatever the value now", stamps.includes('MERCURY_SEATS') && stamps.includes('MERCURY_MODEL'))
check('an operator pin with no carrier stays', !stamps.includes('MERCURY_MODEL_LANES'))
check('the answer is sorted', JSON.stringify(stamps) === JSON.stringify([...stamps].sort()))

setFlagEnv('MERCURY_BARE', '1')
check('a flag this process wrote through the bounded writer is in its ledger', selfWrittenFlagEnv().get('MERCURY_BARE') === '1')
check('…and reads as a stamp in an env holding that value', sessionEnvStamps({ MERCURY_BARE: '1' }).includes('MERCURY_BARE'))
check('…but not when the env holds another value (the operator set it)', !sessionEnvStamps({ MERCURY_BARE: '0' }).includes('MERCURY_BARE'))
deleteFlagEnv('MERCURY_BARE')
check('the paired delete clears the ledger row', !selfWrittenFlagEnv().has('MERCURY_BARE') && !sessionEnvStamps({ MERCURY_BARE: '1' }).includes('MERCURY_BARE'))

const scrub = scrubSessionEnvStamps(planted)
check('the scrub removes exactly the stamps and reports them', JSON.stringify(scrub.scrubbed) === JSON.stringify(stamps) && stamps.every(n => scrub.env[n] === undefined))
check('the scrub keeps the pin and the diverged row', scrub.env.MERCURY_MODEL_LANES === '1' && scrub.env.MERCURY_SKIP_PERMISSIONS === '0')
check('the scrub never mutates the object handed in', planted.MERCURY_ENTRYPOINT === 'cli' && planted.MERCURY_SEATS === '2')
const untouched: NodeJS.ProcessEnv = { PATH: process.env.PATH, MERCURY_MODEL_LANES: '1' }
const nothing = scrubSessionEnvStamps(untouched)
check('with nothing to scrub the same object comes back and the list is empty', nothing.env === untouched && nothing.scrubbed.length === 0)
check('a malformed receipt attributes nothing (the safe side)', sessionEnvStamps({ MERCURY_SPAWNED_ENV: '{not json', MERCURY_SEATS: '2' }).join(',') === 'MERCURY_SPAWNED_ENV')
check('every self-stamped row is a value row', FLAG_REGISTRY.filter(f => f.selfStamped === true).every(f => f.kind === 'value'))
for (const [name, consumer] of [
  ['MERCURY_SUITE_ENV', 'scripts/lib/suite-env.sh'],
  ['MERCURY_PROOF_POISON_SCRUB', 'scripts/bash/prove-shell-session-env.ts'],
  ['MERCURY_PROOF_POISON_GUARD', 'scripts/gate/prove-suite-env-guard.sh'],
  ['MERCURY_SLICE_ROOT', 'scripts/verify/impact.ts'],
  ['MERCURY_SUITE_TIMEOUT', 'scripts/gate/ci-shard.sh'],
  ['MERCURY_SUITE_CEILING', 'scripts/gate/ci-shard.sh'],
]) check(`script environment reader ${name} has its actual consumer registered`, getFlagSpec(name!)?.consumer === consumer && readFileSync(join(ROOT, consumer!), 'utf8').includes(name!))

section('§2 the exec seam: scrubbed by default, named on the handle, inherited on request')
const { exec, setCwd } = await import('../../src/platform/shell/shellExec.ts')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'session-env-scrub-')))
setCwd(SCRATCH)

process.env.MERCURY_ENTRYPOINT = 'cli'
process.env.MERCURY_BOOT_ENV_APPLIED = JSON.stringify({ MERCURY_GODOT_TOOLS: '1' })
process.env.MERCURY_GODOT_TOOLS = '1'
process.env.MERCURY_SEATS = '2'
stampSpawnReceipt(process.env, ['MERCURY_SEATS'])
setFlagEnv('MERCURY_BARE', '1')
process.env.MERCURY_MODEL_LANES = '1'
const expectScrubbed = ['MERCURY_BARE', 'MERCURY_BOOT_ENV_APPLIED', 'MERCURY_ENTRYPOINT', 'MERCURY_GODOT_TOOLS', 'MERCURY_SEATS', SPAWN_STAMP_RECEIPT].sort()

async function childEnv(inherit: boolean): Promise<{ env: Map<string, string>; scrubbed: readonly string[]; code: number }> {
  const out = join(SCRATCH, `env-${inherit ? 'inherit' : 'scrub'}.txt`)
  const handle = await exec(`env > ${JSON.stringify(out)}`, new AbortController().signal, 'bash', {
    timeout: 20_000,
    shouldAutoBackground: false,
    ...(inherit ? { inheritSessionEnv: true } : {}),
  })
  const result = await handle.result
  const env = new Map<string, string>()
  for (const line of readFileSync(out, 'utf8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env.set(line.slice(0, eq), line.slice(eq + 1))
  }
  return { env, scrubbed: handle.scrubbedSessionEnv ?? [], code: result.code }
}

const scrubbedRun = await childEnv(false)
check('the command ran', scrubbedRun.code === 0)
check('the child sees none of the stamps by default', expectScrubbed.every(n => !scrubbedRun.env.has(n)), expectScrubbed.filter(n => scrubbedRun.env.has(n)).join(','))
check('the child keeps the operator pin', scrubbedRun.env.get('MERCURY_MODEL_LANES') === '1')
check('the child still carries the MERCURY=1 marker (not a stamp)', scrubbedRun.env.get('MERCURY') === '1')
check('the handle names exactly the scrubbed set', JSON.stringify([...scrubbedRun.scrubbed]) === JSON.stringify(expectScrubbed), JSON.stringify(scrubbedRun.scrubbed))

const inheritRun = await childEnv(true)
check('an inheriting call hands the child every stamp', poisoned ? expectScrubbed.every(n => !inheritRun.env.has(n)) : expectScrubbed.every(n => inheritRun.env.has(n)), expectScrubbed.filter(n => !inheritRun.env.has(n)).join(','))
check('…and the handle reports nothing scrubbed', inheritRun.scrubbed.length === 0)
check('…with the pin present too', inheritRun.env.get('MERCURY_MODEL_LANES') === '1')

section('§3 the tools: the inherit input and the result notice')
const { scrubbedSessionEnvNotice, sessionEnvNoticeForResult, shortScrubbedSessionEnvNotice, resetSessionEnvNoticeOnFold } = await import('../../src/tools/kit/sessionEnvNotice.ts')
const { disposeOwner } = await import('../../src/engine/run-owner/ownerLifecycle.ts')
const { processMainOwner } = await import('../../src/engine/run-owner/resolveOwner.ts')
const notice = scrubbedSessionEnvNotice(['MERCURY_ENTRYPOINT', 'MERCURY_SEATS'])
check('the notice names the scrubbed variables and the inherit input', notice.includes('MERCURY_ENTRYPOINT, MERCURY_SEATS') && notice.includes('inherit_session_env'))
check('no notice when nothing was scrubbed', scrubbedSessionEnvNotice([]) === '' && scrubbedSessionEnvNotice(undefined) === '')

section('§3b once per session: the full note first, then nothing unless the command names a scrubbed stamp')
await disposeOwner(processMainOwner())
const scrubbedSet = ['MERCURY_ENTRYPOINT', 'MERCURY_MODEL', 'MERCURY_SEATS']
const first = sessionEnvNoticeForResult({ scrubbed: scrubbedSet, commandText: 'ls -la' })
check('the first scrubbing result carries the full note with the inherit hint', first === scrubbedSessionEnvNotice(scrubbedSet) && first.includes('inherit_session_env'))
const second = sessionEnvNoticeForResult({ scrubbed: scrubbedSet, commandText: 'echo hello' })
check('a later result whose command names no stamp carries nothing', second === '')
const third = sessionEnvNoticeForResult({ scrubbed: scrubbedSet, commandText: 'echo "$MERCURY_MODEL"' })
check('a later result whose command names a stamp carries only the short line for that stamp', third === shortScrubbedSessionEnvNotice(['MERCURY_MODEL']) && third === '[session env scrubbed: MERCURY_MODEL]' && !third.includes('inherit_session_env'))
const fourth = sessionEnvNoticeForResult({ scrubbed: scrubbedSet, commandText: 'printf %s "$MERCURY_SEATS-$MERCURY_ENTRYPOINT"' })
check('the short line names every stamp the command referenced, in the scrubbed order', fourth === '[session env scrubbed: MERCURY_ENTRYPOINT, MERCURY_SEATS]')
await disposeOwner(processMainOwner())
check('a call that scrubbed nothing carries nothing even as the first of a session', sessionEnvNoticeForResult({ scrubbed: [], commandText: 'echo $MERCURY_MODEL' }) === '' && sessionEnvNoticeForResult({ scrubbed: undefined, commandText: 'x' }) === '')
await disposeOwner(processMainOwner())
sessionEnvNoticeForResult({ scrubbed: scrubbedSet, commandText: 'ls' })
const afterCompaction = (resetSessionEnvNoticeOnFold(), sessionEnvNoticeForResult({ scrubbed: scrubbedSet, commandText: 'ls' }))
check('a compaction resets the latch, so the first result after the fold carries the full note again', afterCompaction === scrubbedSessionEnvNotice(scrubbedSet) && afterCompaction.includes('inherit_session_env'))
const t = await import('../core-runtime/turnScenarios.ts')
const noticeAfterARun = async (plan: Parameters<typeof t.runScripted>[0]): Promise<{ folded: boolean; notice: string }> => {
  let notice = ''
  const run = await t.runScripted({
    ...plan,
    before: () => {
      sessionEnvNoticeForResult({ scrubbed: scrubbedSet, commandText: 'ls' })
      return () => {
        notice = sessionEnvNoticeForResult({ scrubbed: scrubbedSet, commandText: 'ls' })
        void disposeOwner(processMainOwner())
      }
    },
  })
  return { folded: run.events.some(event => event.kind === 'compaction_boundary'), notice }
}
const acrossAFold = await noticeAfterARun({ seed: [t.fixtures.ask('hello there rig'), t.fixtures.fat('old fat turn', 700)], autocompact: [t.fixtures.folded()], script: [t.fixtures.yields(t.fixtures.says('the turn after the fold.'))] })
const acrossNoFold = await noticeAfterARun({ script: [t.fixtures.yields(t.fixtures.says('a turn with no fold.'))] })
check(
  'the turn machine resets the notice latch at the compaction boundary',
  acrossAFold.folded && acrossAFold.notice === scrubbedSessionEnvNotice(scrubbedSet) && !acrossNoFold.folded && acrossNoFold.notice === '',
  `after a run in which a fold landed (boundary seen: ${acrossAFold.folded}) the next scrubbing result carried ${JSON.stringify(acrossAFold.notice)} (the full note is right); after a run with no fold (boundary seen: ${acrossNoFold.folded}) it carried ${JSON.stringify(acrossNoFold.notice)} (nothing is right) — makeRequest in src/engine/loop/turn/makeRequest.ts resets the once-per-session latch where it yields the compaction boundary`,
)
await disposeOwner(processMainOwner())
const { normalizeToolInput } = await import('../../src/engine/messages/apiSystemAndToolSchema.ts')
const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
const normalized = normalizeToolInput(BashTool as never, { command: 'env', inherit_session_env: true }) as { inherit_session_env?: boolean }
check('the tool-input normaliser keeps inherit_session_env on its way to execution', normalized.inherit_session_env === true, JSON.stringify(normalized))

section("§4 the owned daemon's extra stamps ride its receipt: a runner's tool shell scrubs them and a suite guard inside it runs")
const daemonEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, MERCURY_DAEMON_OWNER_PID: '4242', MERCURY_DAEMON_SELF_WARM_CONSENT: '1' }
stampSpawnReceipt(daemonEnv, ['MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_SELF_WARM_CONSENT'])
check('the consent stamp the receipt names is a session stamp', sessionEnvStamps(daemonEnv).includes('MERCURY_DAEMON_SELF_WARM_CONSENT'), JSON.stringify(sessionEnvStamps(daemonEnv)))
check('…and the same value with no carrier stays, as an operator pin would', !sessionEnvStamps({ PATH: process.env.PATH, MERCURY_DAEMON_SELF_WARM_CONSENT: '1' }).includes('MERCURY_DAEMON_SELF_WARM_CONSENT'))
delete process.env.MERCURY_MODEL_LANES
process.env.MERCURY_DAEMON_SELF_WARM_CONSENT = '1'
stampSpawnReceipt(process.env, ['MERCURY_DAEMON_SELF_WARM_CONSENT'])
const guardCommand = `. ${JSON.stringify(join(ROOT, 'scripts/lib/suite-env.sh'))} && suite_env_guard ${JSON.stringify(join(ROOT, 'scripts/substrate/run-all.sh'))} && echo guard-admitted-the-shell`
async function guardRun(inherit: boolean): Promise<{ code: number; text: string }> {
  const handle = await exec(guardCommand, new AbortController().signal, 'bash', { timeout: 20_000, shouldAutoBackground: false, ...(inherit ? { inheritSessionEnv: true } : {}) })
  const result = await handle.result
  return { code: result.code, text: `${result.stdout}\n${result.stderr}` }
}
const guarded = await guardRun(false)
check('a suite guard run from the tool shell admits the shell: the session stamps, the consent stamp included, never reach it', guarded.code === 0 && guarded.text.includes('guard-admitted-the-shell'), `rc=${guarded.code} ${guarded.text.trim().slice(0, 300)}`)
const inheritedGuard = await guardRun(true)
check('the same guard refuses an inheriting call, naming the consent stamp among the foreign values (the guard stays strict)', poisoned ? inheritedGuard.code === 0 : inheritedGuard.code === 78 && inheritedGuard.text.includes('MERCURY_DAEMON_SELF_WARM_CONSENT'), `rc=${inheritedGuard.code} ${inheritedGuard.text.trim().slice(0, 300)}`)

const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
let appState = getDefaultAppState()
const toolContext = {
  options: { engineModel: 'claude-sonnet-5', tools: [], commands: [], mcpClients: [], mcpResources: {} },
  readFileState: new Map(),
  getAppState: () => appState,
  setAppState: (update: (state: typeof appState) => typeof appState) => { appState = update(appState) },
  abortController: new AbortController(),
  toolUseId: 'scrub-command',
} as never
let failureText = ''
await disposeOwner(processMainOwner())
const { formatError } = await import('../../src/tools/kit/toolErrors.ts')
let failureStderr = ''
try { await BashTool.call({ command: 'exit 7' }, toolContext) } catch (error) { failureText = formatError(error); failureStderr = String((error as { stderr?: string }).stderr ?? '') }
check('a failed real Bash tool call preserves the scrub notice and exit in what the model reads', failureText.includes('MERCURY_ENTRYPOINT') && failureText.includes('inherit_session_env') && failureText.includes('7'), failureText)
check("the notice is the result's own line, not part of the command's stderr (the operator's `!` card paints stderr alone)", !failureStderr.includes('session env scrubbed'), failureStderr)
const background = await BashTool.call({ command: 'sleep 2', run_in_background: true }, toolContext)
check('a real background launch carries the scrubbed names', background.data.backgroundTaskId !== undefined && background.data.scrubbedSessionEnv?.includes('MERCURY_ENTRYPOINT') === true, JSON.stringify(background.data))
const running = appState.tasks[background.data.backgroundTaskId ?? ''] as unknown as { shellCommand?: { result: Promise<unknown> } }
await running?.shellCommand?.result
const interruptedController = new AbortController()
let interruptedText = ''
let interruptionSent = false
await disposeOwner(processMainOwner())
try {
  const result = await BashTool.call({ command: 'while :; do printf "ready\\n"; sleep 0.2; done' }, { ...toolContext, abortController: interruptedController } as never, undefined, undefined, () => { interruptionSent = true; interruptedController.abort('proof-cancel') })
  interruptedText = JSON.stringify(BashTool.mapToolResultToToolResultBlockParam(result.data, 'interrupted'))
} catch (error) { interruptedText = formatError(error) }
check('an interrupted real Bash call preserves scrub attribution in what the model reads', interruptionSent && interruptedText.includes('MERCURY_ENTRYPOINT'), interruptedText)
await disposeOwner(processMainOwner())
rmSync(SCRATCH, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
