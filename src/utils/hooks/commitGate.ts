import type { SetAppState } from '../messageQueueManager.js'
import { getSessionId } from '../../bootstrap/state.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import {
  isVerifySegment,
  pipefailActiveBefore,
  splitShellControlOps,
  stripQuotedShellArgs,
  verificationSummary,
} from '../verification/verificationState.js'
import { addFunctionHook, removeFunctionHook } from './sessionHooks.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { subprocessEnv } from '../subprocessEnv.js'
import {
  GENERATED_ASSETS_MAP,
  commandWords,
  checkChained,
  describeOwedAssets,
  generatedAssetsOwed,
  parseGeneratedAssetsMap,
  type GeneratedAssetRow,
} from './generatedAssets.js'


export const COMMIT_GATE_ID = 'commit-gate'


function isGitCommit(segment: string): boolean {
  return /\bgit(?:\s+(?:(?:-C|-c|--git-dir|--work-tree)\s+(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S+)|--(?:git-dir|work-tree)=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S+)))*\s+commit\b(?!-)/i.test(
    segment,
  )
}

function receiptEligibleCommand(segments: readonly { text: string }[]): boolean {
  return segments.every(s => {
    const head = s.text.trim().split(/\s+/)[0]?.replace(/^.*[\\/]/, '').toLowerCase()
    return head === 'git' || isVerifySegment(s.text)
  })
}

export interface CommitGateVerdict {
  allow: boolean
  rule:
    | 'not-a-commit'
    | 'chained-verify'
    | 'fresh-receipt'
    | 'bare-commit'
    | 'no-verify-flag'
  reason: string
}

export function evaluateCommitGate(
  command: string,
  opts?: {
    freshReceipt?: boolean
  },
): CommitGateVerdict {
  const cmd = typeof command === 'string' ? command : ''
  const segments = splitShellControlOps(cmd)
  const commitIdx = segments.findIndex(s => isGitCommit(s.text))
  if (commitIdx === -1) {
    return {
      allow: true,
      rule: 'not-a-commit',
      reason: 'no git commit in command',
    }
  }

  const commitSeg = segments[commitIdx]!
  if (hasNoVerifyFlag(commitSeg.text)) {
    return {
      allow: false,
      rule: 'no-verify-flag',
      reason:
        'git commit --no-verify skips the pre-commit safety hooks — denied. Run the verify, then commit without --no-verify.',
    }
  }

  if (commitSeg.opBefore === '&&') {
    for (let i = commitIdx - 1; i >= 0; i--) {
      if (isVerifySegment(segments[i]!.text)) {
        return {
          allow: true,
          rule: 'chained-verify',
          reason: 'commit is chained behind a verify (&&) — green-gate enforced',
        }
      }
      const op = segments[i]!.opBefore
      if (op === '&&') continue
      if (op === 'pipe' && pipefailActiveBefore(segments, i)) continue
      break
    }
  }

  if (opts?.freshReceipt) {
    return {
      allow: true,
      rule: 'fresh-receipt',
      reason:
        'fresh current-tree receipt: green verification evidence covers this exact tree with no mutations since — no same-command rerun required',
    }
  }

  return {
    allow: false,
    rule: 'bare-commit',
    reason:
      'unverified `git commit` — chain a verify with `&&` DIRECTLY before the commit (`&&` short-circuits on a failing verify; `;` `||` `&` run the commit regardless). To keep long verify output readable, prefix `set -o pipefail && verify | tail -40 && git commit …` — the pipeline then retains the verifier\'s exit status. A commit right after a green verify of the SAME tree passes without re-running (fresh receipt).',
  }
}

function hasNoVerifyFlag(segment: string): boolean {
  const bare = stripQuotedShellArgs(segment)
  if (/--no-verify\b/.test(bare)) return true
  return /(?:^|\s)-[A-Za-z]*n[A-Za-z]*(?=\s|$)/.test(bare)
}

