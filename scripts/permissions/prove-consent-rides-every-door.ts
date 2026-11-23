#!/usr/bin/env bun
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'sovereign-doors-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
delete process.env.MERCURY_DAEMON_PERMISSION_MODE
delete process.env.MERCURY_WARM_RUNNER
delete process.env.MERCURY_DAEMON_NO_SELF_WARM
delete process.env.MERCURY_SKIP_PERMISSIONS
writeFileSync(
  join(HOME, '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fixture', refreshToken: 'sk-ant-ort01-fixture', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
)
const PROJ = mkdtempSync(join(tmpdir(), 'sovereign-doors-proj-'))
process.chdir(PROJ)


let failures = 0
const doorHints: Record<string, string> = {
  '§1': 'to fix, look at initializeToolPermissionContext in src/permissions/rules/permissionSetup.ts (how the allow and skip flags set isBypassPermissionsModeAvailable)',
  '§2': 'to fix, look at bootBirthFacts, setBootBirthFacts and carriedConsentOf in src/daemon/switchboard/bootBirthFacts.ts',
  '§3': 'to fix, look at buildConcourseWorkerSpec in src/daemon/concourse-workers/concourseWorkers.ts and buildRunnerInvocation in src/daemon/runner-link/headlessRun.ts (where the consent becomes argv)',
  '§4': 'to fix, look at headlessPermissionArgv in src/daemon/runner-link/headlessRun.ts',
  '§5': 'to fix, look at ensureWarmRunner and claimWarmRunner in src/daemon/runner-link/warmRunner.ts (the consent gate on the warm pool)',
  '§7': 'to fix, look at buildRunnerInvocation in src/daemon/runner-link/headlessRun.ts and resolvePermissionModeTransition in src/daemon/runner/controlHandlers.ts',
  '§8': 'to fix, look at carriedTypedModeOf in src/daemon/switchboard/bootBirthFacts.ts (what the launch carries) and buildConcourseWorkerSpec in src/daemon/concourse-workers/spec.ts (what the seat keeps)',
}
let doorHint = ''
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${cond || doorHint === '' ? '' : ` — ${doorHint}`}`)
  if (!cond) failures++
}
const section = (t: string): void => {
  doorHint = doorHints[t.slice(0, 2)] ?? ''
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const { enableConfigs, saveGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))

const { initializeToolPermissionContext } = await import('../../src/permissions/rules/permissionSetup.ts')
const facts = await import('../../src/daemon/switchboard/bootBirthFacts.ts')
const { buildConcourseWorkerSpec } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { buildRunnerInvocation, headlessPermissionArgv } = await import('../../src/daemon/runner-link/headlessRun.ts')
const { deriveSessionKitForWorkspace } = await import('../../src/daemon/session-seat/sessionKit.ts')
const warm = await import('../../src/daemon/runner-link/warmRunner.ts')
const { standInRunner } = await import('../lib/seatDoor.ts')
type StandInRunner = ReturnType<typeof standInRunner>
type RunnerDoor = import('../../src/daemon/runner-link/runnerConnection.ts').RunnerDoor
const { resolvePermissionModeTransition } = await import('../../src/daemon/runner/controlHandlers.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')

const SKIP = '--sovereign'
const ALLOW = '--allow-sovereign'

console.log('============================================================')
console.log(' the launch consent rides every door — the unit half')
console.log('============================================================')

section('§1 the one owner: the permission context maps the launch consent')
{
  const ctx = async (permissionMode: 'default' | 'sovereign', allow: boolean): Promise<boolean> =>
    (await initializeToolPermissionContext({ allowedToolsCli: [], disallowedToolsCli: [], permissionMode, allowDangerouslySkipPermissions: allow })).toolPermissionContext
      .isBypassPermissionsModeAvailable
  check('the skip flag (a sovereign posture) ⇒ the station is available', (await ctx('sovereign', false)) === true)
  check('the allow flag (a default posture) ⇒ the station is available', (await ctx('default', true)) === true)
  check('no consent ⇒ the station is NOT available (the control)', (await ctx('default', false)) === false)
}

section('§2 the birth-facts record carries the consent; the carry never spells false')
{
  facts._resetBootBirthFactsForTesting()
  check('a fresh record carries NO consent', facts.bootBirthFacts().bypassConsent === false)
  check('the carry of no consent is NOTHING (absent on the wire)', Object.keys(facts.carriedConsentOf(facts.bootBirthFacts())).length === 0)
  facts.setBootBirthFacts({ bypassConsent: true })
  check('the boot writes the consent once; every later read sees it (sticky)', facts.bootBirthFacts().bypassConsent === true && facts.bootBirthFacts().bypassConsent === true)
  check('the carry of consent spells exactly { bypassConsent: true }', JSON.stringify(facts.carriedConsentOf(facts.bootBirthFacts())) === JSON.stringify({ bypassConsent: true }))
  facts.setBootBirthFacts({ title: 'x' })
  check('an unrelated facts write leaves the consent standing', facts.bootBirthFacts().bypassConsent === true)
  facts._resetBootBirthFactsForTesting()
  check('the proof reset clears it', facts.bootBirthFacts().bypassConsent === false)
}

section('§3 the seat spec carries the consent into the runner argv')
{
  const argvOf = (extra: { permissionMode?: 'default' | 'sovereign' | 'flow'; bypassConsent?: true; warm?: true }): string[] =>
    buildRunnerInvocation(
      buildConcourseWorkerSpec({
        runnerId: 'concourse-w9',
        ...(extra.warm ? { warm: true } : { sessionId: '00000000-0000-4000-8000-000000000001' }),
        workspaceId: PROJ,
        modelKey: 'claude-sonnet-5',
        ...(extra.permissionMode !== undefined ? { permissionMode: extra.permissionMode } : {}),
        ...(extra.bypassConsent ? { bypassConsent: true } : {}),
      }),
    ).argv
  const consentedDefault = argvOf({ permissionMode: 'default', bypassConsent: true })
  check('consent + default posture ⇒ the allow flag rides, the skip flag does not', consentedDefault.includes(ALLOW) && !consentedDefault.includes(SKIP))
  const consentedSovereign = argvOf({ permissionMode: 'sovereign', bypassConsent: true })
  check('consent + sovereign posture ⇒ the skip flag alone (it implies the consent)', consentedSovereign.includes(SKIP) && !consentedSovereign.includes(ALLOW) && !consentedSovereign.includes('--mode'))
  const consentedFlow = argvOf({ permissionMode: 'flow', bypassConsent: true })
  check('consent + flow posture ⇒ --mode flow AND the allow flag', consentedFlow.includes(ALLOW) && consentedFlow[consentedFlow.indexOf('--mode') + 1] === 'flow')
  const plain = argvOf({ permissionMode: 'default' })
  check('no consent ⇒ neither bypass word (the control)', !plain.includes(ALLOW) && !plain.includes(SKIP))
  const warmConsented = argvOf({ bypassConsent: true, warm: true })
  check('the WARM spec carries the consent the same way (the pool boots the station)', warmConsented.includes(ALLOW) && !warmConsented.includes('--session-id'))
  const warmPlain = argvOf({ warm: true })
  check('the WARM spec without consent carries no bypass word', !warmPlain.includes(ALLOW) && !warmPlain.includes(SKIP))
}

section('§4 headlessPermissionArgv: posture words plus the allow flag when consented')
{
  const same = (a: string[], b: string[]): boolean => JSON.stringify(a) === JSON.stringify(b)
  check('(default, consent) ⇒ [allow]', same(headlessPermissionArgv('default', true), [ALLOW]))
  check('(flow, consent) ⇒ [--mode, flow, allow]', same(headlessPermissionArgv('flow', true), ['--mode', 'flow', ALLOW]))
  check('(sovereign, consent) ⇒ [skip] alone', same(headlessPermissionArgv('sovereign', true), [SKIP]))
  check('(sovereign, no consent) ⇒ [skip] — unchanged', same(headlessPermissionArgv('sovereign'), [SKIP]))
  check('(default, no consent) ⇒ [] — unchanged', same(headlessPermissionArgv('default'), []))
  check('(implement, no consent) ⇒ [--mode, implement] — unchanged', same(headlessPermissionArgv('implement'), ['--mode', 'implement']))
}

section("§5 the warm pool's consent gate (the kit gate's twin) on the real policy")
{
  type Spec = ReturnType<typeof buildConcourseWorkerSpec>
  class FakeRoster {
    registered: Array<{ short: string; spec: Spec }> = []
    stands = new Map<string, StandInRunner>()
    claims: Array<{ short: string; params: Record<string, unknown> }> = []
    killed: string[] = []
    present = new Map<string, { alive: boolean; ready: boolean }>()
    has(short: string): { alive: boolean; present: boolean; ready: boolean } {
      const p = this.present.get(short)
      return p ? { present: true, alive: p.alive, ready: p.ready } : { present: false, alive: false, ready: false }
    }
    list(): Array<{ short: string; outcome?: string }> {
      return [...this.present.keys()].map(short => ({ short }))
    }
    registerLongLived(short: string, spec: Spec): { ok: boolean; pid?: number; error?: string } {
      this.registered.push({ short, spec })
      this.present.set(short, { alive: true, ready: true })
      const stand = standInRunner({
        sessionId: null,
        autoAnswer: {
          'session/claim': (params: unknown) => {
            const claim = params as Record<string, unknown>
            this.claims.push({ short, params: claim })
            return { session_id: String(claim.session_id) }
          },
        },
      })
      this.stands.set(short, stand)
      return { ok: true, pid: process.pid }
    }
    door(short: string): RunnerDoor | undefined {
      const stand = this.stands.get(short)
      return stand === undefined || stand.connection.closed ? undefined : stand.connection
    }
    kill(short: string): boolean {
      this.killed.push(short)
      this.present.delete(short)
      this.stands.get(short)?.close('killed')
      this.stands.delete(short)
      return true
    }
    patchSeatClaim(short: string, patch: { model: string; effort: string; respawnExtraArgv: readonly string[] }): Spec | null {
      const reg = this.registered.find(r => r.short === short)
      if (!reg) return null
      return { ...reg.spec, model: patch.model, effort: patch.effort, respawnExtraArgv: [...patch.respawnExtraArgv] }
    }
  }
  const recordsDir = mkdtempSync(join(tmpdir(), 'sovereign-doors-daemon-'))
  const roster = new FakeRoster()
  const deps = { roster: () => roster, dir: recordsDir }
  const ws = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'sovereign-doors-ws-')))
  const claim = (workspaceDir: string, bypassConsent: boolean, permissionMode: string) =>
    warm.claimWarmRunner(
      { workspaceId: workspaceDir, sessionId: '00000000-0000-4000-8000-00000000000a', modelKey: 'claude-sonnet-5', effort: 'high', permissionMode, bypassConsent, kit: deriveSessionKitForWorkspace(workspaceDir), answerDeadlineMs: 1_500 },
      deps,
    )
  warm.resetWarmRunnersForTesting()

  const wsA = ws()
  const a = await warm.ensureWarmRunner({ workspaceDir: wsA, bypassConsent: true }, deps)
  const specA = roster.registered.at(-1)?.spec
  check('(a) a consented ensure warms a runner', a.state === 'warmed', a.detail ?? '')
  check('(a) …whose spec carries the consent and whose argv carries the allow flag', specA?.allowBypass === true && buildRunnerInvocation(specA!).argv.includes(ALLOW))
  const b = await claim(wsA, false, 'default')
  check('(b) an UNCONSENTED claim on the consented runner declines, naming the consent', b.claimed === false && /consent/i.test(b.claimed === false ? b.reason : ''), b.claimed === false ? b.reason : 'claimed')
  check('(b) …and the runner retires (never serves an unconsented birth)', roster.killed.length === 1 && warm.warmRunnerCount() === 0)
  const wsB = ws()
  const cEnsure = await warm.ensureWarmRunner({ workspaceDir: wsB }, deps)
  const specB = roster.registered.at(-1)?.spec
  check('(c) an unconsented ensure warms a runner without the station', cEnsure.state === 'warmed' && specB?.allowBypass === undefined && !buildRunnerInvocation(specB!).argv.includes(ALLOW))
  const c = await claim(wsB, true, 'sovereign')
  check('(c) a CONSENTED sovereign claim on it declines (the runner could only refuse the posture)', c.claimed === false && /consent/i.test(c.claimed === false ? c.reason : ''), c.claimed === false ? c.reason : 'claimed')
  check('(c) …and that runner retires too', roster.killed.length === 2)
  const wsC = ws()
  const dEnsure = await warm.ensureWarmRunner({ workspaceDir: wsC, bypassConsent: true }, deps)
  const d = await claim(wsC, true, 'sovereign')
  const lastClaim = roster.claims.at(-1)?.params
  check('(d) an equal-consent claim LANDS on the consented runner', dEnsure.state === 'warmed' && d.claimed === true, d.claimed === false ? d.reason : '')
  check('(d) …with the sovereign posture riding session/claim', lastClaim !== undefined && lastClaim.mode === 'sovereign', JSON.stringify(lastClaim))
  const wsD = ws()
  const e1 = await warm.ensureWarmRunner({ workspaceDir: wsD }, deps)
  const killedBefore = roster.killed.length
  const registeredBefore = roster.registered.length
  const e2 = await warm.ensureWarmRunner({ workspaceDir: wsD, bypassConsent: true }, deps)
  check('(e) an unconsented runner stands…', e1.state === 'warmed')
  check('(e) …a consented ensure for the same workspace retires it and warms a consented one (never "kept")', e2.state === 'warmed' && roster.killed.length === killedBefore + 1 && roster.registered.length === registeredBefore + 1 && roster.registered.at(-1)?.spec.allowBypass === true, `state=${e2.state}`)
  const e3 = await warm.ensureWarmRunner({ workspaceDir: wsD, bypassConsent: true }, deps)
  check('(e) an equal ensure keeps it', e3.state === 'kept')
}

section('§7 the floors: crew seats, cron one-shots and the runner claim door')
{
  const crew = buildRunnerInvocation({ model: 'claude-opus-5', effort: 'max', appendSystemPrompt: 'pack', role: 'MERCURY_CONCOURSE_WORKER', agentName: 'scout', agentId: 'scout-1', permissionMode: 'flow' }).argv
  check('a crew seat (no consent on its spec) carries no bypass word', !crew.includes(ALLOW) && !crew.includes(SKIP))
  const withoutFlag = resolvePermissionModeTransition('sovereign', getEmptyToolPermissionContext())
  check('the runner claim door refuses a sovereign posture it was not launched for', withoutFlag.ok === false && withoutFlag.ok === false && withoutFlag.error.includes(SKIP))
  const withFlag = resolvePermissionModeTransition('sovereign', { ...getEmptyToolPermissionContext(), isBypassPermissionsModeAvailable: true })
  check('…and accepts it on a runner that booted the consent', withFlag.ok === true && withFlag.ok === true && withFlag.context.mode === 'sovereign')
}

section("§8 the typed mode rides beside the consent: only the launch's own typed word crosses, and the seat spells a typed default")
{
  const carried = (mode?: string): string => JSON.stringify(mode === undefined ? facts.carriedTypedModeOf(facts.bootBirthFacts()) : facts.carriedTypedModeOf(facts.bootBirthFacts(), mode))
  facts._resetBootBirthFactsForTesting()
  check('a fresh record carries no typed word', carried() === '{}')
  facts.setBootBirthFacts({ permissionMode: 'default', permissionModeTyped: true })
  check('a launch that typed its mode carries exactly { permissionModeTyped: true } on a birth', carried() === JSON.stringify({ permissionModeTyped: true }))
  check('…and on a resume that carries that same mode', carried('default') === JSON.stringify({ permissionModeTyped: true }))
  check("a resume that carries another mode (the chat's own, after a step) is not the typed word", carried('flow') === '{}')
  facts.setBootBirthFacts({ permissionMode: 'default', permissionModeTyped: false })
  check('a mode the launch resolved from the settings carries nothing', carried() === '{}' && carried('default') === '{}')
  facts.setBootBirthFacts({ permissionMode: 'default', permissionModeTyped: true })
  facts._resetBootBirthFactsForTesting()
  check('the proof reset clears it', carried() === '{}')
  const seat = (extra: { permissionMode: string; permissionModeTyped?: true; bypassConsent?: true }) =>
    buildConcourseWorkerSpec({ runnerId: 'concourse-w9', sessionId: '00000000-0000-4000-8000-000000000001', workspaceId: PROJ, modelKey: 'claude-sonnet-5', ...(extra as object) } as never)
  const typed = buildRunnerInvocation(seat({ permissionMode: 'default', permissionModeTyped: true, bypassConsent: true })).argv
  check('typed default + consent ⇒ --mode default AND the allow flag, never the skip flag', typed[typed.indexOf('--mode') + 1] === 'default' && typed.includes(ALLOW) && !typed.includes(SKIP))
  check('a typed word beside a carried word that is no mode does not cross: the seat keeps its own resolution, untyped', seat({ permissionMode: 'frobnicate', permissionModeTyped: true }).permissionModeTyped === undefined)
}

console.log(failures === 0 ? '\nprove-consent-rides-every-door: ALL LAWS HOLD' : `\nprove-consent-rides-every-door: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
