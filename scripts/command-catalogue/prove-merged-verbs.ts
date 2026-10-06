#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'merged-verbs-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.NODE_ENV
delete process.env.MERCURY_HOME

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

console.log('the merged command roster: one door per function, the absorbed names gone')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const commands = await import('../../src/commands.ts')
const roster = commands.builtinCommands()
const byName = (name: string): Record<string, unknown> | undefined =>
  commands.findCommand(name, roster) as Record<string, unknown> | undefined

check('/sessions is the one session door', byName('sessions') !== undefined)
check('/resume is gone (a name Mercury does not know)', commands.findCommand('resume', roster) === undefined)
check('/sessiontab is gone (the chord lives in the key handler)', commands.findCommand('sessiontab', roster) === undefined)
check('/daemon carries the halt verb headless', Array.isArray(byName('daemon')?.headlessVerbs) && (byName('daemon')?.headlessVerbs as readonly string[]).includes('halt'))
check('/halt is gone', commands.findCommand('halt', roster) === undefined)
check('/voice is the one voice door', byName('voice') !== undefined)
check('/speak is gone', commands.findCommand('speak', roster) === undefined)
check('/jev is the one JEV door', byName('jev') !== undefined)
check('/jevor is gone', commands.findCommand('jevor', roster) === undefined)
check('/appearance is the one appearance door', byName('appearance') !== undefined)
check('/accent is gone', commands.findCommand('accent', roster) === undefined)
check('/orient is the guide writer (a prompt command)', byName('orient')?.type === 'prompt')
check('/init is gone', commands.findCommand('init', roster) === undefined)

console.log('\nthe merged verbs drive the real road')

const slash = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
const { unknownCommandLine } = slash as unknown as { unknownCommandLine: (name: string, roster: unknown[]) => string }
check('a retired name answers as any unknown input', unknownCommandLine('halt', roster).startsWith('Unknown command: /halt'))
check('…never naming a replacement', !unknownCommandLine('speak', roster).includes('voice'))

const voice = (await import('../../src/commands/voice/voice.js')) as { call: (arg: string) => Promise<{ type: string; value: string }> }
const on = await voice.call('on')
check('/voice on arms the input', on.value.startsWith('voice input ON'), on.value.slice(0, 60))
const status = await voice.call('options')
check('/voice options lists the transcribers (the /speak door)', status.value.length > 0)

const jev = (await import('../../src/commands/jev/jev.js')) as { call: (arg: string) => Promise<{ type: string; value: string }> }
const orOn = await jev.call('or on')
check('/jev or on selects the OpenRouter road (the /jevor door)', orOn.value.length > 0, orOn.value.slice(0, 60))
const official = await jev.call('on')
check('/jev on selects the official road', official.value.length > 0)

const daemonModule = (await import('../../src/commands/daemon/daemon.js')) as { call: (onDone: (r?: string) => void, context: unknown, args: string) => Promise<null> }
let haltWords: string | undefined
const stubContext = { getAppState: () => ({ tasks: {} }), setAppState: (f: (p: unknown) => unknown) => f({}) }
await daemonModule.call(r => { haltWords = r }, stubContext, 'halt')
check("/daemon halt runs the hard stop to its receipt", haltWords !== undefined && haltWords.startsWith('⊘ Hard stop'), haltWords ?? 'no receipt')

const appearance = (await import('../../src/commands/appearance/appearance.js')) as { call: (onDone: (r?: string) => void, context: unknown, args: string) => Promise<string | null> }
let accentWords: string | undefined
await appearance.call(r => { accentWords = r }, {}, 'accent reset')
check('/appearance accent reset answers (the /accent door)', accentWords !== undefined && accentWords.length > 0, accentWords)
let named: string | undefined
await appearance.call(r => { named = r }, {}, 'accent')
check('/appearance accent (bare) shows the status + names', named !== undefined && named.includes('accent '), named?.slice(0, 50))

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ MERGED VERBS GREEN')
  process.exit(0)
}
console.log(` ❌ MERGED VERBS RED (${failures} failed)`)
process.exit(1)
