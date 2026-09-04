#!/usr/bin/env bun
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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

const REPO = join(import.meta.dir, '..', '..')
const src = (...p: string[]): string => readFileSync(join(REPO, 'src', ...p), 'utf-8')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 8 } }))

const { initializeToolPermissionContext } = await import('../../src/utils/permissions/permissionSetup.ts')
const facts = await import('../../src/services/switchboard/bootBirthFacts.ts')
const { buildConcourseWorkerSpec } = await import('../../src/daemon/concourseSupervisor.ts')
const { buildStreamJsonInvocation, headlessPermissionArgv } = await import('../../src/daemon/headlessRun.ts')
const { deriveSessionKitForWorkspace } = await import('../../src/daemon/sessionKit.ts')
const warm = await import('../../src/daemon/warmRunner.ts')
const { resolvePermissionModeTransition } = await import('../../src/cli/headless/controlHandlers.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

const SKIP = '--dangerously-skip-permissions'
const ALLOW = '--allow-dangerously-skip-permissions'

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
    buildStreamJsonInvocation(
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
  check('consent + sovereign posture ⇒ the skip flag alone (it implies the consent)', consentedSovereign.includes(SKIP) && !consentedSovereign.includes(ALLOW) && !consentedSovereign.includes('--permission-mode'))
  const consentedFlow = argvOf({ permissionMode: 'flow', bypassConsent: true })
  check('consent + flow posture ⇒ --permission-mode flow AND the allow flag', consentedFlow.includes(ALLOW) && consentedFlow[consentedFlow.indexOf('--permission-mode') + 1] === 'flow')
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
  check('(flow, consent) ⇒ [--permission-mode, flow, allow]', same(headlessPermissionArgv('flow', true), ['--permission-mode', 'flow', ALLOW]))
  check('(sovereign, consent) ⇒ [skip] alone', same(headlessPermissionArgv('sovereign', true), [SKIP]))
  check('(sovereign, no consent) ⇒ [skip] — unchanged', same(headlessPermissionArgv('sovereign'), [SKIP]))
  check('(default, no consent) ⇒ [] — unchanged', same(headlessPermissionArgv('default'), []))
  check('(implement, no consent) ⇒ [--permission-mode, implement] — unchanged', same(headlessPermissionArgv('implement'), ['--permission-mode', 'implement']))
}

section("§5 the warm pool's consent gate (the kit gate's twin) on the real policy")
{
  type Spec = ReturnType<typeof buildConcourseWorkerSpec>
  class FakeRoster {
    registered: Array<{ short: string; spec: Spec }> = []
    controls: Array<{ short: string; frame: string }> = []
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
      return { ok: true, pid: process.pid }
    }
    control(short: string, frame: string): boolean {
      this.controls.push({ short, frame })
      const parsed = JSON.parse(frame) as { request_id?: string; request?: { subtype?: string } }
      if (parsed.request?.subtype === 'claim_session' && typeof parsed.request_id === 'string') {
        const requestId = parsed.request_id
        queueMicrotask(() => warm.onWarmRunnerLine(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId } })))
      }
      return true
    }
    kill(short: string): boolean {
      this.killed.push(short)
      this.present.delete(short)
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
  check('(a) …whose spec carries the consent and whose argv carries the allow flag', specA?.allowBypass === true && buildStreamJsonInvocation(specA!).argv.includes(ALLOW))
  const b = await claim(wsA, false, 'default')
  check('(b) an UNCONSENTED claim on the consented runner declines, naming the consent', b.claimed === false && /consent/i.test(b.claimed === false ? b.reason : ''), b.claimed === false ? b.reason : 'claimed')
  check('(b) …and the runner retires (never serves an unconsented birth)', roster.killed.length === 1 && warm.warmRunnerCount() === 0)
  const wsB = ws()
  const cEnsure = await warm.ensureWarmRunner({ workspaceDir: wsB }, deps)
  const specB = roster.registered.at(-1)?.spec
  check('(c) an unconsented ensure warms a runner without the station', cEnsure.state === 'warmed' && specB?.allowBypass === undefined && !buildStreamJsonInvocation(specB!).argv.includes(ALLOW))
  const c = await claim(wsB, true, 'sovereign')
  check('(c) a CONSENTED sovereign claim on it declines (the runner could only refuse the posture)', c.claimed === false && /consent/i.test(c.claimed === false ? c.reason : ''), c.claimed === false ? c.reason : 'claimed')
  check('(c) …and that runner retires too', roster.killed.length === 2)
  const wsC = ws()
  const dEnsure = await warm.ensureWarmRunner({ workspaceDir: wsC, bypassConsent: true }, deps)
  const d = await claim(wsC, true, 'sovereign')
  const frame = roster.controls.at(-1)?.frame ?? ''
  check('(d) an equal-consent claim LANDS on the consented runner', dEnsure.state === 'warmed' && d.claimed === true, d.claimed === false ? d.reason : '')
  check('(d) …with the sovereign posture riding the claim control', frame.includes('"claim_session"') && frame.includes('"permission_mode":"sovereign"'))
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

section('§6 the doors spread the one carry; the dispatch door never does')
{
  const birth = src('services', 'switchboard', 'bornSession.ts')
  const resume = src('services', 'switchboard', 'hopIntoSession.ts')
  const arming = src('services', 'switchboard', 'ensureDaemon.ts')
  const boot = src('main.tsx')
  check('the birth door spreads the carry onto sessionAdmit', birth.includes('...carriedConsentOf(facts)'))
  check('the resume door spreads the carry onto its sessionAdmit', resume.includes('...carriedConsentOf(bootBirthFacts())'))
  check("the pool's arming door spreads the carry onto concourseWarm", arming.includes('...carriedConsentOf(bootBirthFacts())'))
  check('the boot writes the consent from the permission context it resolved (no re-derivation)', boot.includes('bypassConsent: effectiveContext.isBypassPermissionsModeAvailable === true'))
  const dispatch = src('daemon', 'concourseDispatch.ts')
  check('the dispatch door (board-spawned workers) never carries the consent', !dispatch.includes('bypassConsent'))
  const server = src('daemon', 'controlServer.ts')
  check('the wire admits exactly `true` (shape narrowing) on the admit and the warm doors', (server.match(/raw\.bypassConsent === true/g) ?? []).length === 2)
}

section('§7 the floors: crew seats, cron one-shots and the runner claim door')
{
  const crew = buildStreamJsonInvocation({ model: 'claude-opus-5', effort: 'max', appendSystemPrompt: 'pack', role: 'MERCURY_CREW', agentName: 'scout', agentId: 'scout-1', permissionMode: 'flow' }).argv
  check('a crew seat (no consent on its spec) carries no bypass word', !crew.includes(ALLOW) && !crew.includes(SKIP))
  const headless = src('daemon', 'headlessRun.ts')
  check('the cron one-shot threads the posture alone (no consent argument)', headless.includes('...headlessPermissionArgv(getHeadlessPermissionMode(spec.permissionMode)),'))
  const withoutFlag = resolvePermissionModeTransition('sovereign', getEmptyToolPermissionContext())
  check('the runner claim door refuses a sovereign posture it was not launched for', withoutFlag.ok === false && withoutFlag.ok === false && withoutFlag.error.includes(SKIP))
  const withFlag = resolvePermissionModeTransition('sovereign', { ...getEmptyToolPermissionContext(), isBypassPermissionsModeAvailable: true })
  check('…and accepts it on a runner that booted the consent', withFlag.ok === true && withFlag.ok === true && withFlag.context.mode === 'sovereign')
}

console.log(failures === 0 ? '\nprove-sovereign-rides-every-door: ALL LAWS HOLD' : `\nprove-sovereign-rides-every-door: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
