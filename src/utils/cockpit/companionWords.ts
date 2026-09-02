
import type { Moment, Tip } from './companionVoice.js'
import { chatOnlyBoot } from '../../context/surfaceRoute.js'
import { keyHintLabel } from '../../components/mercury-ui/keyHintLabel.js'

const fleetWorld = (): boolean => !chatOnlyBoot()

const t = (id: string, area: Tip['area'], text: string, surface?: string, when?: () => boolean): Tip => ({
  id,
  area,
  text,
  ...(surface !== undefined ? { surface } : {}),
  ...(when !== undefined ? { when } : {}),
})

export const TIP_BANK: readonly Tip[] = [
  t('minerva.note', 'minerva', 'Type /note to keep a thought for later.', 'note'),
  t('minerva.tabula', 'minerva', '/tabula opens your notes as a board.', 'tabula'),
  t('minerva.tidy', 'minerva', 'Ask Minerva to tidy notes: /minerva.', 'minerva'),
  t('minerva.fire', 'minerva', '/tabula can fire a note into the prompt.', 'tabula'),
  t('minerva.free', 'minerva', 'Minerva costs nothing until you press ↵.'),
  t('minerva.model', 'minerva', "Pick Minerva's model under /submodels.", 'submodels'),
  t('minerva.outlive', 'minerva', 'Notes outlive /clear — jot ideas early.', 'note'),
  t('context.draw', 'context', '/context draws what fills the window.', 'context'),
  t('context.meter', 'context', 'The ctx meter is how full the window is.'),
  t('context.compact', 'context', '/compact folds old turns into a summary.', 'compact'),
  t('context.steer', 'context', 'Words after /compact steer its summary.', 'compact'),
  t('context.clear', 'context', '/clear starts fresh, freeing the window.', 'clear'),
  t('context.outputs', 'context', 'Big outputs eat context — ask for less.'),
  t('context.auto', 'context', 'A full meter compacts on its own.'),
  t('context.window', 'context', '/auto-compact-window sets its size.', 'auto-compact-window'),
  t('models.switch', 'models', '/model switches the model mid-session.', 'model'),
  t('models.effort', 'models', '/effort sets how hard the model thinks.', 'effort'),
  t('models.range', 'models', 'Low effort is quick; max is thorough.'),
  t('models.submodels', 'models', '/submodels picks the Minerva model.', 'submodels'),
  t('models.usage', 'models', '/usage shows what each account has left.', 'usage'),
  t('models.cap', 'models', 'Some models cap the effort you can pick.'),
  t('mcp.list', 'mcp', '/mcp lists servers and toggles each.', 'mcp'),
  t('mcp.connected', 'mcp', '/mcp shows what is actually connected.', 'mcp'),
  t('mcp.extensions', 'mcp', '/extensions — extensions and sources.', 'extensions'),
  t('mcp.kill', 'mcp', '/kill turns a tool off for this session.', 'kill'),
  t('mcp.policy', 'mcp', '/policy shows what runs without asking.', 'policy'),
  t('mcp.team', 'mcp', 'Team tools appear once a team exists.'),
  t('sessions.switch', 'sessions', '/sessions switches sessions in place.', 'sessions'),
  t('sessions.resume', 'sessions', '/resume reopens any earlier session.', 'resume'),
  t('sessions.flip', 'sessions', `Empty prompt: ${keyHintLabel('⌥←→')} flips sessions.`),
  t('sessions.recap', 'sessions', 'Resumed sessions greet you with a recap.'),
  t('look.appearance', 'sessions', 'Change the look under /appearance.', 'appearance'),
  t('sessions.rename', 'sessions', '/rename names this session for later.', 'rename'),
  t('sessions.rewind', 'sessions', '/rewind goes back to a saved point.', 'rewind'),
  t('sessions.clear', 'sessions', '/clear opens a fresh session here.', 'clear'),
  t('sessions.switcher', 'sessions', 'ctrl+x s opens the session switcher.'),
  t('keys.palette', 'keys', 'ctrl+x p opens the command palette.'),
  t('keys.history', 'keys', 'ctrl+r searches your prompt history.'),
  t('keys.pager', 'keys', 'ctrl+o opens the transcript pager.'),
  t('keys.mode', 'keys', 'shift+tab cycles the permission mode.'),
  t('keys.file', 'keys', 'ctrl+x f opens a file by path.'),
  t('keys.grep', 'keys', 'ctrl+x g searches file contents.'),
  t('keys.background', 'keys', 'ctrl+b backgrounds a running task.'),
  t('keys.esc', 'keys', 'esc backs out one layer at a time.'),
  t('keys.surfaces', 'keys', 'ctrl+x m lists every surface, grouped.'),
  t('keys.keys', 'keys', '/keys shows every key in effect.', 'keys'),
  t('agents.delegate', 'agents', 'Delegate side work: ask for an agent.'),
  t('agents.workflows', 'agents', '/workflows shows runs, live and past.', 'workflows', fleetWorld),
  t('agents.teammates', 'agents', '/teammates keeps named long-run helpers.', 'teammates', fleetWorld),
  t('agents.build', 'agents', '/agents lets you build your own agents.', 'agents'),
  t('agents.fleet', 'agents', '/fleet shows who is working right now.', 'fleet', fleetWorld),
  t('agents.run', 'agents', "/run inspects the live run's evidence.", 'run'),
  t('worktrees.ask', 'worktrees', 'Ask for a worktree to keep main clean.'),
  t('worktrees.done', 'worktrees', 'Done in a worktree? Keep it or drop it.'),
  t('worktrees.realms', 'worktrees', '/realms lists the folders you trust.', 'realms'),
  t('worktrees.orient', 'worktrees', '/orient maps a new repo in one read.', 'orient'),
  t('worktrees.branch', 'worktrees', '/branch asks a side question, no derail.', 'branch'),
]

export const MOMENT_LINES: Readonly<Record<Moment, readonly string[]>> = {
  'settled-long': [
    "That one took a while — it's done.",
    'Long stretch. Landed clean.',
    'Finished. Worth a look before moving on.',
    'Done. The receipt line has the tally.',
    'A long run, settled.',
    "That's landed. Take a look when ready.",
    'Long haul over. All quiet now.',
    'Settled after a good stretch of work.',
  ],
  holding: [
    'A permission is waiting on you.',
    'Held at the gate until you decide.',
    'Nothing moves until you answer this one.',
    'One ask is open; the card is waiting.',
    'Paused on a permission — your call.',
    'The turn is holding for your answer.',
    'Still waiting on that permission.',
    'Your decision is the only thing pending.',
  ],
  failure: [
    "That didn't land. The error is above.",
    'A tool refused. Worth reading why.',
    'Stopped short — the trace says why.',
    'That failed; the transcript says why.',
    'Not clean. Have a look at the last row.',
    'Something broke on that step.',
    'The turn ended on an error.',
    'That failed; the reason is on screen.',
  ],
  silence: [
    'Still here whenever you are.',
    'Quiet for a while. Ready when you are.',
    'Back? The session kept its place.',
    'Welcome back. Nothing moved meanwhile.',
    'Picking up where you left off.',
    'All quiet. Everything as you left it.',
    'Ready when you are.',
    'Resting until you need me.',
  ],
}

export const MAX_LINE_CELLS = 40

export function everyCompanionLine(): string[] {
  return [...TIP_BANK.map(tip => tip.text), ...Object.values(MOMENT_LINES).flat()]
}
