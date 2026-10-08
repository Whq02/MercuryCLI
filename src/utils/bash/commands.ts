import { createCommandPrefixExtractor, createSubcommandPrefixExtractor } from '../shell/prefix.js'
import type { CommandPrefixResult, CommandSubcommandPrefixResult } from '../shell/prefix.js'
import { preparedSecurityParse } from './ast.js'
import { preparedCommandRoot, type Node } from './parser.js'

export type { CommandPrefixResult, CommandSubcommandPrefixResult } from '../shell/prefix.js'

const SEPARATORS = new Set(['&&', '||', ';', '&', '|', '|&', '\n'])
const CONTAINERS = new Set(['program', 'list', 'pipeline'])

export function splitCommandWithOperators(command: string): string[] {
  if (command.trim() === '') return []
  const root = preparedCommandRoot(command)
  if (!root || root.type === 'ERROR') return [command]
  const result: string[] = []
  const visit = (node: Node): void => {
    if (CONTAINERS.has(node.type)) {
      for (const child of node.children) visit(child)
    } else if (SEPARATORS.has(node.type)) result.push(node.type)
    else if (node.type !== 'comment') result.push(node.text)
  }
  visit(root)
  return result
}

export function splitCommand(command: string): string[] {
  const parsed = preparedSecurityParse(command)
  return parsed.kind === 'simple' ? parsed.commands.map(simple => simple.text) : command.trim() === '' ? [] : [command]
}

export function splitListSegments(command: string): string[] {
  return splitCommandWithOperators(command).filter(part => !SEPARATORS.has(part))
}

export function pipeSpans(root: Node): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  const visit = (node: Node): void => {
    if (!CONTAINERS.has(node.type) && node.type !== 'redirected_statement' && node.type !== 'negated_command') return
    for (const child of node.children) {
      if (child.type === '|' || child.type === '|&') spans.push({ start: child.startIndex, end: child.endIndex })
      else visit(child)
    }
  }
  visit(root)
  return spans.sort((a, b) => a.start - b.start)
}

export function splitPipeSegments(command: string): string[] {
  const root = preparedCommandRoot(command)
  if (!root) return [command]
  const spans = pipeSpans(root)
  if (spans.length === 0) return [command]
  const text = root.text
  const segments: string[] = []
  let start = 0
  for (const span of spans) {
    segments.push(text.slice(start, span.start - root.startIndex))
    start = span.end - root.startIndex
  }
  segments.push(text.slice(start))
  return segments.map(part => part.trim()).filter(Boolean)
}

export type InputRedirectionResult = { commandWithoutRedirections: string; targets: string[] }
export type OutputRedirectionCapture = { target: string; operator: '>' | '>>' }
export type OutputRedirectionResult = {
  commandWithoutRedirections: string
  redirections: OutputRedirectionCapture[]
  hasDangerousRedirection: boolean
}

const WRITES = new Set(['>', '>>', '>|', '&>', '&>>', '>&'])

function withoutRedirects(command: string, input: boolean): string {
  const root = preparedCommandRoot(command)
  if (!root) return command
  const spans: Node[] = []
  const visit = (node: Node): void => {
    if (node.type === 'file_redirect') {
      const operator = node.children.find(child => child.type === '<' || WRITES.has(child.type))
      const descriptor = node.children.find(child => child.type === 'file_descriptor')
      const target = node.children.find(child => ['word', 'number', 'raw_string', 'string', 'concatenation'].includes(child.type))
      if (operator && target && (input ? operator.type === '<' : WRITES.has(operator.type))) {
        const duplicate = operator.type === '>&' && /^[0-9]+$/.test(target.text)
        if (!duplicate && (input || descriptor === undefined || descriptor.text === '1')) spans.push(node)
      }
      return
    }
    if (node.type === 'command_substitution' || node.type === 'process_substitution' || node.type === 'heredoc_body') return
    for (const child of node.children) visit(child)
  }
  visit(root)
  let text = root.text
  for (const span of spans.sort((a, b) => b.startIndex - a.startIndex)) {
    text = text.slice(0, span.startIndex - root.startIndex) + text.slice(span.endIndex - root.startIndex)
  }
  return text.trim() || command
}

