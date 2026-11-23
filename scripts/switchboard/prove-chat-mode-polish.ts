#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'chat-mode-polish-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_FULLSCREEN = '1'

const t = checker()

t.section('§A — the ⚑ badge\'s jump per world')
{
  const { needsYouJump } = await import('../../src/screen/widgets/needsYouJump.ts')
  const chord = 'ctrl+x c'
  t.check('the fleet world names the board and its chord', needsYouJump({ plain: false, ownOnly: false, boardChord: chord }) === 'ctrl+x c board')
  t.check('the fleet world names the board even when every ask is the chat\'s own (the board lists it too)', needsYouJump({ plain: false, ownOnly: true, boardChord: chord }) === 'ctrl+x c board')
  t.check('the plain world, every ask the focused chat\'s own: "this chat"', needsYouJump({ plain: true, ownOnly: true, boardChord: chord }) === 'this chat')
  t.check('the plain world, another session\'s ask: the estate\'s resume door (/sessions — the face\'s Continue/Resume from inside the chat)', needsYouJump({ plain: true, ownOnly: false, boardChord: chord }) === '/sessions')
  t.check('POISON absent: the plain world never says "board" and never names the chord', [true, false].every(own => { const j = needsYouJump({ plain: true, ownOnly: own, boardChord: chord }); return !j.includes('board') && !j.includes(chord) }))
  t.check('the jump follows a rebind in the fleet world (the resolver\'s display, never a copied string)', needsYouJump({ plain: false, ownOnly: false, boardChord: 'alt+b' }) === 'alt+b board')
}


t.section('§C — the shortcuts tab: ctrl+x c\'s label per world, the triple untouched')
{
  const { EVERYDAY } = await import('../../src/screen/help/ShortcutsTab.tsx')
  const row = EVERYDAY.rows.find(r => r.action === 'app:openSurfaceSwitcher')
  t.check('the row keeps its registry triple (action · context · fallback)', row !== undefined && row.context === 'Global' && row.fallback === 'ctrl+x c')
  t.check('the row carries both labels: the board in the fleet world, the live view (and that the concourse is off) in the plain world', row?.label === 'session concourse — every surface, one board' && row?.plainLabel === 'live view of your sessions — the concourse is off in this boot')
  t.check('only the concourse row has a plain-world label', EVERYDAY.rows.filter(r => r.plainLabel !== undefined).length === 1)
}

t.section('§D — the felt path (L15): `--chat` lands on the boot menu, and ↵ New Session is the warm road')
{
  const { builtHelp } = await import('../lib/builtProduct.ts')
  const rootHelp = builtHelp()
  t.check('the option help says the menu is the landing and ↵ New Session the door', rootHelp.includes('↵ New Session on the menu starts the chat') && rootHelp.includes('`-chat` is the same switch'))
}

t.section('§E — the boot face per twin: no row in --chat; the live-view door in --concourse-off')
{
  const { concourseRowCtx } = await import('../../src/screen/boot-face/BootSplashScreen.tsx')
  t.check('the fleet world names the live board (and its live count)', concourseRowCtx({ live: true, why: null, liveCount: 0 }) === 'the live board' && concourseRowCtx({ live: true, why: null, liveCount: 3 }) === 'the live board · 3 live')
  t.check('the saved switch off: "live view only — concourse off" (the bytes the strip drive\'s S5 and the one-door drive\'s L4b pin)', concourseRowCtx({ live: true, why: 'concourse off', liveCount: 0 }) === 'live view only — concourse off')
  t.check('an unregistered surface dims with its reason', concourseRowCtx({ live: false, why: null, liveCount: 0 }) === 'unregistered in this build' && concourseRowCtx({ live: false, why: 'concourse off', liveCount: 0 }) === 'unregistered in this build')
  t.check('POISON absent: the switch-off world never says "the live board"', !concourseRowCtx({ live: true, why: 'concourse off', liveCount: 2 }).includes('the live board'))
  const { faceKeyMapHintOf } = await import('../../src/screen/boot-face/BootSplashScreen.tsx')
  t.check('the m phrase rides beside a strip hint, stands alone when the strip has no move, and is absent with the setting off', faceKeyMapHintOf('⇧→ concourse', true) === '⇧→ concourse · m to select model-default' && faceKeyMapHintOf('', true) === 'm to select model-default' && faceKeyMapHintOf('⇧→ concourse', false) === '⇧→ concourse' && faceKeyMapHintOf('', false) === '')
  const { assembleCardRows } = await import('../../assets/splash/splash-core.mjs')
  const keysOf = (concourse: { ctx: string } | null): string[] => (assembleCardRows({ cwdBase: 'proj', continueTarget: null, menuAvailable: true, concourse, projects: [] }) as Array<{ key: string }>).map(r => r.key)
  t.check('the --chat card carries no concourse key and is exactly one row shorter than the card that does', !keysOf(null).includes('concourse') && keysOf({ ctx: 'the live board' }).includes('concourse') && keysOf({ ctx: 'x' }).length === keysOf(null).length + 1)
  const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.ts')
  t.check('the new env read has its flag-registry row (consumer: the splash)', getFlagSpec('MERCURY_SPLASH_CHAT') !== undefined)
}


