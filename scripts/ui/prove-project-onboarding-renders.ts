#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'onb-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const onboardingFixHint = 'change projectOnboardingHint, noteProjectOnboardingShown or incrementProjectOnboardingSeenCount in src/boot/projectOnboarding.ts'
const check = (label: string, cond: boolean, detail = ''): void => {
  const shown = cond ? detail : detail ? detail + '; ' + onboardingFixHint : onboardingFixHint
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ' — ' + shown : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const { setCwd } = await import('../../src/platform/shell/shellExec.js')
const onboarding = (await import('../../src/boot/projectOnboarding.ts')) as unknown as {
  projectOnboardingHint?: (() => string | undefined) & { cache?: { clear?: () => void } }
  shouldShowProjectOnboarding: (() => boolean) & { cache?: { clear?: () => void } }
  noteProjectOnboardingShown?: () => void
  incrementProjectOnboardingSeenCount: () => void
}
const { getCurrentProjectConfig } = await import('../../src/platform/settings/config.js')

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
    'a non-empty directory without MERCURY.md gets the /orient step',
    plainHint !== undefined && plainHint.includes('/orient'),
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


console.log(failures === 0 ? '\nprove-project-onboarding-renders: all green' : `\nprove-project-onboarding-renders: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
