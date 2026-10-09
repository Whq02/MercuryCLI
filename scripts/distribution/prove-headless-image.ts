#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUNTIME_PACK_PATH, runtimeBinaryFor } from '../../src/services/privateChannel/vendoredRuntime.ts'
import { ALL_PROVIDER_CREDENTIAL_ENV_VARS } from '../../src/services/providers/credentialEnvSpellings.ts'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
function finish(): never {
  if (failures > 0) {
    console.log(`\nheadless image: RED (${failures})`)
    process.exit(1)
  }
  console.log('\nheadless image: green')
  process.exit(0)
}

console.log('headless image — the Dockerfile, its build context and the README contract')

const dockerfilePath = join(ROOT, 'Dockerfile')
const ignorePath = join(ROOT, '.dockerignore')
check('Dockerfile exists at the repository root', existsSync(dockerfilePath))
check('.dockerignore exists at the repository root', existsSync(ignorePath))
if (!existsSync(dockerfilePath) || !existsSync(ignorePath)) finish()

type Instruction = { verb: string; args: string; line: number }
type Stage = { from: string; name: string | null; instructions: Instruction[] }

const INSTRUCTIONS = new Set(['ARG', 'FROM', 'RUN', 'COPY', 'WORKDIR', 'ENV', 'USER', 'ENTRYPOINT', 'CMD'])
const dockerfile = readFileSync(dockerfilePath, 'utf8')
const rawLines = dockerfile.split('\n')
const logical: Instruction[] = []
const unknown: string[] = []
const commentLines: number[] = []
{
  let pending = ''
  let startedAt = 0
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!
    if (pending === '') {
      if (raw.trim() === '') continue
      if (raw.trimStart().startsWith('#')) {
        commentLines.push(i + 1)
        continue
      }
      startedAt = i + 1
    }
    if (raw.endsWith('\\')) {
      pending += raw.slice(0, -1) + ' '
      continue
    }
    const text = (pending + raw).trim()
    pending = ''
    const space = text.search(/\s/)
    const verb = space < 0 ? text : text.slice(0, space)
    const args = space < 0 ? '' : text.slice(space + 1).trim()
    if (!INSTRUCTIONS.has(verb)) unknown.push(`${startedAt}: ${verb}`)
    logical.push({ verb, args, line: startedAt })
  }
  if (pending !== '') unknown.push('a trailing continuation with no instruction after it')
}
check('the Dockerfile parses: every instruction is one the image needs (ARG FROM RUN COPY WORKDIR ENV USER ENTRYPOINT CMD)', unknown.length === 0, unknown.join('; '))
check('the Dockerfile carries no comment lines (the README carries the words)', commentLines.length === 0, `lines ${commentLines.join(', ')}`)

const args = new Map<string, string>()
const stages: Stage[] = []
for (const instruction of logical) {
  if (instruction.verb === 'ARG' && stages.length === 0) {
    const eq = instruction.args.indexOf('=')
    if (eq > 0) args.set(instruction.args.slice(0, eq), instruction.args.slice(eq + 1))
    continue
  }
  if (instruction.verb === 'FROM') {
    const match = /^(\S+)(?:\s+AS\s+(\S+))?$/i.exec(instruction.args)
    const image = (match?.[1] ?? instruction.args).replace(/\$\{(\w+)\}/g, (_, name: string) => args.get(name) ?? `\${${name}}`)
    stages.push({ from: image, name: match?.[2] ?? null, instructions: [] })
    continue
  }
  stages.at(-1)?.instructions.push(instruction)
}
check('two stages: a builder and the runtime image', stages.length === 2 && stages[0]!.name === 'builder', stages.map(s => `${s.name ?? '(final)'} FROM ${s.from}`).join(' · '))
for (const stage of stages) {
  check(`${stage.name ?? 'the runtime'} stage's base image is pinned by digest (${stage.from.split('@')[0]})`, /^[a-z0-9.\-/]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/.test(stage.from), stage.from)
}

const builder = stages[0]
const runtime = stages[1]
if (!builder || !runtime) finish()

