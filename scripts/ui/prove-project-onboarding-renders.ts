#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-project-onboarding-renders.ts — the per-project
//  first-run step actually runs (FC-134). projectOnboardingState composed
//  the two hints a brand-new folder is supposed to get and nothing ever
//  rendered them: shouldShowProjectOnboarding was only cache-cleared,
//  incrementProjectOnboardingSeenCount had no caller, and every project
//  record kept projectOnboardingSeenCount 0 forever.
//
//  §1 the composed hint by ground: empty dir ⇒ the workspace invitation;
//     non-empty without MERCURY.md ⇒ the /init step; MERCURY.md present ⇒
//     nothing (complete).
//  §2 the seen budget: one bump per session (the process latch), and a
//     spent budget silences the hint.
//  §3 the composer's idle placeholder consumes the hint (call-shaped: the
//     rung sits ahead of the generic discoverability line).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-project-onboarding-renders.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'onb-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const ROOT = join(import.meta.dir, '..', '..')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { setCwd } = await import('../../src/utils/Shell.js')
const onboarding = (await import('../../src/projectOnboardingState.ts')) as unknown as {
  projectOnboardingHint?: (() => string | undefined) & { cache?: { clear?: () => void } }
  shouldShowProjectOnboarding: (() => boolean) & { cache?: { clear?: () => void } }
  noteProjectOnboardingShown?: () => void
  incrementProjectOnboardingSeenCount: () => void
}
const { getCurrentProjectConfig } = await import('../../src/utils/config.js')

const hintAt = (dir: string): string | undefined => {
  setCwd(dir)
  process.chdir(dir)
  onboarding.projectOnboardingHint?.cache?.clear?.()
  onboarding.shouldShowProjectOnboarding.cache?.clear?.()
  return onboarding.projectOnboardingHint?.()
}

section('§1 THE COMPOSED HINT, BY GROUND')
{
  check('the hint composer is exported (projectOnboardingHint)', typeof onboarding.projectOnboardingHint === 'function')
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'onb-empty-')))
  const emptyHint = hintAt(empty)
  check(
    'an empty directory gets the workspace invitation',
    emptyHint !== undefined && emptyHint.includes('build a fresh app'),
    String(emptyHint),
  )
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'onb-plain-')))
  writeFileSync(join(plain, 'notes.txt'), 'x\n')
  const plainHint = hintAt(plain)
  check(
    'a non-empty directory without MERCURY.md gets the /init step',
    plainHint !== undefined && plainHint.includes('/init'),
    String(plainHint),
  )
  const done = realpathSync(mkdtempSync(join(tmpdir(), 'onb-done-')))
  writeFileSync(join(done, 'MERCURY.md'), '# rules\n')
  check('a project with MERCURY.md gets nothing (complete)', hintAt(done) === undefined)
}

section('§2 THE SEEN BUDGET')
{
  const budget = realpathSync(mkdtempSync(join(tmpdir(), 'onb-budget-')))
  setCwd(budget)
  process.chdir(budget)
  check('the note caller is exported (noteProjectOnboardingShown)', typeof onboarding.noteProjectOnboardingShown === 'function')
  onboarding.noteProjectOnboardingShown?.()
  onboarding.noteProjectOnboardingShown?.()
  const count = getCurrentProjectConfig().projectOnboardingSeenCount ?? 0
  check('one session bumps the persisted count exactly once', count === 1, `count=${count}`)
  for (let i = 0; i < 4; i++) onboarding.incrementProjectOnboardingSeenCount()
  check('a spent budget silences the hint', hintAt(budget) === undefined)
}

section('§3 THE PLACEHOLDER CONSUMES IT (call-shaped)')
{
  const hook = readFileSync(
    join(ROOT, 'src', 'components', 'PromptInput', 'usePromptInputPlaceholder.ts'),
    'utf-8',
  )
  check(
    'the rung reads projectOnboardingHint before any submission',
    hook.includes('projectOnboardingHint()') && hook.includes('submitCount === 0'),
  )
  check(
    'the seen count bumps in an effect, once per session',
    hook.includes('noteProjectOnboardingShown()') && /useEffect\(\(\) => \{\s*\n\s*if \(onboardingHint !== undefined\) noteProjectOnboardingShown\(\)/.test(hook),
  )
  check(
    'the rung sits ahead of the generic discoverability line',
    hook.includes('onboardingHint !== undefined) {') &&
      hook.indexOf('onboardingHint !== undefined) {') < hook.indexOf('cockpitActive && submitCount < 2'),
  )
}

console.log(failures === 0 ? '\nprove-project-onboarding-renders: all green' : `\nprove-project-onboarding-renders: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
