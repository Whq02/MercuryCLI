#!/usr/bin/env bun
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const launchDir = process.cwd()
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'rule-reason-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'rule-reason-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'
delete process.env.CLAUDE_CONFIG_DIR
process.chdir(PROJ)
const argAt = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const frameDir = argAt('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

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
const parseRoutes = new Map<string, unknown>()
{
  const ast = await import('../../src/utils/bash/ast.js')
  const parseUnrouted = ast.parseForSecurity
  mock.module('../../src/utils/bash/ast.js', () => ({
    ...ast,
    parseForSecurity: async (command: string) => parseRoutes.get(command) ?? parseUnrouted(command),
  }))
}

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { generateSettingsJSONSchema } = await import('../../src/utils/settings/schemaOutput.js')
const { SettingsSchema } = await import('../../src/utils/settings/types.js')
const { validateSettingsFileContent } = await import('../../src/utils/settings/validation.js')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const { loadAllPermissionRulesFromDisk } = await import('../../src/utils/permissions/permissionsLoader.js')
const { applyPermissionRulesToPermissionContext, syncPermissionRulesFromDisk, hasPermissionsToUseTool } = await import('../../src/utils/permissions/permissions.js')
const { applyPermissionUpdate } = await import('../../src/utils/permissions/PermissionUpdate.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { checkReadPermissionForTool, checkWritePermissionForTool } = await import('../../src/utils/permissions/filesystem.js')
const { bashToolCheckExactMatchPermission, bashToolCheckPermission, bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const { SandboxManager } = await import('../../src/utils/sandbox/sandbox-adapter.js')
const { PermissionRuleExplanation } = await import('../../src/components/permissions/PermissionRuleExplanation.js')
const { FallbackPermissionRequest } = await import('../../src/components/permissions/FallbackPermissionRequest.js')
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createStore } = await import('../../src/state/store.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/ink.js')
const { default: Ajv2020 } = await import('ajv/dist/2020.js')
const helper = await import('../../src/utils/permissions/ruleReason.js').catch(() => null)

type Rule = { source: string; ruleBehavior: string; ruleValue: { toolName: string; ruleContent?: string; reason?: string } }
type Decision = { behavior: string; message?: string; decisionReason?: { type: string; rule?: Rule } }
type Ctx = ReturnType<typeof getEmptyToolPermissionContext>
type Reasons = Record<string, string>

const R_SECRETS = 'production keys live there; use the .example files'
const R_PROD = 'the production tree is owned by the release lead'
const R_FETCH = 'this repository is built offline'
const R_GITHUB = 'the GitHub server is read-only here'
const R_ISSUE = 'issues are filed by the lead, never by an agent'
const R_PUSH = 'pushes go through the release lead'

const ctxWith = (rules: { allow?: string[]; deny?: string[]; ask?: string[] }, reasons?: Reasons, source = 'session'): Ctx =>
  ({
    ...getEmptyToolPermissionContext(),
    alwaysAllowRules: rules.allow ? { [source]: rules.allow } : {},
    alwaysDenyRules: rules.deny ? { [source]: rules.deny } : {},
    alwaysAskRules: rules.ask ? { [source]: rules.ask } : {},
    ...(reasons ? { ruleReasons: { [source]: reasons } } : {}),
  }) as unknown as Ctx

section('§1 THE SETTINGS SCHEMA — permissions.reasons is declared, typed, and optional')
{
  const schema = JSON.parse(generateSettingsJSONSchema()) as { properties: { permissions: { properties: Record<string, { type?: string; additionalProperties?: { type?: string } }> } } }
  const declared = Object.keys(schema.properties.permissions.properties)
  const reasons = schema.properties.permissions.properties['reasons']
  check(
    'the generated settings schema declares permissions.reasons as a rule-spelling → words map',
    reasons !== undefined && reasons.type === 'object' && reasons.additionalProperties?.type === 'string',
    `permissions declares only: ${declared.join(', ')}`,
  )
  const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false })
  const validate = ajv.compile(schema as object)
  const withMap = { permissions: { deny: ['Read(secrets/**)'], reasons: { 'Read(secrets/**)': R_SECRETS } } }
  const withoutMap = { permissions: { deny: ['Read(secrets/**)'] } }
  check('a file carrying the map validates against the schema', validate(withMap) === true, j(validate.errors))
  check('a file without the map (an older build wrote it) validates against the schema', validate(withoutMap) === true, j(validate.errors))
  check('a non-string reason is refused by the schema', validate({ permissions: { reasons: { Read: 5 } } }) === false, 'the schema accepted { reasons: { Read: 5 } }')
  const parsed = SettingsSchema().safeParse(withMap)
  check('the runtime settings parse keeps the map', parsed.success && j((parsed.data as { permissions?: { reasons?: unknown } }).permissions?.reasons) === j(withMap.permissions.reasons))
  check('the runtime settings parse of an older file still succeeds', SettingsSchema().safeParse(withoutMap).success)
  check('the strict edit-time validation admits the map', validateSettingsFileContent(JSON.stringify(withMap)).isValid)
}

