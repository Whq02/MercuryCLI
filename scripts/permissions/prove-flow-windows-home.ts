#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as os from 'node:os'
import * as path from 'node:path'
import { ROADS, asksWith, check, finish, j, openKit, refusedWith } from './flowLawKit.ts'

const home = 'C:\\Users\\operator'
process.env.HOME = process.env.USERPROFILE = home
mock.module('node:os', () => ({ ...os, homedir: () => home }))
if (process.platform !== 'win32') {
  const { posix, win32 } = path
  const drive = (word: string): boolean => /^[A-Za-z]:[\\/]/.test(word)
  mock.module('node:path', () => ({
    ...path,
    resolve: (...words: string[]) => (words.some(drive) ? win32 : posix).resolve(...words),
    dirname: (word: string) => (drive(word) ? win32 : posix).dirname(word),
    isAbsolute: (word: string) => (drive(word) ? win32 : posix).isAbsolute(word),
  }))
}
const kit = await openKit('flow-windows-home')
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
try {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  const { getPlatform } = await import('../../src/platform/environment/platform.ts')
  getPlatform.cache.set(undefined, 'windows')
  const { setOriginalCwd, setCwdState } = await import('../../src/boot/process-state/processState.ts')
  setOriginalCwd('C:\\src\\project')
  setCwdState('C:\\src\\project')
  for (const [command, words] of [
    ['cd ~ && echo x > notes.txt', 'Flow asks before echo x > notes.txt: it writes ~\\notes.txt, outside the project.'],
    ['echo "export X=1" >> "$HOME/.zshrc"', 'Flow asks before echo "export X=1" >> "$HOME/.zshrc": it writes ~/.zshrc, outside the project.'],
  ] as const) {
    for (const road of ROADS) {
      const outcome = await kit.decide(command, { road })
      const ok = road === 'prompt-less' ? refusedWith(outcome, words) : asksWith(outcome, words) && outcome.wrapper.decidedBy === 'flowLaw'
      check(`${road}: ${command} → ${words}`, ok, `${j(outcome.decision)}; change scanReading and tildePath in src/permissions/rules/flowLaw.ts`)
    }
  }
} finally {
  Object.defineProperty(process, 'platform', platform)
  kit.close()
}
finish('prove-flow-windows-home')
