import { Command as CommanderCommand, InvalidArgumentError } from 'commander'
import { binaryName } from '../../platform/settings/config.js'
import { logError } from '../../platform/logs/errorLog.js'
import { gracefulShutdown } from '../../platform/processes/gracefulShutdown.js'
import { update as updateCli } from '../../commands/verbs/update.js'
import { exitWithVersionLine, failCli, typedString, writeErr } from './cli.js'
import { healthAction, showAction } from './verbActions.js'

export async function registerSubcommands(program: CommanderCommand): Promise<void> {
  const cliName = binaryName()

  const mcp = registerMcpVerbs(program)
  if (process.argv.includes('mcp')) await registerMcpAddVerb(mcp)
  registerMcpManageVerbs(mcp)
  registerAuthVerbs(program)
  registerExtensionVerbs(program)
  await registerReportVerbs(program)
  registerSessionVerbs(program)
  registerHelpVerbs(program, cliName)
  registerToolVerbs(program, cliName)
}

function registerMcpVerbs(program: CommanderCommand): CommanderCommand {
  const mcp = program.command('mcp').description('Manage MCP servers').helpCommand('help [command]', 'Show help for a command')
  mcp.enablePositionalOptions().configureHelp({ sortSubcommands: true, sortOptions: true })
  mcp
    .command('serve')
    .description('Run the MCP server')
    .option('-d, --debug', 'Debug output')
    .action(async options => {
      const { mcpServeHandler } = await import('../../commands/verbs/mcp.js')
      await mcpServeHandler(options)
    })
  return mcp
}

async function registerMcpAddVerb(mcp: CommanderCommand): Promise<void> {
  try {
    const { registerMcpAddCommand } = await import('../../commands/mcp/addCommand.js')
    registerMcpAddCommand(mcp)
  } catch (error) {
    logError(error)
  }
}

function registerMcpManageVerbs(mcp: CommanderCommand): void {
  mcp
    .command('remove <name>')
    .description('Remove an MCP server')
    .option('-s, --scope <scope>', 'Configuration scope')
    .action(async (name, options) => {
      const { mcpRemoveHandler } = await import('../../commands/verbs/mcp.js')
      await mcpRemoveHandler(name, options)
    })
  mcp
    .command('list')
    .description(
      "List the configured MCP servers and check each by connecting to it (a stdio server is started for the check; the project's servers are included without the approval question)",
    )
    .action(async () => {
      const { mcpListHandler } = await import('../../commands/verbs/mcp.js')
      await mcpListHandler()
    })
  mcp
    .command('get <name>')
    .description(
      'Show one MCP server and check it by connecting to it (a stdio server is started for the check; a project server is included without the approval question)',
    )
    .action(async name => {
      const { mcpGetHandler } = await import('../../commands/verbs/mcp.js')
      await mcpGetHandler(name)
    })
  mcp
    .command('import <name> <json>')
    .description('Add an MCP server from a JSON definition')
    .option('-s, --scope <scope>', 'Configuration scope', 'local')
    .option('--client-secret', 'Prompt for a client secret')
    .action(async (name, json, options) => {
      const { mcpAddJsonHandler } = await import('../../commands/verbs/mcp.js')
      await mcpAddJsonHandler(name, json, options)
    })
  mcp
    .command('trust-reset')
    .description('Reset project MCP server approval choices')
    .action(async () => {
      const { mcpResetChoicesHandler } = await import('../../commands/verbs/mcp.js')
      await mcpResetChoicesHandler()
    })
}

