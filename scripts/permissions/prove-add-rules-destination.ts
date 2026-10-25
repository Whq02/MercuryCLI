#!/usr/bin/env bun
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'add-rules-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'add-rules-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'
process.chdir(PROJ)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const effects: string[] = []
const updateModule = await import('../../src/utils/permissions/PermissionUpdate.ts')
const { applyPermissionUpdate: realApply, persistPermissionUpdate: realPersist } = updateModule
mock.module('../../src/utils/permissions/PermissionUpdate.js', () => ({
  ...updateModule,
  applyPermissionUpdate: (context: unknown, update: unknown) => {
    effects.push(`apply ${j(update)}`)
    return realApply(context as never, update as never)
  },
  persistPermissionUpdate: (update: unknown) => {
    effects.push(`persist ${j((update as { destination: string }).destination)}`)
    return realPersist(update as never)
  },
}))
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { AddPermissionRules } = await import('../../src/components/permissions/rules/AddPermissionRules.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { KeybindingProvider } = await import('../../src/keybindings/KeybindingContext.js')
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/ink.js')
type Ctx = ReturnType<typeof getEmptyToolPermissionContext>
type Rule = { source: string; ruleBehavior: string; ruleValue: { toolName: string; ruleContent?: string } }
type Finding = { rule: Rule; shadowType: string }

const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
const mount = async (props: Record<string, unknown>, columns = 100) => {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows: 40 }) as unknown as NodeJS.WriteStream
  const store = createStore(getDefaultAppState())
  const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const registry = { current: new Map<string, Set<{ action: string; context: string; handler: () => void }>>() }
  const keys = { bindings: [], pendingChordRef: { current: null }, pendingChord: null, setPendingChord() {}, activeContexts: new Set(['Select', 'Confirmation']), registerActiveContext() {}, unregisterActiveContext() {}, handlerRegistryRef: registry }
  const tree = React.createElement(
    StdinContext.Provider,
    { value: stdinValue as never },
    React.createElement(
      TerminalSizeContext.Provider,
      { value: { columns, rows: 40 } },
      React.createElement(
        AppStoreContext.Provider,
        { value: store as never },
        React.createElement(KeybindingProvider, keys as never, React.createElement(Box, { flexDirection: 'column', width: columns }, React.createElement(AddPermissionRules, props as never))),
      ),
    ),
  )
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  return {
    lines: (): string[] => stripAnsi(instance.lastFrame()).replace(/\s+$/, '').split('\n').map(line => line.trimEnd()),
    async action(name: string): Promise<void> {
      for (const registration of registry.current.get(name) ?? []) registration.handler()
      await settle()
    },
    close() { instance.unmount(); instance.cleanup(); stream.destroy() },
  }
}
const has = (lines: string[], text: string): boolean => lines.some(line => line.includes(text))
const rowOf = (lines: string[], text: string): number => lines.findIndex(line => line.includes(text))

section('§1 ONE RULE — the title, the question, the spelled rule and the three destinations with their files')
{
  const one = await mount({ ruleValues: [{ toolName: 'Bash', ruleContent: 'npm test' }], ruleBehavior: 'allow', initialContext: getEmptyToolPermissionContext(), setToolPermissionContext() {}, onAddRules() {}, onCancel() {} })
  const lines = one.lines()
  check('the title names one rule', has(lines, 'Add rule') && !has(lines, 'Add rules'), lines.join(' | '))
  check('the question is singular', has(lines, 'Where should this rule be saved?'))
  check('the rule is spelled', has(lines, 'Bash(npm test)'))
  const local = rowOf(lines, 'Project settings (local)')
  const project = rowOf(lines, 'Project settings (checked in)')
  const user = rowOf(lines, 'User settings')
  check('the destinations come in SOURCES order: local, checked in, user', local >= 0 && project > local && user > project, lines.join(' | '))
  check('the user destination is described by its tilde path', has(lines, '~/') || has(lines, 'settings.json'), lines.join(' | '))
  check('the project destinations are described by paths relative to the project', has(lines, join('.mercury', 'settings.local.json')) && has(lines, join('.mercury', 'settings.json')), lines.join(' | '))
  one.close()
}

section('§2 TWO RULES — the plural words, each rule in order')
{
  const two = await mount({ ruleValues: [{ toolName: 'Read', ruleContent: 'docs/**' }, { toolName: 'WebFetch' }], ruleBehavior: 'deny', initialContext: getEmptyToolPermissionContext(), setToolPermissionContext() {}, onAddRules() {}, onCancel() {} })
  const lines = two.lines()
  check('the title is plural', has(lines, 'Add rules'))
  check('the question is plural', has(lines, 'Where should these rules be saved?'))
  check('the rules are spelled in order', rowOf(lines, 'Read(docs/**)') >= 0 && rowOf(lines, 'WebFetch') > rowOf(lines, 'Read(docs/**)'))
  two.close()
}

