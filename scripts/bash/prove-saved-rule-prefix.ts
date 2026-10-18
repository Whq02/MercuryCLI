import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'saved-rule-prefix-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
await import('../../src/services/providers/callModelRouter.ts')
await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getSimpleCommandPrefix, getFirstWordPrefix, bashToolHasPermission, readBashRuleVerdict } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { bashToolUseOptions } = await import('../../src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx')
const { hasWildcards } = await import('../../src/utils/permissions/shellRuleMatching.ts')
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const seed = (command: string) => {
  const prefix = getSimpleCommandPrefix(command) ?? getFirstWordPrefix(command)
  return prefix === null ? command : `${prefix} *`
}
const contents = (answer: unknown): string[] => ((answer as { suggestions?: { type: string; rules?: { toolName: string; ruleContent?: string }[] }[] }).suggestions ?? []).flatMap(update => (update.rules ?? []).filter(rule => rule.toolName === 'Bash').map(rule => rule.ruleContent ?? ''))
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
    check(`the card seeds ${expected}`, seed(command!) === expected, seed(command!))
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
    check(`the permission result suggests ${expected}`, contents(answer).includes(expected), answer)
  }
  console.log('refusals')
  for (const command of ['rm -rf build', 'rmdir empty', 'del file.txt', 'git reset --hard HEAD', 'git clean -fd', 'git push --force origin topic', 'git stash clear', 'kubectl delete pod sample', 'terraform destroy']) {
    check(`${command}: the card never offers a wildcard`, getSimpleCommandPrefix(command) === null && getFirstWordPrefix(command) === null, seed(command))
    const answer = await bashToolHasPermission({ command }, getEmptyToolPermissionContext(), async () => ({ commandPrefix: command.split(' ')[0]! }))
    check(`${command}: the result never offers a wildcard even with a broad hint`, contents(answer).every(rule => !hasWildcards(rule)), contents(answer))
    const options = bashToolUseOptions({ suggestions: (answer as { suggestions?: never }).suggestions, onRejectFeedbackChange: () => {}, onAcceptFeedbackChange: () => {}, editablePrefix: seed(command), onEditablePrefixChange: () => {} })
    check(`${command}: the ask options carry no wildcard`, options.every(opt => !('initialValue' in opt && typeof opt.initialValue === 'string' && hasWildcards(opt.initialValue))), options.map(o => ({ value: o.value, initialValue: 'initialValue' in o ? o.initialValue : undefined })))
  }
  for (const command of ['npm run', 'docker compose', 'gh pr', 'python3', 'python3 -c "import os"', './../run.sh arg', './bash -c "echo x"', 'env npm run test', 'bash -c "npm run test"', 'npm run test; npm run deploy', 'npm run test\nnpm run deploy', 'npm run $SCRIPT', 'npm run test*']) {
    check(`${command}: no shortened wildcard seed`, getSimpleCommandPrefix(command) === null && getFirstWordPrefix(command) === null, seed(command))
  }
  const wrongHint = await bashToolHasPermission({ command: 'npm run test' }, getEmptyToolPermissionContext(), async () => ({ commandPrefix: 'npm run' }))
  check('an external prefix hint cannot widen the offered rule', contents(wrongHint).includes('npm run test *') && !contents(wrongHint).includes('npm run *'), contents(wrongHint))
  mkdirSync(join(home, '.mercury'), { recursive: true })
  const settingsFile = join(home, '.mercury', 'settings.local.json')
  const rawSettings = '{\n  "guardrails": {\n    "allow": [\n      "Bash(npm run *)"\n    ]\n  }\n}\n'
  writeFileSync(settingsFile, rawSettings)
  const saved = { ...getEmptyToolPermissionContext(), alwaysAllowRules: { localSettings: ['Bash(npm run *)'] } }
  check('an existing broad saved rule is unchanged and its settings file is byte-identical', readBashRuleVerdict({ command: 'npm run deploy' }, saved).behavior === 'allow' && readFileSync(settingsFile, 'utf8') === rawSettings)
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`saved-rule-prefix: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