export const COMMIT_GATE_REPROMPT =
  'Commit gate: this commit is not verified. Three ways to satisfy it: ' +
  '(1) FRESH RECEIPT — a green verification of this EXACT tree with no edits since ' +
  'passes automatically (no rerun needed; if you just ran the suite green, commit plainly). ' +
  '(2) Chain your green-gate before the commit in the SAME command, e.g. ' +
  '`bun run build.ts && git commit -m "…"` — `&&` short-circuits, so a failing verify ' +
  'blocks the commit. `;` and `||` break that guarantee. ' +
  '(3) For long verify output, `set -o pipefail && verify 2>&1 | tail -40 && git commit -m "…"` ' +
  '— pipefail preserves the verifier\'s exit status, so the tail stays readable AND gated. ' +
  'A blocked chain never ran, so re-issue the WHOLE command including its `git add`. ' +
  'Do not use --no-verify. If this repo\'s verify runner is a custom script the gate ' +
  'doesn\'t recognize, set MERCURY_VERIFY_PATTERN to a regex that matches it.'

function generatedAssetsVerdict(command: string): true | string {
  try {
    const refusal = generatedAssetsRefusal(command, getCwd())
    return refusal === null ? true : refusal
  } catch (error) {
    return `Commit gate: generated-asset verification refused: ${error instanceof Error ? error.message : String(error)}`
  }
}

function commandFromContext(hookInput: unknown): string | null {
  if (
    hookInput == null ||
    typeof hookInput !== 'object' ||
    (hookInput as { hook_event_name?: string }).hook_event_name !== 'PreToolUse'
  ) {
    return null
  }
  const hi = hookInput as {
    tool_name?: string
    tool_input?: { command?: unknown }
  }
  if (hi.tool_name !== 'Bash' && hi.tool_name !== POWERSHELL_TOOL_NAME) return null
  const cmd = hi.tool_input?.command
  return typeof cmd === 'string' ? cmd : null
}

export function registerCommitGate(
  setAppState: SetAppState,
  sessionId: string,
): string {
  return addFunctionHook(
    setAppState,
    sessionId,
    'PreToolUse',
    `Bash|${POWERSHELL_TOOL_NAME}`,
    (_messages, _signal, context) => {
      if (flagEnv('MERCURY_COMMIT_GATE') === '0') return true
      if (!commitGateEnabled()) return true
      try {
        const command = commandFromContext(context?.hookInput)
        if (command === null) return true
        const shape = evaluateCommitGate(command)
        if (shape.allow) return generatedAssetsVerdict(command)
        if (shape.rule === 'no-verify-flag') return false
        let fresh = false
        try {
          if (receiptEligibleCommand(splitShellControlOps(command))) {
            const summary = verificationSummary(getCwd(), {})
            fresh =
              summary.state === 'verified' &&
              summary.lastEvidence !== null &&
              summary.lastEvidence.scope !== 'read-back'
          }
        } catch {
          fresh = false
        }
        if (!evaluateCommitGate(command, { freshReceipt: fresh }).allow) return false
        return generatedAssetsVerdict(command)
      } catch {
        return false
      }
    },
    COMMIT_GATE_REPROMPT,
    { timeout: 5000, id: COMMIT_GATE_ID },
  )
}


function assetCommandSegments(command: string): ReturnType<typeof splitShellControlOps> {
  const segments: ReturnType<typeof splitShellControlOps> = []
  const tokens = /\\[\s\S]|"(?:[^"\\]|\\[\s\S])*"|'[^']*'|\d*>&\d+|&>>?|&&|\|\||[;\n&|]/g
  let start = 0
  let opBefore: ReturnType<typeof splitShellControlOps>[number]['opBefore'] = 'start'
  for (const match of command.matchAll(tokens)) {
    const token = match[0]
    if (!['&&', '||', ';', '\n', '&', '|'].includes(token)) continue
    const text = command.slice(start, match.index).trim()
    if (text) segments.push({ text, opBefore })
    opBefore = token === '&&' ? '&&' : token === '|' ? 'pipe' : token === '||' ? 'or' : 'break'
    start = match.index! + token.length
  }
  const text = command.slice(start).trim()
  if (text) segments.push({ text, opBefore })
  return segments
}

export function chainedSegmentsBeforeCommit(command: string): string[] {
  const segments = assetCommandSegments(command)
  const commitIdx = segments.findIndex(s => isGitCommit(s.text))
  if (commitIdx <= 0 || segments[commitIdx]!.opBefore !== '&&') return []
  const out: string[] = []
  for (let i = commitIdx - 1; i >= 0; i--) {
    out.push(segments[i]!.text.trim())
    const op = segments[i]!.opBefore
    if (op === '&&') continue
    if (op === 'pipe' && pipefailActiveBefore(segments, i)) continue
    break
  }
  return out
}

