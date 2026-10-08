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
const { bashToolCheckExactMatchPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const { checkParsedCommand: bashToolCheckPermission } = await import('../bash/floor-proof-helpers.ts')
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
const decide = async (command: string, ctx: Ctx): Promise<Decision> => await bashToolCheckPermission({ command } as never, ctx as never) as unknown as Decision
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
  check('`npm run build` is allowed by `Bash(npm run *)`', (await decide('npm run build', star)).behavior === 'allow' && (await decide('npm run build', star)).decisionReason?.rule?.ruleValue.ruleContent === 'npm run *', j((await decide('npm run build', star))))
  check('`npm run` alone is allowed by `Bash(npm run *)`', (await decide('npm run', star)).behavior === 'allow', j((await decide('npm run', star))))
  check('`npm runner` is not', (await decide('npm runner', star)).behavior === 'passthrough', j((await decide('npm runner', star))))
  check('`NODE_ENV=test npm run build` is (a safe assignment is stripped)', (await decide('NODE_ENV=test npm run build', star)).behavior === 'allow', j((await decide('NODE_ENV=test npm run build', star))))
  const exactRule = ctxWith({ allow: ['Bash(npm run)'] })
  check('`Bash(npm run)` allows that command alone', exact('npm run', exactRule).behavior === 'allow' && (await decide('npm run build', exactRule)).behavior === 'passthrough', j((await decide('npm run build', exactRule))))
  const colon = ctxWith({ allow: ['Bash(npm run:*)'] })
  const nonsense = ctxWith({ allow: ['Bash(npm run:%)'] })
  for (const command of ['npm run', 'npm run build', 'xargs npm run build']) {
    const a = (await decide(command, colon))
    const b = (await decide(command, nonsense))
    check(`\`Bash(npm run:*)\` and \`Bash(npm run:%)\` decide ${j(command)} alike: ${b.behavior}`, a.behavior === b.behavior && a.behavior === 'passthrough', `${j(a)} vs ${j(b)}`)
  }
  const denyStar = ctxWith({ deny: ['Bash(rm *)'] })
  check('`Bash(rm *)` in deny refuses `rm -rf dist`', (await decide('rm -rf dist', denyStar)).behavior === 'deny', j((await decide('rm -rf dist', denyStar))))
  check('…and `rm` alone', (await decide('rm', denyStar)).behavior === 'deny', j((await decide('rm', denyStar))))
  check('…but not `rmdir x`', (await decide('rmdir x', denyStar)).behavior !== 'deny', j((await decide('rmdir x', denyStar))))
  const askStar = ctxWith({ ask: ['Bash(git push *)'] })
  check('`Bash(git push *)` in ask asks for `git push origin main`', (await decide('git push origin main', askStar)).behavior === 'ask', j((await decide('git push origin main', askStar))))
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

section('§5 ONE VOICE WHEN A RULE DECIDES — what was attempted, the verdict, the rule as written, where it lives')
{
  const reasonModule = await import('../../src/utils/permissions/ruleReason.js') as Record<string, unknown>
  check('the one sentence helper exists', typeof reasonModule.ruleSentence === 'function' && typeof reasonModule.ruleSourceWords === 'function')
  if (typeof reasonModule.ruleSentence !== 'function') {
    console.log(`\n❌ rule-words: ${failures} failure(s)`)
    process.exit(1)
  }
  const { ruleSentence, ruleSourceWords, refusalWithReason } = reasonModule as unknown as typeof import('../../src/utils/permissions/ruleReason.js')
  const { createPermissionRequestMessage } = await import('../../src/utils/permissions/decision/requestMessage.js')
  const { checkReadPermissionForTool, checkWritePermissionForTool } = await import('../../src/utils/permissions/filesystem.js')
  const { PermissionRuleExplanation } = await import('../../src/components/permissions/PermissionRuleExplanation.js')
  const rule = (source: string, behavior: 'allow' | 'deny' | 'ask', toolName: string, ruleContent?: string) =>
    ({ source, ruleBehavior: behavior, ruleValue: { toolName, ...(ruleContent === undefined ? {} : { ruleContent }) } }) as never
  check('a deny names what was attempted, the rule and the file', ruleSentence('rm -rf dist', 'deny', rule('projectSettings', 'deny', 'Bash', 'rm *')) === 'rm -rf dist is denied by the rule Bash(rm *) in the shared project settings.')
  check('an ask says "asks first" and names the rule', ruleSentence('git push origin main', 'ask', rule('userSettings', 'ask', 'Bash', 'git push *')) === 'git push origin main asks first — the rule Bash(git push *) in your user settings.')
  check('an allow names the rule that allowed it', ruleSentence('npm run build', 'allow', rule('localSettings', 'allow', 'Bash', 'npm run *')) === 'npm run build is allowed by the rule Bash(npm run *) in the project local settings.')
  check('a whole-tool rule is named bare', ruleSentence('Using WebFetch', 'deny', rule('policySettings', 'deny', 'WebFetch')) === 'Using WebFetch is denied by the rule WebFetch in the managed settings.')
  check('every rule source has its words', (['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings', 'cliArg', 'command', 'session', 'toolsNarrowing', 'mcpServerPolicy'] as const).every(source => typeof ruleSourceWords(source) === 'string' && ruleSourceWords(source).length > 0))
  check('your own reason rides the end of the sentence', refusalWithReason(ruleSentence('rm -rf dist', 'deny', rule('projectSettings', 'deny', 'Bash', 'rm *')), 'the build tree is sacred') === 'rm -rf dist is denied by the rule Bash(rm *) in the shared project settings: the build tree is sacred.')

  const denyCtx = ctxWith({ deny: ['Bash(rm *)'] }, 'projectSettings')
  check('the Bash road: a deny rule speaks the sentence', (await decide('rm -rf dist', denyCtx)).message === 'rm -rf dist is denied by the rule Bash(rm *) in the shared project settings.', j((await decide('rm -rf dist', denyCtx))))
  const askCtx = ctxWith({ ask: ['Bash(git push *)'] }, 'userSettings')
  check('the Bash road: an ask rule speaks the sentence', (await decide('git push origin main', askCtx)).message === 'git push origin main asks first — the rule Bash(git push *) in your user settings.', j((await decide('git push origin main', askCtx))))
  const psDeny = powershellToolCheckPermission({ command: 'Remove-Item -Recurse dist' }, ctxWith({ deny: ['PowerShell(Remove-Item *)'] }, 'userSettings') as never) as unknown as Decision
  check('the PowerShell road: the same sentence', psDeny.message === 'Remove-Item -Recurse dist is denied by the rule PowerShell(Remove-Item *) in your user settings.', j(psDeny))
  const fileCtx = ctxWith({ deny: ['Read(//etc/passwd)'], ask: ['Edit(//tmp/notes.txt)'] }, 'userSettings')
  const readTool = { name: 'Read', getPath: (input: { file_path: string }) => input.file_path }
  const readDenied = checkReadPermissionForTool(readTool as never, { file_path: '/etc/passwd' }, fileCtx as never) as unknown as Decision
  check('the file road: reading a denied path speaks the sentence', readDenied.behavior === 'deny' && readDenied.message === 'Reading /etc/passwd is denied by the rule Read(//etc/passwd) in your user settings.', j(readDenied))
  const editAsked = checkWritePermissionForTool({ name: 'Edit', getPath: readTool.getPath } as never, { file_path: '/tmp/notes.txt' }, fileCtx as never) as unknown as Decision
  check('the file road: editing an asked path speaks the sentence', editAsked.behavior === 'ask' && editAsked.message === 'Editing /tmp/notes.txt asks first — the rule Edit(//tmp/notes.txt) in your user settings.', j(editAsked))
  check('the wire: an ask carried by its rule speaks the sentence', createPermissionRequestMessage('WebFetch', { type: 'rule', rule: rule('projectSettings', 'ask', 'WebFetch', 'domain:example.com') } as never) === 'This WebFetch call asks first — the rule WebFetch(domain:example.com) in the shared project settings.')

  const settle = async (): Promise<void> => {
    for (let index = 0; index < 6; index++) {
      flushPendingSyncWork()
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
  }
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns: 120, rows: 40 }) as unknown as NodeJS.WriteStream
  const store = createStore({ ...getDefaultAppState(), toolPermissionContext: askCtx as never })
  const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const decision = { behavior: 'ask', message: 'x', decisionReason: { type: 'rule', rule: rule('userSettings', 'ask', 'Bash', 'git push *') } }
  const tree = React.createElement(
    StdinContext.Provider,
    { value: stdinValue as never },
    React.createElement(
      TerminalSizeContext.Provider,
      { value: { columns: 120, rows: 40 } },
      React.createElement(AppStoreContext.Provider, { value: store as never }, React.createElement(Box, { flexDirection: 'column', width: 120 }, React.createElement(PermissionRuleExplanation, { permissionResult: decision as never, toolType: 'command' }))),
    ),
  )
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  const cardLines = stripAnsi(instance.lastFrame()).replace(/\s+$/, '').split('\n').map(line => line.trimEnd())
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  check('the card: the rule line and the hint', j(cardLines) === j(['The rule Bash(git push *) in your user settings asks first.', 'Rules live in /permissions']), j(cardLines))
}

console.log()
if (failures) {
  console.log(`❌ rule-words: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ rule-words green')