section('§2 THE LOADER AND THE CONTEXT — the words ride from the file into the posture and leave with the file')
{
  const settingsPath = join(HOME, 'settings.json')
  const file = {
    permissions: {
      deny: ['Read(secrets/**)', 'WebFetch'],
      ask: [' Bash(git push:*) '],
      reasons: { 'Read(secrets/**)': R_SECRETS, WebFetch: R_FETCH, 'Bash(git push:*)': R_PUSH, 'Bash(git fetch:*)': 'a reason for a rule that is not there' },
    },
  }
  writeFileSync(settingsPath, JSON.stringify(file, null, 2))
  resetSettingsCache()
  const rules = loadAllPermissionRulesFromDisk() as Rule[]
  const byName = (toolName: string, content?: string): Rule | undefined =>
    rules.find(r => r.ruleValue.toolName === toolName && r.ruleValue.ruleContent === content)
  check('a deny rule loaded from the file carries its reason', byName('Read', 'secrets/**')?.ruleValue.reason === R_SECRETS, j(byName('Read', 'secrets/**')))
  check('a whole-tool deny rule carries its reason', byName('WebFetch')?.ruleValue.reason === R_FETCH, j(byName('WebFetch')))
  check('a padded rule spelling still finds its reason (the key is matched on the parsed spelling)', byName('Bash', 'git push:*')?.ruleValue.reason === R_PUSH, j(byName('Bash', 'git push:*')))
  const ctx = applyPermissionRulesToPermissionContext(getEmptyToolPermissionContext(), rules as never) as unknown as { ruleReasons?: Record<string, Reasons>; alwaysDenyRules: Record<string, string[]> }
  check('the posture carries the words by source and rule spelling', ctx.ruleReasons?.['userSettings']?.['Read(secrets/**)'] === R_SECRETS && ctx.ruleReasons?.['userSettings']?.['WebFetch'] === R_FETCH, j(ctx.ruleReasons))
  check('the posture carries the padded ask rule under its parsed spelling', ctx.ruleReasons?.['userSettings']?.['Bash(git push:*)'] === R_PUSH, j(ctx.ruleReasons))
  check('a reason whose rule is not in any array never enters the posture', ctx.ruleReasons?.['userSettings']?.['Bash(git fetch:*)'] === undefined, j(ctx.ruleReasons))
  check('the rule arrays are what they were', j(ctx.alwaysDenyRules['userSettings']) === j(['Read(secrets/**)', 'WebFetch']), j(ctx.alwaysDenyRules))
  writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: ['Read(secrets/**)', 'WebFetch'], ask: ['Bash(git push:*)'] } }, null, 2))
  resetSettingsCache()
  const synced = syncPermissionRulesFromDisk(ctx as never, loadAllPermissionRulesFromDisk()) as unknown as { ruleReasons?: Record<string, Reasons>; alwaysDenyRules: Record<string, string[]> }
  check('a hot reload of the file without the map drops the words (no stale reason survives)', synced.ruleReasons?.['userSettings']?.['Read(secrets/**)'] === undefined && synced.ruleReasons?.['userSettings']?.['WebFetch'] === undefined, j(synced.ruleReasons))
  check('…and the rules themselves stay', j(synced.alwaysDenyRules['userSettings']) === j(['Read(secrets/**)', 'WebFetch']))
  const grant = applyPermissionUpdate(getEmptyToolPermissionContext(), { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' })
  check('a session grant without a reason leaves the posture shape exactly as today (no reasons key)', !('ruleReasons' in grant), j(Object.keys(grant)))
  const removed = applyPermissionUpdate(ctx as never, { type: 'removeRules', rules: [{ toolName: 'WebFetch' }], behavior: 'deny', destination: 'userSettings' }) as unknown as { ruleReasons?: Record<string, Reasons> }
  check('removing a rule removes its words', removed.ruleReasons?.['userSettings']?.['WebFetch'] === undefined && removed.ruleReasons?.['userSettings']?.['Read(secrets/**)'] === R_SECRETS, j(removed.ruleReasons))
  rmSync(settingsPath, { force: true })
  resetSettingsCache()
}

section('§3 THE FILESYSTEM ROAD — the refusal says the words; the most specific matching rule speaks; no reason is byte-identical')
{
  const readTool = { name: 'Read', getPath: (input: { file_path: string }) => input.file_path }
  const editTool = { name: 'Edit', getPath: (input: { file_path: string }) => input.file_path }
  const key = join(PROJ, 'secrets', 'k.pem')
  const prodKey = join(PROJ, 'secrets', 'prod', 'k.pem')
  const decide = (tool: typeof readTool, path: string, ctx: Ctx, road: 'read' | 'edit'): Decision =>
    (road === 'read' ? checkReadPermissionForTool(tool as never, { file_path: path }, ctx as never) : checkWritePermissionForTool(tool as never, { file_path: path }, ctx as never)) as unknown as Decision

  const plain = decide(readTool, key, ctxWith({ deny: ['Read(secrets/**)'] }), 'read')
  check('control: a deny rule without a reason refuses with today\'s sentence, byte for byte', plain.behavior === 'deny' && plain.message === `Permission to read ${key} has been denied.`, j(plain))
  const other = decide(readTool, key, ctxWith({ deny: ['Read(secrets/**)'] }, { 'Read(other/**)': 'words for another rule' }), 'read')
  check('control: a reasons map that names another rule changes nothing', other.message === `Permission to read ${key} has been denied.`, j(other))

  const said = decide(readTool, key, ctxWith({ deny: ['Read(secrets/**)'] }, { 'Read(secrets/**)': R_SECRETS }), 'read')
  check('a Read deny with a reason refuses with the words', said.behavior === 'deny' && said.message === `Permission to read ${key} has been denied: ${R_SECRETS}.`, j(said))
  check('…and the decision\'s rule carries the reason', said.decisionReason?.type === 'rule' && said.decisionReason.rule?.ruleValue.reason === R_SECRETS, j(said.decisionReason))

  const edited = decide(editTool, key, ctxWith({ deny: ['Edit(secrets/**)'] }, { 'Edit(secrets/**)': R_SECRETS }), 'edit')
  check('an Edit deny with a reason refuses with the words', edited.behavior === 'deny' && edited.message === `Permission to edit ${key} has been denied: ${R_SECRETS}.`, j(edited))
  const editedPlain = decide(editTool, key, ctxWith({ deny: ['Edit(secrets/**)'] }), 'edit')
  check('control: an Edit deny without a reason keeps today\'s sentence', editedPlain.message === `Permission to edit ${key} has been denied.`, j(editedPlain))

  const both = { 'Read(secrets/**)': R_SECRETS, 'Read(secrets/prod/**)': R_PROD }
  const wideFirst = decide(readTool, prodKey, ctxWith({ deny: ['Read(secrets/**)', 'Read(secrets/prod/**)'] }, both), 'read')
  check('two matching rules, the wide one listed first: the more specific rule\'s words win', wideFirst.message === `Permission to read ${prodKey} has been denied: ${R_PROD}.`, j(wideFirst))
  const narrowFirst = decide(readTool, prodKey, ctxWith({ deny: ['Read(secrets/prod/**)', 'Read(secrets/**)'] }, both), 'read')
  check('two matching rules, the narrow one listed first: the same words', narrowFirst.message === `Permission to read ${prodKey} has been denied: ${R_PROD}.`, j(narrowFirst))
  const onlyWide = decide(readTool, prodKey, ctxWith({ deny: ['Read(secrets/prod/**)', 'Read(secrets/**)'] }, { 'Read(secrets/**)': R_SECRETS }), 'read')
  check('two matching rules where only the wide one has words: those words speak', onlyWide.message === `Permission to read ${prodKey} has been denied: ${R_SECRETS}.`, j(onlyWide))
  const outside = decide(readTool, key, ctxWith({ deny: ['Read(secrets/**)', 'Read(secrets/prod/**)'] }, both), 'read')
  check('a path the narrow rule does not cover gets the wide rule\'s words', outside.message === `Permission to read ${key} has been denied: ${R_SECRETS}.`, j(outside))

  const asked = decide(readTool, key, ctxWith({ ask: ['Read(secrets/**)'] }, { 'Read(secrets/**)': R_SECRETS }), 'read')
  check('an ask rule keeps its sentence and hands the card its reason on the rule', asked.behavior === 'ask' && asked.message === `Permission to read ${key} requires confirmation.` && asked.decisionReason?.rule?.ruleValue.reason === R_SECRETS, j(asked))
  const askedPlain = decide(readTool, key, ctxWith({ ask: ['Read(secrets/**)'] }), 'read')
  check('control: an ask rule without a reason carries none', askedPlain.behavior === 'ask' && askedPlain.decisionReason?.rule?.ruleValue.reason === undefined, j(askedPlain))
}

section('§4 THE ENGINE ROAD — a whole-tool deny says the words; the tool-specific MCP rule outranks the server-wide one')
{
  const ASSISTANT = { message: { id: 'msg_rule_reason' } } as never
  const fakeTool = (name: string): unknown => ({
    name,
    inputSchema: z.object({}).passthrough(),
    checkPermissions: async () => ({ behavior: 'passthrough', message: 'no opinion' }),
  })
  const useContext = (ctx: Ctx): unknown => ({
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: ctx, denialTracking: undefined }),
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    options: {},
  })
  const decide = (name: string, ctx: Ctx): Promise<Decision> =>
    hasPermissionsToUseTool(fakeTool(name) as never, {}, useContext(ctx) as never, ASSISTANT, 'toolu_rule_reason') as unknown as Promise<Decision>

  const plain = await decide('WebFetch', ctxWith({ deny: ['WebFetch'] }))
  check('control: a whole-tool deny without a reason refuses with today\'s sentence, byte for byte', plain.behavior === 'deny' && plain.message === 'Permission to use WebFetch has been denied.', j(plain))
  const said = await decide('WebFetch', ctxWith({ deny: ['WebFetch'] }, { WebFetch: R_FETCH }))
  check('a whole-tool deny with a reason refuses with the words', said.behavior === 'deny' && said.message === `Permission to use WebFetch has been denied: ${R_FETCH}.`, j(said))
  check('…and the decision\'s rule carries the reason', said.decisionReason?.rule?.ruleValue.reason === R_FETCH, j(said.decisionReason))
  const both = { mcp__github: R_GITHUB, mcp__github__create_issue: R_ISSUE }
  const serverFirst = await decide('mcp__github__create_issue', ctxWith({ deny: ['mcp__github', 'mcp__github__create_issue'] }, both))
  check('a server-wide and a tool-specific MCP deny both match: the tool-specific words win', serverFirst.message === `Permission to use mcp__github__create_issue has been denied: ${R_ISSUE}.`, j(serverFirst))
  const toolFirst = await decide('mcp__github__create_issue', ctxWith({ deny: ['mcp__github__create_issue', 'mcp__github'] }, both))
  check('…in either order', toolFirst.message === `Permission to use mcp__github__create_issue has been denied: ${R_ISSUE}.`, j(toolFirst))
  const sibling = await decide('mcp__github__list_issues', ctxWith({ deny: ['mcp__github', 'mcp__github__create_issue'] }, both))
  check('a sibling tool the specific rule does not name gets the server-wide words', sibling.message === `Permission to use mcp__github__list_issues has been denied: ${R_GITHUB}.`, j(sibling))
  const wide = await decide('mcp__github__list_issues', ctxWith({ deny: ['mcp__github__*'] }, { 'mcp__github__*': R_GITHUB }))
  check('the wildcard server spelling finds its words', wide.message === `Permission to use mcp__github__list_issues has been denied: ${R_GITHUB}.`, j(wide))
  const bypass = await decide('WebFetch', { ...ctxWith({ deny: ['WebFetch'] }, { WebFetch: R_FETCH }), mode: 'sovereign' } as Ctx)
  check('the deny stays bypass-immune with its words', bypass.behavior === 'deny' && bypass.message === `Permission to use WebFetch has been denied: ${R_FETCH}.`, j(bypass))
}

