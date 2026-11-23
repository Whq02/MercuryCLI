import { Command as CommanderCommand, InvalidArgumentError, Option } from 'commander'
import { releaseLauncherAltHoldNow } from '../../screen/renderer/launcherAltHold.js'
import { binaryName } from '../../platform/settings/config.js'
import { timeSpanMsOf } from '../../platform/async/deadline.js'
import { EFFORT_LEVELS, parseCliEffort } from '../../models/effort/effort.js'
import { PERMISSION_MODES } from '../../permissions/rules/permissionMode.js'
import { MODE_GLOSS } from '../../platform/settings/validationTips.js'
import { exitWithVersionLine, failCli } from './cli.js'

export function addRootOptions(program: CommanderCommand): void {
  program
    .argument('[prompt]', 'The prompt to start with')
    .option('-d', 'Enable debug output')
    .option('--debug [filter]', 'Enable debug output (with an optional category filter)')
    .addOption(new Option('--log-stderr', 'Mirror debug output to stderr').hideHelp())
    .option('--log-file <path>', 'Write debug output to a file')
    .option('--lean', 'Minimal session: skips hooks, LSP, extensions, attribution, memory, background discovery, keychain reads and automatic project instructions. Supply context with --brief, --brief-add, --mcp and --allowed-tools; supply API-key settings with --config.')
    .addOption(new Option('--format <format>', 'Answer format for run: text, one JSON result, or JSON-line rows').choices(['text', 'json', 'rows']))
    .addOption(new Option('--input <format>', 'Read JSON-line rows from stdin with run').choices(['rows']))
    .option('--schema <schema>', 'JSON schema for structured output')
    .option('--partial', 'Include partial rows while run streams')
    .option('--sovereign', 'Start in sovereign mode: no permission prompts at all (a deny rule still refuses)')
    .option('--allow-sovereign', 'Let the session switch into running without permission prompts (sovereign mode) later; it does not start there')
    .addOption(new Option('--reasoning-mode <mode>', 'Thinking mode').choices(['enabled', 'adaptive', 'disabled']).hideHelp())
    .addOption(new Option('--max-turns <turns>', 'Maximum turns for a run').argParser((value: string) => {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        failCli(`--max-turns must be a positive integer (got '${value}')`)
      }
      return parsed
    }).hideHelp())
    .option('--budget <usd>', 'The most a run may spend, in US dollars (2.50 is two dollars fifty); the turn ends when it is reached', value => {
      const parsed = Number(value)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        failCli('--budget must be a positive number greater than 0')
      }
      return parsed
    })
    .option('--max-time <time>', 'The longest a run may take, in seconds or with a unit (600, 10m, 1h); once it is reached the turn ends at its next step and the outcome says so', value => {
      const parsed = timeSpanMsOf(value)
      if (parsed === null) {
        failCli(`--max-time must be a span of time in seconds or with a unit s, m or h (600, 90s, 10m, 1h30m); got '${value}'`)
      }
      return parsed
    })
    .option('--allowed-tools <tools...>', 'Tools the model may use without asking, as rules: a tool name, or a tool with a pattern — Read, Bash(git *), Edit(src/**), mcp__server__tool')
    .option('--toolset <tools...>', 'Base tool set')
    .option('--block-tools <tools...>', 'Tools the model may never use, in the same shape as --allowed-tools')
    .option('--mcp <configs...>', 'MCP server configs (JSON or file paths)')
    .option('--only-mcp', 'Only use MCP servers from --mcp')
    .option('--brief <prompt>', 'Set the standing instructions the model reads before the conversation (the session system brief)')
    .addOption(new Option('--brief-file <file>', 'Read the session system brief from a file').hideHelp())
    .option('--default-brief', 'Return a continued session to the default brief, forgetting the brief it was given')
    .option('--brief-add <prompt>', 'Append to the session system brief')
    .addOption(new Option('--brief-add-file <file>', 'Append to the session system brief from a file').hideHelp())
    .addOption(new Option('--host-brief-add <prompt>', 'The note of the host that runs this session: it rides behind the session system brief and is never recorded with the session').hideHelp())
    .addOption(new Option('--mode <mode>', `Permission mode: ${PERMISSION_MODES.map(mode => `${mode}: ${MODE_GLOSS[mode]}`).join('; ')} (apollo requires the cockpit or a host serving the session over mercury runner; mercury run alone refuses it)`).choices(PERMISSION_MODES))
    .option('-c, --continue', 'Continue the most recent conversation')
    .option('-r, --resume [value]', 'Resume a conversation (session id, title, or picker)')
    .option('--fork', 'Fork to a new session id on resume')
    .option('--pr [value]', 'Resume the session for a PR')
    .addOption(new Option('--draft <text>', 'Prefill the input buffer').hideHelp())
    .option('--ephemeral', 'Keep nothing of the run: no transcript, no lineage row, no note for the next session, no journal line')
    .addOption(new Option('--replay-to <message-id>', 'Truncate the resumed session at a message').hideHelp())
    .addOption(new Option('--restore-files <user-message-id>', 'Rewind files to a user message').hideHelp())
    .option('--model <model>', 'The model for the session')
    .option('--advise', 'Turn on the second model that advises the working model (the advisor) from the run\'s first turn (at birth) — the headless form of /advise on; the advisor\'s master switch in Mercury\'s home folder for this run (the config home) must be on')
    .option(`--effort <level>`, `Reasoning effort level (${EFFORT_LEVELS.join(', ')})`, value => {
      const { level } = parseCliEffort(value)
      if (level === undefined) {
        throw new InvalidArgumentError(
          `Unrecognised effort level "${value}". Valid values: ${EFFORT_LEVELS.join(', ')}.`,
        )
      }
      return level
    })
    .option('--agent <agent>', 'The agent to run as')
    .option('--provider-preview <betas...>', 'Provider beta headers')
    .option('--backup-model <model>', 'Fallback model when the primary is overloaded')
    .addOption(new Option('--meter-tag <tag>', 'Workload tag').hideHelp())
    .option('--project <directory>', 'Start in this folder. Pass it before the command word (mercury --project <dir> run …); later positions are refused', (value: string) => {
      const folder = /\s/.test(value) ? JSON.stringify(value) : value
      throw new InvalidArgumentError(`--project goes before the command word, not after it: ${binaryName()} --project ${folder} run …`)
    })
    .option('--config <file-or-json>', 'Extra settings (path or inline JSON)')
    .option('--session-id <uuid>', 'Use a specific session id')
    .option('--title <name>', 'Session title')
    .option('--chat', 'Open only the screen Mercury opens on (the Boot face) and a chat: no board of your sessions (no concourse) in this boot, and the row of screens shift+←/→ move between (the strip) is those two alone; ↵ New Session on the menu starts the chat (`-chat` is the same switch)')
    .option('--concourse-off', 'Turn the concourse off for this and every future boot (persisted; the strip is the Boot face and the chat alone; the Boot face\'s Session Concourse row keeps a plain live view of your sessions; `-concourse-off` is the same switch)')
    .option('--concourse-on', 'Turn the concourse back on for this and every future boot (persisted; the default is on; `-concourse-on` is the same switch)')
    .addOption(new Option('--coordinator-on').hideHelp())
    .addOption(new Option('--coordinator-off').hideHelp())
    .option('--agent-defs <json>', 'Extra agent definitions (JSON)')
    .option('--config-layers <sources>', 'Which settings sources may apply, comma-separated: user, project, local')
    .option('--extension <path>', 'An extension folder approved for this session only (repeatable)', (value, previous: string[]) => [...previous, value], [] as string[])
    .option('--no-commands', 'Disable all slash commands')
    .option('-v, --version', 'Print the version')
    .option('-w, --worktree [name]', 'Run inside a managed worktree')
    .option('--multiplex', 'Create a tmux session for the worktree')

  program.addOption(new Option('-V', 'Print the version').hideHelp())
  program.on('option:V', () => {
    releaseLauncherAltHoldNow()
    exitWithVersionLine()
  })
}
