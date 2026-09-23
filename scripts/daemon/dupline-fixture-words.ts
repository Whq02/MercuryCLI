export const LINE = 'the line during the agent'
export const FIRST_LINE = 'the first line during the agent'
export const SECOND_LINE = 'the second line during the agent'
export const RETURN_LINE = 'the line at the return'
export const AFTER_RETURN_LINE = 'the line after the return'
export const FOLD_LINE = 'the line during the fold'
export const AGENT_TURN_ASK = 'agent turn'
export const SLEEP_TOOL_TURN_ASK = 'agent turn sleep'
export const CREW_TURN_ASK = 'agent turn crew'
export const FOLD_TURN_ASK = 'agent turn fold'
export const NESTED_TURN_ASK = 'agent turn nested'
export const FORK_TURN_ASK = 'agent turn fork'
export const WORKFLOW_TURN_ASK = 'agent turn workflow'
export const RELAUNCH_TURN_ASK = 'agent turn relaunch'
export const THREE_ROUNDS_ASK = 'three tool rounds'
export const AGENT_PROMPT = 'sub agent work'
export const AGENT_DESCRIPTION = 'sub work'
export const SLEEP_TOOL_PROMPT = 'sub agent sleep work'
export const FOLD_PROMPT = 'sub agent fold work'
export const NESTED_PROMPT = 'sub agent nested work'
export const DEEPER_PROMPT = 'nested agent work'
export const FORK_PROMPT = 'fork work'
export const QUICK_PROMPT = 'quick background work'
export const QUICK_DESCRIPTION = 'quick work'
export const WORKFLOW_PROMPT = 'workflow agent work'
export const WORKFLOW_NAME = 'one-agent-workflow'
export const WORKFLOW_ALLOW_RULE = `Workflow(${WORKFLOW_NAME})`
export const WORKFLOW_SCRIPT = [`export const meta = { name: '${WORKFLOW_NAME}', description: 'one agent, one sleep' }`, `return await agent('${WORKFLOW_PROMPT}', { label: 'the one agent' })`].join('\n')
export const RELAUNCH_PROMPT = 'sub agent relaunch work'
export const QUICK_DONE = 'quick agent done'
export const DEEPER_DONE = 'the deeper agent ran'
export const FORK_DONE = 'the fork ran'
export const WORKFLOW_AGENT_DONE = 'workflow agent done'
export const FOLD_MARKER = 'Write the running record of this conversation'
export const FOLD_SUMMARY_MARK = 'the folded record of the sub agent fold work'
export const FOLD_TRIGGER_INPUT_TOKENS = 190_000
export const CREW_NOTICE = `Agent "${QUICK_DESCRIPTION}" completed`
export const BG_SLEEP_TURN_ASK = 'agent turn background sleep'
export const BG_SLEEP_PROMPT = 'sub agent background sleep work'
export const BG_SLEEP_DESCRIPTION = 'background sleeper'
export const BG_SHELL_DESCRIPTION = 'the sub agent background shell'
export const BG_SHELL_NOTICE = `Background command "${BG_SHELL_DESCRIPTION}" completed`
export const BG_AGENT_NOTICE = `Agent "${BG_SLEEP_DESCRIPTION}" completed`
export const BG_SLEEP_DONE = 'agent done: the background sleeping sub agent finished'
export const BG_SHELL_SECONDS = 4
export const BG_SUB_SLEEP_SECONDS = 40
export const BG_MAIN_SLEEP_SECONDS = 90
export const WATCHED_WORDS = [
  LINE,
  'the line during the main tool',
  'the mid-turn line one',
  'the between-turns line',
  FIRST_LINE,
  SECOND_LINE,
  RETURN_LINE,
  AFTER_RETURN_LINE,
  'and please read @notes.txt too',
  'THE-NOTES-BODY',
  'BATCH-HOOK-CONTEXT',
  FOLD_LINE,
  FOLD_SUMMARY_MARK,
  'the follow-up after the compact',
  CREW_NOTICE,
  DEEPER_DONE,
  FORK_DONE,
  WORKFLOW_AGENT_DONE,
  BG_SHELL_NOTICE,
  BG_AGENT_NOTICE,
] as const
export const doneText = (ask: string): string => `done: ${ask}`
