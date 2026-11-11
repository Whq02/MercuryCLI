import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, resolve } from 'node:path'
import type { Tool, ToolPermissionContext } from '../../Tool.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { readBashRuleVerdict } from '../../tools/BashTool/bashPermissions.js'
import { shellCommandSegments } from '../../tools/BashTool/destructiveCommandWarning.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { MONITOR_TOOL_NAME } from '../../tools/MonitorTool/constants.js'
import { DEBUG_TOOL_NAME } from '../../tools/DebugTool/prompt.js'
import { startedCommandText } from '../bash/ast.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { getStartingCwd } from '../cwd.js'
import { getPathsForPermissionCheck } from '../fsOperations.js'
import { resolveShellCwd } from '../Shell.js'
import { PARSE_ABORTED, pinnedCommandAnalysis, preparedCommandRoot, type Node } from './decision/commandAnalysis.js'
import { getMercuryTempDir, getScratchpadDir, matchingRuleForInput, pathInWorkingPath } from './filesystem.js'
import { ownGroundCategory } from './ownGround.js'

type FlowItem = 1 | 2 | 3 | 4
export type FlowAsk = { item: FlowItem; subject: string; why: string }

type PublishEntry = { commands: readonly string[]; forms: readonly string[]; why: string; when?: (args: readonly string[]) => boolean }

const PRIVILEGE_COMMANDS = ['sudo', 'sudoedit', 'doas', 'pkexec', 'su', 'runas', 'gsudo', 'pfexec', 'dzdo', 'pbrun'] as const

const GIT_FORMS: ReadonlyArray<{ form: string; why: string; test: (sub: string, args: readonly string[]) => boolean }> = [
  { form: 'push', why: 'it publishes history', test: sub => sub === 'push' },
  { form: 'reset --hard', why: 'it rewrites history', test: (sub, args) => sub === 'reset' && args.includes('--hard') },
  { form: 'clean -f', why: 'it deletes untracked files for good', test: (sub, args) => sub === 'clean' && args.some(arg => arg === '--force' || /^-[a-zA-Z]*f/.test(arg)) && !args.some(arg => arg === '--dry-run' || /^-[a-zA-Z]*n/.test(arg)) },
  { form: 'branch -D', why: 'it deletes a branch for good', test: (sub, args) => sub === 'branch' && (args.some(arg => /^-[a-zA-Z]*D/.test(arg)) || (args.some(arg => arg === '--delete' || /^-[a-zA-Z]*d/.test(arg)) && args.some(arg => arg === '--force' || /^-[a-zA-Z]*f/.test(arg)))) },
  { form: 'filter-branch', why: 'it rewrites history', test: sub => sub === 'filter-branch' },
  { form: 'filter-repo', why: 'it rewrites history', test: sub => sub === 'filter-repo' },
]

const FORGE_FORMS: ReadonlyArray<{ commands: readonly string[]; form: string; why: string }> = [
  { commands: ['gh'], form: 'pr merge', why: 'it merges on GitHub' },
  { commands: ['gh'], form: 'release create', why: 'it publishes a release' },
  { commands: ['gh'], form: 'release upload', why: 'it publishes a release' },
  { commands: ['gh'], form: 'release delete', why: 'it deletes a published release' },
  { commands: ['gh'], form: 'repo delete', why: 'it deletes a repository on GitHub' },
  { commands: ['glab'], form: 'mr merge', why: 'it merges on GitLab' },
  { commands: ['glab'], form: 'release create', why: 'it publishes a release' },
  { commands: ['glab'], form: 'release upload', why: 'it publishes a release' },
  { commands: ['glab'], form: 'release delete', why: 'it deletes a published release' },
  { commands: ['glab'], form: 'repo delete', why: 'it deletes a repository on GitLab' },
]

const PACKAGE = 'it publishes a package'
const IMAGE = 'it publishes an image'
const DEPLOY = 'it deploys outside this machine'
const INFRA = 'it changes live infrastructure'
const CLUSTER = 'it changes a live cluster'

function formMatches(form: string, words: readonly string[]): boolean {
  const parts = form.split(' ')
  const plain = words.filter(word => !word.startsWith('-'))
  const positional = parts.filter(part => !part.startsWith('-'))
  return positional.every((part, index) => plain[index] === part) && parts.filter(part => part.startsWith('-')).every(flag => words.includes(flag))
}

const anyForm = (forms: readonly string[]) => (args: readonly string[]): boolean => forms.some(form => formMatches(form, args))