export function commitRepositoryRoot(commitSegment: string, cwd: string): string | null {
  const prefix = commitRepositoryArguments(commitSegment)
  try { return gitLines(cwd, [...prefix, 'rev-parse', '--show-toplevel'])[0] ?? null } catch { return null }
}

function commitRepositoryArguments(commitSegment: string): string[] {
  const header: string[] = []
  let optionValue = false
  for (const match of commitSegment.matchAll(/(?:[^\s'"\\]+|\\[\s\S]|"(?:[^"\\]|\\[\s\S])*"|'[^']*')+/g)) {
    if (match[0] === 'commit' && !optionValue) break
    if (header.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(match[0])) continue
    header.push(match[0])
    optionValue = !optionValue && ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(match[0])
  }
  const words = header.length === 1 && /^\$/.test(header[0]!) ? ['git'] : commandWords(header.join(' '))
  if (!words || !/(?:^|[\\/])git(?:\.exe)?$/.test(words[0] ?? '')) throw new Error('Cannot locate the generated-asset map through a variable or substitution in the Git executable or repository options. Select the directory separately and use literal Git repository options.')
  return words.slice(1)
}

function gitLines(root: string, args: string[]): string[] {
  const paths = args.includes('--name-only') || args.includes('ls-files')
  const split = args.indexOf('--')
  const at = split < 0 ? args.length : split
  const argv = paths ? [...args.slice(0, at), '-z', ...args.slice(at)] : args
  const output = execFileSync('git', argv, { cwd: root, env: subprocessEnv(), encoding: 'utf8', stdio: 'pipe', timeout: 3000, windowsHide: true })
  return paths ? output.split(String.fromCharCode(0)).filter(Boolean) : output.split('\n').map(line => line.trim()).filter(Boolean)
}

function commitArguments(segment: string): { prefix: string[]; args: string[] } {
  const words = commandWords(segment)
  if (!words || !/(?:^|[\\/])git(?:\.exe)?$/.test(words[0] ?? '')) throw new Error('A shell variable, substitution or nonliteral commit invocation prevents checking the generated-asset candidate. Resolve it separately, then use a direct git commit with literal arguments.')
  let at = 1
  while (words[at] !== 'commit') {
    const word = words[at++]
    if (word === undefined) throw new Error('No git commit invocation was found')
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(word)) at++
    else if (!/^--(?:git-dir|work-tree|namespace)=/.test(word)) throw new Error(`Unsupported git prefix ${word}; apply it before committing`)
  }
  return { prefix: words.slice(1, at), args: words.slice(at + 1) }
}

function commitSelection(segment: string): { all: boolean; include: boolean; paths: string[] } {
  const { args } = commitArguments(segment)
  let all = false, include = false, operands = false
  const paths: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') { operands = true; continue }
    if (operands || !arg.startsWith('-')) { paths.push(arg); continue }
    if (arg === '--all') all = true
    if (arg === '--include') include = true
    if (arg.startsWith('--pathspec-from-file')) throw new Error('Stage pathspec-file selections separately before committing')
    if (/^--(?:message|file|reuse-message|reedit-message|template|author|date|cleanup)$/.test(arg)) i++
    else if (!arg.startsWith('--')) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j]!
        if (flag === 'a') all = true
        if (flag === 'i') include = true
        if ('mFCct'.includes(flag)) { if (j === arg.length - 1) i++; break }
        if ('SuU'.includes(flag)) break
      }
    }
  }
  return { all, include, paths }
}

export function commitPathsOf(root: string, commitSegment: string, cwd = root): string[] {
  const { prefix } = commitArguments(commitSegment)
  const selection = commitSelection(commitSegment)
  const git = (args: string[]): string[] => gitLines(cwd, [...prefix, ...args])
  if (selection.paths.length > 0) {
    const selected = [...git(['diff', '--cached', '--name-only', '--', ...selection.paths]), ...git(['diff', '--name-only', '--', ...selection.paths])]
    return [...new Set(selection.include ? [...git(['diff', '--cached', '--name-only']), ...selected] : selected)].sort()
  }
  const paths = new Set(git(['diff', '--cached', '--name-only']))
  if (selection.all) for (const p of git(['diff', '--name-only'])) paths.add(p)
  return [...paths].sort()
}

