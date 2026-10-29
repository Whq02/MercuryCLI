import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const original = process.cwd()
const world = realpathSync(mkdtempSync(join(tmpdir(), 'shell-syntax-')))
const project = join(world, 'project')
mkdirSync(join(project, 'tests'), { recursive: true })
mkdirSync(join(project, 'sub'), { recursive: true })
mkdirSync(join(project, 'sites', 'blog', 'content'), { recursive: true })
mkdirSync(join(project, 'sites', 'handbook.expected'), { recursive: true })
writeFileSync(join(project, 'package.json'), '{"name":"fixture","scripts":{"test":"node --test tests/*.test.mjs"}}\n')
writeFileSync(join(project, 'sites', 'blog', 'site.json'), '{}\n')
writeFileSync(join(project, 'sites', 'blog', 'content', 'a.md'), '# a\n')
writeFileSync(join(project, 'sites', 'handbook.expected', 'index.html'), '<p>x</p>\n')
process.env.MERCURY_CONFIG_DIR = join(world, 'home')
process.chdir(project)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ' — ' + detail}`)
  if (!ok) failures++
}
const tool = { name: 'Bash', inputSchema: z.object({ command: z.string() }), checkPermissions: (input: any, context: any) => bashToolHasPermission(input, context.getAppState().toolPermissionContext) } as never
const assistant = { message: { id: 'shell-syntax' } } as never
function context(mode = 'flow') {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode } }
  return { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, options: { isNonInteractiveSession: true, hostHoldsAsks: false }, messages: [] } as never
}
async function decide(command: string, mode = 'flow') {
  const outcome = await decideToolPermissionWithModes(tool, { command }, context(mode), assistant, command)
  return outcome.decision as { behavior: string; message?: string }
}
const heredoc = (target: string) => `cat > ${target} <<'EOF'\nimport { buildNav } from './core/nav.mjs'\nconst check = (name, pages, expectedHrefs) => {\n  const actual = buildNav(pages).map(p => p.href).join(',')\n  if (actual !== expectedHrefs.join(',')) console.log(\`FAIL \${name}\`)\n}\ncheck('numeric order beats string order', [{ title: 'Ten', href: '/ten.html', order: 10 }], ['/ten.html'])\nEOF`
try {
  const evidence: Array<[string, string]> = [
    ['for f in sites/blog/content/*.md sites/blog/site.json; do echo "=== $f ==="; cat "$f"; done', 'cat sites/blog/content/*.md sites/blog/site.json'],
    ['for f in sites/handbook.expected/*.html; do echo "=== $f ==="; cat "$f"; done', 'cat sites/handbook.expected/*.html'],
    ['for f in sites/blog/content/*.md sites/blog/site.json; do echo "=== $f ==="; cat "$f"; echo; done', 'cat sites/blog/content/*.md'],
    [`fails=0; for i in $(seq 1 30); do node --test 'tests/*.test.ts' > sub/run_$i.log 2>&1 || fails=$((fails+1)); done; echo "failures in 30 runs: $fails"; grep -h -c "ok" sub/run_1.log`, "node --test 'tests/*.test.ts' > sub/run_1.log 2>&1"],
    [`fails=0; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do node --test 'tests/*.test.ts' > sub/run_$i.log 2>&1 || fails=$((fails+1)); done; echo "failures in 30 runs: $fails"`, "node --test 'tests/*.test.ts' > sub/run_30.log 2>&1"],
    [`fails=0; for i in $(seq 1 20); do if ! npm test >sub/run_$i.log 2>&1; then fails=$((fails+1)); fi; done; echo "failures: $fails/20"`, 'npm test > sub/run_1.log 2>&1'],
    [heredoc('sub/nav-edge.test.mjs'), 'cat > sub/nav-edge.test.mjs'],
    ['npm test && npm run typecheck; echo done', 'npm test'],
  ]
  for (const [command, bare] of evidence) {
    const whole = await decide(command)
    const inner = await decide(bare)
    check(`hostless Flow decides the construct as it decides the command inside (${inner.behavior}): ${command.slice(0, 70)}`, whole.behavior === inner.behavior && whole.behavior === 'allow', JSON.stringify(whole))
  }
  for (const [command, bare] of [[evidence[0]![0], evidence[0]![1]], [evidence[6]![0], evidence[6]![1]]] as Array<[string, string]>) {
    const whole = await decide(command, 'default')
    const inner = await decide(bare, 'default')
    check(`default mode gives the construct the command's own verdict (${inner.behavior}): ${command.slice(0, 60)}`, whole.behavior === inner.behavior, JSON.stringify({ whole, inner }))
  }
  const strict: string[] = [
    'for f in sites/blog/content/*.md; do rm -rf "$f"; done',
    'for i in $(seq 1 3); do rm -rf ../$i; done',
    'for i in $(seq 1 3); do git push origin topic; done',
    'for f in sub/*.log; do sudo rm -rf /; done',
    `fails=0; for i in $(seq 1 30); do node --test 'tests/*.test.ts' > /tmp/run_$i.log 2>&1 || fails=$((fails+1)); done`,
    heredoc('/tmp/nav-edge.test.mjs'),
    'for i in $(seq 1 100); do echo $i > sub/$i.log; done',
    'n=abc; for i in 1 2; do n=$((n+1)); done',
    'echo $((HOME+1))',
    'cat > sub/x.sh <<EOF\n$(rm -rf sub)\nEOF',
  ]
  for (const command of strict) {
    const result = await decide(command)
    check(`a construct over a command that asks still asks: ${command.slice(0, 70)}`, result.behavior !== 'allow', JSON.stringify(result))
  }
} finally {
  process.chdir(original)
  rmSync(world, { recursive: true, force: true })
}
console.log(failures ? `shell syntax verdict: ${failures} FAILED` : 'shell syntax verdict: ALL PASS')
process.exit(failures ? 1 : 0)
