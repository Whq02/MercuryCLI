import { spawnSync } from 'node:child_process'
import { shimContent } from '../../src/services/privateChannel/installLayout.ts'
import { TEARDOWN_SUITE } from '../../src/ink/root/teardown.ts'

const expected = TEARDOWN_SUITE.flatMap(step => step.kind === 'bytes' && (step.when === 'always' || step.when === 'alt-only') ? [step.bytes] : []).join('')
const launcher = shimContent(false)
const line = launcher.split('\n').find(row => row.trim().startsWith('"$node_bin" -e '))
let failures = 0
const check = (label: string, ok: boolean, detail: unknown = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`)
}
check('the launcher has one crash-reset command', launcher.split('\n').filter(row => row.trim().startsWith('"$node_bin" -e ')).length === 1)
const script = line?.trim().replace(/ 2>\/dev\/null \|\| true$/, '') ?? 'exit 1'
const written = spawnSync('sh', ['-c', `node_bin="$RESET_NODE"; ${script}`], { encoding: 'utf8', windowsHide: true, env: { ...process.env, RESET_NODE: process.execPath }, timeout: 10_000 })
check('the written command executes as a shell line', written.status === 0, written.stderr)
check('the written launcher emits exactly always plus alt-only teardown bytes in owner order', written.stdout === expected, { actual: written.stdout, expected })
check('the reset is gated on a terminal and a failed child', launcher.includes('[ -t 1 ] && [ "$rt" != "0" ]'))
check('the child exit code still leaves unchanged', launcher.includes('exit $rt'))
console.log(`${failures ? 'FAIL' : 'PASS'} launcher-reset-owner: ${failures} failures`)
process.exit(failures ? 1 : 0)