export function loadGeneratedAssetsMap(root: string): { rows: GeneratedAssetRow[]; errors: string[] } | null {
  const path = join(root, GENERATED_ASSETS_MAP)
  if (!existsSync(path)) return null
  return parseGeneratedAssetsMap(readFileSync(path, 'utf8'))
}

export function generatedAssetsRefusal(command: string, cwd: string): string | null {
  const segments = assetCommandSegments(command)
  const commitIndex = segments.findIndex(s => isGitCommit(s.text))
  if (commitIndex < 0) return null
  const commitSeg = segments[commitIndex]!
  let directory = cwd
  let directoryRefusal: string | null = null
  const candidateChanges: string[] = []
  const checkDirectories = new Map<string, string>()
  for (let index = 0; index < commitIndex; index++) {
    const segment = segments[index]!
    const words = commandWords(segment.text)
    if (words?.[0] === 'cd') {
      if (words.length !== 2 || segments[index + 1]?.opBefore !== '&&' || !['start', '&&'].includes(segment.opBefore)) directoryRefusal = 'Generated-asset checks require an unambiguous directory. Run directory changes separately or chain literal cd commands with && before committing.'
      if (words.length === 2) directory = resolve(directory, words[1]!)
      continue
    }
    checkDirectories.set(segment.text.trim(), directory)
    const head = basename(words?.[0] ?? '').replace(/\.exe$/i, '')
    let gitVerb = 1
    if (head === 'git' && words) {
      while (words[gitVerb]?.startsWith('-')) {
        if (['-C', '-c', '--git-dir', '--work-tree'].includes(words[gitVerb]!)) gitVerb += 2
        else if (/^--(?:git-dir|work-tree)=/.test(words[gitVerb]!)) gitVerb++
        else break
      }
    }
    const readOnlyGit = head === 'git' && /^(?:status|diff|log|show|rev-parse|ls-files)$/.test(words?.[gitVerb] ?? '')
    const inert = ['echo', 'printf', 'true', 'false', 'pwd', ':', 'test', '[', 'ls', 'cat', 'head', 'tail', 'grep', 'rg'].includes(head)
    const shellOptions = head === 'set' && words?.every((word, at) => at === 0 || /^-[a-z]+$/.test(word) || word === 'pipefail')
    if (!words || !(isVerifySegment(segment.text) || readOnlyGit || inert || shellOptions)) candidateChanges.push(segment.text)
  }
  const root = commitRepositoryRoot(commitSeg.text, directory)
  if (root === null) return null
  const repositoryArgs = commitRepositoryArguments(commitSeg.text)
  const readGitMap = (revision: string): string => execFileSync('git', [...repositoryArgs, 'show', `${revision}:${GENERATED_ASSETS_MAP}`], { cwd: directory, env: subprocessEnv(), encoding: 'utf8', stdio: 'pipe', timeout: 3000 })
  const indexedMap = gitLines(directory, [...repositoryArgs, 'ls-files', '--full-name', '--', GENERATED_ASSETS_MAP]).includes(GENERATED_ASSETS_MAP) ? readGitMap('') : null
  let previousMap: string | null = null
  try { previousMap = readGitMap('HEAD') } catch {  }
  const workingMap = existsSync(join(root, GENERATED_ASSETS_MAP)) ? readFileSync(join(root, GENERATED_ASSETS_MAP), 'utf8') : null
  if (workingMap === null && indexedMap === null && previousMap === null) return null
  if (workingMap !== null) {
    const parsed = parseGeneratedAssetsMap(workingMap)
    if (parsed.errors.length > 0) return `The generated-asset map (${GENERATED_ASSETS_MAP}) does not parse: ${parsed.errors.join('; ')} — fix the map before committing.`
  }
  if (indexedMap !== null && workingMap !== indexedMap) return `Generated-asset map differs from the index (${GENERATED_ASSETS_MAP}). Stage or undo its changes separately before committing.`
  const mapSelection = commitSelection(commitSeg.text)
  const limited = mapSelection.paths.length > 0 && !mapSelection.include
  const mapSelected = limited && commitPathsOf(root, commitSeg.text, directory).includes(GENERATED_ASSETS_MAP)
  const candidateMap = limited && !mapSelected ? previousMap : indexedMap ?? workingMap
  if (candidateMap === null) return null
  const map = parseGeneratedAssetsMap(candidateMap)
  if (map.errors.length > 0) return `The generated-asset map (${GENERATED_ASSETS_MAP}) does not parse: ${map.errors.join('; ')} — fix the map before committing.`
  if (map.rows.length === 0) return null
  if (directoryRefusal !== null) return directoryRefusal
  if (candidateChanges.some(segment => !map.rows.some(row => row.check !== null && checkChained(row.check, [segment]))) || segments.slice(commitIndex + 1).some(s => isGitCommit(s.text))) return 'Generated-asset checks require a stable commit candidate. Run staging or file-changing commands separately, then check and commit the resulting index.'
  const commitPaths = commitPathsOf(root, commitSeg.text, directory)
  if (commitPaths.length === 0) return null
  const { prefix } = commitArguments(commitSeg.text)
  const selection = commitSelection(commitSeg.text)
  const workingPaths = new Set(selection.all || selection.paths.length > 0
    ? gitLines(directory, [...prefix, 'ls-files', '--full-name', ...(selection.all ? [] : ['--', ...selection.paths])])
    : [])
  const staged = new Map<string, string | null>()
  const contentOf = (path: string): string | null => {
    if (staged.has(path)) return staged.get(path)!
    let text: string | null
    try {
      text = workingPaths.has(path)
        ? readFileSync(join(root, path), 'utf8')
        : execFileSync('git', [...prefix, 'show', `:${path}`], { cwd: directory, env: subprocessEnv(), encoding: 'utf8', stdio: 'pipe', timeout: 3000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    } catch {
      try {
        text = readFileSync(join(root, path), 'utf8')
      } catch {
        text = null
      }
    }
    if (text !== null && text.includes('\0')) text = null
    staged.set(path, text)
    return text
  }
  const readFile = (path: string): string | null => {
    try {
      return readFileSync(join(root, path), 'utf8')
    } catch {
      return null
    }
  }
  const previousContentOf = (path: string): string | null => {
    try { return execFileSync('git', [...prefix, 'show', `HEAD:${path}`], { cwd: directory, env: subprocessEnv(), encoding: 'utf8', stdio: 'pipe', timeout: 3000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }) } catch { return null }
  }
  const chainedVerifies = chainedSegmentsBeforeCommit(command).filter(segment => realpathSync(checkDirectories.get(segment) ?? directory) === realpathSync(root))
  const owed = generatedAssetsOwed({ rows: map.rows, commitPaths, contentOf, previousContentOf, readFile, chainedVerifies })
  return owed.length === 0 ? null : describeOwedAssets(owed)
}

export function unregisterCommitGate(
  setAppState: SetAppState,
  sessionId: string,
): void {
  removeFunctionHook(setAppState, sessionId, 'PreToolUse', COMMIT_GATE_ID)
}


export function commitGateEnabled(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_COMMIT_GATE'))
}

const commitGateEngagedSessions = new Set<string>()

export function isCommitGateEngaged(
  sessionId: string = getSessionId(),
): boolean {
  return commitGateEngagedSessions.has(sessionId)
}

export function engageCommitGate(
  setAppState: SetAppState,
  sessionId: string = getSessionId(),
): boolean {
  if (!commitGateEnabled()) return false
  if (commitGateEngagedSessions.has(sessionId)) return false
  registerCommitGate(setAppState, sessionId)
  commitGateEngagedSessions.add(sessionId)
  logForDebugging(
    `[commit-gate] engaged for session ${sessionId}`,
  )
  return true
}

export function disengageCommitGate(
  setAppState: SetAppState,
  sessionId: string = getSessionId(),
): boolean {
  if (!commitGateEngagedSessions.has(sessionId)) return false
  unregisterCommitGate(setAppState, sessionId)
  commitGateEngagedSessions.delete(sessionId)
  logForDebugging(
    `[commit-gate] disengaged for session ${sessionId}`,
  )
  return true
}
