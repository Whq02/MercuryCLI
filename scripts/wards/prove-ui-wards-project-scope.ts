#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { handoffTurn, startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'ui-ward-scope-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_WARDS = '1'
const { registerWardsGuard } = await import('../../src/permissions/guards/wardsGuard.js')
const { judgeToolCall } = await import('../../src/permissions/guards/guards.js')
const { runWithCwdOverride } = await import('../../src/platform/files/cwd.js')
let failures = 0
let serial = 0
const check = (label: string, good: boolean, answer: unknown, hint?: string): void => {
  console.log(`${good ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(answer)}${good || hint === undefined ? '' : ` -- ${hint}`}`)
  if (!good) failures++
}
const project = (name: string, packageName: string, palette: boolean, git = true): string => {
  const dir = join(scratch, name)
  mkdirSync(join(dir, 'src', 'components'), { recursive: true })
  if (git) mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: packageName }))
  writeFileSync(join(dir, 'src', 'components', 'Button.tsx'), 'export const color = "blue"\n')
  if (palette) copyFileSync(join(root, 'src', 'screen', 'theme', 'mercuryPalette.ts'), join(dir, 'src', 'components', 'mercuryPalette.ts'))
  return dir
}
const judge = async (cwd: string, file: string, text: string, mode = 'default', tool = 'Edit') => runWithCwdOverride(cwd, async () => {
  const session = `ui-ward-${++serial}`
  registerWardsGuard((() => {}) as never, session)
  return judgeToolCall(session, {
    tool, input: tool === 'Write' ? { file_path: file, content: text } : { file_path: file, old_string: '', new_string: text },
    callId: session, messages: [], toolRef: { name: tool } as never,
    asksAnswerable: mode !== 'sovereign',
  })
})