t.section('§G — the next-session facts (L18): one record, every door, never a running session')
{
  const facts = await import('../../src/daemon/switchboard/bootBirthFacts.ts')
  facts._resetBootBirthFactsForTesting()
  facts.setNextSessionFacts({ title: 'once', model: 'claude-opus-5', effort: 'max', permissionMode: 'implement', runnerArgv: ['--x'] })
  t.check('the title is ONE-SHOT: the first taker consumes it, the second reads null', facts.takeBootTitle() === 'once' && facts.takeBootTitle() === null)
  t.check('model · effort · permissionMode · runnerArgv are STICKY: two reads, one answer', facts.bootBirthFacts().model === 'claude-opus-5' && facts.bootBirthFacts().model === 'claude-opus-5' && facts.bootBirthFacts().effort === 'max' && facts.bootBirthFacts().permissionMode === 'implement' && facts.bootBirthFacts().runnerArgv.join(',') === '--x')
  t.check("the model precedence: the record (the menu's explicit choice) → a door's inheritance → the screen's main model", facts.birthModelOf({ model: 'a' }, 'b', 'c') === 'a' && facts.birthModelOf({ model: null }, 'b', 'c') === 'b' && facts.birthModelOf({ model: null }, null, 'c') === 'c' && facts.birthModelOf({ model: null }, undefined, 'c') === 'c')
  facts._resetBootBirthFactsForTesting()
  const menu = await import('../../src/platform/substrate/startupMenu.ts')
  const profPath = join(SCRATCH, 'boot-env.json')
  const a = menu.resolveEffectiveSettingsSnapshot({ sessionId: 's', path: profPath, env: {} })
  const menuRow = (menu.STARTUP_MENU as ReadonlyArray<{ env: string }>).find(r => menu.menuRowChoices(r as never).some(c => c.value !== null))
  t.check('a living menu row with a choice exists to carry the per-admission law', menuRow !== undefined, 'STARTUP_MENU offers no row with a choice')
  const choice = menuRow ? (menu.menuRowChoices(menuRow as never).find(c => c.value !== null)!.value as string) : ''
  const saved = menuRow ? menu.saveBootDefaultsProfile({ [menuRow.env]: choice }, profPath) : { ok: false as const }
  const b = menu.resolveEffectiveSettingsSnapshot({ sessionId: 's', path: profPath, env: {} })
  t.check("a menu row changed AFTER boot changes the next session's snapshot (the profile is read per admission, not once at boot)", menuRow !== undefined && saved.ok === true && a.snapshotId !== b.snapshotId && b.rows.find(r => r.env === menuRow.env)?.source === 'profile')
  const route = await import('../../src/screen/routes/surfaceRoute.ts')
  const plain = { concourseEnabled: true, chatBoot: true, chatPresent: false }
  t.check('--chat before a session: the menu alone; shift+→ moves nothing (the dim hint, no commit)', route.stripStops(plain).join(',') === 'boot-settings' && JSON.stringify(route.stripMove('boot-settings', 'right', route.stripStops(plain))) === JSON.stringify({ to: null, hint: 'no chat open' }))
}

removeScratch(SCRATCH)
t.finish('prove-chat-mode-polish')
