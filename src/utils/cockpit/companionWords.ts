
import type { Moment, Tip } from './companionVoice.js'
import { chatOnlyBoot } from '../../context/surfaceRoute.js'
import { keyHintLabel } from '../../components/mercury-ui/keyHintLabel.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { isAgentSwarmsEnabled } from '../agentSwarmsEnabled.js'
import { isTabulaEnabled } from '../tabula/tabulaGates.js'
import { repoSurfaceMapEnabled } from './repoSurfaceMap.js'

const fleetWorld = (): boolean => !chatOnlyBoot()

const fleetCenter = (): boolean => fleetWorld() && isAgentSwarmsEnabled()

const notepadWorld = (): boolean => isTabulaEnabled()

const chord = (action: string, context: string, fallback: string): string => {
  try {
    return getShortcutDisplay(action, context, fallback)
  } catch {
    return fallback
  }
}

const t = (
  id: string,
  area: Tip['area'],
  stage: Tip['stage'],
  text: string,
  surface?: string,
  when?: () => boolean,
): Tip => ({
  id,
  area,
  stage,
  text,
  ...(surface !== undefined ? { surface } : {}),
  ...(when !== undefined ? { when } : {}),
})

function buildBank(): readonly Tip[] {
  return [
    t('keys.esc', 'keys', 1, `${chord('chat:cancel', 'Chat', 'esc')} interrupts the turn, not its agents.`),
    t('keys.mode', 'keys', 1, `${chord('chat:cycleMode', 'Chat', 'shift+tab')} cycles the permission mode.`),
    t('context.meter', 'context', 1, 'The ctx meter is how full the window is.'),
    t('context.compact', 'context', 1, '/compact folds old turns into a summary.', 'compact'),
    t('sessions.switch', 'sessions', 1, '/sessions switches sessions in place.', 'sessions'),
    t('agents.delegate', 'agents', 1, 'Delegate side work: ask for an agent.'),
    t('keys.help', 'keys', 1, '/help lists every command and shortcut.', 'help'),
    t('keys.shortcuts', 'keys', 1, '? on an empty prompt shows shortcuts.'),
    t('context.auto', 'context', 2, 'A full meter compacts on its own.'),
    t('context.steer', 'context', 2, 'Words after /compact steer its summary.', 'compact'),
    t('context.clear', 'context', 2, '/clear starts fresh, freeing the window.', 'clear'),
    t('context.draw', 'context', 2, '/context draws what fills the window.', 'context'),
    t('models.switch', 'models', 2, '/model switches the model mid-session.', 'model'),
    t('models.effort', 'models', 2, '/effort sets how hard the model thinks.', 'effort'),
    t('models.range', 'models', 2, 'Low effort is fastest; high is thorough.'),
    t('models.logins', 'models', 2, '/logins signs in another provider.', 'logins'),
    t('models.usage', 'models', 2, '/usage shows what each account has left.', 'usage'),
    t('sessions.resume', 'sessions', 2, '/resume reopens any earlier session.', 'resume'),
    t('sessions.flip', 'sessions', 2, `Empty prompt: ${keyHintLabel('⌥←→')} flips sessions.`),
    t('sessions.switcher', 'sessions', 2, `${chord('command:sessions', 'Global', 'ctrl+x s')} opens the session switcher.`),
    t('sessions.rename', 'sessions', 2, '/rename names this session for later.', 'rename'),
    t('sessions.rewind', 'sessions', 2, '/rewind goes back to a saved point.', 'rewind'),
    t('sessions.recap', 'sessions', 2, 'Resumed sessions greet you with a recap.'),
    t('look.appearance', 'sessions', 2, '/appearance picks theme, accent, motion.', 'appearance'),
    t('keys.palette', 'keys', 2, `${chord('app:commandPalette', 'Global', 'ctrl+x p')} opens the command palette.`),
    t('keys.history', 'keys', 2, `${chord('history:search', 'Global', 'ctrl+r')} searches your prompt history.`),
    t('keys.pager', 'keys', 2, `${chord('app:toggleTranscript', 'Global', 'ctrl+o')} opens the transcript pager.`),
    t('keys.file', 'keys', 2, `${chord('app:fileOpen', 'Global', 'ctrl+x f')} opens a file by path.`),
    t('keys.grep', 'keys', 2, `${chord('app:contentSearch', 'Global', 'ctrl+x g')} searches file contents.`),
    t('keys.background', 'keys', 2, `${chord('task:background', 'Task', 'ctrl+b')} backgrounds a running task.`),
    t('keys.surfaces', 'keys', 2, `${chord('command:surfaces', 'Global', 'ctrl+x m')} lists every surface, grouped.`),
    t('keys.keys', 'keys', 2, '/keys shows every key in effect.', 'keys'),
    t('mcp.permissions', 'mcp', 2, '/permissions: what runs free, what asks.', 'permissions'),
    t('mcp.list', 'mcp', 2, '/mcp lists servers and toggles each.', 'mcp'),
    t('mcp.kill', 'mcp', 2, '/kill turns a tool off for this session.', 'kill'),
    t('minerva.note', 'minerva', 2, 'Type /note to keep a thought for later.', 'note', notepadWorld),
    t('context.window', 'context', 3, '/auto-compact-window sets the fold size.', 'auto-compact-window'),
    t('models.cap', 'models', 3, 'Unserved effort runs the nearest level.'),
    t('models.submodels', 'models', 3, '/submodels seats Minerva and Console.', 'submodels'),
    t('mcp.extensions', 'mcp', 3, '/extensions installs from added sources.', 'extensions'),
    t('agents.workflows', 'agents', 3, '/workflows shows runs, live and past.', 'workflows', fleetWorld),
    t('agents.teammates', 'agents', 3, '/teammates shows the crew, live.', 'teammates', fleetWorld),
    t('agents.build', 'agents', 3, '/agents lets you build your own agents.', 'agents'),
    t('agents.fleet', 'agents', 3, '/fleet is the command-center for agents.', 'fleet', fleetCenter),
    t('agents.run', 'agents', 3, "/run inspects the live run's evidence.", 'run'),
    t('worktrees.ask', 'worktrees', 3, 'Ask for a worktree to keep main clean.'),
    t('worktrees.done', 'worktrees', 3, 'Done in a worktree? Keep it or drop it.'),
    t('worktrees.realms', 'worktrees', 3, '/realms lists the folders you trust.', 'realms'),
    t('worktrees.orient', 'worktrees', 3, '/orient maps a new repo in one read.', 'orient', repoSurfaceMapEnabled),
    t('worktrees.branch', 'worktrees', 3, '/branch asks a side question, no derail.', 'branch'),
    t('minerva.tabula', 'minerva', 3, '/tabula asks Minerva to refine a prompt.', 'tabula', notepadWorld),
    t('minerva.tidy', 'minerva', 3, '/minerva turns your words into notes.', 'minerva', notepadWorld),
    t('minerva.free', 'minerva', 3, 'Minerva bills one call per line sent.', undefined, notepadWorld),
    t('minerva.outlive', 'minerva', 3, 'Notes outlive /clear: they live on disk.', 'note', notepadWorld),
  ]
}

let bank: readonly Tip[] | null = null

export function tipBank(): readonly Tip[] {
  bank ??= buildBank()
  return bank
}

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
  return [...tipBank().map(tip => tip.text), ...Object.values(MOMENT_LINES).flat()]
}
