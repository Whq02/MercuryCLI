#!/usr/bin/env bun
// gate-watch: src/tools/BashTool/bashPermissions.ts src/tools/BashTool/readOnlyValidation.ts src/tools/BashTool/pathValidation.ts
// gate-watch: src/tools/BashTool/bashCommandHelpers.ts src/tools/BashTool/bashSecurity.ts src/utils/bash/commands.ts src/utils/bash/ParsedCommand.ts src/Tool.ts
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'input-redirect-read-')))
const root = join(scratch, 'run')
mkdirSync(root)
mkdirSync(join(root, 'sub'))
mkdirSync(join(scratch, 'outside'))
mkdirSync(join(scratch, 'home'))
writeFileSync(join(root, 'l_data.txt'), 'line\n'.repeat(1234))
writeFileSync(join(root, 'secret.txt'), 'shh\n')
const outsideWords = join(scratch, 'outside', 'words')
writeFileSync(outsideWords, 'alpha\nbeta\n')
const previousCwd = process.cwd()
process.chdir(root)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const { checkReadOnlyConstraints } = await import('../../src/tools/BashTool/readOnlyValidation.js')
const { checkPathConstraints } = await import('../../src/tools/BashTool/pathValidation.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
type Verdict = { behavior: string; message?: string; decisionReason?: { type?: string; reasons?: Map<string, Verdict> } }
const context = (extra: Record<string, unknown> = {}) => ({ ...getEmptyToolPermissionContext(), mode: 'default', ...extra })
const decide = async (command: string, extra: Record<string, unknown> = {}): Promise<Verdict> =>
  (await bashToolHasPermission({ command } as never, context(extra) as never)) as Verdict
const shown = (v: Verdict): string => `${v.behavior}: ${v.message ?? ''}`

console.log('prove-input-redirect-read — a static `< file` is a read, path-checked, in the main session and the scout')

console.log('\n1. wc -l < l_data.txt is allowed')
{
  const v = await decide('wc -l < l_data.txt')
  check('wc -l < l_data.txt → allow', v.behavior === 'allow', shown(v))
}

console.log('\n2. the other read shapes are allowed')
for (const command of ['wc -l 0< l_data.txt', 'cat < "l_data.txt"', 'sort < l_data.txt | head -n 3', 'wc -l < /dev/null', 'head -n 5 < l_data.txt', 'grep line < l_data.txt']) {
  const v = await decide(command)
  check(`${command} → allow`, v.behavior === 'allow', shown(v))
}

console.log('\n3. the pipe with 2>&1 stays allowed')
{
  const v = await decide('wc -l l_data.txt l_missing.txt 2>&1 | tail -n 3')
  check('wc -l l_data.txt l_missing.txt 2>&1 | tail -n 3 → allow', v.behavior === 'allow', shown(v))
}

console.log('\n4. a target outside the starting folder asks with the read words')
{
  const v = await decide(`wc -l < ${outsideWords}`)
  const want = `Mercury needs permission to read ${outsideWords}, outside the starting folder ('${root}').`
  check('wc -l < <outside>/words → ask', v.behavior === 'ask', shown(v))
  check('the words are the read words naming the file and the starting folder', v.message === want, shown(v))
  const relative = await decide('wc -l < ../outside/words')
  check('a relative path outside asks the same', relative.behavior === 'ask' && relative.message === want, shown(relative))
  if (existsSync('/usr/share/dict/words')) {
    const dict = await decide('wc -l < /usr/share/dict/words')
    const resolved = realpathSync('/usr/share/dict/words')
    check('wc -l < /usr/share/dict/words → ask naming the dictionary as the path check resolves it', dict.behavior === 'ask' && dict.message === `Mercury needs permission to read ${resolved}, outside the starting folder ('${root}').`, shown(dict))
  }
}

console.log('\n5. a Read deny rule on the target denies the input redirect')
{
  const secret = join(root, 'secret.txt')
  const v = await decide('wc -l < secret.txt', { alwaysDenyRules: { userSettings: [`Read(/${secret})`] } })
  check('wc -l < secret.txt → deny', v.behavior === 'deny', shown(v))
  check(`the words start "The input redirect from ${secret} is denied by"`, (v.message ?? '').startsWith(`The input redirect from ${secret} is denied by`), shown(v))
}

console.log('\n6. a cd in the same command asks with the read twin of the redirect words')
{
  const v = await decide('cd sub && wc -l < l_data.txt')
  check('cd sub && wc -l < l_data.txt → ask', v.behavior === 'ask', shown(v))
  check('the words name the directory change and the input redirect', v.message === 'This command changes directory and also reads through an input redirect, so the file it reads cannot be determined safely. It needs explicit approval.', shown(v))
  const made = await decide('mkdir sub2 && cd sub2 && wc -l < l_data.txt')
  check('mkdir sub2 && cd sub2 && wc -l < l_data.txt is not allowed (the mkdir asks first, as it did)', made.behavior === 'ask', shown(made))
}

console.log('\n7. the shapes that keep refusing')
{
  const subst = await decide('wc -l <(cat l_data.txt)')
  check('wc -l <(cat l_data.txt) → ask naming `<(`', subst.behavior === 'ask' && subst.message === 'This command uses the shell operator `<(`, which needs approval.', shown(subst))
  const path = checkPathConstraints({ command: 'wc -l <(cat l_data.txt)' }, root, context() as never) as Verdict
  check('the path check keeps its process-substitution words', path.behavior === 'ask' && (path.message ?? '').startsWith('This command uses process substitution'), shown(path))
  const rows: Array<[string, string]> = [
    ['wc -l <<< "a b"', 'This command uses the shell operator `<<<`, which needs approval.'],
    ['cat <> l_data.txt', 'This command uses the shell operator `<>`, which needs approval.'],
    ['cat 3< l_data.txt', 'This command uses the shell operator `<`, which needs approval.'],
    ['cat < $F', 'This command uses the shell operator `<` with a target the shell expands (`$F`), which needs approval.'],
    ['cat < *.txt', 'This command uses the shell operator `<` with a target the shell expands (`*.txt`), which needs approval.'],
  ]
  for (const [command, want] of rows) {
    const v = await decide(command)
    check(`${command} → ask: ${want}`, v.behavior === 'ask' && v.message === want, shown(v))
  }
  const interpreter = await decide('python3 < l_data.txt')
  check('python3 < l_data.txt is not allowed', interpreter.behavior !== 'allow', shown(interpreter))
  const variable = await decide('echo $X < l_data.txt')
  check('a variable before the redirect keeps the variable words', variable.behavior === 'ask' && variable.message === 'A variable reference next to a redirect or pipe can expand to an unexpected command.', shown(variable))
}

console.log("\n8. the scout's test: the read-only rule allows the redirect")
{
  const v = checkReadOnlyConstraints({ command: 'wc -l < l_data.txt' }, false)
  check("checkReadOnlyConstraints({command: 'wc -l < l_data.txt'}, false).behavior === 'allow'", v.behavior === 'allow', shown(v as Verdict))
  const piped = checkReadOnlyConstraints({ command: 'sort < l_data.txt | head -n 3' }, false)
  check('sort < l_data.txt | head -n 3 is read-only', piped.behavior === 'allow', shown(piped as Verdict))
}

console.log('\n9. a prefix allow rule matches the command once its target passed the read check')
{
  const v = await decide('wc -l < l_data.txt', { alwaysAllowRules: { userSettings: ['Bash(wc *)'] } })
  const sub = v.decisionReason?.reasons?.get('wc -l')
  check('Bash(wc *) allows wc -l < l_data.txt by the rule', v.behavior === 'allow' && sub?.decisionReason?.type === 'rule', `${shown(v)} sub=${JSON.stringify(sub?.decisionReason?.type)}`)
  const denied = await decide('wc -l < secret.txt', { alwaysAllowRules: { userSettings: ['Bash(wc *)'] }, alwaysDenyRules: { userSettings: [`Read(/${join(root, 'secret.txt')})`] } })
  check('the read deny on the target wins over the prefix allow', denied.behavior === 'deny', shown(denied))
}

process.chdir(previousCwd)
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-input-redirect-read: ALL LAWS HOLD' : `\nprove-input-redirect-read: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
