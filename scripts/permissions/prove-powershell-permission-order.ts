#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'powershell-permission-order-')))
const project = join(scratch, 'project')
mkdirSync(project)
mkdirSync(join(scratch, 'home'))
writeFileSync(join(project, 'a.txt'), 'a\n')
writeFileSync(join(project, 'x.txt'), 'x\n')
const previousCwd = process.cwd()
process.chdir(project)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const HINT = 'check the numbered steps of src/tools/powershell/powershellPermissions.ts; step 13 scans fragments before exact allow answers'
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${[detail, HINT].filter(Boolean).join('; ')}`}`)
  if (!ok) failures++
}

const { getPlatform } = await import('../../src/platform/environment/platform.ts')
const originalPlatform = getPlatform()

try {
  const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
  const { powershellToolHasPermission } = await import('../../src/tools/powershell/powershellPermissions.ts')
  const { pinnedCommandAnalysis } = await import('../../src/permissions/rules/decision/commandAnalysis.ts')
  type Element = { name: string; nameType: 'cmdlet' | 'application' | 'unknown'; text: string; args: string[]; elementType: string; elementTypes: string[] }
  const wordsOf = (text: string): string[] => (text.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(word => word.replace(/^'|'$/g, '').replace(/^"|"$/g, ''))
  pinnedCommandAnalysis.parsePowerShellCommand = async (text: string) => {
    const base = { variables: [], hasStopParsing: false, originalCommand: text }
    if (text.includes('<<unparsed>>')) return { ...base, valid: false, statements: [], errors: [{ message: 'fixture: the parse did not hold', errorId: 'Fixture' }] }
    if (text.startsWith('$')) return { ...base, valid: true, errors: [], statements: [{ statementType: 'expression', text, commands: [], nestedCommands: [], redirections: [] }] }
    const statements = text.split(';').map(part => part.trim()).filter(part => part !== '').map(part => {
      const redirect = / > (\S+)$/.exec(part)
      const body = redirect ? part.slice(0, redirect.index) : part
      const commands: Element[] = body.split('|').map(piece => piece.trim()).filter(piece => piece !== '').map(piece => {
        const words = wordsOf(piece)
        const name = words.shift() ?? ''
        return { name, nameType: pinnedCommandAnalysis.classifyCommandName(name), text: piece, args: words, elementType: 'command', elementTypes: [name, ...words].map(() => 'StringConstant') }
      })
      return { statementType: 'pipeline', text: part, commands, nestedCommands: [], redirections: redirect ? [{ operator: '>', target: redirect[1]!, isMerging: false }] : [] }
    })
    return { ...base, valid: true, errors: [], statements, ...(text.startsWith('using ') ? { hasUsingStatements: true } : {}) }
  }

  type Verdict = { behavior: string; message?: string; decisionReason?: { type?: string; reason?: string; operatorOnly?: boolean; rule?: { ruleValue?: { ruleContent?: string } } }; suggestions?: unknown[] }
  type Rules = { deny?: string[]; ask?: string[]; allow?: string[]; mode?: string }
  const asRule = (r: string): string => `PowerShell(${r.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`
  const decide = async (command: string, rules: Rules = {}): Promise<Verdict> => {
    const context = { ...getEmptyToolPermissionContext(), mode: rules.mode ?? 'default', alwaysDenyRules: { session: (rules.deny ?? []).map(asRule) }, alwaysAskRules: { session: (rules.ask ?? []).map(asRule) }, alwaysAllowRules: { session: (rules.allow ?? []).map(asRule) } }
    return (await powershellToolHasPermission({ command }, { getAppState: () => ({ toolPermissionContext: context }), abortController: new AbortController() } as never)) as Verdict
  }
  const shown = (v: Verdict): string => JSON.stringify({ behavior: v.behavior, message: (v.message ?? '').slice(0, 130), reason: v.decisionReason?.type, operatorOnly: v.decisionReason?.operatorOnly, rule: v.decisionReason?.rule?.ruleValue?.ruleContent, suggestions: v.suggestions?.length })
  const ruleOf = (v: Verdict): string | undefined => v.decisionReason?.rule?.ruleValue?.ruleContent

  console.log('§A the rule matcher: an exact rule is found wherever rules are asked')
  {
    const v = await decide('Set-Content a.txt hi; Remove-Item x.txt', { deny: ['Remove-Item x.txt'], mode: 'implement' })
    check('implement mode: a compound is refused by an exact deny rule on ONE of its commands', v.behavior === 'deny' && ruleOf(v) === 'Remove-Item x.txt', shown(v))
    const w = await decide('Get-ChildItem . ; Get-Content a.txt', { ask: ['Get-Content a.txt'] })
    check('a read-only compound is asked about by an exact ask rule on ONE of its commands', w.behavior === 'ask' && ruleOf(w) === 'Get-Content a.txt', shown(w))
    const x = await decide('Get-ChildItem .', { ask: ['Get-ChildItem .'] })
    check('step 10: a read-only command with its own exact ask rule is asked about, by the rule', x.behavior === 'ask' && ruleOf(x) === 'Get-ChildItem .', shown(x))
    const y = await decide('Get-ChildItem .', { ask: ['Get-ChildItem .'], mode: 'implement' })
    check('…in implement mode too', y.behavior === 'ask' && ruleOf(y) === 'Get-ChildItem .', shown(y))
  }
  console.log('§B the slot: a waiting ask does not come before a deny found later')
  {
    const v = await decide('Get-ChildItem . ; Remove-Item x.txt', { ask: ['Get-ChildItem *'], deny: ['Remove-Item x.txt'] })
    check('step 10: a prefix ask rule waits, the exact deny rule on a later command wins', v.behavior === 'deny' && ruleOf(v) === 'Remove-Item x.txt', shown(v))
    const w = await decide('Get-ChildItem .', { ask: ['Get-ChildItem *'] })
    check('step 10: with no deny the prefix ask rule is what is asked', w.behavior === 'ask' && ruleOf(w) === 'Get-ChildItem *', shown(w))
  }
  console.log('§C the network path and the device path, the platform set to Windows')
  getPlatform.cache.set(undefined, 'windows')
  {
    const share = String.raw`Get-Content \\server.example.com\share\f.txt`
    const asked = await decide(share)
    check('step 11: a network path is asked about, naming the whole command, operator only', asked.behavior === 'ask' && String(asked.message).startsWith(share + ' may reach the remote host server.example.com') && asked.decisionReason?.type === 'safetyCheck' && asked.decisionReason?.operatorOnly === true, shown(asked))
    const thing = String.raw`Invoke-Thing \\server.example.com\share\f.txt`
    const thingAsked = await decide(thing)
    check('step 11: a cmdlet the path check does not read is asked about its network path too', thingAsked.behavior === 'ask' && String(thingAsked.message).startsWith(thing + ' may reach the remote host server.example.com'), shown(thingAsked))
    const granted = await decide(thing, { allow: [thing] })
    check('step 11, THE S36 CASE: the same command with its own exact allow rule is not asked about the network path: the rule allows it', granted.behavior === 'allow' && ruleOf(granted) === thing, shown(granted))
    const read = await decide(share, { allow: [share] })
    check('14j: a cmdlet that READS the network path is still asked, by the path check, naming the path', read.behavior === 'ask' && String(read.message).includes('SMB/WebDAV') && !String(read.message).startsWith('Get-Content'), shown(read))
    const bare = String.raw`Get-ChildItem \\server`
    const noOption = await decide(bare)
    check('step 11: the unit is asked with no option, so a bare host is told at this step and the ask names the whole command', noOption.behavior === 'ask' && String(noOption.message).startsWith(bare + ' may reach the remote host server'), shown(noOption))
    const waits = await decide(share + ' ; Remove-Item x.txt', { deny: ['Remove-Item x.txt'] })
    check('step 11: the network ask waits, a deny found later wins', waits.behavior === 'deny' && ruleOf(waits) === 'Remove-Item x.txt', shown(waits))
    const device = await decide(String.raw`Get-Content \\.\PhysicalDrive0`)
    check('step 12: a device path is a bare ask (no reason, not operator only)', device.behavior === 'ask' && device.message === 'A Windows device namespace can bypass ordinary path checks and requires manual approval.' && device.decisionReason === undefined, shown(device))
    const deviceWaits = await decide(String.raw`Get-Content \\.\PhysicalDrive0 ; Remove-Item x.txt`, { deny: ['Remove-Item x.txt'] })
    check('step 12: the device ask waits, a deny found later wins', deviceWaits.behavior === 'deny', shown(deviceWaits))
  }
  getPlatform.cache.set(undefined, 'macos')
  console.log('§D a parse that does not hold')
  {
    const cmd = 'Get-ChildItem . ; Remove-Item x.txt <<unparsed>>'
    const held = await decide(cmd, { allow: [cmd], deny: ['Remove-Item *'] })
    check('step 13: the fragment scan comes first, so a deny rule on a fragment refuses though the command has its own exact allow rule', held.behavior === 'deny' && ruleOf(held) === 'Remove-Item *', shown(held))
    const removal = 'Get-ChildItem . ; Remove-Item / <<unparsed>>'
    const dangerous = await decide(removal, { allow: [removal] })
    check('step 13: the dangerous-removal test refuses though the command has its own exact allow rule', dangerous.behavior === 'deny', shown(dangerous))
    const plain = 'Get-Thing a.txt <<unparsed>>'
    const plainAllowed = await decide(plain, { allow: [plain] })
    check('step 13: with no deny on a fragment the exact allow rule still answers a parse that does not hold', plainAllowed.behavior === 'allow' && ruleOf(plainAllowed) === plain, shown(plainAllowed))
    const refused = await decide(cmd, { deny: ['Remove-Item *'] })
    check("step 13b: without the exact allow rule the fragment's deny rule refuses", refused.behavior === 'deny', shown(refused))
    const malformed = await decide('Get-Thing <<unparsed>>')
    check('step 13d: the malformed-syntax ask is bare', malformed.behavior === 'ask' && malformed.message === 'The command has malformed syntax that cannot be parsed: fixture: the parse did not hold' && malformed.decisionReason === undefined, shown(malformed))
    const moduleCmd = 'Microsoft.PowerShell.Management\\Get-ChildItem . <<unparsed>>'
    const moduleAllowed = await decide(moduleCmd, { allow: [moduleCmd] })
    check('step 13a: the first word is classed as it stands, so a module-qualified name is no cmdlet there and its exact allow rule does not answer', moduleAllowed.behavior === 'ask' && String(moduleAllowed.message).startsWith('The command has malformed syntax'), shown(moduleAllowed))
  }
  console.log('§E the list of a parse that holds')
  {
    const redirected = await decide('Get-ChildItem . > out.txt', { mode: 'implement' })
    check('14m: a file redirection asks with the exact suggestions and no reason', redirected.behavior === 'ask' && redirected.message === 'The command has file redirections that could write to arbitrary paths.' && redirected.decisionReason === undefined && Array.isArray(redirected.suggestions) && redirected.suggestions.length > 0, shown(redirected))
    const using = await decide('using module Foo')
    check('14d: a using statement is a bare ask', using.behavior === 'ask' && String(using.message).startsWith('A `using` statement') && using.decisionReason === undefined, shown(using))
    const cdGit = await decide('Set-Location sub ; git status')
    check('14g: a directory change with git is a bare ask', cdGit.behavior === 'ask' && String(cdGit.message).startsWith('A compound that mixes a directory change with a git invocation') && cdGit.decisionReason === undefined, shown(cdGit))
    const archiveAfter = await decide('git status ; tar -xf a.tar')
    check('14h: an archive command beside git asks wherever it stands, bare', archiveAfter.behavior === 'ask' && String(archiveAfter.message).startsWith('The compound unpacks an archive') && archiveAfter.decisionReason === undefined, shown(archiveAfter))
    const dotGit = await decide('Set-Content .git/hooks/pre-commit x')
    check('14i: a write into .git asks without git on the line, bare', dotGit.behavior === 'ask' && String(dotGit.message).startsWith('The command targets .git/') && dotGit.decisionReason === undefined, shown(dotGit))
    const noCommand = await decide('$x', { allow: ['$x'] })
    check('14k: with no command in the parse the exact allow rule is not what allows', !(noCommand.behavior === 'allow' && noCommand.decisionReason?.type === 'rule'), shown(noCommand))
    const exactAllowed = await decide('Get-Thing a.txt', { allow: ['Get-Thing a.txt'] })
    check('14k: a cmdlet with its own exact allow rule is allowed by the rule', exactAllowed.behavior === 'allow' && ruleOf(exactAllowed) === 'Get-Thing a.txt', shown(exactAllowed))
    const readOnly = await decide('Get-ChildItem .')
    check('14l: a read-only command is allowed', readOnly.behavior === 'allow' && readOnly.decisionReason?.reason === 'The whole command is read-only.', shown(readOnly))
  }
  console.log('§F the first answers')
  {
    const hidden = await decide('Get-ChildItem\u200B .')
    check('step 1: a hidden character is refused with a safety reason, operator only', hidden.behavior === 'deny' && hidden.decisionReason?.type === 'safetyCheck' && hidden.decisionReason?.operatorOnly === true && hidden.decisionReason?.reason === hidden.message, shown(hidden))
    const empty = await decide('   ')
    check('step 3: an empty command is allowed', empty.behavior === 'allow' && empty.decisionReason?.reason === 'Nothing to run.', shown(empty))
    const exactDeny = await decide('Get-ChildItem .', { deny: ['Get-ChildItem .'] })
    check('step 5: an exact deny rule refuses at once', exactDeny.behavior === 'deny' && ruleOf(exactDeny) === 'Get-ChildItem .', shown(exactDeny))
    const prefixDeny = await decide('Get-ChildItem .', { deny: ['Get-ChildItem *'] })
    check('step 6: a prefix deny rule refuses at once', prefixDeny.behavior === 'deny' && ruleOf(prefixDeny) === 'Get-ChildItem *', shown(prefixDeny))
  }
} finally {
  getPlatform.cache.set(undefined, originalPlatform)
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nPASS prove-powershell-permission-order' : `\nFAIL ${failures}`)
process.exit(failures === 0 ? 0 : 1)
