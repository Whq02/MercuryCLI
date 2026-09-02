// ============================================================================
//  src/constants/xml.ts — XML tag-name vocabulary for message framing. Tag
//  NAMES only; consumers compose the angle brackets. Contract data.
// ============================================================================

// Command metadata.
export const COMMAND_NAME_TAG = 'command-name'
export const COMMAND_MESSAGE_TAG = 'command-message'
export const COMMAND_ARGS_TAG = 'command-args'

// Terminal activity in user messages.
export const BASH_INPUT_TAG = 'bash-input'
export const BASH_STDOUT_TAG = 'bash-stdout'
export const BASH_STDERR_TAG = 'bash-stderr'
export const LOCAL_COMMAND_STDOUT_TAG = 'local-command-stdout'
export const LOCAL_COMMAND_STDERR_TAG = 'local-command-stderr'
export const LOCAL_COMMAND_CAVEAT_TAG = 'local-command-caveat'

/** The ordered list identifying a message as terminal output rather than a
 *  user prompt. */
export const TERMINAL_OUTPUT_TAGS = [
  BASH_INPUT_TAG,
  BASH_STDOUT_TAG,
  BASH_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
] as const

export const TICK_TAG = 'tick'

// Task-notification framing.
export const TASK_NOTIFICATION_TAG = 'task-notification'
export const TASK_ID_TAG = 'task-id'
export const TOOL_USE_ID_TAG = 'tool-use-id'
export const TASK_TYPE_TAG = 'task-type'
export const OUTPUT_FILE_TAG = 'output-file'
export const STATUS_TAG = 'status'
export const SUMMARY_TAG = 'summary'
export const REASON_TAG = 'reason'
export const WORKTREE_TAG = 'worktree'
export const WORKTREE_PATH_TAG = 'worktreePath'
export const WORKTREE_BRANCH_TAG = 'worktreeBranch'

// Mercury additions.
/** Swarm inter-agent communication. */
export const TEAMMATE_MESSAGE_TAG = 'teammate-message'
/** External channel messages. */
export const CHANNEL_TAG = 'channel'
/**
 * Delimits the standing rules-and-format preamble a forked child receives in
 * its opening user message: the fork composer emits it and later searches
 * for it again so autocompaction cannot swallow the preamble, and the
 * transcript renderer folds the delimited span away.
 */
export const FORK_BOILERPLATE_TAG = 'fork-boilerplate'
/** Must stay in sync with the fork composer. */
export const FORK_DIRECTIVE_PREFIX = 'Your directive: '

// Slash-command argument patterns; both lists are order-significant.
export const COMMON_HELP_ARGS: readonly string[] = ['help', '-h', '--help']
export const COMMON_INFO_ARGS: readonly string[] = [
  'list',
  'show',
  'display',
  'current',
  'view',
  'get',
  'check',
  'describe',
  'print',
  'version',
  'about',
  'status',
  '?',
]