section('§5 THE HELPER — one composer, one specificity order')
{
  check('the reason helper module exists', helper !== null, 'src/utils/permissions/ruleReason.ts is absent')
  if (helper) {
    const h = helper as unknown as {
      refusalWithReason: (sentence: string, reason: string | undefined) => string
      ruleSpecificity: (value: { toolName: string; ruleContent?: string }) => number
      normaliseRuleReasons: (raw: unknown) => Record<string, string>
    }
    check('no reason leaves the sentence untouched', h.refusalWithReason('Permission to use X has been denied.', undefined) === 'Permission to use X has been denied.')
    check('a reason joins with a colon and closes the sentence', h.refusalWithReason('Permission to use X has been denied.', 'no network here') === 'Permission to use X has been denied: no network here.')
    check('a reason that already closes its sentence is not doubled', h.refusalWithReason('Permission to use X has been denied.', 'ask the lead first!') === 'Permission to use X has been denied: ask the lead first!')
    const order = [{ toolName: 'Read' }, { toolName: 'Read', ruleContent: 'secrets/**' }, { toolName: 'Read', ruleContent: 'secrets/prod/**' }].map(h.ruleSpecificity)
    check('a content rule outranks the whole-tool rule and a longer literal outranks a shorter one', order[0]! < order[1]! && order[1]! < order[2]!, j(order))
    const mcp = [{ toolName: 'mcp__srv' }, { toolName: 'mcp__srv__*' }, { toolName: 'mcp__srv__tool' }].map(h.ruleSpecificity)
    check('the MCP ladder: server, then wildcard, then the named tool', mcp[0]! < mcp[1]! && mcp[1]! < mcp[2]!, j(mcp))
    const bash = [{ toolName: 'Bash', ruleContent: 'git:*' }, { toolName: 'Bash', ruleContent: 'git push:*' }].map(h.ruleSpecificity)
    check('a longer command prefix outranks a shorter one', bash[0]! < bash[1]!, j(bash))
    const normalised = h.normaliseRuleReasons({ ' Read(secrets/**) ': '  one\nline\tonly \u001b[31m ', Bash: 42, Empty: '   ' })
    check('the map is normalised: parsed spelling keys, one-line words, non-strings and blanks dropped', j(normalised) === j({ 'Read(secrets/**)': 'one line only [31m' }), j(normalised))
  }
}