function registerAuthVerbs(program: CommanderCommand): void {
  const auth = program.command('auth').description('Manage authentication').helpCommand('help [command]', 'Show help for a command')
  auth
    .command('mint')
    .description('Create a long-lived authentication token')
    .action(async () => {
      const { setupTokenHandler } = await import('../../commands/verbs/setupTokenAndHealth.js')
      const { createRoot } = await import('../../screen/themedRenderer.js')
      await setupTokenHandler(await createRoot())
    })
  auth
    .command('login [family]')
    .description('Sign in to Anthropic or a named provider family')
    .option('--email <email>', 'Account email')
    .option('--sso', 'Use SSO')
    .option('--console', 'Sign in with an Anthropic Console (API) account; the default is the subscription sign-in')
    .option('--key <key>', 'API key or token')
    .option('--device', 'Use device-code sign-in where offered')
    .option('--coding', 'Store as a GLM Coding Plan key')
    .option('--region <region>', 'Kimi region: global or mainland-cn')
    .action(async (family, options) => {
      const { providerAuthLogin } = await import('../../commands/verbs/providerAuth.js')
      await providerAuthLogin(family, options, { exit: code => process.exit(code) })
    })
  auth
    .command('list')
    .description('List provider families and their sign-in state')
    .option('--json', 'JSON output')
    .action(async options => {
      const { providerAuthList } = await import('../../commands/verbs/providerAuth.js')
      await providerAuthList(options, { exit: code => process.exit(code) })
    })
  auth
    .command('status [family]')
    .description('Show authentication status')
    .option('--json', 'JSON output (the default when stdout is not a terminal)')
    .action(async (family, options) => {
      const { providerAuthStatus } = await import('../../commands/verbs/providerAuth.js')
      await providerAuthStatus(family, options, { exit: code => process.exit(code) })
    })
  auth
    .command('logout [family]')
    .description('Sign out')
    .action(async family => {
      const { providerAuthLogout } = await import('../../commands/verbs/providerAuth.js')
      await providerAuthLogout(family, { exit: code => process.exit(code) })
    })
}

function registerExtensionVerbs(program: CommanderCommand): void {
  const extensions = program.command('extensions').description('Install extensions and manage their sources').helpCommand('help [command]', 'Show help for a command')
  extensions
    .command('list')
    .description('The installed extensions, each with its state and the first reason behind it; --source lists what one source offers')
    .option('--json', 'JSON output')
    .option('--source <label>', 'List what one source offers, by the name you filed it under (its label)')
    .action(async options => {
      const { listVerb } = await import('../../integrations/extensions/cli.js')
      process.exitCode = (await listVerb(options)).exit
    })
  extensions
    .command('sources')
    .description('Your sources, each with its state')
    .option('--json', 'JSON output')
    .action(async options => {
      const { sourcesVerb } = await import('../../integrations/extensions/cli.js')
      process.exitCode = (await sourcesVerb(options)).exit
    })
  extensions
    .command('add <source>')
    .description('Add a source: a git URL on any host, a folder, or an archive (nothing is installed)')
    .option('--label <label>', 'The name to file the source under (its label)')
    .option('--json', 'JSON output')
    .action(async (source, options) => {
      const { addVerb } = await import('../../integrations/extensions/cli.js')
      process.exitCode = (await addVerb(source, options)).exit
    })
  extensions
    .command('remove')
    .argument('<label>', 'The name you filed the source under (its label)')
    .description('Remove a source (its installed copies keep working)')
    .option('--and-extensions', 'Also uninstall the extensions installed from it')
    .action(async (label, options) => {
      const { removeVerb } = await import('../../integrations/extensions/cli.js')
      process.exitCode = (await removeVerb(label, options)).exit
    })
  extensions
    .command('refresh')
    .argument('[label]', 'The name you filed the source under (its label); none means every source')
    .description('Refresh one or every source; prints the updates found (installs nothing)')
    .option('--json', 'JSON output')
    .action(async (label, options) => {
      const { checkVerb } = await import('../../integrations/extensions/cli.js')
      process.exitCode = (await checkVerb(label, options)).exit
    })
  extensions
    .command('install')
    .argument('<name>', 'The extension to install; name@label takes it from the one source filed under that name (its label)')
    .description('Install an extension: fetch it, show what it will run on your machine and what it needs (the card), then approve it (on a TTY-less run, --yes is the approval)')
    .option('--yes', 'Approve without asking (the only scripted approval)')
    .option('--project', 'Switch on for this project only')
    .action(async (name, options) => {
      const { installVerb } = await import('../../integrations/extensions/cli.js')
      process.exitCode = (await installVerb(name, options)).exit
    })
  extensions
    .command('trust <id>')
    .description('Show what an installed-but-off or newly found extension will run and needs, then approve it')
    .option('--yes', 'Approve without asking')
    .option('--project', 'Switch on for this project only')
    .action(async (id, options) => {
      const { approveVerb } = await import('../../integrations/extensions/cli.js')
      process.exitCode = (await approveVerb(id, options)).exit
    })
  extensions
    .command('enable <id>')
    .description('Turn an installed extension on')
    .option('--project', 'For this project only')
    .action(async (id, options) => {
      const { enableVerb } = await import('../../integrations/extensions/cli.js')
      process.exitCode = (await enableVerb(id, options)).exit
    })
  extensions
    .command('disable <id>')
    .description('Turn an installed extension off (its switch)')
    .option('--project', 'For this project only')
    .action(async (id, options) => {
      const { disableVerb } = await import('../../integrations/extensions/cli.js')
      process.exitCode = (await disableVerb(id, options)).exit
    })
  extensions
    .command('update [id]')
    .description('Update to the version the source lists (after a check); --previous swaps back')
    .option('--all', 'Every installed extension with a known update')
    .option('--yes', 'Approve without asking when the update changes what the extension contributes')
    .option('--previous', 'Swap back to the kept previous version')
    .action(async (id, options) => {
      const { updateVerb } = await import('../../integrations/extensions/cli.js')
      process.exitCode = (await updateVerb(id, options)).exit
    })
  extensions
    .command('uninstall <id>')
    .description('Uninstall, leaving no residue')
    .option('--keep-data', "Keep the extension's data folder")
    .option('--yes', 'Do not ask')
    .action(async (id, options) => {
      const { uninstallVerb } = await import('../../integrations/extensions/cli.js')
      process.exitCode = (await uninstallVerb(id, options)).exit
    })
  extensions
    .command('fence <entry>')
    .description('Add an entry to the blocklist (the fence): an extension id, the name a source is filed under (its label), a URL or a host')
    .action(async entry => {
      const { blockVerb } = await import('../../integrations/extensions/cli.js')
      process.exitCode = (await blockVerb(entry)).exit
    })
  extensions
    .command('unfence <entry>')
    .description('Remove an entry from the blocklist')
    .action(async entry => {
      const { unblockVerb } = await import('../../integrations/extensions/cli.js')
      process.exitCode = (await unblockVerb(entry)).exit
    })
  extensions
    .command('inspect <path>')
    .description("The maker's linter — checks an extension's manifest, or a source's list of extensions (its catalogue), and what each contributes")
    .option('--json', 'JSON output')
    .action(async (path, options) => {
      const { validateVerb } = await import('../../integrations/extensions/cli.js')
      process.exitCode = (await validateVerb(path, options)).exit
    })
  extensions
    .command('scaffold <name>')
    .description('Scaffold an extension folder (or, with --source, a source root) that validates clean')
    .option('--source', 'Scaffold a source root with its list of extensions (a catalogue) and the README template')
    .option('--dir <dir>', 'Where to create it (default: the current directory)')
    .action(async (name, options) => {
      const { initVerb } = await import('../../integrations/extensions/cli.js')
      process.exitCode = (await initVerb(name, options)).exit
    })
}

