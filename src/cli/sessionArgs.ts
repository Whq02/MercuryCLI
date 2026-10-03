const required = new Set([
  '--log-file', '--format', '--input', '--schema', '--reasoning-mode', '--max-turns', '--budget',
  '--brief', '--brief-file', '--brief-add', '--brief-add-file',
  '--mode', '--draft', '--replay-to', '--restore-files', '--model', '--effort', '--agent', '--backup-model',
  '--meter-tag', '--project', '--config', '--session-id', '--title', '--agent-defs', '--config-layers', '--extension',
  '--seat-id', '--seat', '--crew', '--seat-color', '--parent', '--role',
])
const optional = new Set(['--debug', '-r', '--resume', '--pr', '-w', '--worktree'])
const variadic = new Set(['--allowed-tools', '--toolset', '--block-tools', '--mcp', '--provider-preview'])

function* optionIndexes(args: readonly string[]): Generator<number> {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!
    if (token === '--') return
    yield i
    const equal = token.indexOf('=')
    if (equal >= 0) continue
    if (required.has(token)) { i++; continue }
    if (optional.has(token)) {
      if (args[i + 1] !== undefined && !args[i + 1]!.startsWith('-')) i++
    } else if (variadic.has(token)) {
      while (args[i + 1] !== undefined && !args[i + 1]!.startsWith('-')) i++
    }
  }
}

export function readSessionOption(args: readonly string[], name: string): { present: boolean; value?: string } {
  let result: { present: boolean; value?: string } = { present: false }
  for (const i of optionIndexes(args)) {
    const token = args[i]!
    const equal = token.indexOf('=')
    const flag = equal < 0 ? token : token.slice(0, equal)
    if (flag === name) result = { present: true, value: equal < 0 ? args[i + 1] : token.slice(equal + 1) }
  }
  return result
}

export function inspectSessionArgs(args: readonly string[]): { command?: string; format?: string; input?: string; runner: boolean; outputRequest: boolean } {
  let command: string | undefined
  let outputRequest = false
  for (const i of optionIndexes(args)) {
    const token = args[i]!
    const flag = token.split('=', 1)[0]!
    if (['--help', '-h', '--version', '-v', '-V'].includes(flag)) outputRequest = true
    if (!token.startsWith('-') && command === undefined) command = token
  }
  return {
    command,
    format: readSessionOption(args, '--format').value,
    input: readSessionOption(args, '--input').value,
    runner: command === 'run' || command === 'runner',
    outputRequest,
  }
}

export function isSessionRunArgv(argv: readonly string[] = process.argv): boolean {
  return inspectSessionArgs(argv.slice(2)).runner
}