section('§6 THE BASH ROAD — every deny sentence says the words; the longer prefix speaks; no reason is byte-identical')
{
  const R_GIT = 'git is read-only here'
  const R_ENVIRON = 'process environment files hold secrets'
  const bashCtx = (deny: string[], reasons?: Reasons): Ctx => ctxWith({ deny }, reasons, 'userSettings')
  const exact = (command: string, ctx: Ctx): Decision => bashToolCheckExactMatchPermission({ command } as never, ctx as never) as unknown as Decision
  const perSub = (command: string, ctx: Ctx): Decision => bashToolCheckPermission({ command } as never, ctx as never) as unknown as Decision
  const whole = (command: string, ctx: Ctx): Promise<Decision> => bashToolHasPermission({ command } as never, ctx as never) as unknown as Promise<Decision>

  const exactPlain = exact('git push origin main', bashCtx(['Bash(git push origin main)']))
  check('control: an exact deny without a reason keeps today\'s sentence', exactPlain.behavior === 'deny' && exactPlain.message === 'Bash(git push origin main) is blocked by a deny rule.', j(exactPlain))
  const exactSaid = exact('git push origin main', bashCtx(['Bash(git push origin main)'], { 'Bash(git push origin main)': R_PUSH }))
  check('1 the exact-match deny says the words', exactSaid.behavior === 'deny' && exactSaid.message === `Bash(git push origin main) is blocked by a deny rule: ${R_PUSH}.`, j(exactSaid))
  check('…and its rule carries the reason for the transcript', exactSaid.decisionReason?.rule?.ruleValue.reason === R_PUSH, j(exactSaid.decisionReason))

  const subPlain = perSub('git push origin main', bashCtx(['Bash(git push:*)']))
  check('control: a prefix deny without a reason keeps today\'s sentence', subPlain.behavior === 'deny' && subPlain.message === 'Bash deny rule matched.', j(subPlain))
  const subSaid = perSub('git push origin main', bashCtx(['Bash(git push:*)'], { 'Bash(git push:*)': R_PUSH }))
  check('2 the per-subcommand prefix deny says the words', subSaid.behavior === 'deny' && subSaid.message === `Bash deny rule matched: ${R_PUSH}.`, j(subSaid))
  const bothPrefixes = { 'Bash(git:*)': R_GIT, 'Bash(git push:*)': R_PUSH }
  const shortFirst = perSub('git push origin main', bashCtx(['Bash(git:*)', 'Bash(git push:*)'], bothPrefixes))
  check('two matching prefix rules, the short one listed first: the longer prefix\'s words win', shortFirst.message === `Bash deny rule matched: ${R_PUSH}.`, j(shortFirst))
  const longFirst = perSub('git push origin main', bashCtx(['Bash(git push:*)', 'Bash(git:*)'], bothPrefixes))
  check('…in either order', longFirst.message === `Bash deny rule matched: ${R_PUSH}.`, j(longFirst))
  const fetchSaid = perSub('git fetch origin', bashCtx(['Bash(git:*)', 'Bash(git push:*)'], bothPrefixes))
  check('a command only the short prefix covers gets the short prefix\'s words', fetchSaid.message === `Bash deny rule matched: ${R_GIT}.`, j(fetchSaid))

  const gates = { enabled: SandboxManager.isSandboxingEnabled, auto: SandboxManager.isAutoAllowBashIfSandboxedEnabled, unsandboxed: SandboxManager.areUnsandboxedCommandsAllowed }
  SandboxManager.isSandboxingEnabled = () => true
  SandboxManager.isAutoAllowBashIfSandboxedEnabled = () => true
  SandboxManager.areUnsandboxedCommandsAllowed = () => false
  try {
    const fullPlain = await whole('git push origin main', bashCtx(['Bash(git push:*)']))
    check('control: the sandbox road\'s full-command deny without a reason keeps today\'s sentence', fullPlain.behavior === 'deny' && fullPlain.message === 'git push origin main is blocked by a deny rule.', j(fullPlain))
    const fullSaid = await whole('git push origin main', bashCtx(['Bash(git push:*)'], { 'Bash(git push:*)': R_PUSH }))
    check('3 the sandbox road\'s full-command deny says the words', fullSaid.behavior === 'deny' && fullSaid.message === `git push origin main is blocked by a deny rule: ${R_PUSH}.`, j(fullSaid))
    const subSandboxSaid = await whole('echo ok && git push origin main', bashCtx(['Bash(git push:*)'], { 'Bash(git push:*)': R_PUSH }))
    check('4 the sandbox road\'s subcommand deny names the whole command and says the words', subSandboxSaid.behavior === 'deny' && subSandboxSaid.message === `echo ok && git push origin main is blocked by a deny rule: ${R_PUSH}.`, j(subSandboxSaid))
  } finally {
    SandboxManager.isSandboxingEnabled = gates.enabled
    SandboxManager.isAutoAllowBashIfSandboxedEnabled = gates.auto
    SandboxManager.areUnsandboxedCommandsAllowed = gates.unsandboxed
  }

  parseRoutes.set('git push origin {main,dev}', { kind: 'too-complex', reason: 'contains brace expansion syntax' })
  const earlyPlain = await whole('git push origin {main,dev}', bashCtx(['Bash(git push:*)']))
  check('control: the early-exit deny without a reason keeps today\'s sentence', earlyPlain.behavior === 'deny' && earlyPlain.message === 'git push origin {main,dev} is blocked by a deny rule.', j(earlyPlain))
  const earlySaid = await whole('git push origin {main,dev}', bashCtx(['Bash(git push:*)'], { 'Bash(git push:*)': R_PUSH }))
  check('5 the early-exit deny (a too-complex parse) says the words', earlySaid.behavior === 'deny' && earlySaid.message === `git push origin {main,dev} is blocked by a deny rule: ${R_PUSH}.`, j(earlySaid))
  const environ = 'echo ok && cat /proc/self/environ'
  parseRoutes.set(environ, {
    kind: 'simple',
    commands: [
      { argv: ['echo', 'ok'], envVars: [], redirects: [], text: 'echo ok' },
      { argv: ['cat', '/proc/self/environ'], envVars: [], redirects: [], text: 'cat /proc/self/environ' },
    ],
  })
  const semanticsPlain = await whole(environ, bashCtx(['Bash(cat:*)']))
  check('control: the semantics deny without a reason keeps today\'s sentence', semanticsPlain.behavior === 'deny' && semanticsPlain.message === 'cat /proc/self/environ is blocked by a deny rule.', j(semanticsPlain))
  const semanticsSaid = await whole(environ, bashCtx(['Bash(cat:*)'], { 'Bash(cat:*)': R_ENVIRON }))
  check('6 the semantics deny (a red-flagged subcommand) says the words', semanticsSaid.behavior === 'deny' && semanticsSaid.message === `cat /proc/self/environ is blocked by a deny rule: ${R_ENVIRON}.`, j(semanticsSaid))
  parseRoutes.clear()

  const aggregatePlain = await whole('echo ok && git push origin main', bashCtx(['Bash(git push:*)']))
  check('control: a compound command\'s aggregate deny without a reason keeps today\'s sentence', aggregatePlain.behavior === 'deny' && aggregatePlain.message === 'A subcommand was denied.', j(aggregatePlain))
  const aggregateSaid = await whole('echo ok && git push origin main', bashCtx(['Bash(git push:*)'], { 'Bash(git push:*)': R_PUSH }))
  check('7 a compound command\'s aggregate deny says the denied subcommand\'s words', aggregateSaid.behavior === 'deny' && aggregateSaid.message === `A subcommand was denied: ${R_PUSH}.`, j(aggregateSaid))
}