const PUBLISH_TABLE: readonly PublishEntry[] = [
  { commands: ['npm', 'pnpm', 'yarn', 'bun'], forms: ['publish', 'unpublish', 'deprecate', 'npm publish'], why: PACKAGE },
  { commands: ['cargo'], forms: ['publish', 'yank'], why: PACKAGE },
  { commands: ['twine'], forms: ['upload'], why: PACKAGE },
  { commands: ['flit', 'poetry', 'hatch', 'uv', 'pdm', 'maturin'], forms: ['publish'], why: PACKAGE },
  { commands: ['gem'], forms: ['push', 'yank'], why: PACKAGE },
  { commands: ['mvn', 'mvnw'], forms: ['deploy', 'release:perform', 'nexus-staging:release'], why: PACKAGE },
  { commands: ['gradle', 'gradlew', 'sbt'], forms: [], why: PACKAGE, when: args => args.some(arg => /^publish/i.test(arg)) },
  { commands: ['lein'], forms: ['deploy'], why: PACKAGE },
  { commands: ['mix'], forms: ['hex.publish'], why: PACKAGE },
  { commands: ['dart', 'flutter'], forms: ['pub publish'], why: PACKAGE },
  { commands: ['dotnet'], forms: ['nuget push'], why: PACKAGE },
  { commands: ['nuget'], forms: ['push', 'delete'], why: PACKAGE },
  { commands: ['snapcraft'], forms: ['upload', 'push', 'release'], why: PACKAGE },
  { commands: ['docker', 'podman', 'nerdctl'], forms: ['push', 'image push', 'compose push', 'manifest push'], why: IMAGE },
  { commands: ['docker', 'podman', 'nerdctl'], forms: ['build --push', 'buildx build --push'], why: IMAGE },
  { commands: ['docker'], forms: ['stack deploy', 'service create', 'service update'], why: DEPLOY },
  { commands: ['crane', 'oras'], forms: ['push', 'copy'], why: IMAGE },
  { commands: ['skopeo'], forms: ['copy', 'sync'], why: IMAGE },
  { commands: ['wrangler'], forms: ['deploy', 'publish', 'pages deploy', 'pages publish', 'versions deploy', 'versions upload'], why: DEPLOY },
  { commands: ['vercel'], forms: ['deploy', 'promote', 'redeploy', 'rollback', 'alias', '--prod', '--production'], why: DEPLOY, when: args => anyForm(['deploy', 'promote', 'redeploy', 'rollback', 'alias', '--prod', '--production'])(args) || args.every(arg => arg.startsWith('-')) },
  { commands: ['netlify'], forms: ['deploy'], why: DEPLOY },
  { commands: ['firebase'], forms: ['deploy', 'hosting:channel:deploy'], why: DEPLOY },
  { commands: ['fly', 'flyctl'], forms: ['deploy', 'launch', 'destroy', 'apps destroy', 'machine destroy'], why: DEPLOY },
  { commands: ['heroku'], forms: ['container:push', 'container:release', 'pipelines:promote', 'apps:destroy', 'releases:rollback'], why: DEPLOY },
  { commands: ['railway'], forms: ['up', 'deploy', 'down'], why: DEPLOY },
  { commands: ['render'], forms: ['deploy'], why: DEPLOY },
  { commands: ['deno'], forms: ['deploy'], why: DEPLOY },
  { commands: ['deployctl', 'gh-pages', 'surge'], forms: [], why: DEPLOY, when: () => true },
  { commands: ['amplify'], forms: ['push', 'publish'], why: DEPLOY },
  { commands: ['kamal'], forms: ['deploy', 'setup', 'rollback', 'remove'], why: DEPLOY },
  { commands: ['cap'], forms: [], why: DEPLOY, when: args => args.includes('deploy') },
  { commands: ['pm2'], forms: ['deploy'], why: DEPLOY },
  { commands: ['skaffold'], forms: ['run', 'deploy', 'delete'], why: DEPLOY },
  { commands: ['expo'], forms: ['publish'], why: DEPLOY },
  { commands: ['eas'], forms: ['update', 'submit', 'build'], why: DEPLOY },
  { commands: ['supabase'], forms: ['db push', 'functions deploy'], why: DEPLOY },
  { commands: ['shopify'], forms: ['theme push', 'app deploy'], why: DEPLOY },
  { commands: ['serverless', 'sls'], forms: ['deploy', 'remove'], why: INFRA },
  { commands: ['sam'], forms: ['deploy', 'delete'], why: INFRA },
  { commands: ['cdk'], forms: ['deploy', 'destroy'], why: INFRA },
  { commands: ['pulumi'], forms: ['up', 'destroy', 'refresh'], why: INFRA },
  { commands: ['terraform', 'tofu', 'terragrunt'], forms: ['apply', 'destroy', 'import', 'taint', 'state rm', 'state mv', 'run-all apply', 'run-all destroy'], why: INFRA },
  { commands: ['aws'], forms: ['cloudformation deploy', 'cloudformation create-stack', 'cloudformation update-stack', 'cloudformation delete-stack', 'lambda update-function-code', 'lambda publish-version', 'ecs update-service', 's3 rm', 's3 rb'], why: INFRA },
  { commands: ['aws'], forms: ['s3 cp', 's3 mv', 's3 sync'], why: INFRA, when: args => anyForm(['s3 cp', 's3 mv', 's3 sync'])(args) && (args.filter(arg => !arg.startsWith('-')).at(-1) ?? '').startsWith('s3://') },
  { commands: ['gcloud'], forms: ['app deploy', 'run deploy', 'functions deploy', 'builds submit'], why: INFRA, when: args => anyForm(['app deploy', 'run deploy', 'functions deploy', 'builds submit'])(args) || args.includes('delete') },
  { commands: ['az'], forms: ['webapp up', 'containerapp up'], why: INFRA, when: args => anyForm(['webapp up', 'containerapp up'])(args) || args.includes('deploy') || args.includes('deployment') || args.includes('delete') },
  { commands: ['kubectl', 'oc'], forms: ['apply', 'delete', 'create', 'replace', 'patch', 'rollout', 'scale', 'drain', 'edit', 'set'], why: CLUSTER },
  { commands: ['helm'], forms: ['install', 'upgrade', 'uninstall', 'delete', 'rollback'], why: CLUSTER },
  { commands: ['nomad'], forms: ['job run', 'run', 'job stop', 'stop'], why: CLUSTER },
  { commands: ['argocd'], forms: ['app sync', 'app delete', 'app create'], why: CLUSTER },
]