section('§3 A CHOICE — apply, persist, set, then the report: the created rules carry the destination; a finding counts only for an added rule')
{
  const added: Rule[][] = []
  const findings: (Finding[] | undefined)[] = []
  const contexts: Ctx[] = []
  const initial: Ctx = {
    ...getEmptyToolPermissionContext(),
    alwaysDenyRules: { userSettings: ['Bash', 'Read'] },
    alwaysAllowRules: { userSettings: ['Read(secrets/keys/**)'] },
  } as unknown as Ctx
  const dialog = await mount({
    ruleValues: [{ toolName: 'Bash', ruleContent: 'npm test' }, { toolName: 'Read', ruleContent: 'docs/**' }],
    ruleBehavior: 'allow',
    initialContext: initial,
    setToolPermissionContext: (context: Ctx) => { contexts.push(context); effects.push('set') },
    onAddRules: (rules: Rule[], unreachable?: Finding[]) => { added.push(rules); findings.push(unreachable); effects.push('report') },
    onCancel() { effects.push('cancel') },
  })
  await dialog.action('select:accept')
  check('the effects run in order: apply, persist, set, report', j(effects.map(line => line.split(' ')[0])) === j(['apply', 'persist', 'set', 'report']), j(effects))
  check('the update carries the values, the behaviour and the chosen (first) destination', effects[0] === `apply ${j({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }, { toolName: 'Read', ruleContent: 'docs/**' }], behavior: 'allow', destination: 'localSettings' })}`, effects[0])
  check('the setter receives the context with the rules applied', contexts.length === 1 && j((contexts[0] as unknown as { alwaysAllowRules: Record<string, string[]> }).alwaysAllowRules.localSettings) === j(['Bash(npm test)', 'Read(docs/**)']), j(contexts[0]))
  check('the created rules name the destination, the behaviour and each value in order', j(added[0]) === j([{ source: 'localSettings', ruleBehavior: 'allow', ruleValue: { toolName: 'Bash', ruleContent: 'npm test' } }, { source: 'localSettings', ruleBehavior: 'allow', ruleValue: { toolName: 'Read', ruleContent: 'docs/**' } }]), j(added[0]))
  const reported = findings[0] ?? []
  check('both added rules are reported as blocked by the tool-wide denies', reported.length === 2 && reported.every(finding => finding.shadowType === 'deny') && j(reported.map(finding => finding.rule.ruleValue.ruleContent)) === j(['npm test', 'docs/**']), j(reported))
  check('the pre-existing shadowed rule (Read(secrets/keys/**) under the Read deny) is not reported: only added rules count', reported.every(finding => finding.rule.ruleValue.ruleContent !== 'secrets/keys/**'), j(reported))
  const file = join(PROJ, '.mercury', 'settings.local.json')
  check('the rules were persisted to the local project settings file', existsSync(file) && readFileSync(file, 'utf8').includes('Bash(npm test)'), existsSync(file) ? readFileSync(file, 'utf8') : 'no file')
  dialog.close()
}

section('§4 NO FINDING — a clean add reports undefined, not an empty list; escape cancels')
{
  effects.length = 0
  const findings: unknown[] = []
  const dialog = await mount({ ruleValues: [{ toolName: 'Glob' }], ruleBehavior: 'allow', initialContext: getEmptyToolPermissionContext(), setToolPermissionContext() {}, onAddRules: (_rules: Rule[], unreachable?: unknown) => { findings.push(unreachable) }, onCancel() { effects.push('cancel') } })
  await dialog.action('select:next')
  await dialog.action('select:next')
  await dialog.action('select:accept')
  check('the third row is the user destination', effects.some(line => line === 'persist "userSettings"'), j(effects))
  check('a clean add reports no findings as undefined', findings.length === 1 && findings[0] === undefined, j(findings))
  dialog.close()
  effects.length = 0
  const cancelled = await mount({ ruleValues: [{ toolName: 'Glob' }], ruleBehavior: 'allow', initialContext: getEmptyToolPermissionContext(), setToolPermissionContext() {}, onAddRules() { effects.push('report') }, onCancel() { effects.push('cancel') } })
  await cancelled.action('confirm:no')
  check('escape cancels without a report', j(effects) === j(['cancel']), j(effects))
  cancelled.close()
}

console.log(failures === 0 ? '\nPASS add rules destination' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