async function registerReportVerbs(program: CommanderCommand): Promise<void> {
  program
    .command('models')
    .description('Print the models the signed-in accounts reach (the mercury://models reference)')
    .option('--json', 'JSON output')
    .action(async options => {
      const { modelsCli } = await import('../../commands/verbs/models.js')
      await modelsCli({ json: options.json === true })
      process.exit(0)
    })

  program
    .command('roster')
    .description('Print the agent inventory')
    .option('--config-layers <sources>', 'Which settings sources may apply, comma-separated: user, project, local')
    .action(async () => {
      const { agentsHandler } = await import('../../commands/verbs/agents.js')
      await agentsHandler()
      process.exit(0)
    })

  program
    .command('usage')
    .description("Print the usage figures the /usage screen shows, read the way the screen reads them (each signed-in provider's reader sampled once, as on open): the compact figures line as text, or the whole reading as JSON — per sign-in the windows with used and reset, the figures and credits the provider stated, each with its source and age, and the session spend per model")
    .option('--json', 'The whole reading as JSON')
    .option('--history', 'Report local usage across sessions without contacting providers')
    .option('--days <n>', 'With --history, include today and the preceding N-1 UTC days', value => {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError('Days must be a positive integer.')
      return Number(value)
    })
    .option('--project', 'With --history, include only the current project')
    .action(async options => {
      if ((options.days !== undefined || options.project) && !options.history) failCli('--days and --project require --history.', 2)
      if (options.history) {
        const { usageHistoryCli } = await import('../../commands/verbs/usageHistory.js')
        await usageHistoryCli({ json: options.json === true, days: options.days, project: options.project })
      } else {
        const { usageCli } = await import('../../commands/verbs/usage.js')
        await usageCli({ json: options.json === true })
      }
      process.exit(0)
    })

  const { registerTuneDoor } = await import('../../commands/verbs/tuneDoor.js')
  registerTuneDoor(program, gracefulShutdown)
  program.command('extension-api').description('JSON operations for external programs')
    .option('--json', 'Read a JSON request from stdin')
    .action(async options => {
      const { extensionApiCli } = await import('../../commands/verbs/extensionApi.js')
      await gracefulShutdown(await extensionApiCli(options))
    })
}