const DELETE_VERBS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash'])
const MOVE_VERBS = new Set(['mv'])
const COPY_VERBS = new Set(['cp', 'install', 'rsync', 'ditto', 'scp'])
const INPLACE_EDITORS = new Set(['sed', 'perl', 'ruby'])
const TEE_VERBS = new Set(['tee'])
const DISK_VERBS = new Set(['wipefs', 'fdisk', 'parted', 'sgdisk', 'diskutil'])
const PSEUDO_DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin', '/dev/tty', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/full'])
const SHELLS = /^(?:ba|z|da|k|fi|c|tc)?sh$/
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'uvx'])
const SKIP_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '{', '}', '(', ')', '!', 'time', 'builtin', 'command', 'exec', 'nohup', 'coproc'])

export const FLOW_LAW = {
  1: { name: 'privilege escalation', commands: PRIVILEGE_COMMANDS, powershell: ['Start-Process -Verb RunAs', 'runas'] },
  2: { name: 'git that rewrites or publishes history', git: GIT_FORMS.map(entry => entry.form), forges: FORGE_FORMS.map(entry => `${entry.commands.join('/')} ${entry.form}`) },
  3: { name: 'publishing and deploying', table: PUBLISH_TABLE.map(entry => ({ commands: entry.commands, forms: entry.forms, why: entry.why })) },
  4: {
    name: 'deleting or overwriting outside the project tree and the run\'s own scratch',
    verbs: { delete: [...DELETE_VERBS], move: [...MOVE_VERBS], copy: [...COPY_VERBS], inPlace: [...INPLACE_EDITORS].map(name => `${name} -i`), stream: [...TEE_VERBS, 'truncate', 'dd of=', 'ln -f', 'curl -o', 'wget -O', 'find -delete', '> >> &> redirects'], disk: ['mkfs*', ...DISK_VERBS] },
    free: ['the starting folder and its worktrees', 'the scratchpad and every path this run created', 'the temp roots (TMPDIR, /tmp, /var/tmp)'],
  },
  5: { name: 'your own deny and ask rules', note: 'guardrails.deny refuses, guardrails.ask asks, in Flow as in Default' },
} as const

export function flowAskSentence(ask: FlowAsk): string {
  return `Flow asks before ${ask.subject}: ${ask.why}.`
}

function cut(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

let ownRootsCache: { key: string; roots: string[]; temps: string[] } | null = null

function realForm(path: string): string {
  const forms = getPathsForPermissionCheck(path)
  return forms[forms.length - 1] ?? path
}

function projectRoots(): string[] {
  const roots = new Set<string>()
  for (const start of [getOriginalCwd(), getStartingCwd()]) {
    if (!start) continue
    roots.add(start)
    const worktree = /^(.*?)[\\/]\.mercury[\\/]worktrees[\\/][^\\/]+/.exec(start)
    if (worktree?.[1]) roots.add(worktree[1])
  }
  return [...roots]
}

function ownRoots(): { roots: string[]; temps: string[] } {
  const key = [getOriginalCwd(), getStartingCwd(), process.env.TMPDIR ?? '', process.env.MERCURY_TMPDIR ?? ''].join('\0')
  if (ownRootsCache?.key === key) return ownRootsCache
  const roots = projectRoots().flatMap(root => [root, realForm(root)])
  const temps = new Set<string>()
  for (const temp of [getMercuryTempDir(), tmpdir(), process.env.TMPDIR, process.env.MERCURY_TMPDIR, process.env.TEMP, process.env.TMP, '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp']) {
    if (!temp) continue
    temps.add(temp.replace(/[\\/]+$/, ''))
    temps.add(realForm(temp).replace(/[\\/]+$/, ''))
  }
  ownRootsCache = { key, roots, temps: [...temps] }
  return ownRootsCache
}

function sameFolder(a: string, b: string): boolean {
  return pathInWorkingPath(a, b) && pathInWorkingPath(b, a)
}

function groundOf(candidate: string): boolean {
  const { roots, temps } = ownRoots()
  if (roots.some(root => pathInWorkingPath(candidate, root))) return true
  if (temps.some(temp => pathInWorkingPath(candidate, temp) && !sameFolder(candidate, temp))) return true
  try {
    if (pathInWorkingPath(candidate, getScratchpadDir())) return true
  } catch {
  }
  try {
    return ownGroundCategory(candidate) !== null
  } catch {
    return false
  }
}

export function isOwnGround(path: string, cwd: string = getStartingCwd()): boolean {
  const absolute = isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) ? path : resolve(cwd, path)
  const forms = getPathsForPermissionCheck(absolute, cwd)
  const [spelled, ...real] = forms
  const candidates = real.length === 0 ? [spelled ?? absolute] : real
  return candidates.every(groundOf)
}

