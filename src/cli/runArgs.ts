const required = new Set([
  '--debug-file', '--format', '--input', '--json-schema', '--thinking', '--max-turns', '--max-budget-usd',
  '--permission-prompt-tool', '--permission-channel', '--system-prompt', '--system-prompt-file',
  '--append-system-prompt', '--append-system-prompt-file', '--mode', '--prefill', '--resume-session-at',
  '--rewind-files', '--model', '--effort', '--agent', '--fallback-model', '--workload', '--project-root',
  '--settings', '--session-id', '-n', '--name', '--agents', '--setting-sources', '--extension',
  '--agent-id', '--agent-name', '--crew-name', '--agent-color', '--parent-session-id', '--agent-type',
])
const optional = new Set(['-d', '--debug', '-r', '--resume', '--from-pr', '-w', '--worktree'])
const variadic = new Set(['--allowed-tools', '--tools', '--disallowed-tools', '--mcp-config', '--betas'])

export function inspectRunArgs(args: readonly string[]): { command?: string; format?: string; runner: boolean } {
  let command: string | undefined
  let format: string | undefined
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!
    if (token === '--') break
    const equal = token.indexOf('=')
    const flag = equal < 0 ? token : token.slice(0, equal)
    if (flag === '--format') format = equal < 0 ? args[i + 1] : token.slice(equal + 1)
    if (equal >= 0) continue
    if (required.has(flag)) { i++; continue }
    if (optional.has(flag)) {
      if (args[i + 1] !== undefined && !args[i + 1]!.startsWith('-')) i++
      continue
    }
    if (variadic.has(flag)) {
      while (args[i + 1] !== undefined && !args[i + 1]!.startsWith('-')) i++
      continue
    }
    if (!token.startsWith('-') && command === undefined) command = token
  }
  return { command, format, runner: command === 'run' }
}

export function isRunArgv(argv: readonly string[] = process.argv): boolean {
  return inspectRunArgs(argv.slice(2)).command === 'run'
}
