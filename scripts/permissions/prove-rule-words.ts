#!/usr/bin/env bun
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'rule-words-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'rule-words-proj-')))
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

async function stub(path: string, fixture: () => Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixture() }))
}
await stub('../../src/keybindings/useKeybinding.js', () => ({ useKeybinding: () => undefined, useKeybindings: () => undefined }))
await stub('../../src/utils/unaryLogging.js', () => ({ logUnaryEvent: async () => undefined }))

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const shell = await import('../../src/utils/permissions/shellRuleMatching.js')
const { validatePermissionRule } = await import('../../src/utils/settings/permissionValidation.js')
const { isDangerousBashPermission } = await import('../../src/utils/permissions/permissionSetup.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { bashToolCheckExactMatchPermission, bashToolCheckPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const { powershellToolCheckPermission } = await import('../../src/tools/PowerShellTool/powershellPermissions.js')
const { PermissionRuleDescription } = await import('../../src/components/permissions/rules/PermissionRuleDescription.js')
const { PermissionRuleInput } = await import('../../src/components/permissions/rules/PermissionRuleInput.js')
const { bashToolUseOptions } = await import('../../src/components/permissions/BashPermissionRequest/bashToolUseOptions.js')
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/ink.js')

type Ctx = ReturnType<typeof getEmptyToolPermissionContext>
type Decision = { behavior: string; message?: string; decisionReason?: { type: string; rule?: { ruleValue: { ruleContent?: string } } } }
const ctxWith = (rules: { allow?: string[]; deny?: string[]; ask?: string[] }, source = 'localSettings'): Ctx =>
  ({
    ...getEmptyToolPermissionContext(),
    alwaysAllowRules: rules.allow ? { [source]: rules.allow } : {},
    alwaysDenyRules: rules.deny ? { [source]: rules.deny } : {},
    alwaysAskRules: rules.ask ? { [source]: rules.ask } : {},
  }) as unknown as Ctx
const decide = (command: string, ctx: Ctx): Decision => bashToolCheckPermission({ command } as never, ctx as never) as unknown as Decision
const exact = (command: string, ctx: Ctx): Decision => bashToolCheckExactMatchPermission({ command } as never, ctx as never) as unknown as Decision

section('§1 THE "STARTS WITH" RULE — a space and a star end it; the parser knows two kinds')
{
  check('`npm run *` is a wildcard rule', shell.parsePermissionRule('npm run *').type === 'wildcard')
  check('`npm run` is an exact rule', shell.parsePermissionRule('npm run').type === 'exact')
  check('the parser knows exact and wildcard and nothing else', ['npm run *', 'npm run', 'npm run:*', ':*', 'npm *build'].every(rule => ['exact', 'wildcard'].includes(shell.parsePermissionRule(rule).type)))
  check('the command words of `npm run *` are `npm run`', shell.permissionRuleExtractPrefix('npm run *') === 'npm run')
  check('an exact rule has no "starts with" words', shell.permissionRuleExtractPrefix('npm run') === null)
  check('a star inside the words is a pattern, not a "starts with" rule', shell.permissionRuleExtractPrefix('npm *build') === null && shell.permissionRuleExtractPrefix('npm * *') === null)
  check('a bare star after a space names no command', shell.permissionRuleExtractPrefix(' *') === null)
  check('an escaped star is a literal', shell.permissionRuleExtractPrefix('npm run \\*') === null)
  const suggested = shell.suggestionForPrefix('Bash', 'npm run') as Array<{ rules: Array<{ toolName: string; ruleContent?: string }> }>
  check('the "don\'t ask again" suggestion writes `npm run *`', suggested[0]?.rules[0]?.ruleContent === 'npm run *' && suggested[0]?.rules[0]?.toolName === 'Bash', j(suggested))
}

section('§2 WHAT A RULE DECIDES — `Bash(npm run *)` covers the command and its arguments; a spelling the grammar does not know covers nothing')
{
  const star = ctxWith({ allow: ['Bash(npm run *)'] })
  check('`npm run build` is allowed by `Bash(npm run *)`', decide('npm run build', star).behavior === 'allow' && decide('npm run build', star).decisionReason?.rule?.ruleValue.ruleContent === 'npm run *', j(decide('npm run build', star)))
  check('`npm run` alone is allowed by `Bash(npm run *)`', decide('npm run', star).behavior === 'allow', j(decide('npm run', star)))
  check('`npm runner` is not', decide('npm runner', star).behavior === 'passthrough', j(decide('npm runner', star)))
  check('`NODE_ENV=test npm run build` is (a safe assignment is stripped)', decide('NODE_ENV=test npm run build', star).behavior === 'allow', j(decide('NODE_ENV=test npm run build', star)))
  const exactRule = ctxWith({ allow: ['Bash(npm run)'] })
  check('`Bash(npm run)` allows that command alone', exact('npm run', exactRule).behavior === 'allow' && decide('npm run build', exactRule).behavior === 'passthrough', j(decide('npm run build', exactRule)))
  const colon = ctxWith({ allow: ['Bash(npm run:*)'] })
  const nonsense = ctxWith({ allow: ['Bash(npm run:%)'] })
  for (const command of ['npm run', 'npm run build', 'xargs npm run build']) {
    const a = decide(command, colon)
    const b = decide(command, nonsense)
    check(`\`Bash(npm run:*)\` and \`Bash(npm run:%)\` decide ${j(command)} alike: ${b.behavior}`, a.behavior === b.behavior && a.behavior === 'passthrough', `${j(a)} vs ${j(b)}`)
  }
  const denyStar = ctxWith({ deny: ['Bash(rm *)'] })
  check('`Bash(rm *)` in deny refuses `rm -rf dist`', decide('rm -rf dist', denyStar).behavior === 'deny', j(decide('rm -rf dist', denyStar)))
  check('…and `rm` alone', decide('rm', denyStar).behavior === 'deny', j(decide('rm', denyStar)))
  check('…but not `rmdir x`', decide('rmdir x', denyStar).behavior !== 'deny', j(decide('rmdir x', denyStar)))
  const askStar = ctxWith({ ask: ['Bash(git push *)'] })
  check('`Bash(git push *)` in ask asks for `git push origin main`', decide('git push origin main', askStar).behavior === 'ask', j(decide('git push origin main', askStar)))
  const ps = powershellToolCheckPermission({ command: 'Get-Process -Name node' }, ctxWith({ allow: ['PowerShell(Get-Process *)'] }) as never) as unknown as Decision
  check('`PowerShell(Get-Process *)` allows `Get-Process -Name node`', ps.behavior === 'allow', j(ps))
  const psColon = powershellToolCheckPermission({ command: 'Get-Process -Name node' }, ctxWith({ allow: ['PowerShell(Get-Process:*)'] }) as never) as unknown as Decision
  check('`PowerShell(Get-Process:*)` covers nothing', psColon.behavior === 'passthrough', j(psColon))
}

section('§3 THE VALIDATOR — the star forms are legal; no sentence of its own names a form the grammar does not have')
{
  check('`Bash(npm run *)` validates', validatePermissionRule('Bash(npm run *)').valid)
  check('`Bash(npm *build)` validates', validatePermissionRule('Bash(npm *build)').valid)
  check('`Bash(npm run)` validates', validatePermissionRule('Bash(npm run)').valid)
  check('`Bash(npm run:*)` is plain content and validates like `Bash(npm run:%)`', validatePermissionRule('Bash(npm run:*)').valid === validatePermissionRule('Bash(npm run:%)').valid)
  for (const rule of ['Bash(:*)', 'Bash(npm:* run)', 'Read(src:*)', 'Edit(:*)']) {
    const result = validatePermissionRule(rule)
    const words = [result.error, result.suggestion, ...(result.examples ?? [])].filter((w): w is string => typeof w === 'string')
    check(`no validator sentence for ${j(rule)} spells a colon-star form`, words.every(w => !w.includes(':*')), j(result))
  }
  check('a dangerous "starts with" allow is still seen as dangerous', isDangerousBashPermission('Bash', 'bash *') && isDangerousBashPermission('Bash', 'bash*') && isDangerousBashPermission('Bash', 'bash'))
  check('an ordinary "starts with" allow is not', !isDangerousBashPermission('Bash', 'git *'))
}

section('§4 THE SCREENS — the gloss, the free-text example and the card placeholder speak the star form')
{
  const settle = async (): Promise<void> => {
    for (let index = 0; index < 6; index++) {
      flushPendingSyncWork()
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
  }
  const mount = async (node: React.ReactNode, columns = 120): Promise<{ frame: () => string; close: () => void }> => {
    const emitter = new EventEmitter()
    const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
    const stream = new PassThrough()
    stream.resume()
    const stdout = Object.assign(stream, { columns, rows: 40 }) as unknown as NodeJS.WriteStream
    const store = createStore({ ...getDefaultAppState() })
    const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
    const tree = React.createElement(
      StdinContext.Provider,
      { value: stdinValue as never },
      React.createElement(
        TerminalSizeContext.Provider,
        { value: { columns, rows: 40 } },
        React.createElement(AppStoreContext.Provider, { value: store as never }, React.createElement(Box, { flexDirection: 'column', width: columns }, node)),
      ),
    )
    let painted = (): void => {}
    const firstFrame = new Promise<void>(resolve => { painted = resolve })
    const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
    await firstFrame
    await settle()
    return {
      frame: () => stripAnsi(instance.lastFrame()).replace(/\s+$/, ''),
      close: () => { instance.unmount(); instance.cleanup(); stream.destroy() },
    }
  }
  const gloss = async (ruleContent?: string): Promise<string> => {
    const mounted = await mount(React.createElement(PermissionRuleDescription, { ruleValue: { toolName: 'Bash', ...(ruleContent === undefined ? {} : { ruleContent }) } }))
    const text = mounted.frame().trim()
    mounted.close()
    return text
  }
  check('the gloss of `Bash(npm run *)`', (await gloss('npm run *')) === 'any Bash command starting with npm run', await gloss('npm run *'))
  check('the gloss of `Bash(npm run)`', (await gloss('npm run')) === 'the Bash command npm run', await gloss('npm run'))
  check('the gloss of `Bash(npm *build)`', (await gloss('npm *build')) === 'any Bash command matching npm *build', await gloss('npm *build'))
  check('the gloss of `Bash`', (await gloss()) === 'any Bash command', await gloss())
  const input = await mount(React.createElement(PermissionRuleInput, { onCancel: () => {}, onSubmit: () => {}, ruleBehavior: 'allow' }))
  const inputFrame = input.frame()
  input.close()
  check('the free-text entry teaches `Bash(ls *)`', inputFrame.includes('Bash(ls *)'), inputFrame)
  check('…and no colon-star example', !inputFrame.includes(':*'), inputFrame)
  const options = bashToolUseOptions({ suggestions: shell.suggestionForPrefix('Bash', 'npm run') as never, onRejectFeedbackChange: () => {}, onAcceptFeedbackChange: () => {}, editablePrefix: 'npm run *', onEditablePrefixChange: () => {} }) as Array<{ value: string; placeholder?: string; initialValue?: string }>
  const editable = options.find(option => option.value === 'yes-edited-prefix')
  check('the Bash card\'s "starts with" box is seeded and placeholdered in the star form', editable?.initialValue === 'npm run *' && editable?.placeholder === 'npm run *', j(editable))
}

console.log()
if (failures) {
  console.log(`❌ rule-words: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ rule-words green')
