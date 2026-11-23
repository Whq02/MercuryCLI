import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'saved-rule-prefix-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
await import('../../src/models/roads/callModelRouter.ts')
await import('../../src/engine/messages/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { getSimpleCommandPrefix, getFirstWordPrefix, bashToolHasPermission, readBashRuleVerdict } = await import('../../src/tools/shell/bashPermissions.ts')
const { bashToolUseOptions } = await import('../../src/permissions/cards/bash/shellAskOptions.tsx')
const { hasWildcards } = await import('../../src/permissions/rules/shellRuleMatching.ts')
const { createEditRuleSuggestion } = await import('../../src/permissions/rules/permissionUpdate.ts')
const { resolveShellCwd } = await import('../../src/platform/shell/shellExec.ts')
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail?: unknown, hint = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}${!ok && hint ? ` — ${hint}` : ''}`)
}
const seed = (command: string) => {
  const prefix = getSimpleCommandPrefix(command) ?? getFirstWordPrefix(command)
  return prefix === null ? command : `${prefix} *`
}
const contents = (answer: unknown): string[] => ((answer as { suggestions?: { type: string; rules?: { toolName: string; ruleContent?: string }[] }[] }).suggestions ?? []).flatMap(update => (update.rules ?? []).filter(rule => rule.toolName === 'Bash').map(rule => rule.ruleContent ?? ''))
const offers = (answer: unknown): string[] => ((answer as { suggestions?: { type: string; behavior?: string; destination?: string; rules?: { toolName: string; ruleContent?: string }[] }[] }).suggestions ?? []).flatMap(update => (update.rules ?? []).map(rule => `${update.type} ${update.behavior} ${rule.toolName}(${rule.ruleContent ?? ''}) to ${update.destination}`))
try {
  for (const [command, expected] of [
    ['git push origin main', 'git push *'],
    ['npm run test -- --watch', 'npm run test *'],
    ['npm run test:unit', 'npm run test:unit *'],
    ['docker compose up -d', 'docker compose up *'],
    ['gh pr create --fill', 'gh pr create *'],
    ['cargo test --release', 'cargo test *'],
    ['python3 script.py', 'python3 script.py *'],
    ['./run.sh arg', './run.sh *'],
    ['ls -la', 'ls *'],
    ['cat notes.txt', 'cat *'],
  ]) {
    check(`the card seeds ${expected}`, seed(command!) === expected, seed(command!), 'getSimpleCommandPrefix and getFirstWordPrefix in src/tools/shell/bashPermissions.ts must yield the prefix the card seeds')
  }
  for (const [command, expected] of [
    ['npm run test', 'npm run test *'],
    ['docker compose up -d', 'docker compose up *'],
    ['gh pr create --fill', 'gh pr create *'],
    ['cargo test --release', 'cargo test *'],
    ['git push origin main', 'git push *'],
    ['python3 script.py', 'python3 script.py *'],
    ['./run.sh arg', './run.sh *'],
  ] as const) {
    const answer = await bashToolHasPermission({ command }, getEmptyToolPermissionContext())
    check(`the permission result suggests ${expected}`, contents(answer).includes(expected), answer, 'bashToolHasPermission in src/tools/shell/bashPermissions.ts must suggest the prefix rule for this command')
  }
  console.log('refusals')
  const folderRule = `Edit(${(createEditRuleSuggestion(resolveShellCwd(), 'localSettings') as { rules: { ruleContent: string }[] }).rules[0]!.ruleContent})`
  for (const command of ['rm -rf build', 'rmdir empty', 'del file.txt', 'git reset --hard HEAD', 'git clean -fd', 'git push --force origin topic', 'git stash clear', 'kubectl delete pod sample', 'terraform destroy']) {
    check(`${command}: the card never offers a wildcard`, getSimpleCommandPrefix(command) === null && getFirstWordPrefix(command) === null, seed(command), 'getSimpleCommandPrefix and getFirstWordPrefix in src/tools/shell/bashPermissions.ts must return null for a destructive command')
    const answer = await bashToolHasPermission({ command }, getEmptyToolPermissionContext())
    const first = command === 'rm -rf build' || command === 'rmdir empty' ? folderRule : `Bash(${command})`
    const after = first === folderRule ? await bashToolHasPermission({ command }, { ...getEmptyToolPermissionContext(), alwaysAllowRules: { localSettings: [folderRule] } }) : answer
    check(`${command}: the result offers ${first === folderRule ? 'no Bash rule but the Edit rule for the working folder, and with that rule saved only' : 'only'} the Bash rule for the command itself, to local settings`, JSON.stringify(offers(answer)) === JSON.stringify([`addRules allow ${first} to localSettings`]) && JSON.stringify(offers(after)) === JSON.stringify([`addRules allow Bash(${command}) to localSettings`]), { offers: offers(answer), after: offers(after) }, 'bashToolHasPermission in src/tools/shell/bashPermissions.ts must offer only the exact-command Bash rule (plus the Edit folder rule for rm and rmdir)')
    const options = bashToolUseOptions({ suggestions: (answer as { suggestions?: never }).suggestions, onRejectFeedbackChange: () => {}, onAcceptFeedbackChange: () => {}, editablePrefix: seed(command), onEditablePrefixChange: () => {} })
    check(`${command}: the ask options carry no wildcard`, options.every(opt => !('initialValue' in opt && typeof opt.initialValue === 'string' && hasWildcards(opt.initialValue))), options.map(o => ({ value: o.value, initialValue: 'initialValue' in o ? o.initialValue : undefined })), 'bashToolUseOptions in src/permissions/cards/bash/shellAskOptions.tsx must not seed a wildcard into an option for this command')
  }
  for (const command of ['npm run', 'docker compose', 'gh pr', 'python3', 'python3 -c "import os"', './../run.sh arg', './bash -c "echo x"', 'env npm run test', 'bash -c "npm run test"', 'npm run test; npm run deploy', 'npm run test\nnpm run deploy', 'npm run $SCRIPT', 'npm run test*']) {
    check(`${command}: no shortened wildcard seed`, getSimpleCommandPrefix(command) === null && getFirstWordPrefix(command) === null, seed(command), 'getSimpleCommandPrefix and getFirstWordPrefix in src/tools/shell/bashPermissions.ts must return null rather than a shortened prefix for this command')
  }
  const offered = await bashToolHasPermission({ command: 'npm run test' }, getEmptyToolPermissionContext())
  check('npm run test: the result offers npm run test *, never the wider npm run *', contents(offered).includes('npm run test *') && !contents(offered).includes('npm run *'), contents(offered), 'bashToolHasPermission in src/tools/shell/bashPermissions.ts must suggest the full prefix, never a wider one')
  mkdirSync(join(home, '.mercury'), { recursive: true })
  const settingsFile = join(home, '.mercury', 'settings.local.json')
  const rawSettings = '{\n  "guardrails": {\n    "allow": [\n      "Bash(npm run *)"\n    ]\n  }\n}\n'
  writeFileSync(settingsFile, rawSettings)
  const saved = { ...getEmptyToolPermissionContext(), alwaysAllowRules: { localSettings: ['Bash(npm run *)'] } }
  check('an existing broad saved rule is unchanged and its settings file is byte-identical', readBashRuleVerdict({ command: 'npm run deploy' }, saved).behavior === 'allow' && readFileSync(settingsFile, 'utf8') === rawSettings, undefined, 'readBashRuleVerdict in src/tools/shell/bashPermissions.ts must still allow npm run deploy under the saved Bash(npm run *) rule and must not rewrite the settings file')
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`saved-rule-prefix: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