type Scan = { cwd: string | null; asks: FlowAsk[]; depth: number; rules?: ToolPermissionContext }

function expandKnown(text: string, cwd: string | null): string | null {
  let out = text
  const home = homedir()
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) out = home + out.slice(1)
  out = out.replace(/\$\{?HOME\}?|\$env:USERPROFILE|\$env:HOME/gi, home)
  out = out.replace(/\$\{?TMPDIR\}?|\$env:TEMP|\$env:TMP/gi, process.env.TMPDIR ?? tmpdir())
  if (/\$\{?PWD\}?/.test(out)) {
    if (cwd === null) return null
    out = out.replace(/\$\{?PWD\}?/g, cwd)
  }
  return out
}

function literalPrefix(path: string): { target: string; folder: boolean } | null {
  const unknown = path.search(/[$`]/)
  const glob = path.search(/[*?[{]/)
  const cutAt = [unknown, glob].filter(index => index !== -1).sort((a, b) => a - b)[0]
  if (cutAt === undefined) return { target: path, folder: false }
  const head = path.slice(0, cutAt)
  const slash = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'))
  if (slash === -1) return cutAt === unknown ? null : { target: '.', folder: true }
  return { target: head.slice(0, slash + 1), folder: true }
}

function outsidePath(operand: string, scan: Scan): string | null {
  const expanded = expandKnown(operand, scan.cwd)
  if (expanded === null || expanded === '' || expanded === '-') return null
  const prefix = literalPrefix(expanded)
  if (prefix === null) return null
  const { target, folder } = prefix
  const rooted = isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('\\\\')
  if (!rooted && scan.cwd === null) return null
  if (target.startsWith('/dev/')) return PSEUDO_DEVICES.has(target) || target.startsWith('/dev/fd/') ? null : expanded
  const absolute = rooted ? target : resolve(scan.cwd as string, target)
  const probe = folder ? resolve(absolute, 'x') : absolute
  if (isOwnGround(probe, scan.cwd ?? getStartingCwd()) || grantedByRule(probe, scan.rules)) return null
  return tildePath(absolute)
}

function grantedByRule(path: string, rules: ToolPermissionContext | undefined): boolean {
  if (rules === undefined) return false
  try {
    return matchingRuleForInput(path, rules, 'edit', 'allow') !== null
  } catch {
    return false
  }
}

function tildePath(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`) ? `~${path.slice(home.length)}` : path
}

function operandsOf(args: readonly string[], valued: ReadonlySet<string> = new Set()): string[] {
  const operands: string[] = []
  let ended = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (ended || !arg.startsWith('-') || arg === '-') {
      operands.push(arg)
      continue
    }
    if (arg === '--') {
      ended = true
      continue
    }
    if (valued.has(arg)) i++
  }
  return operands
}

function peel(argv: readonly string[]): { name: string; args: string[]; fromStdin: boolean } | null {
  let words = [...argv]
  let fromStdin = false
  for (let guard = 0; guard < 8 && words.length > 0; guard++) {
    const head = basename(words[0]!).replace(/\.exe$/i, '')
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) {
      words = words.slice(1)
      continue
    }
    if (SKIP_KEYWORDS.has(head) && head !== 'time') {
      words = words.slice(1)
      continue
    }
    if (head === 'env') {
      let i = 1
      while (i < words.length && (words[i]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!))) {
        if (words[i] === '-u' || words[i] === '-C' || words[i] === '-S' || words[i] === '--unset' || words[i] === '--chdir') i++
        i++
      }
      words = words.slice(i)
      continue
    }
    if (head === 'nice' || head === 'ionice') {
      let i = 1
      while (i < words.length && words[i]!.startsWith('-')) {
        if (/^-[nc]$/.test(words[i]!)) i++
        i++
      }
      words = words.slice(i)
      continue
    }
    if (head === 'timeout') {
      let i = 1
      while (i < words.length && words[i]!.startsWith('-')) {
        if (/^(?:-k|-s|--kill-after|--signal)$/.test(words[i]!)) i++
        i++
      }
      words = words.slice(i + 1)
      continue
    }
    if (head === 'time' || head === 'nohup' || head === 'caffeinate' || head === 'chronic' || head === 'unbuffer') {
      let i = 1
      while (i < words.length && words[i]!.startsWith('-')) i++
      words = words.slice(i)
      continue
    }
    if (head === 'stdbuf') {
      let i = 1
      while (i < words.length && words[i]!.startsWith('-')) {
        if (/^-[ioe]$/.test(words[i]!)) i++
        i++
      }
      words = words.slice(i)
      continue
    }
    if (head === 'xargs') {
      let i = 1
      while (i < words.length && words[i]!.startsWith('-')) {
        if (/^-[aEdILnPs]$/.test(words[i]!) || /^--(?:arg-file|delimiter|eof|replace|max-lines|max-args|max-procs|max-chars)$/.test(words[i]!)) i++
        i++
      }
      words = words.slice(i)
      fromStdin = true
      continue
    }
    if (/^python[\d.]*$/.test(head) && words[1] === '-m' && words[2] !== undefined) {
      words = words.slice(2)
      continue
    }
    if (RUNNERS.has(head) || ((head === 'pnpm' || head === 'yarn' || head === 'npm' || head === 'bun') && (words[1] === 'dlx' || words[1] === 'exec' || words[1] === 'x')) || (head === 'pipx' && words[1] === 'run')) {
      let i = RUNNERS.has(head) ? 1 : 2
      while (i < words.length && words[i]!.startsWith('-')) {
        if (/^(?:-p|--package|-c|--call)$/.test(words[i]!)) i++
        i++
      }
      const spec = words[i]
      if (spec === undefined) return null
      const tail = spec.startsWith('@') ? spec.split('/').pop() ?? spec : spec
      words = [tail.replace(/@[^@]*$/, ''), ...words.slice(i + 1)]
      continue
    }
    break
  }
  if (words.length === 0) return null
  return { name: basename(words[0]!).replace(/\.exe$/i, ''), args: words.slice(1), fromStdin }
}

