#!/usr/bin/env bun

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

section('§1b a standing entry (timeoutMs: Infinity) — no expiry, yields the row to any later entry, returns after it')
{
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const armed: Array<{ fire: () => void; delayMs: number }> = []
  globalThis.setTimeout = ((fn: () => void, delay?: number) => {
    const handle = { fire: fn, delayMs: delay ?? 0 }
    armed.push(handle)
    return handle
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((handle: unknown) => {
    const at = armed.indexOf(handle as never)
    if (at !== -1) armed.splice(at, 1)
    else realClearTimeout(handle as never)
  }) as unknown as typeof clearTimeout
  const fire = (key: number): void => {
    const [timer] = armed.splice(key, 1)
    timer?.fire()
  }
  try {
    const store = makeStore()
    const current = (): string | null => store.get().notifications.current?.key ?? null
    const queued = (): string[] => store.get().notifications.queue.map(e => e.key)
    enqueueNotification(store.set as never, { key: 'u', text: 'standing', priority: 'high', timeoutMs: Infinity })
    check('a standing entry is displayed at once', current() === 'u', JSON.stringify(store.get().notifications))
    check('…and arms NO expiry timer', armed.length === 0, `timers armed: ${armed.map(t => t.delayMs).join(', ')}`)
    enqueueNotification(store.set as never, { key: 'u', text: 'standing again', priority: 'high', timeoutMs: Infinity })
    check('a same-key re-post of the standing entry drops (one line per session)', current() === 'u' && queued().length === 0, JSON.stringify(store.get().notifications))
    enqueueNotification(store.set as never, { key: 'r', text: 'a receipt', priority: 'low', timeoutMs: 60_000 })
    check('a later LOW entry takes the row from the standing entry, which waits behind it', current() === 'r' && queued().join(',') === 'u', JSON.stringify(store.get().notifications))
    check('…the receipt arms its own expiry', armed.length === 1 && armed[0]?.delayMs === 60_000, `timers armed: ${armed.map(t => t.delayMs).join(', ')}`)
    fire(0)
    check('when the receipt expires the standing entry returns, still with no timer', current() === 'u' && queued().length === 0 && armed.length === 0, JSON.stringify(store.get().notifications))
    enqueueNotification(store.set as never, { key: 'i', text: 'now', priority: 'immediate', timeoutMs: 5_000 })
    check('an immediate entry pre-empts the standing entry and re-queues it', current() === 'i' && queued().join(',') === 'u')
    enqueueNotification(store.set as never, { key: 'u2', text: 'another standing', priority: 'high', timeoutMs: Infinity })
    enqueueNotification(store.set as never, { key: 'r2', text: 'a late receipt', priority: 'low', timeoutMs: 60_000 })
    check('behind the immediate: two standing entries queued before a low receipt', current() === 'i' && queued().join(',') === 'u,u2,r2', JSON.stringify(store.get().notifications))
    fire(0)
    check('the low receipt is promoted ahead of both standing entries (a standing entry ranks last)', current() === 'r2' && queued().join(',') === 'u,u2', JSON.stringify(store.get().notifications))
    fire(0)
    check('after it, the earlier standing entry returns and the other waits', current() === 'u' && queued().join(',') === 'u2' && armed.length === 0, JSON.stringify(store.get().notifications))
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
}

section('§2 the killswitch drive — the mode flip says why')
{

  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ guardrails: { disableSovereignMode: true } }))
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
  resetSettingsCache()
  const killswitch = await import('../../src/utils/permissions/bypassPermissionsKillswitch.ts')

  const live = makeStore({
    toolPermissionContext: { mode: 'sovereign', isBypassPermissionsModeAvailable: true },
  })
  killswitch.resetSovereignCheck()
  await killswitch.checkAndDisableSovereignIfNeeded(
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

  const idle = makeStore({
    toolPermissionContext: { mode: 'default', isBypassPermissionsModeAvailable: true },
  })
  killswitch.resetSovereignCheck()
  await killswitch.checkAndDisableSovereignIfNeeded(
    idle.get().toolPermissionContext as never,
    idle.set as never,
  )
  const idleWord = idle.get().notifications.current
  check('a non-bypass session still hears the policy word', /organization's security policy/.test(idleWord?.text ?? ''), idleWord?.text)
  check('…without a reset it did not perform', !/reset to default/.test(idleWord?.text ?? ''), idleWord?.text)

  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({}))
  resetSettingsCache()
  const free = makeStore({
    toolPermissionContext: { mode: 'sovereign', isBypassPermissionsModeAvailable: true },
  })
  killswitch.resetSovereignCheck()
  await killswitch.checkAndDisableSovereignIfNeeded(
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
  const writeFail = config.slice(config.indexOf('const writeSource'), config.indexOf('const writeGlobal'))
  check("/config's write-fail arm discloses through the door", writeFail.includes('enqueueNotification(setAppState') && writeFail.includes("key: 'config-write-failed'"), writeFail.slice(0, 120))
  check('…beside (not instead of) the debug log', writeFail.includes('logForDebugging'))
  const channel = src('context/notifications.tsx')
  check('the hook DELEGATES to the door (one channel, one code path)', channel.includes('enqueueNotification(setAppState, incoming)'))
  const wards = src('guards/wardsGuard.ts')
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