function registerSessionVerbs(program: CommanderCommand): void {
  const sessions = program
    .command('sessions')
    .description('Saved sessions: list, delete')
    .helpCommand('help [command]', 'Show help for a command')
    .option('--all', 'List the saved sessions of every project, not only this one')
    .option('--limit <n>', 'The most sessions to list (default 50)', value => Number.parseInt(value, 10))
    .action(async (options: { all?: boolean; limit?: number }) => {
      const { sessionsListCli } = await import('../../commands/verbs/sessionsVerb.js')
      await gracefulShutdown(await sessionsListCli({ all: options.all === true, ...(options.limit !== undefined ? { limit: options.limit } : {}) }))
    })
  sessions
    .command('list')
    .description('List the saved sessions of this project, newest first, with the id a resume or a delete takes; --all reads every project')
    .option('--all', 'List the saved sessions of every project, not only this one')
    .option('--limit <n>', 'The most sessions to list (default 50)', value => Number.parseInt(value, 10))
    .action(async (options: { all?: boolean; limit?: number }) => {
      const { sessionsListCli } = await import('../../commands/verbs/sessionsVerb.js')
      await gracefulShutdown(await sessionsListCli({ all: options.all === true, ...(options.limit !== undefined ? { limit: options.limit } : {}) }))
    })
  sessions
    .command('delete <id>')
    .description('Delete one saved session on purpose — its transcript and the records kept beside it (receipts, resume snapshot) — after a question; a session the background process (the daemon) hosts now is refused')
    .option('--yes', 'Delete without the question (for scripts)')
    .action(async (id: string, options: { yes?: boolean }) => {
      const { sessionsDeleteCli } = await import('../../commands/verbs/sessionsVerb.js')
      await gracefulShutdown(await sessionsDeleteCli(id, { yes: options.yes === true }))
    })

  const lsp = program.command('lsp').description('Language servers: list the ones Mercury knows (the catalogue), install one').helpCommand('help [command]', 'Show help for a command')
  lsp
    .command('list')
    .description('List the language servers Mercury knows: each one installed (with its binary) or absent (with its install remedy); Mercury never installs one on its own')
    .action(async () => {
      const { lspListCli } = await import('../../commands/verbs/lspVerb.js')
      await gracefulShutdown(await lspListCli())
    })
  lsp
    .command('install <server>')
    .description('Install one language server Mercury knows by running its install remedy, shown first and run after a question; reports where the binary landed; an unknown server is refused with the list of known ones')
    .option('--yes', 'Run the remedy without the question (for scripts)')
    .action(async (server: string, options: { yes?: boolean }) => {
      const { lspInstallCli } = await import('../../commands/verbs/lspVerb.js')
      await gracefulShutdown(await lspInstallCli(server, { yes: options.yes === true }))
    })
}