function subcommandOf(args: readonly string[], valued: RegExp): { sub: string; rest: string[] } | null {
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) {
    if (valued.test(args[i]!)) i++
    i++
  }
  const sub = args[i]
  return sub === undefined ? null : { sub, rest: args.slice(i + 1) }
}

function gitAsk(args: readonly string[]): FlowAsk | null {
  const parsed = subcommandOf(args, /^(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env|--exec-path|--super-prefix)$/)
  if (parsed === null) return null
  const hit = GIT_FORMS.find(entry => entry.test(parsed.sub, parsed.rest))
  return hit === null || hit === undefined ? null : { item: 2, subject: `git ${hit.form}`, why: hit.why }
}

function forgeAsk(name: string, args: readonly string[]): FlowAsk | null {
  const hit = FORGE_FORMS.find(entry => entry.commands.includes(name) && formMatches(entry.form, args))
  return hit === undefined ? null : { item: 2, subject: `${name} ${hit.form}`, why: hit.why }
}

function publishAsk(name: string, args: readonly string[]): FlowAsk | null {
  if (args.some(arg => arg === '--help' || arg === '-h' || arg === '--dry-run')) return null
  for (const entry of PUBLISH_TABLE) {
    if (!entry.commands.includes(name)) continue
    const matched = entry.when === undefined ? anyForm(entry.forms)(args) : entry.when(args)
    if (!matched) continue
    const form = entry.forms.find(candidate => formMatches(candidate, args))
    const subject = form === undefined ? cut([name, ...args.filter(arg => !arg.startsWith('-')).slice(0, 3)].join(' '), 48) : `${name} ${form}`
    return { item: 3, subject, why: entry.why }
  }
  return null
}

function outsideAsk(verb: string, operands: readonly string[], scan: Scan, shown: readonly string[]): FlowAsk | null {
  for (const operand of operands) {
    const outside = outsidePath(operand, scan)
    if (outside !== null) return { item: 4, subject: cut(shown.join(' '), 60), why: `${verb} ${outside}, outside the project` }
  }
  return null
}