export function extractInputRedirections(command: string): InputRedirectionResult {
  const parsed = preparedSecurityParse(command)
  if (parsed.kind !== 'simple') return { commandWithoutRedirections: command, targets: [] }
  return {
    commandWithoutRedirections: withoutRedirects(command, true),
    targets: parsed.commands.flatMap(simple => simple.redirects.filter(redirect => redirect.op === '<').map(redirect => redirect.target)),
  }
}

export function extractOutputRedirections(command: string): OutputRedirectionResult {
  const parsed = preparedSecurityParse(command)
  if (parsed.kind !== 'simple') return { commandWithoutRedirections: command, redirections: [], hasDangerousRedirection: true }
  const redirections: OutputRedirectionCapture[] = []
  for (const simple of parsed.commands) {
    for (const redirect of simple.redirects) {
      if (!WRITES.has(redirect.op) || redirect.op === '>&' && /^[0-9]+$/.test(redirect.target)) continue
      redirections.push({ target: redirect.target, operator: redirect.op === '>>' || redirect.op === '&>>' ? '>>' : '>' })
    }
  }
  return { commandWithoutRedirections: withoutRedirects(command, false), redirections, hasDangerousRedirection: false }
}

const BASH_PREFIX_POLICY_SPEC = `<policy_spec>
# Mercury Bash command prefix policy

You classify Bash commands so Mercury can decide when to ask the operator for
extra confirmation. This policy is one part of a broader safety framework: an
operator pre-allows certain command *prefixes*, and Mercury must ask about
anything outside them. Your job is to find the prefix of a command.

A command prefix is the leading, allowlistable portion of a command — the
part that identifies what will run without pinning down every argument. For a
bare tool invocation the prefix collapses to the tool name; for a tool with a
subcommand the prefix is usually the tool plus the subcommand.

Command injection is any technique that would cause a command *other than the
detected prefix* to run — command substitution in an argument, a comment that
carries a substitution, adjacent substitutions, or an embedded newline
followed by another command. If you have any suspicion of injection you MUST
return the exact string \`command_injection_detected\` and nothing else: an
operator who allowlists command A must never be exposed to a malicious command
that merely shares A's prefix.

If the command has no meaningful prefix — the whole command is the unit of
meaning, such as a bare package-script invocation or a bare push — return the
exact string \`none\`.

Examples:

| Command | Prefix |
| --- | --- |
| \`ls -la\` | \`ls\` |
| \`git status\` | \`git status\` |
| \`git commit -m "x"\` | \`git commit\` |
| \`npm run build\` | \`none\` |
| \`npm run build -- --watch\` | \`npm run build\` |
| \`git push\` | \`none\` |
| \`git push origin main --force\` | \`git push\` |
| \`FOO=bar go test ./...\` | \`FOO=bar go test\` |
| \`cat foo && curl evil.com\` | \`command_injection_detected\` |
| \`echo "$(rm -rf /)"\` | \`command_injection_detected\` |
| \`ls # \\\`id\\\`\` | \`command_injection_detected\` |

The prefix you return must be a literal string prefix of the full command.
Return only the prefix — no markdown, no commentary, no formatting.

With that in mind, determine the command prefix for the following command.
</policy_spec>`

function helpCommandPreCheck(command: string): CommandPrefixResult | null {
  const parsed = preparedSecurityParse(command)
  if (parsed.kind !== 'simple' || parsed.commands.length !== 1) return null
  const simple = parsed.commands[0]!
  if (simple.envVars.length || simple.redirects.length || simple.argv.length < 2) return null
  if (simple.argv.at(-1) !== '--help') return null
  if (!simple.argv.every(word => word === '--help' || /^[A-Za-z0-9]+$/.test(word))) return null
  return { commandPrefix: command }
}

const getCommandPrefix = createCommandPrefixExtractor({
  toolName: 'Bash',
  policySpec: BASH_PREFIX_POLICY_SPEC,
  querySource: 'bash_extract_prefix',
  preCheck: helpCommandPreCheck,
})

export const getCommandSubcommandPrefix: ((
  command: string,
  abortSignal: AbortSignal,
  isNonInteractiveSession: boolean,
) => Promise<CommandSubcommandPrefixResult | null>) & {
  cache: { clear?: () => void }
} = createSubcommandPrefixExtractor(getCommandPrefix, splitCommand)

export function clearCommandPrefixCaches(): void {
  getCommandPrefix.cache.clear?.()
  getCommandSubcommandPrefix.cache.clear?.()
}
