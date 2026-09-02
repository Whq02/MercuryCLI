#!/usr/bin/env bun
// ============================================================================
//  prove-silent-disclosures — the C7 disclosure lines ride the REAL
//  notification channel, through its one module-level door.
//
//  The silences (polish worklist C7, queue row 2): a project wards.json parse
//  problem yielded zero safety rules with no word (proven in
//  scripts/wards/prove-wards.ts §3b); the org bypass-permissions killswitch
//  flipped a LIVE session's mode with no word; a failed /config toggle write
//  painted nothing (debug-only log). The channel door itself
//  (enqueueNotification) is the same code the useNotifications hook runs —
//  extracted so non-component callers holding the app setter reach the SAME
//  channel, promote step included: a bare setAppState queue push sat
//  invisible until something else raised a notification.
//
//    §1 the door: enqueue displays (promotes), dedupes by key, immediate
//       pre-empts — driven on a fixture store.
//    §2 the killswitch drive: a scratch home whose settings carry the org
//       policy — the mode resets AND the line lands displayed, naming the
//       policy and the reset; softer wording when no bypass mode was live;
//       control: no policy ⇒ no flip, no word.
//    §3 the wiring, structural: /config's write-fail arm and the plan tool
//       ride the door; the hook delegates to it (one channel, one spelling).
//
//  Hermetic: MERCURY_CONFIG_DIR on a scratch home; no PTY, no network.
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'silent-disclosures-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

type Entry = { key: string; text?: string; priority?: string }
type Store = {
  notifications: { current: Entry | null; queue: Entry[] }
  toolPermissionContext?: Record<string, unknown>
}
const makeStore = (extra: Partial<Store> = {}): {
  set: (updater: (prev: Store) => Store) => void
  get: () => Store
} => {
  let state: Store = { notifications: { current: null, queue: [] }, ...extra }
  return {
    set: updater => {
      state = updater(state)
    },
    get: () => state,
  }
}

const { enqueueNotification } = await import('../../src/context/notifications.js')

section('§1 the door — enqueue displays, dedupes, immediate pre-empts')
{
  const store = makeStore()
  enqueueNotification(store.set as never, { key: 'a', text: 'first', priority: 'high', timeoutMs: 60_000 })
  check('a first enqueue is DISPLAYED, not just queued', store.get().notifications.current?.key === 'a', JSON.stringify(store.get().notifications))
  enqueueNotification(store.set as never, { key: 'a', text: 'dupe', priority: 'high', timeoutMs: 60_000 })
  check('a same-key duplicate drops (no queue growth)', store.get().notifications.queue.length === 0)
  enqueueNotification(store.set as never, { key: 'b', text: 'second', priority: 'low', timeoutMs: 60_000 })
  check('a different key queues behind the displayed entry', store.get().notifications.current?.key === 'a' && store.get().notifications.queue.some(e => e.key === 'b'))
  enqueueNotification(store.set as never, { key: 'c', text: 'now', priority: 'immediate', timeoutMs: 60_000 })
  check('immediate pre-empts and re-queues the displaced entry', store.get().notifications.current?.key === 'c' && store.get().notifications.queue.some(e => e.key === 'a'))
}

section('§2 the killswitch drive — the mode flip says why')
{
  // The org policy in the scratch home's user settings.
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } }))
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
  resetSettingsCache()
  const killswitch = await import('../../src/utils/permissions/bypassPermissionsKillswitch.ts')

  // A LIVE bypass session (the bypass-semantics modes are sovereign and
  // autopilot — PermissionMode.ts's one predicate): the mode resets AND the
  // line names both facts.
  const live = makeStore({
    toolPermissionContext: { mode: 'sovereign', isBypassPermissionsModeAvailable: true },
  })
  killswitch.resetBypassPermissionsCheck()
  await killswitch.checkAndDisableBypassPermissionsIfNeeded(
    live.get().toolPermissionContext as never,
    live.set as never,
  )
  const flipped = live.get().toolPermissionContext as { mode?: string; isBypassPermissionsModeAvailable?: boolean }
  check('the live bypass mode resets to default', flipped.mode === 'default', JSON.stringify(flipped))
  check('…and bypass availability clears', flipped.isBypassPermissionsModeAvailable === false)
  const word = live.get().notifications.current
  check('…and the disclosure is DISPLAYED', word?.key === 'bypass-killswitch', JSON.stringify(word))
  check(
    "…naming the policy AND the reset ('reset to default')",
    /organization's security policy/.test(word?.text ?? '') && /reset to default/.test(word?.text ?? ''),
    word?.text,
  )

  // A non-bypass session: availability clears; the softer line, no reset tail.
  const idle = makeStore({
    toolPermissionContext: { mode: 'default', isBypassPermissionsModeAvailable: true },
  })
  killswitch.resetBypassPermissionsCheck()
  await killswitch.checkAndDisableBypassPermissionsIfNeeded(
    idle.get().toolPermissionContext as never,
    idle.set as never,
  )
  const idleWord = idle.get().notifications.current
  check('a non-bypass session still hears the policy word', /organization's security policy/.test(idleWord?.text ?? ''), idleWord?.text)
  check('…without a reset it did not perform', !/reset to default/.test(idleWord?.text ?? ''), idleWord?.text)

  // CONTROL: no policy ⇒ no flip, no word.
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({}))
  resetSettingsCache()
  const free = makeStore({
    toolPermissionContext: { mode: 'sovereign', isBypassPermissionsModeAvailable: true },
  })
  killswitch.resetBypassPermissionsCheck()
  await killswitch.checkAndDisableBypassPermissionsIfNeeded(
    free.get().toolPermissionContext as never,
    free.set as never,
  )
  const freeCtx = free.get().toolPermissionContext as { mode?: string }
  check('control: no policy ⇒ the mode stands', freeCtx.mode === 'sovereign')
  check('control: no policy ⇒ no notification', free.get().notifications.current === null && free.get().notifications.queue.length === 0)
}

section('§3 the wiring — every silent road rides the ONE door (structural)')
{
  const src = (rel: string): string => readFileSync(new URL(`../../src/${rel}`, import.meta.url), 'utf8')
  const config = src('components/Settings/Config.tsx')
  const writeFail = config.slice(config.indexOf('const writeSource'), config.indexOf('const globalTouchedRef'))
  check("/config's write-fail arm discloses through the door", writeFail.includes('enqueueNotification(setAppState') && writeFail.includes("key: 'config-write-failed'"), writeFail.slice(0, 120))
  check('…beside (not instead of) the debug log', writeFail.includes('logForDebugging'))
  const planTool = src('tools/EnterPlanModeTool/EnterPlanModeTool.ts')
  check(
    'the plan tool rides the door (the bare notifications-state push is gone)',
    planTool.includes('enqueueNotification(context.setAppState') && !/notifications:\s*\{/.test(planTool),
  )
  const channel = src('context/notifications.tsx')
  check('the hook DELEGATES to the door (one channel, one code path)', channel.includes('enqueueNotification(setAppState, incoming)'))
  const wards = src('utils/hooks/wardsHook.ts')
  check('the wards registration rides the door (functionally proven in prove-wards §3b)', wards.includes('enqueueNotification(setAppState'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-silent-disclosures — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-silent-disclosures — all checks pass')
process.exit(0)