function registerHelpVerbs(program: CommanderCommand, cliName: string): void {
  program
    .command('version')
    .description('Print the version (the same line as --version)')
    .action(() => {
      exitWithVersionLine()
    })
  program
    .command('help [command...]')
    .description('Show help: this page, or one command\'s page (help mcp serve reaches a sub-command)')
    .action((words: string[]) => {
      let target: CommanderCommand = program
      for (const word of words) {
        const next = target.commands.find(command => command.name() === word || command.aliases().includes(word))
        if (next === undefined) failCli(`unknown command: ${words.join(' ')} — ${cliName} --help lists every command`)
        target = next
      }
      target.outputHelp()
      process.exit(0)
    })
  program.command('health [topic]')
    .description('Check the installation health: configured MCP servers are validated WITHOUT starting them; `health processes` lists Mercury\'s own processes as JSON')
    .option('--json', 'The full health report as JSON (the certificate)')
    .option('--deep', 'Run the slower, deeper checks too')
    .option('--fix', 'Run the guided fix flow')
    .option('--only <id>', 'Limit to one check')
    .option('--yes', 'Assume yes at fix prompts')
    .option('--end-stale', 'With `health processes`: end the stale processes the listing names — first by asking the background process that runs them (the daemon), then a termination signal, then a kill')
    .action(async (topic, options) => {
      if (typeof topic === 'string' && topic !== '') {
        if (topic !== 'processes') {
          process.stderr.write(`unknown health topic: ${topic} (the one topic is "processes")\n`)
          await gracefulShutdown(2)
          return
        }
        const { runHealthProcessesCli } = await import('../../commands/verbs/healthProcesses.js')
        await gracefulShutdown(await runHealthProcessesCli({ endStale: options.endStale === true }))
        return
      }
      await healthAction({
        json: Boolean(options.json),
        deep: Boolean(options.deep),
        fix: Boolean(options.fix),
        only: typedString(options.only),
        yes: options.yes === true,
      })
    })
}

function registerToolVerbs(program: CommanderCommand, cliName: string): void {
  program
    .command('godot [verb] [args...]')
    .description('Godot engine jobs, each on a copy of the project taken the moment the job is submitted (a frozen project): run | check | capture | frames | profile | tour | jobs | cancel | result')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (_verb: string | undefined, _args: string[] | undefined, _options: unknown, command: { args: string[] }) => {
      const { godotEngineCli } = await import('../../commands/verbs/godotEngineCli.js')
      process.exit(await godotEngineCli(command.args))
    })

  for (const [name, description, usage] of [
    ['daemon [subcommand]', 'The background process that hosts your sessions and runs scheduled jobs (the daemon): run | status | stop | restart', `Usage: ${cliName} daemon <run|status|stop|restart>`],
    ['acp', 'Serve an editor over the Agent Client Protocol on stdio', `Usage: ${cliName} acp`],
    ['host [subcommand]', 'Run a model on one of your computers: start | status | stop | restart | logs | uninstall | add | recipes', `Usage: ${cliName} host --help`],
  ] as const) {
    program
      .command(name)
      .description(description)
      .allowUnknownOption(true)
      .action(() => {
        writeErr(usage)
        process.exit(1)
      })
  }

  program
    .command('image <image>')
    .description('Render an image to the terminal')
    .option('--protocol <p>', 'Force a display protocol: iterm, kitty, sixel or cells')
    .option('--cols <n>', 'Width limit in terminal columns (default 76) — exact when the picture is drawn as coloured text (the cells protocol)', Number)
    .action(async (image: string, options: { protocol?: string; cols?: number }) => {
      await showAction(image, options)
    })

  program
    .command('bridge <action>')
    .description('Install, check or remove the VS Code extension: install | status | uninstall')
    .action(async (action: string) => {
      const { editorBridgeMain } = await import('../../commands/verbs/editorBridge.js')
      process.exit(await editorBridgeMain(action))
    })

  program
    .command('update')
    .alias('upgrade')
    .description('Update to the newest release (no GitHub sign-in needed)')
    .option('--allow-unsigned', 'Explicitly allow an unsigned payload; invalid or untrusted signatures still refuse')
    .option('--check', 'Only check for updates')
    .option('--status', 'Show update status')
    .option('--rollback', 'Roll back to the previous version')
    .option('--yes', "Inside an install made by Homebrew or npm, run that package manager's own upgrade without asking first")
    .option('--json', 'JSON output')
    .action(async options => {
      await updateCli(options)
    })

  program
    .command('install')
    .description('Install the release archive this command runs from, for your user only (a stable `mercury` command and its managed launcher shims); a build tree is refused')
    .option('--allow-unsigned', 'Explicitly allow an unsigned payload; invalid or untrusted signatures still refuse')
    .option('--dry-run', 'Preview only')
    .option('--uninstall', 'Remove the shims')
    .option('--force', 'Overwrite unexpected files')
    .option('--json', 'JSON output')
    .action(async options => {
      const { installVerb } = await import('../../commands/verbs/installVerb.js')
      await installVerb(options)
    })
}
