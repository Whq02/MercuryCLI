type TagFamily<Prefix extends string, Members extends readonly string[]> = {
  readonly [Member in Members[number]]: `${Prefix}-${Member}`
}

function tagFamily<const Prefix extends string, const Members extends readonly string[]>(
  prefix: Prefix,
  members: Members,
): TagFamily<Prefix, Members> {
  return Object.fromEntries(members.map(member => [member, `${prefix}-${member}`])) as TagFamily<Prefix, Members>
}

export const {
  name: COMMAND_NAME_TAG,
  message: COMMAND_MESSAGE_TAG,
  args: COMMAND_ARGS_TAG,
} = tagFamily('command', ['name', 'message', 'args'])

export const {
  input: BASH_INPUT_TAG,
  stdout: BASH_STDOUT_TAG,
  stderr: BASH_STDERR_TAG,
  'exit-code': BASH_EXIT_CODE_TAG,
  'duration-ms': BASH_DURATION_MS_TAG,
  'background-task': BASH_BACKGROUND_TASK_TAG,
} = tagFamily('bash', ['input', 'stdout', 'stderr', 'exit-code', 'duration-ms', 'background-task'])

export const {
  stdout: LOCAL_COMMAND_STDOUT_TAG,
  stderr: LOCAL_COMMAND_STDERR_TAG,
  caveat: LOCAL_COMMAND_CAVEAT_TAG,
} = tagFamily('local-command', ['stdout', 'stderr', 'caveat'])

export const TERMINAL_OUTPUT_TAGS = [
  BASH_INPUT_TAG,
  BASH_STDOUT_TAG,
  BASH_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
] as const

export const TICK_TAG = 'tick'

export const TASK_NOTIFICATION_TAG = 'task-notification'
export const TASK_ID_TAG = 'task-id'
export const TOOL_USE_ID_TAG = 'tool-use-id'
export const OUTPUT_FILE_TAG = 'output-file'
export const STATUS_TAG = 'status'
export const SUMMARY_TAG = 'summary'
export const MESSAGE_TAG = 'message'
export const STRUCTURED_TAG = 'structured'

export const CREWMATE_MESSAGE_TAG = 'crewmate-message'
export const CHANNEL_TAG = 'channel'

export const COMMON_HELP_ARGS: readonly string[] = ['help', '-h', '--help']
export const COMMON_INFO_ARGS: readonly string[] = [
  'list', 'show', 'display', 'current', 'view', 'get', 'check',
  'describe', 'print', 'version', 'about', 'status', '?',
]