function writeTargetsAsk(name: string, args: readonly string[], scan: Scan, shown: readonly string[]): FlowAsk | null {
  if (DELETE_VERBS.has(name)) return outsideAsk('it deletes', operandsOf(args), scan, shown)
  if (MOVE_VERBS.has(name)) return outsideAsk('it moves', operandsOf(args, new Set(['-t', '--target-directory', '-S', '--suffix'])), scan, shown)
  if (COPY_VERBS.has(name)) {
    const targetFlag = args.findIndex(arg => arg === '-t' || arg === '--target-directory')
    const explicit = targetFlag >= 0 ? args[targetFlag + 1] : args.find(arg => arg.startsWith('--target-directory='))?.slice('--target-directory='.length)
    const operands = operandsOf(args, new Set(['-t', '--target-directory', '-S', '--suffix', '-e', '--rsh', '-i', '-P', '-o', '-F', '-J', '-l', '-S']))
    const destination = explicit ?? (operands.length > 1 ? operands[operands.length - 1] : undefined)
    if (destination === undefined || (/^[^/\\]*@?[^/\\:]+:/.test(destination) && !/^[A-Za-z]:[\\/]/.test(destination))) return null
    return outsideAsk('it overwrites', [destination], scan, shown)
  }
  if (INPLACE_EDITORS.has(name)) {
    const inPlace = args.some(arg => arg === '--in-place' || arg.startsWith('--in-place=') || /^-[a-zA-Z]*i/.test(arg))
    if (!inPlace) return null
    const valued = name === 'sed' ? new Set(['-e', '--expression', '-f', '--file', '-l', '--line-length']) : new Set(['-e', '-E', '-M', '-m', '-I', '-x', '-F', '-l', '-0', '-C', '-r', '-W'])
    const operands = operandsOf(args, valued).filter(operand => name === 'sed' || !/^[a-zA-Z_]\w*\s*=/.test(operand))
    const files = name === 'sed' && !args.some(arg => arg === '-e' || arg === '--expression' || arg.startsWith('--expression=') || arg === '-f' || arg === '--file' || arg.startsWith('--file=')) ? operands.slice(1) : operands
    return outsideAsk('it edits', files.filter(file => !/^\s*s[^a-zA-Z0-9]/.test(file) && !/\{|\$/.test(file)), scan, shown)
  }
  if (TEE_VERBS.has(name)) return outsideAsk('it writes', operandsOf(args), scan, shown)
  if (name === 'truncate') return outsideAsk('it truncates', operandsOf(args, new Set(['-s', '--size', '-r', '--reference'])), scan, shown)
  if (name === 'dd') {
    const of = args.find(arg => arg.startsWith('of='))?.slice(3)
    return of === undefined ? null : outsideAsk('it overwrites', [of], scan, shown)
  }
  if (name === 'ln' && args.some(arg => arg === '--force' || /^-[a-zA-Z]*f/.test(arg))) {
    const operands = operandsOf(args, new Set(['-t', '--target-directory', '-S', '--suffix']))
    return operands.length > 1 ? outsideAsk('it replaces', [operands[operands.length - 1]!], scan, shown) : null
  }
  if (name === 'curl') {
    const targets = args.flatMap((arg, index) => (arg === '-o' || arg === '--output' ? [args[index + 1] ?? ''] : arg.startsWith('--output=') ? [arg.slice('--output='.length)] : []))
    return outsideAsk('it writes', targets, scan, shown)
  }
  if (name === 'wget') {
    const targets = args.flatMap((arg, index) => (arg === '-O' || arg === '--output-document' ? [args[index + 1] ?? ''] : arg.startsWith('--output-document=') || arg.startsWith('-O') && arg.length > 2 ? [arg.replace(/^(?:--output-document=|-O)/, '')] : []))
    return outsideAsk('it writes', targets, scan, shown)
  }
  if (name === 'find') {
    const expression = args.findIndex(arg => /^[-!(]/.test(arg))
    const paths = (expression === -1 ? args : args.slice(0, expression)).filter(arg => !arg.startsWith('-'))
    const deletes = args.includes('-delete') || args.some((arg, index) => /^-(?:exec|execdir|ok|okdir)$/.test(arg) && DELETE_VERBS.has(basename(args[index + 1] ?? '')))
    return deletes ? outsideAsk('it deletes under', paths.length === 0 ? ['.'] : paths, scan, shown) : null
  }
  if (/^mkfs(?:\.|$)/.test(name) || name === 'wipefs') return { item: 4, subject: cut(shown.join(' '), 60), why: 'it erases a disk' }
  if (DISK_VERBS.has(name)) {
    const device = args.some(arg => arg.startsWith('/dev/'))
    const reads = args.some(arg => /^(?:-l|--list|list|info|print|p)$/.test(arg))
    const erases = name === 'diskutil' ? args.some(arg => /^(?:erase|partition|reformat|secureErase|zeroDisk|randomDisk|deleteContainer|deleteVolume|resizeContainer)/i.test(arg)) : device && !reads
    return erases ? { item: 4, subject: cut(shown.join(' '), 60), why: 'it erases a disk' } : null
  }
  return null
}

function findExecArgv(args: readonly string[]): string[][] {
  const found: string[][] = []
  for (let i = 0; i < args.length; i++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[i]!)) continue
    const start = ++i
    while (i < args.length && args[i] !== ';' && args[i] !== '+') i++
    const argv = args.slice(start, i)
    if (argv.length > 0) found.push(argv)
  }
  return found
}

function preAuthorised(text: string, rules: ToolPermissionContext | undefined): boolean {
  if (rules === undefined || text.trim() === '') return false
  try {
    return readBashRuleVerdict({ command: text }, rules).behavior === 'allow'
  } catch {
    return false
  }
}

