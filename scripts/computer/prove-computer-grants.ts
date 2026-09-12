#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, HOME, scratchDir, section, sourceText } from './computerProofKit.ts'
import { allowEverything, ownerOf, resultOf, toolContext, toolUseTurn, withScreenshot } from './computerToolKit.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const grants = await import('../../src/services/desktop/computerGrant.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')
const { resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const { getSessionId, setIsInteractive, getIsInteractive, setAskChannel, getAskChannel } = await import('../../src/bootstrap/state.ts')
const { readBootEnvChoices, bootEnvPath } = await import('../../src/substrate/startupMenu.ts')
const { applyComputerAskChoice, COMPUTER_ASK_CHOICES, COMPUTER_ASK_NOTE } = await import('../../src/components/permissions/ComputerPermissionRequest/ComputerPermissionRequest.tsx')
type ToolUseContext = import('../../src/Tool.ts').ToolUseContext

const scratch = scratchDir('grants')
const TEXTEDIT = { identity: 'com.example.TextEdit', name: 'TextEdit' }
const FINDER = { identity: 'com.example.Finder', name: 'Finder', pid: 4300, title: null, bounds: { x: 0, y: 0, width: 600, height: 400 } }
const SESSION = String(getSessionId())
const NOW = 1_800_000_000_000

function useScene(name: string, scene: Record<string, unknown> | null): void {
  if (scene === null) delete process.env.MERCURY_DESKTOP_FAKE_SCENE
  else {
    const path = join(scratch, `${name}.json`)
    writeFileSync(path, JSON.stringify(scene))
    process.env.MERCURY_DESKTOP_FAKE_SCENE = path
  }
  resetDesktopDriverForTest()
}

type Verdict = { behavior: string; message?: string }
const permission = async (input: Record<string, unknown>, context: ToolUseContext): Promise<Verdict> => (await ComputerTool.checkPermissions(input as never, context)) as Verdict

async function fresh(name: string, scene: Record<string, unknown> | null, options: Parameters<typeof toolContext>[0] = {}): Promise<{ context: ToolUseContext; owner: ReturnType<typeof ownerOf> }> {
  useScene(name, scene)
  const base = toolContext(options)
  const owner = ownerOf(base)
  session.forgetDesktopOwner(owner)
  const shot = await withScreenshot(ComputerTool as never, base, `toolu_${name}_shot`)
  check(`${name}: the opening screenshot succeeds`, shot.outcome === 'succeeded', shot.result)
  return { context: shot.context, owner }
}

section('§1 the store: a per-session file, kept while it runs, gone when it expires')
{
  grants.clearComputerGrant(SESSION)
  check('no grant reads null', grants.readComputerGrant(SESSION, NOW) === null)
  const path = grants.computerGrantPath(SESSION)
  check("the file lives under the config home's sessions/<session id>/", path === join(HOME, 'sessions', SESSION, 'computer-grant.json'), path)
  const hour = grants.timedComputerGrant(1, NOW)
  check('a one-hour grant ends one hour after it was granted', hour.kind === 'timed' && hour.until === NOW + grants.HOUR_MS && hour.hours === 1)
  grants.writeComputerGrant(SESSION, hour)
  check('the written grant reads back while it runs', JSON.stringify(grants.readComputerGrant(SESSION, NOW + 30 * 60_000)) === JSON.stringify(hour))
  check('its words name the span and what is left', grants.computerGrantWords(hour, NOW + 8 * 60_000) === 'granted for 1 hour · 52m left', grants.computerGrantWords(hour, NOW + 8 * 60_000))
  check('at the hour it reads null and the file is cleared', grants.readComputerGrant(SESSION, NOW + grants.HOUR_MS) === null && !existsSync(path))
  const day = grants.timedComputerGrant(24, NOW)
  check('a 24-hour grant ends a day later and its words say 24 hours', day.kind === 'timed' && day.until === NOW + 24 * grants.HOUR_MS && grants.computerGrantWords(day, NOW).startsWith('granted for 24 hours · 24h left'))
  check('another session id has no grant', grants.readComputerGrant('another-session', NOW) === null)
  mkdirSync(join(HOME, 'sessions', SESSION), { recursive: true })
  writeFileSync(path, '{"version":1,"kind":"timed","hours":7,"grantedAt":1,"until":9e15}')
  check('a record outside the shape reads null', grants.readComputerGrant(SESSION, NOW) === null)
  writeFileSync(path, '{"version":1,"kind":"sovereign","grantedAt":1}')
  check('a sovereign record from an earlier build reads null (the posture is the state)', grants.readComputerGrant(SESSION, NOW) === null)
  grants.clearComputerGrant(SESSION)
}

section('§2 the five choices and what each does')
{
  check('the card offers Yes, No, 1 hour, 24 hours, sovereign mode — in that order', COMPUTER_ASK_CHOICES.map(c => c.value).join(',') === 'yes,no,hour,day,sovereign')
  check('the labels say what each grants', COMPUTER_ASK_CHOICES[2]!.label === 'Yes, for 1 hour — every application' && COMPUTER_ASK_CHOICES[3]!.label === 'Yes, for 24 hours — every application' && COMPUTER_ASK_CHOICES[4]!.label === 'Enable sovereign mode to avoid further permissions by default')
  const yes = applyComputerAskChoice('yes', SESSION, NOW)
  check('Yes allows and grants nothing beyond this application', yes.allow && yes.grant === null && yes.saved === null && grants.readComputerGrant(SESSION, NOW) === null)
  const no = applyComputerAskChoice('no', SESSION, NOW)
  check('No refuses and grants nothing', !no.allow && no.grant === null && grants.readComputerGrant(SESSION, NOW) === null)
  const hour = applyComputerAskChoice('hour', SESSION, NOW)
  check('1 hour allows and writes a one-hour grant for this session', hour.allow && hour.grant?.kind === 'timed' && hour.grant.hours === 1 && grants.readComputerGrant(SESSION, NOW)?.kind === 'timed')
  const day = applyComputerAskChoice('day', SESSION, NOW)
  check('24 hours allows and writes a 24-hour grant', day.allow && day.grant?.kind === 'timed' && day.grant.hours === 24 && (grants.readComputerGrant(SESSION, NOW) as { hours?: number } | null)?.hours === 24)
  check('the timed choices carry no permission update', hour.permissionUpdates.length === 0 && day.permissionUpdates.length === 0 && yes.permissionUpdates.length === 0 && no.permissionUpdates.length === 0)
  grants.clearComputerGrant(SESSION)
  check('the boot-env file carries no Sovereign mode row yet', (readBootEnvChoices() ?? {}).MERCURY_SKIP_PERMISSIONS === undefined)
  const sovereign = applyComputerAskChoice('sovereign', SESSION, NOW)
  check("sovereign mode allows and saves the Boot Menu's Sovereign mode row on — the one bypass, through the menu's own writer", sovereign.allow && sovereign.saved === 'sovereign' && sovereign.savedError === null && (readBootEnvChoices() ?? {}).MERCURY_SKIP_PERMISSIONS === '1', JSON.stringify({ sovereign, saved: readBootEnvChoices(), path: bootEnvPath() }))
  check('it writes no grant file under the session (the posture is the state)', sovereign.grant === null && grants.readComputerGrant(SESSION, NOW) === null)
  check('it moves the running session into Sovereign Mode at the session scope (the consent card\'s own road)', JSON.stringify(sovereign.permissionUpdates) === JSON.stringify([{ type: 'setMode', mode: 'sovereign', destination: 'session' }]), JSON.stringify(sovereign.permissionUpdates))
  check('it never names the retired access type', !sourceText('src/components/permissions/ComputerPermissionRequest/ComputerPermissionRequest.tsx').includes('MERCURY_COMPUTER_ACCESS'))
  check("the card's note says sovereign mode is saved in the Boot Menu and nothing asks after it, computer use included", COMPUTER_ASK_NOTE === 'A timed grant covers every application and asks again when it runs out; sovereign mode is saved in the Boot Menu and no permission is asked after it, computer use included.', COMPUTER_ASK_NOTE)
  check('no permission rule was written by any choice', !sourceText('src/components/permissions/ComputerPermissionRequest/ComputerPermissionRequest.tsx').includes('addRules'))
  writeFileSync(bootEnvPath(), JSON.stringify({ version: 1, savedAt: 'x', env: {} }))
}

section('§3 a timed grant skips the ask in a second application and leaves no per-application grant behind')
{
  grants.writeComputerGrant(SESSION, grants.timedComputerGrant(1))
  const { context, owner } = await fresh('grant-switch', { switches: [{ afterActs: 1, frontmost: FINDER }] })
  const first = await permission({ action: 'click', x: 812, y: 300 }, context)
  check('the first act in TextEdit is allowed without an ask', first.behavior === 'allow', JSON.stringify(first))
  const acted = resultOf(await ComputerTool.call({ action: 'click', x: 812, y: 300, capture: false } as never, context, allowEverything, toolUseTurn('toolu_grant_click', 'Computer', { action: 'click', x: 812, y: 300, capture: false })))
  check('the act runs', acted.outcome === 'succeeded', acted.result)
  check('the act under the grant leaves no per-application grant behind', session.appApproved(owner, TEXTEDIT.identity) === false && session.approvedAppList(owner).length === 0)
  const second = await permission({ action: 'click', x: 100, y: 100 }, context)
  check('the next act, now in Finder, is allowed without an ask', second.behavior === 'allow', JSON.stringify(second))
  grants.clearComputerGrant(SESSION)
  const after = await permission({ action: 'click', x: 100, y: 100 }, context)
  check('with the grant gone the first act in Finder asks', after.behavior === 'ask', JSON.stringify(after))
  session.forgetDesktopOwner(owner)
}

section('§4 a grant that ran out brings the ask back; another session never inherits one')
{
  const { context, owner } = await fresh('grant-expired', null)
  grants.writeComputerGrant(SESSION, { version: 1, kind: 'timed', hours: 1, grantedAt: Date.now() - 2 * grants.HOUR_MS, until: Date.now() - grants.HOUR_MS })
  const expired = await permission({ action: 'click', x: 812, y: 300 }, context)
  check('an expired grant asks again and is cleared', expired.behavior === 'ask' && !existsSync(grants.computerGrantPath(SESSION)), JSON.stringify(expired))
  grants.writeComputerGrant('some-other-session', grants.timedComputerGrant(24))
  const foreign = await permission({ action: 'click', x: 812, y: 300 }, context)
  check("another session's grant does not reach this one", foreign.behavior === 'ask', JSON.stringify(foreign))
  grants.clearComputerGrant('some-other-session')
  session.forgetDesktopOwner(owner)
}

section('§5 the 24-hour grant spans a second application; a deny rule still refuses under any grant')
{
  grants.writeComputerGrant(SESSION, grants.timedComputerGrant(24))
  const { context, owner } = await fresh('grant-day', { switches: [{ afterActs: 1, frontmost: FINDER }] })
  const first = await permission({ action: 'type', text: 'hello' }, context)
  check('the first act is allowed', first.behavior === 'allow', JSON.stringify(first))
  const acted = resultOf(await ComputerTool.call({ action: 'type', text: 'hello', capture: false } as never, context, allowEverything, toolUseTurn('toolu_day_type', 'Computer', { action: 'type', text: 'hello', capture: false })))
  check('the act runs and Finder comes in front', acted.outcome === 'succeeded', acted.result)
  const second = await permission({ action: 'click', x: 100, y: 100 }, context)
  check('the act in the second application is allowed', second.behavior === 'allow', JSON.stringify(second))
  const denied = toolContext({ deny: ['Computer(app:com.example.Finder)'] })
  session.forgetDesktopOwner(ownerOf(denied))
  const shot = await withScreenshot(ComputerTool as never, denied, 'toolu_day_deny_shot')
  const denyVerdict = await permission({ action: 'click', x: 100, y: 100 }, shot.context)
  check('a deny rule still refuses under the grant', denyVerdict.behavior === 'deny', JSON.stringify(denyVerdict))
  grants.clearComputerGrant(SESSION)
  session.forgetDesktopOwner(ownerOf(denied))
  session.forgetDesktopOwner(owner)
}

section('§6 only the card grants: the tool never writes one, and a headless seat has no card')
{
  check('the tool reads grants and never writes them', !sourceText('src/tools/ComputerTool/ComputerTool.ts').includes('writeComputerGrant') && sourceText('src/tools/ComputerTool/ComputerTool.ts').includes('readComputerGrant'))
  check('the card is the one writer outside the store', sourceText('src/components/permissions/ComputerPermissionRequest/ComputerPermissionRequest.tsx').includes('writeComputerGrant('))
  const wasInteractive = getIsInteractive()
  const wasChannel = getAskChannel()
  setIsInteractive(false)
  setAskChannel('sdk')
  const { context, owner } = await fresh('headless', null, { interactive: false })
  const verdict = await permission({ action: 'click', x: 812, y: 300 }, context)
  check('a non-interactive seat still gets the ask and no grant appears', verdict.behavior === 'ask' && grants.readComputerGrant(SESSION) === null, JSON.stringify(verdict))
  setAskChannel(wasChannel)
  setIsInteractive(wasInteractive)
  session.forgetDesktopOwner(owner)
}

useScene('default', null)
finish('prove-computer-grants')