section('§7 THE CONSENT CARD — one line under the rule, the hint below it; none without a reason')
{
  const settle = async (): Promise<void> => {
    for (let index = 0; index < 6; index++) {
      flushPendingSyncWork()
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
  }
  const mount = async (node: React.ReactNode, ctx: Ctx, columns = 178): Promise<{ frame: () => string; close: () => void }> => {
    const emitter = new EventEmitter()
    const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
    const stream = new PassThrough()
    stream.resume()
    const stdout = Object.assign(stream, { columns, rows: 51 }) as unknown as NodeJS.WriteStream
    const store = createStore({ ...getDefaultAppState(), toolPermissionContext: ctx as never })
    const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
    const tree = React.createElement(
      StdinContext.Provider,
      { value: stdinValue as never },
      React.createElement(
        TerminalSizeContext.Provider,
        { value: { columns, rows: 51 } },
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
  const lines = (frame: string): string[] => frame.split('\n').map(line => line.trimEnd())
  const askFor = (rule: Rule): Decision => ({ behavior: 'ask', message: 'Permission to use Bash requires confirmation.', decisionReason: { type: 'rule', rule } })
  const pushRule = (reason?: string): Rule => ({ source: 'userSettings', ruleBehavior: 'ask', ruleValue: { toolName: 'Bash', ruleContent: 'git push:*', ...(reason ? { reason } : {}) } })
  const explanation = (decision: Decision): React.ReactNode => React.createElement(PermissionRuleExplanation, { permissionResult: decision as never, toolType: 'command' })

  const bare = await mount(explanation(askFor(pushRule())), ctxWith({ ask: ['Bash(git push:*)'] }, undefined, 'userSettings'))
  const bareLines = lines(bare.frame())
  check('control: without a reason the explanation is exactly today\'s two lines', j(bareLines) === j(['The rule Bash(git push:*) requires confirmation for this command', 'Permission rules can be changed in /permissions']), j(bareLines))
  bare.close()

  const stamped = await mount(explanation(askFor(pushRule(R_PUSH))), ctxWith({ ask: ['Bash(git push:*)'] }, undefined, 'userSettings'))
  const stampedLines = lines(stamped.frame())
  check('a rule carrying its reason paints the words on one line between the rule and the hint', j(stampedLines) === j(['The rule Bash(git push:*) requires confirmation for this command', R_PUSH, 'Permission rules can be changed in /permissions']), j(stampedLines))
  if (frameDir) writeFileSync(join(frameDir, 'explanation-178.txt'), stamped.frame() + '\n')
  stamped.close()

  const looked = await mount(explanation(askFor(pushRule())), ctxWith({ ask: ['Bash(git push:*)'] }, { 'Bash(git push:*)': R_PUSH }, 'userSettings'))
  const lookedLines = lines(looked.frame())
  check('a rule without a stamped reason still finds its words in the posture (every ask road paints the line)', j(lookedLines) === j(['The rule Bash(git push:*) requires confirmation for this command', R_PUSH, 'Permission rules can be changed in /permissions']), j(lookedLines))
  looked.close()

  const managed = await mount(explanation(askFor({ ...pushRule(R_PUSH), source: 'policySettings' })), ctxWith({ ask: ['Bash(git push:*)'] }, undefined, 'policySettings'))
  const managedLines = lines(managed.frame())
  check('a managed-policy rule paints its words and still omits the /permissions hint', j(managedLines) === j(['The rule Bash(git push:*) requires confirmation for this command', R_PUSH]), j(managedLines))
  managed.close()

  const fetchTool = {
    name: 'WebFetch',
    userFacingName: () => 'WebFetch',
    renderToolUseMessage: () => 'url: "https://example.test/spec"',
    isMcp: false,
  }
  const cardDecision: Decision = { behavior: 'ask', message: 'Permission to use WebFetch requires confirmation.', decisionReason: { type: 'rule', rule: { source: 'userSettings', ruleBehavior: 'ask', ruleValue: { toolName: 'WebFetch' } } } }
  const cardContext = ctxWith({ ask: ['WebFetch'] }, { WebFetch: 'every fetch is reviewed while the audit runs' }, 'userSettings')
  const toolUseContext = { abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: cardContext }), setAppState: () => {}, messages: [], options: {} }
  const toolUseConfirm = {
    assistantMessage: { message: { id: 'msg_card' } },
    tool: fetchTool,
    description: 'Fetches the page at a URL and returns its text',
    input: { url: 'https://example.test/spec' },
    toolUseContext,
    toolUseID: 'toolu_card',
    permissionResult: cardDecision,
    permissionPromptStartTimeMs: 0,
    onUserInteraction() {},
    onAbort() {},
    onAllow() {},
    onReject() {},
    recheckPermission: async () => {},
  }
  const card = await mount(
    React.createElement(FallbackPermissionRequest, { toolUseConfirm: toolUseConfirm as never, toolUseContext: toolUseContext as never, onDone() {}, onReject() {}, verbose: true, workerBadge: undefined }),
    cardContext,
  )
  const cardFrame = card.frame()
  const cardLines = lines(cardFrame)
  const ruleRow = cardLines.findIndex(line => line.includes('The rule WebFetch requires confirmation for this tool'))
  check('the fallback consent card mounts with the rule line', !cardFrame.includes('RENDER ERROR') && ruleRow >= 0, cardFrame)
  check('the card paints the reason on the line right under the rule line, the hint under that', ruleRow >= 0 && cardLines[ruleRow + 1]?.includes('every fetch is reviewed while the audit runs') === true && cardLines[ruleRow + 2]?.includes('Permission rules can be changed in /permissions') === true, cardLines.slice(ruleRow, ruleRow + 3).join(' | '))
  check('the card fits 178 columns', cardLines.every(line => line.length <= 178))
  if (frameDir) writeFileSync(join(frameDir, 'card-178x51.txt'), cardFrame + '\n')
  card.close()
}

process.chdir(launchDir)
rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
if (failures > 0) {
  console.log(`\nprove-rule-reason: ${failures} RED`)
  process.exit(1)
}
console.log('\nprove-rule-reason: all green')
