import { Command as CommanderCommand, Option } from 'commander'
import { failCli, INTERACTIVE_BOOT_OPTIONS, RUN_OUTPUT_OPTIONS, type RootOptions } from './cli.js'
import { defaultAction } from './defaultAction.js'

export function registerSessionDoors(program: CommanderCommand, sessionOptions: (command: CommanderCommand) => RootOptions): CommanderCommand {
  program.action(async (prompt: string | undefined) => {
    await defaultAction(prompt, program.opts())
  })
  const runCommand = program.command('run')
    .description('Run a prompt without a terminal UI; use only in directories you trust')
    .argument('[prompt]', 'The prompt; - or no prompt reads it from stdin to the end; with a prompt, anything piped in is added as context — the pipe is read until it closes or has been silent for 1 s')
    .configureHelp({ sortOptions: true })
    .action(async (prompt: string | undefined) => {
      await defaultAction(prompt, { ...sessionOptions(runCommand), runMode: true })
    })
  const headlessResumeOption = new Option('-r, --resume <value>', 'Resume a session by its id (a UUID) or its .jsonl transcript path')
  for (const option of program.options) {
    if (INTERACTIVE_BOOT_OPTIONS.has(option.long ?? '')) continue
    runCommand.addOption(option.long === '--resume' ? headlessResumeOption : option)
  }
  const runnerCommand = program.command('runner')
    .description('Serve a session to a host over stdio (JSON-RPC 2.0, one message per line): the host sends the prompts and answers the permission asks')
    .configureHelp({ sortOptions: true })
    .action(async () => {
      await defaultAction(undefined, { ...sessionOptions(runnerCommand), runMode: true, runner: true })
    })
  for (const option of program.options) {
    if (RUN_OUTPUT_OPTIONS.has(option.long ?? '') || INTERACTIVE_BOOT_OPTIONS.has(option.long ?? '')) continue
    runnerCommand.addOption(option.long === '--resume' ? headlessResumeOption : option)
  }

  const mcpServerCommand = program.command('mcp-server')
    .description('Serve Mercury tools over MCP (stdio or authenticated HTTP)')
    .addOption(new Option('--transport <transport>', 'stdio or HTTP').choices(['stdio', 'http']).default('stdio'))
    .option('--bind <address>', 'HTTP listen address (default: 127.0.0.1)')
    .option('--port <port>', 'HTTP listen port (default: 8787)', Number)
    .option('--token-file <file>', 'Read client tokens and their reach from a private JSON file')
    .option('--client <name>', 'Choose the stdio client named in the token file')
    .option('--lead <session-id>', 'The session addressed by lead')
    .option('--coordinator <session-id>', 'The session addressed by coordinator')
    .addOption(new Option('--max-mode <mode>', 'Permission ceiling for client-owned sessions').choices(['default', 'dontAsk', 'implement', 'sovereign', 'flow', 'apollo']))
    .option('--origin <url>', 'Allow this HTTPS tunnel origin')
    .action(async (options, command) => {
      const { mcpServerCli } = await import('../../commands/verbs/mcpServer.js')
      const session = sessionOptions(command)
      try {
        await mcpServerCli({ ...options, transport: options.transport as 'stdio' | 'http', model: session.model, effort: session.effort, allowSovereign: session.allowSovereign })
      } catch (error) { failCli(error instanceof Error ? error.message : String(error)) }
    })
  for (const option of program.options) {
    if (['--model', '--effort', '--allow-sovereign'].includes(option.long ?? '')) mcpServerCommand.addOption(option)
  }
  return runCommand
}
