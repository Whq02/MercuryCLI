#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tracker-known-values-')))
const project = join(scratch, 'project')
mkdirSync(join(project, '.mercury'), { recursive: true })
mkdirSync(join(scratch, 'outside'), { recursive: true })
const previous = process.cwd()
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.chdir(project)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
await import('../../src/Tool.js')
const { parseForSecurity } = await import('../../src/utils/bash/ast.js')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok || !detail ? '' : ` — ${detail}`}`)
}
const argvOf = async (command: string): Promise<string[][] | string> => {
  const result = await parseForSecurity(command)
  return result.kind === 'simple' ? result.commands.map(c => c.argv) : `${result.kind}: ${(result as { reason?: string }).reason ?? ''}`
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
async function decision(command: string, allow: string[] = []) {
  return bashToolHasPermission({ command }, {
    ...getEmptyToolPermissionContext(), mode: 'default',
    alwaysAllowRules: { localSettings: allow }, alwaysDenyRules: { localSettings: [] }, alwaysAskRules: { localSettings: [] },
  } as never)
}

try {
  console.log('values the command itself spells out are known (red on the base: every one asked)')
  const S = '/private/tmp/scratch'
  for (const [command, argv] of [
    [`S=${S} && echo "=== xref ===" && python3 $S/addbsftfg/xrefcheck.py`, [['echo', '=== xref ==='], ['python3', `${S}/addbsftfg/xrefcheck.py`]]],
    [`S=${S} && echo a && echo b && python3 $S/x.py && ls $S`, [['echo', 'a'], ['echo', 'b'], ['python3', `${S}/x.py`], ['ls', S]]],
    [`S=${S}; mkdir -p $S; ls -la $S`, [['mkdir', '-p', S], ['ls', '-la', S]]],
    [`S=${S} && python3 \${S}/x.py "\${S}/y"`, [['python3', `${S}/x.py`, `${S}/y`]]],
    ['for m in state turn hero; do printf "%-11s " "$m:"; ls crates/homm3-core/src/$m | tr "\\n" " "; echo; done; ls crates/homm3-core/tests/', [['printf', '%-11s ', 'state:'], ['ls', 'crates/homm3-core/src/state'], ['tr', '\\n', ' '], ['echo'], ['printf', '%-11s ', 'turn:'], ['ls', 'crates/homm3-core/src/turn'], ['tr', '\\n', ' '], ['echo'], ['printf', '%-11s ', 'hero:'], ['ls', 'crates/homm3-core/src/hero'], ['tr', '\\n', ' '], ['echo'], ['ls', 'crates/homm3-core/tests/']]],
    [`S=${S}; mkdir -p $S; for i in 1 2 3; do curl -sL -o $S/hd_\${i}.jpg "https://example.test/hd$i.jpg"; done; ls -la $S`, [['mkdir', '-p', S], ['curl', '-sL', '-o', `${S}/hd_1.jpg`, 'https://example.test/hd1.jpg'], ['curl', '-sL', '-o', `${S}/hd_2.jpg`, 'https://example.test/hd2.jpg'], ['curl', '-sL', '-o', `${S}/hd_3.jpg`, 'https://example.test/hd3.jpg'], ['ls', '-la', S]]],
    ['x=1 && y=2 && z=3 && echo $x $y $z', [['echo', '1', '2', '3']]],
    ['x=1 || echo $x', [['echo', '1']]],
    ['for f in "a b" c; do echo "$f"; done', [['echo', 'a b'], ['echo', 'c']]],
    ['for f in a; do x=1; echo $x; done', [['echo', '1']]],
    ['for f in *.txt; do cat $f; done', [['cat', '*.txt']]],
    ['for f in ../outside/*.md; do cat $f; done', [['cat', '../outside/*.md']]],
    ['n=0; for i in $(seq 1 3); do n=$((n+i)); done; echo "n=$n"', [['seq', '1', '3'], ['echo', 'n=__MERCURY_UNKNOWN_INTEGER__']]],
  ] as const) {
    const got = await argvOf(command)
    check(`known: ${command.slice(0, 90)}`, same(got, argv), JSON.stringify(got).slice(0, 300))
  }

  console.log('values the shell would supply at runtime still refuse, with the reason that names them')
  for (const [command, reason] of [
    ['echo $UNKNOWN_X', 'reference to variable $UNKNOWN_X whose value is not statically known'],
    ['false || x=1 && echo $x', 'Bash needs approval for $x because its value is unknown. Use its literal path or value.'],
    ['A=1 && B=2 || echo $B', 'Bash needs approval for $B because its value is unknown. Use its literal path or value.'],
    ['x=1 && unset x; echo $x', 'Bash needs approval for $x because its value is unknown. Use its literal path or value.'],
    ['for f in a b; do x=$f; done; echo $x', 'Bash needs approval for $x because its value is unknown. Use its literal path or value.'],
    ['for f in $(ls); do echo $f; done', 'Bash needs approval for $f because its value is unknown. Use its literal path or value.'],
    ['for i in $(seq 1 100); do echo $i; done', 'Bash needs approval for $i because its value is unknown. Use its literal path or value.'],
    ['for f in *.txt; do echo > "$f"; done', 'an unquoted wildcard expands to paths at runtime; quote it as text or spell out the paths, or approve'],
    ['n=abc; for i in 1 2; do n=$((n+1)); done', 'arithmetic expression contains a non-literal term "n"'],
    ['ls $(cat names)', 'a command substitution supplies an argument at runtime; spell out its value or run the inner command separately, or approve'],
    ['for f in "a b"; do ls $f; done', 'value of $f would be word-split or glob-expanded into a different argv'],
    ['for f in ~/x; do ls $f; done', 'Bash needs approval for $f because its value is unknown. Use its literal path or value.'],
    ['for PATH in /tmp; do ls; done', 'loop variable PATH changes shell lookup, path expansion or startup code; use a different variable, or approve'],
    ['select m in a b; do echo $m; done', 'Bash needs approval for $m because its value is unknown. Use its literal path or value.'],
    ['echo ${x:-default}', 'the expansion "${x:-default}" supplies a value at runtime; spell out the value, or approve'],
    ['x=1; echo ${#x}', 'the expansion "${#x}" supplies a value at runtime; spell out the value, or approve'],
    ['x=1; echo ${x[0]}', 'the expansion "${x[0]}" supplies a value at runtime; spell out the value, or approve'],
    ['b=1; for i in a b; do read $i; done; echo $b', 'Bash needs approval for $b because its value is unknown. Use its literal path or value.'],
    ['b=1; for i in a b; do read $i; done; echo $a', 'Bash needs approval for $a because its value is unknown. Use its literal path or value.'],
  ] as const) {
    const got = await argvOf(command)
    check(`refused: ${command}`, got === `too-complex: ${reason}`, String(got).slice(0, 300))
  }
  const many = `for i in ${Array.from({ length: 65 }, (_, n) => n + 1).join(' ')}; do echo $i; done`
  check('a literal list past the cap (64 items) is walked once with the variable unknown, as before', (await argvOf(many)) === 'too-complex: Bash needs approval for $i because its value is unknown. Use its literal path or value.')
  const sixtyFour = `for i in ${Array.from({ length: 64 }, (_, n) => n + 1).join(' ')}; do echo $i; done`
  const walked = await argvOf(sixtyFour)
  check('a literal list at the cap is walked item by item', Array.isArray(walked) && walked.length === 64 && same(walked[63], ['echo', '64']), String(walked).slice(0, 100))

  console.log('the decision ladder reads the known values: a saved rule answers the concrete commands')
  const chain = await decision(`S=${S} && echo a && python3 $S/x.py`, ['Bash(echo *)', 'Bash(python3 *)'])
  check('an assignment carried through && lets the rules answer (red on the base: the ask named $S)', chain.behavior === 'allow', `${chain.behavior}: ${JSON.stringify(chain).slice(0, 200)}`)
  const loop = await decision('for m in state turn; do python3 run_$m.py; done', ['Bash(python3 *)'])
  check('a literal for list lets the rules answer every iteration', loop.behavior === 'allow', `${loop.behavior}: ${JSON.stringify(loop).slice(0, 200)}`)
  const partial = await decision('for m in state turn; do python3 run_$m.py; done', ['Bash(python3 run_state.py)'])
  check('a rule that answers one iteration only leaves the rest to approval, named', partial.behavior !== 'allow' && JSON.stringify(partial).includes('python3 run_turn.py') && !JSON.stringify(partial).includes('run_state.py'), `${partial.behavior}: ${JSON.stringify(partial).slice(0, 300)}`)
  const bare = await decision('for m in state turn; do python3 run_$m.py; done')
  check('with no rule every concrete iteration is named for approval', bare.behavior !== 'allow' && JSON.stringify(bare).includes('python3 run_state.py, python3 run_turn.py'), `${bare.behavior}: ${JSON.stringify(bare).slice(0, 300)}`)
  const unknown = await decision('echo $UNKNOWN_X', ['Bash(echo *)'])
  check('an unknown variable still asks', unknown.behavior === 'ask' && JSON.stringify(unknown).includes('$UNKNOWN_X'), `${unknown.behavior}: ${JSON.stringify(unknown).slice(0, 200)}`)
  const substitution = await decision('ls $(cat names)', ['Bash(ls *)'])
  check('a command substitution still asks', substitution.behavior === 'ask', `${substitution.behavior}`)
  const glob = await decision('for f in ../outside/*.md; do cat $f; done', ['Bash(cat *)'])
  check('a glob reaching outside the tree still asks', glob.behavior === 'ask', `${glob.behavior}`)
  const settings = await decision('echo x > .mercury/settings.local.json', ['Bash(echo *)'])
  check('a redirect into .mercury/settings.local.json still asks', settings.behavior === 'ask', `${settings.behavior}: ${JSON.stringify(settings).slice(0, 200)}`)
} finally {
  process.chdir(previous)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures ? `prove-tracker-known-values: ${failures} FAILURE(S) of ${checks}` : `prove-tracker-known-values: ALL ${checks} LAWS HOLD`)
process.exit(failures ? 1 : 0)