try {
  const react = project('react', 'button-app', false)
  mkdirSync(join(react, '.mercury'), { recursive: true })
  writeFileSync(join(react, '.mercury', 'wards.json'), JSON.stringify([{ name: 'no-legacy-token', teach: 'Use the current token.', scope: 'edit', patterns: ['LEGACY_BUTTON_TOKEN'] }]))
  const copied = project('copied-palette', 'button-app', true)
  const nameOnly = project('same-name', 'mercury', false)
  const foreign = project('foreign', 'another-app', false)
  const untracked = project('untracked-react', 'another-app', false, false)
  const mirror = join(scratch, 'mercury-link')
  symlinkSync(root, mirror, process.platform === 'win32' ? 'junction' : 'dir')
  const color = 'export const color = "#fff"\n'
  const emoji = `export const icon = "${String.fromCodePoint(0x1f389)}"\n`
  for (const mode of ['default', 'implement', 'sovereign']) {
    for (const dir of [react, copied, nameOnly]) {
      for (const [label, text] of [['hex', color], ['emoji', emoji]] as const) {
        for (const tool of ['Edit', 'Write']) {
          const answer = await judge(dir, join(dir, 'src', 'components', 'Button.tsx'), text, mode, tool)
          check(`${mode}: ${tool} ${label} in ${dir.slice(scratch.length + 1)} is allowed`, !answer.refused, answer, 'a UI ward refused a project that is not the Mercury source tree; check isMercurySource in registerWardsGuard (src/permissions/guards/wardsGuard.ts), which must require src/screen/theme/mercuryPalette.ts and a package.json named mercury')
        }
      }
    }
  }
  console.log('refusals')
  for (const mode of ['default', 'implement', 'sovereign']) {
    for (const tree of [root, mirror]) {
      for (const [label, text, rule] of [['hex', color, 'no-new-hex-outside-theme'], ['emoji', emoji, 'no-emoji-in-tui-source']] as const) {
        const answer = await judge(react, join(tree, 'src', 'components', 'Button.tsx'), text, mode)
        check(`${mode}: Mercury ${label} is refused from another cwd and through a link`, answer.refused && answer.reason.includes(rule), answer, `the ${rule} ward must refuse edits under the Mercury src/ tree from any cwd and through a link; check isMercurySource in src/permissions/guards/wardsGuard.ts and the ward in src/permissions/wards/wards.ts`)
      }
    }
    const away = await judge(root, join(foreign, 'src', 'components', 'Button.tsx'), color, mode)
    check(`${mode}: Mercury cwd does not impose its UI rule on another project`, !away.refused, away, 'a file in another project was judged as Mercury source; check the root and src/ prefix test in isMercurySource (src/permissions/guards/wardsGuard.ts)')
    const awayUntracked = await judge(root, join(untracked, 'src', 'components', 'Button.tsx'), color, mode)
    check(`${mode}: Mercury cwd does not impose its UI rule on an untracked project outside the repo`, !awayUntracked.refused, awayUntracked, 'a file in an untracked project was judged as Mercury source; check the root and src/ prefix test in isMercurySource (src/permissions/guards/wardsGuard.ts)')
    const nested = await judge(root, join(root, 'scratch', 'react', 'src', 'components', 'Button.tsx'), color, mode)
    check(`${mode}: a nested subproject path outside root src/ is not treated as Mercury TUI source`, !nested.refused, nested, 'a nested project path was judged as Mercury source; isMercurySource (src/permissions/guards/wardsGuard.ts) must require the path to lie under the root src/ of the resolved project')
    const palette = await judge(root, join(root, 'src', 'screen', 'theme', 'mercuryPalette.ts'), color, mode)
    check(`${mode}: the sanctioned palette still accepts colors`, !palette.refused, palette, 'edits to src/screen/theme/mercuryPalette.ts must stay allowed; check the no-new-hex-outside-theme ward in src/permissions/wards/wards.ts')
    const omission = await judge(react, join(react, 'src', 'components', 'Button.tsx'), '// rest of code ...', mode)
    check(`${mode}: the non-UI omission ward still refuses`, omission.refused && omission.reason.includes('no-omission-placeholder'), omission, 'the no-omission-placeholder ward in src/permissions/wards/wards.ts must still refuse in every project, not only in the Mercury source tree')
    const customRule = await judge(react, join(react, 'src', 'components', 'Button.tsx'), 'export const x = "LEGACY_BUTTON_TOKEN"\n', mode)
    check(`${mode}: a user project's own .mercury/wards.json rule still refuses`, customRule.refused && customRule.reason.includes('no-legacy-token'), customRule, 'the project rule in .mercury/wards.json was not applied; check how src/permissions/guards/wardsGuard.ts and src/permissions/wards/wards.ts load project wards')
  }
  for (const malformed of ['{', 'null', JSON.stringify({ nested: { name: 'mercury' } }), JSON.stringify({ name: 'another-app', padding: 'x'.repeat(80_000) })]) {
    writeFileSync(join(copied, 'package.json'), malformed)
    const answer = await judge(copied, join(copied, 'src', 'components', 'Button.tsx'), color)
    check('a malformed, nested-name or oversized manifest cannot identify Mercury', !answer.refused, answer, 'a bad package.json made the project count as Mercury source; the JSON parse and name check in isMercurySource (src/permissions/guards/wardsGuard.ts) must return false for it')
  }
  console.log('refusals: the built product in each permission mode')
  for (const mode of ['default', 'implement', 'sovereign']) {
    const home = join(scratch, `product-${mode}`)
    const ownTree = project(`own-${mode}`, 'mercury', true)
    const userTree = project(`user-${mode}`, 'button-app', true)
    seedFirstRun(home, [ownTree, userTree])
    const forbidden = join(ownTree, 'src', 'components', 'New.tsx')
    const permitted = join(userTree, 'src', 'components', 'New.tsx')
    const api = await startFixtureApi([
      { kind: 'tool_use', name: 'Write', input: { file_path: forbidden, content: color } },
      { kind: 'tool_use', name: 'Write', input: { file_path: forbidden, content: emoji } },
      { kind: 'tool_use', name: 'Write', input: { file_path: permitted, content: color } },
      { kind: 'text', text: 'The user component is written; the source-tree rules were respected.' },
      handoffTurn(), handoffTurn(),
    ])
    try {
      const child = spawn('node', [join(root, 'dist', 'mercury.mjs'), 'run', '--format', 'rows', ...(mode === 'sovereign' ? ['--sovereign'] : ['--mode', mode]), '--allowed-tools', 'Write', '--', 'write the fixture components'], {
        cwd: userTree, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: { ...(process.platform === 'win32' ? { USERPROFILE: home, SystemRoot: process.env.SystemRoot, SYSTEMROOT: process.env.SYSTEMROOT, ComSpec: process.env.ComSpec, COMSPEC: process.env.COMSPEC, TEMP: tmpdir(), TMP: tmpdir() } : {}), HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), BROWSER: '/usr/bin/true', MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url },
      })
      let output = ''
      let errors = ''
      child.stdout.on('data', chunk => { output += String(chunk) })
      child.stderr.on('data', chunk => { errors += String(chunk) })
      const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done) })
      const rows = output.split('\n').filter(Boolean).map(line => JSON.parse(line) as { type?: string; mode?: string; status?: string; output?: unknown })
      check(`${mode}: product carries the requested permission mode`, rows.some(row => row.type === 'session' && row.mode === mode), rows.find(row => row.type === 'session'), 'the run row did not report the requested mode; check the --mode and --sovereign flags of the run verb and that dist/mercury.mjs is built')
      for (const rule of ['no-new-hex-outside-theme', 'no-emoji-in-tui-source']) {
        const refused = rows.find(row => row.type === 'tool_result' && String(row.output).includes(`Ward '${rule}'`))
        check(`${mode}: ${rule} refuses before permissions`, refused?.status === 'error', refused, `no error tool_result carried Ward '${rule}'; check the ward in src/permissions/wards/wards.ts and its registration in src/permissions/guards/wardsGuard.ts, and rebuild dist/mercury.mjs`)
      }
      check(`${mode}: a refused component was never written`, !existsSync(forbidden), forbidden, 'the Write was not stopped before touching disk; the wards guard (src/permissions/guards/wardsGuard.ts) must refuse it before permissions')
      check(`${mode}: the React component was written byte for byte`, existsSync(permitted) && readFileSync(permitted, 'utf8') === color, permitted, 'the Write into the non-Mercury project did not land; a UI ward must not apply there (isMercurySource in src/permissions/guards/wardsGuard.ts)')
      check(`${mode}: the product finishes after the refusals`, code === 0 && rows.some(row => row.type === 'outcome' && row.status === 'completed'), { code, errors: errors.slice(-300), output: code === 0 ? '' : output.slice(-3000) }, 'the run exited non-zero or reported no completed outcome; read errors and output here, and check the refusal path in src/permissions/guards/wardsGuard.ts')
    } finally {
      await api.close()
    }
  }
  console.log(`${failures === 0 ? 'PASS' : 'FAIL'} UI wards are confined to the Mercury source tree; failures=${failures}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