const buildText = readFileSync(join(ROOT, 'build.ts'), 'utf8')
const splashPair = [...buildText.matchAll(/resolve\(ROOT, 'assets', 'splash', '[^']+'\), name: '([^']+)'/g)].map(m => m[1]!)
check('build.ts names the splash pair the image leaves out', splashPair.length === 2, splashPair.join(', '))
const builderRuns = builder.instructions.filter(i => i.verb === 'RUN').map(i => i.args)
const buildRun = builderRuns.find(r => r.includes('bun run build.ts --target linux-x64'))
check('the builder stage builds the linux-x64 release target (bun run build.ts --target linux-x64)', buildRun !== undefined)
check('the builder stage installs the lockfile held (bun install --frozen-lockfile)', builderRuns.some(r => r.includes('bun install --frozen-lockfile')))
for (const fetcher of ['fetch-node.ts --platform linux-x64', 'fetch-brush.ts --platform linux-x64', 'fetch-pyright.ts', 'fetch-debugpy.ts', 'fetch-js-debug.ts', 'fetch-grammars.ts']) {
  check(`the builder stage prepares the vendor pack: scripts/vendor/${fetcher}`, builderRuns.some(r => r.includes(`bun run scripts/vendor/${fetcher}`)))
}
check('the splash pair is removed from dist before the runtime stage copies it', buildRun !== undefined && splashPair.length === 2 && splashPair.every(name => buildRun.includes(`dist/${name}`)) && /\brm\b/.test(buildRun ?? ''), buildRun ?? '')
const builderWorkdir = builder.instructions.find(i => i.verb === 'WORKDIR')?.args ?? ''
check('the builder works under a source root no bundle prose can spell (longer than one word)', /^\/[a-z]+\/[a-z-]+$/.test(builderWorkdir), builderWorkdir)

const copies = runtime.instructions.filter(i => i.verb === 'COPY')
check('the runtime stage copies from the builder alone, never from the build context', copies.length > 0 && copies.every(c => /--from=builder\b/.test(c.args)), copies.map(c => c.args).join(' | '))
const distCopy = copies.find(c => c.args.endsWith(`${builderWorkdir}/dist /opt/mercury`))
check('the runtime stage carries the built dist at /opt/mercury', distCopy !== undefined)
const user = runtime.instructions.filter(i => i.verb === 'USER').at(-1)?.args ?? ''
check('the runtime image runs as a non-root user', user !== '' && user !== 'root' && user !== '0', user || '(no USER)')
const entryIndex = runtime.instructions.findIndex(i => i.verb === 'ENTRYPOINT')
const userIndex = runtime.instructions.findIndex(i => i.verb === 'USER' && i.args === user)
check('the USER instruction comes before the entry point', userIndex >= 0 && entryIndex > userIndex)
check('the runtime image creates that user with a home', runtime.instructions.some(i => i.verb === 'RUN' && i.args.includes(`useradd --create-home`) && i.args.includes(` ${user}`)))
const workdir = runtime.instructions.find(i => i.verb === 'WORKDIR')?.args ?? ''
check('the runtime image works in /work (the mounted tree)', workdir === '/work', workdir)
check(`the runtime image owns ${workdir || '/work'} for its user`, runtime.instructions.some(i => i.verb === 'RUN' && i.args.includes(`chown ${user}:${user} ${workdir}`)))
check(`git trusts the mounted tree (safe.directory ${workdir || '/work'})`, runtime.instructions.some(i => i.verb === 'RUN' && i.args.includes(`git config --system --add safe.directory ${workdir}`)))
check('the runtime image installs the certificate store and git beside the bundle', runtime.instructions.some(i => i.verb === 'RUN' && i.args.includes('apt-get install') && i.args.includes('ca-certificates') && i.args.includes(' git')))

const entrypoint = runtime.instructions.find(i => i.verb === 'ENTRYPOINT')?.args ?? ''
const cmd = runtime.instructions.find(i => i.verb === 'CMD')?.args ?? ''
check('ENTRYPOINT is ["mercury"]', entrypoint === '["mercury"]', entrypoint)
check('CMD is ["run"] (docker run <image> run "<prompt>" and docker run <image> --version both read naturally)', cmd === '["run"]', cmd)
const launcherLine = runtime.instructions.find(i => i.verb === 'RUN' && i.args.includes('/usr/local/bin/mercury'))?.args ?? ''
const expectedExec = `exec /opt/mercury/${RUNTIME_PACK_PATH}/${runtimeBinaryFor('linux-x64')} /opt/mercury/mercury.mjs "$@"`
check('the mercury launcher execs the vendored runtime on the bundle (signals reach the run: SIGTERM exits 143 with its outcome flushed)', launcherLine.includes(expectedExec) && launcherLine.includes('chmod 755 /usr/local/bin/mercury'), launcherLine)

const envKeys: string[] = []
let configDir = ''
let pathValue = ''
for (const instruction of runtime.instructions.filter(i => i.verb === 'ENV')) {
  for (const pair of instruction.args.matchAll(/([A-Z_]+)=(\S+)/g)) {
    envKeys.push(pair[1]!)
    if (pair[1] === 'MERCURY_CONFIG_DIR') configDir = pair[2]!
    if (pair[1] === 'PATH') pathValue = pair[2]!
  }
}
check('the image sets a config home of its own (MERCURY_CONFIG_DIR under the user home)', configDir.startsWith(`/home/${user}/`), configDir || '(unset)')
check(`the vendored runtime is on PATH (${RUNTIME_PACK_PATH}/bin)`, pathValue.startsWith(`/opt/mercury/${RUNTIME_PACK_PATH}/bin:`), pathValue)
const foreign = envKeys.filter(k => k !== 'MERCURY_CONFIG_DIR' && k !== 'PATH')
check('no other environment default rides the image: colour, mouse, splash and permission posture stay the product\'s own detection', foreign.length === 0, foreign.join(', '))

const ignoreLines = readFileSync(ignorePath, 'utf8').split('\n').map(l => l.trim()).filter(l => l !== '')
check('.dockerignore is a whitelist: its first line excludes everything', ignoreLines[0] === '*')
const included = ignoreLines.slice(1).map(l => l.replace(/^!/, ''))
check('.dockerignore holds only re-inclusions after the first line', ignoreLines.slice(1).every(l => l.startsWith('!')), ignoreLines.slice(1).filter(l => !l.startsWith('!')).join(', '))
const bunfig = readFileSync(join(ROOT, 'bunfig.toml'), 'utf8')
const preloadDirs = [...bunfig.matchAll(/"\.\/((?:[^/"]+\/)*)[^/"]+"/g)].map(m => m[1]!.replace(/\/$/, ''))
const required = ['build.ts', 'package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'README.md', 'src', 'assets/splash', 'docs/*.md', 'docs/templates', 'scripts/vendor', 'vendor/*.lock.json', ...preloadDirs]
for (const path of new Set(required)) {
  check(`.dockerignore re-includes ${path}`, included.includes(path))
}
for (const never of ['.git', 'node_modules', 'dist', 'bench', '.mercury', 'vendor/node', 'vendor/brush', 'vendor/pyright', 'vendor/debugpy', 'vendor/js-debug', 'vendor/grammars', 'release-out', 'ci-gate-out']) {
  check(`.dockerignore never re-includes ${never}`, !included.some(p => p === never || p.startsWith(`${never}/`)))
}

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const dockerLines = readme.split('\n').filter(l => /^\s*(?:echo .*\| )?docker run\b/.test(l) || /\bdocker run\b/.test(l) && l.includes('mercury'))
const runLine = dockerLines.find(l => / run "/.test(l))
check('README.md carries the one docker run line', runLine !== undefined, dockerLines.join(' | '))
check(`the README run line mounts the tree at ${workdir || '/work'}`, runLine !== undefined && runLine.includes(`:${workdir}`), runLine ?? '')
check('the README run line hands the API key through the environment (-e ANTHROPIC_API_KEY=)', runLine !== undefined && runLine.includes('-e ANTHROPIC_API_KEY='), runLine ?? '')
check(`the README run line's verb after the image is the CMD verb (${cmd})`, runLine !== undefined && new RegExp(`\\s${JSON.parse(cmd || '[""]')[0]}\\s+"`).test(runLine), runLine ?? '')
check('the README shows docker run <image> --version beside it', dockerLines.some(l => l.includes('--version')), dockerLines.join(' | '))
const sectionStart = readme.indexOf('### The headless image')
const sectionEnd = sectionStart < 0 ? -1 : readme.indexOf('\n### ', sectionStart + 1)
const section = sectionStart < 0 ? '' : readme.slice(sectionStart, sectionEnd < 0 ? undefined : sectionEnd)
check('the README has the headless image section', section !== '')
check('the section names the Dockerfile at the repository root', /`Dockerfile` at the repository root/.test(section))
check(`the section names the non-root user (${user}) and the config home variable`, section.includes(`\`${user}\``) && section.includes('`MERCURY_CONFIG_DIR`'))
for (const spelling of ALL_PROVIDER_CREDENTIAL_ENV_VARS) {
  check(`the section lists the provider key spelling ${spelling}`, section.includes(`\`${spelling}\``))
}

finish()