async function checkCommand(argv: readonly string[], scan: Scan, text = argv.join(' ')): Promise<void> {
  if (scan.asks.length > 0 || argv.length === 0) return
  const peeled = peel(argv)
  if (peeled === null) return
  const { name, args, fromStdin } = peeled
  const found = (ask: FlowAsk): void => {
    if (!preAuthorised(text, scan.rules)) scan.asks.push(ask)
  }
  if ((PRIVILEGE_COMMANDS as readonly string[]).includes(name)) {
    found({ item: 1, subject: name, why: 'it runs with elevated rights' })
    return
  }
  if (name === 'osascript' && /administrator privileges/i.test(args.join(' '))) {
    found({ item: 1, subject: 'osascript with administrator privileges', why: 'it runs with elevated rights' })
    return
  }
  if (name === 'Start-Process' && args.some((arg, index) => /^-verb$/i.test(arg) && /^runas$/i.test(args[index + 1] ?? ''))) {
    found({ item: 1, subject: 'Start-Process -Verb RunAs', why: 'it runs with elevated rights' })
    return
  }
  if (name === 'cd' || name === 'pushd') {
    const target = operandsOf(args, new Set())[0]
    if (target === undefined) scan.cwd = name === 'cd' ? homedir() : scan.cwd
    else {
      const expanded = expandKnown(target, scan.cwd)
      scan.cwd = expanded === null || expanded === '-' || /[$`*?[{]/.test(expanded) || scan.cwd === null && !isAbsolute(expanded) ? null : resolve(scan.cwd ?? '/', expanded)
    }
    return
  }
  if (name === 'popd') {
    scan.cwd = null
    return
  }
  if (SHELLS.test(name)) {
    const flag = args.findIndex(arg => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg))
    const script = flag >= 0 ? args.slice(flag + 1).find(arg => !arg.startsWith('-')) : undefined
    if (script !== undefined && scan.depth < 4) await scanScript(script, { ...scan, depth: scan.depth + 1 }, scan)
    return
  }
  if (name === 'eval' || name === 'watch') {
    const script = name === 'watch' ? operandsOf(args, new Set(['-n', '--interval', '-d', '--differences'])).join(' ') : args.join(' ')
    if (script !== '' && scan.depth < 4) await scanScript(script, { ...scan, depth: scan.depth + 1 }, scan)
    return
  }
  if (name === 'git') {
    const ask = gitAsk(args)
    if (ask !== null) found(ask)
    return
  }
  const forge = forgeAsk(name, args)
  if (forge !== null) {
    found(forge)
    return
  }
  const publish = publishAsk(name, args)
  if (publish !== null) {
    found(publish)
    return
  }
  if (name === 'find') {
    for (const inner of findExecArgv(args)) await checkCommand(inner.filter(word => word !== '{}'), scan)
    if (scan.asks.length > 0) return
  }
  if (fromStdin) return
  const outside = writeTargetsAsk(name, args, scan, argv)
  if (outside !== null) found(outside)
}

function checkRedirect(op: string, target: string, scan: Scan, shown: string): void {
  if (scan.asks.length > 0) return
  if (!/^(?:>|>>|>\||&>|&>>)$/.test(op)) return
  if (/^\d+$/.test(target) || target.startsWith('&') || target === '-') return
  const outside = outsidePath(target, scan)
  if (outside !== null) scan.asks.push({ item: 4, subject: cut(shown, 60), why: `it writes ${outside}, outside the project` })
}

function wordText(node: Node): string {
  switch (node.type) {
    case 'raw_string':
      return node.text.slice(1, -1)
    case 'ansi_c_string':
      return node.text.slice(2, -1)
    case 'string':
    case 'translated_string':
      return node.children.filter(child => child.type !== '"').map(child => (child.type === 'string_content' ? child.text : wordText(child))).join('')
    case 'concatenation':
      return node.children.map(wordText).join('')
    case 'command_name':
      return node.children[0] === undefined ? node.text : wordText(node.children[0])
    default:
      return node.text
  }
}

function argvOf(command: Node): string[] {
  const words: string[] = []
  for (const child of command.children) {
    if (child.type === 'variable_assignment' || child.type === 'file_redirect' || child.type === 'heredoc_redirect' || child.type === 'herestring_redirect') continue
    if (child.type === 'command_name' && words.length === 0) {
      words.push(wordText(child))
      continue
    }
    if (child.type === 'command_name' || child.type === 'word' || child.type === 'number' || child.type === 'string' || child.type === 'raw_string' || child.type === 'ansi_c_string' || child.type === 'concatenation' || child.type === 'simple_expansion' || child.type === 'expansion' || child.type === 'command_substitution' || child.type === 'arithmetic_expansion' || child.type === 'brace_expression' || child.type === 'process_substitution' || child.type === 'translated_string') {
      words.push(wordText(child))
    }
  }
  return words
}

function redirectOf(node: Node): { op: string; target: string } | null {
  let op: string | null = null
  let target: string | null = null
  for (const child of node.children) {
    if (/^(?:>|>>|>\||&>|&>>|>&|<|<&|<<|<<<)$/.test(child.type)) op = child.type
    else if (child.type !== 'file_descriptor') target = wordText(child)
  }
  return op === null || target === null ? null : { op, target }
}

function lastCommandText(node: Node): string | null {
  let found: string | null = null
  const visit = (current: Node): void => {
    if (current.type === 'command') found = current.text
    for (const child of current.children) visit(child)
  }
  visit(node)
  return found
}

async function walk(node: Node, scan: Scan, statement: string): Promise<void> {
  if (scan.asks.length > 0) return
  switch (node.type) {
    case 'subshell':
    case 'command_substitution':
    case 'process_substitution': {
      const inner: Scan = { ...scan }
      for (const child of node.children) await walk(child, inner, statement)
      scan.asks.push(...inner.asks)
      return
    }
    case 'redirected_statement': {
      const body = node.children.find(child => !/redirect$/.test(child.type))
      const last = body === undefined ? null : lastCommandText(body)
      const shown = last === null ? node.text : `${last} ${node.children.filter(child => /redirect$/.test(child.type)).map(child => child.text).join(' ')}`
      for (const child of node.children) await walk(child, scan, shown)
      return
    }
    case 'file_redirect': {
      const redirect = redirectOf(node)
      if (redirect !== null) checkRedirect(redirect.op, redirect.target, scan, statement)
      return
    }
    case 'command': {
      await checkCommand(argvOf(node), scan, node.text)
      for (const child of node.children) await walk(child, scan, node.text)
      return
    }
    default:
      for (const child of node.children) await walk(child, scan, statement)
  }
}

async function scanTokens(text: string, scan: Scan): Promise<void> {
  for (const segment of shellCommandSegments(text)) {
    if (scan.asks.length > 0) return
    const words: string[] = []
    const redirects: Array<{ op: string; target: string }> = []
    for (let i = 0; i < segment.words.length; i++) {
      const word = segment.words[i]!
      const redirect = /^(\d*>>?|&>>?|>\|)(.*)$/.exec(word)
      if (redirect !== null) {
        const target = redirect[2] !== '' ? redirect[2]! : segment.words[++i] ?? ''
        redirects.push({ op: redirect[1]!.replace(/^\d+/, ''), target })
        continue
      }
      words.push(word)
    }
    const shown = segment.words.join(' ')
    if (words.length > 0 && !['for', 'case', 'select', 'function', 'done', 'esac', 'fi'].includes(words[0]!)) await checkCommand(words, scan)
    for (const redirect of redirects) checkRedirect(redirect.op, redirect.target, scan, shown)
  }
}

async function scanScript(text: string, scan: Scan, parent?: Scan): Promise<void> {
  let root: Node | null | typeof PARSE_ABORTED = preparedCommandRoot(text)
  if (root === null && text.length <= 10_000) {
    try {
      root = await pinnedCommandAnalysis.parseCommandRaw(text)
    } catch {
      root = null
    }
  }
  if (root === null || root === PARSE_ABORTED || root.type === 'ERROR') await scanTokens(text, scan)
  else await walk(root, scan, text)
  if (parent !== undefined) {
    parent.asks.push(...scan.asks)
    parent.cwd = scan.cwd
  }
}

export async function flowShellAsk(command: string, cwd: string, shell: 'bash' | 'powershell' = 'bash', rules?: ToolPermissionContext): Promise<FlowAsk | null> {
  const scan: Scan = { cwd, asks: [], depth: 0, ...(rules === undefined ? {} : { rules }) }
  if (shell === 'powershell') await scanTokens(command, scan)
  else await scanScript(command, scan)
  return scan.asks[0] ?? null
}

function flowPathAsk(path: string, rules?: ToolPermissionContext, verb = 'writing'): FlowAsk | null {
  if (isOwnGround(path) || grantedByRule(path, rules)) return null
  return { item: 4, subject: `${verb} ${tildePath(path)}`, why: 'it is outside the project' }
}

const SERVICE_TOOL_NAME = 'Service'

function startedCommandOf(tool: Pick<Tool, 'name' | 'shellCommandOf'>, input: Record<string, unknown>): string | undefined {
  if (tool.name === DEBUG_TOOL_NAME) return input.op === 'launch' ? startedCommandText(input.program, input.args) : undefined
  if (tool.name === SERVICE_TOOL_NAME && input.op === 'input') return typeof input.text === 'string' && input.text.trim() !== '' ? input.text : undefined
  return tool.shellCommandOf?.(input)
}

export async function flowAskFor(tool: Pick<Tool, 'name' | 'shellCommandOf'> & { getPath?: (input: never) => string | undefined; isReadOnly?: (input: never) => boolean }, input: Record<string, unknown>, rules?: ToolPermissionContext): Promise<FlowAsk | null> {
  if ((tool.name === BASH_TOOL_NAME || tool.name === POWERSHELL_TOOL_NAME || tool.name === MONITOR_TOOL_NAME) && typeof input.command === 'string') {
    const cwd = resolveShellCwd(typeof input.cwd === 'string' ? input.cwd : undefined)
    return flowShellAsk(input.command, cwd, tool.name === POWERSHELL_TOOL_NAME ? 'powershell' : 'bash', rules)
  }
  const started = startedCommandOf(tool, input)
  if (started !== undefined) return flowShellAsk(started, resolveShellCwd(typeof input.cwd === 'string' ? input.cwd : undefined), 'bash', rules)
  if (typeof tool.getPath !== 'function') return null
  try {
    if (tool.isReadOnly?.(input as never) === true) return null
    const path = tool.getPath(input as never)
    return typeof path === 'string' && path !== '' ? flowPathAsk(path, rules) : null
  } catch {
    return null
  }
}
