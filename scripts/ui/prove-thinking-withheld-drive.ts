import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADMITTED, check, drive, endLeg, FACE_READY, finish, printFrame, requireCaptureDriver, scratch, startLeg } from '../computer/computerDriveKit.ts'

const frameAt = process.argv.indexOf('--frames')
const frames = frameAt < 0 ? null : process.argv[frameAt + 1]!
if (frames) mkdirSync(frames, { recursive: true })
const driver = requireCaptureDriver('thinking-withheld-drive')
const cwd = join(scratch, 'project')
mkdirSync(cwd, { recursive: true })
const leg = await startLeg('thinking-withheld', [
  { kind: 'stream', blocks: [{ type: 'thinking', deltas: [''] }, { type: 'thinking', deltas: [''] }, { type: 'text', deltas: ['Private reasoning answer.'] }], gapMs: 0 },
  { kind: 'text', thinking: 'Visible reasoning body.', text: 'Visible reasoning answer.' },
], null, cwd)
const gate = { requireAwait: true, minTick: 2, awaitSettleTicks: 4 }
const CLICK = '\x1b[<0;{X};{Y}M\x1b[<0;{X};{Y}m'
const fact = 'the provider returned no thinking text for this model'
try {
  const result = await drive(driver, leg, { cols: 140, rows: 50 }, [
    { ...gate, awaitText: FACE_READY, data: '\r' },
    { ...gate, awaitText: ADMITTED, data: 'private reasoning' },
    { ...gate, awaitText: '❯ private reasoning', data: '\r' },
    { ...gate, awaitText: 'Private reasoning answer.', data: '', mark: 'default' },
    { ...gate, awaitText: 'Private reasoning answer.', targetText: 'Private reasoning answer.', targetDx: 3, data: CLICK },
    { ...gate, awaitText: 'Private reasoning answer.', data: '', mark: 'clicked' },
    { ...gate, awaitText: 'Private reasoning answer.', targetText: 'Private reasoning answer.', targetDx: 3, data: CLICK },
    { ...gate, awaitText: 'Private reasoning answer.', data: '', mark: 'closed' },
    { ...gate, awaitText: 'Private reasoning answer.', data: '\x0f' },
    { ...gate, awaitText: 'Private reasoning answer.', data: '', mark: 'transcript' },
    { ...gate, awaitText: 'Private reasoning answer.', data: '\x0f' },
    { ...gate, awaitText: ADMITTED, data: 'visible reasoning' },
    { ...gate, awaitText: '❯ visible reasoning', data: '\r' },
    { ...gate, awaitText: 'Visible reasoning answer.', data: '', mark: 'visible-default' },
    { ...gate, awaitText: 'Visible reasoning answer.', targetText: 'thinking… ⌄', targetDx: 3, data: CLICK },
    { ...gate, awaitText: 'Visible reasoning answer.', data: '', mark: 'visible-clicked' },
  ], 500, { MERCURY_DESKTOP_DRIVER: 'none', MERCURY_SPLASH: 'off', MERCURY_REDUCED_MOTION: '1', MERCURY_DAEMON_DIR: 'daemon', TMPDIR: '.' }, 'Visible reasoning answer.')
  for (const [name, rows] of Object.entries(result.marks)) {
    printFrame(name, rows)
    if (frames) writeFileSync(join(frames, `thinking-withheld-${name}.txt`), rows.join('\n') + '\n')
  }
  if (result.status !== 0) printFrame('capture stopped', result.final)
  const text = (name: string): string => (result.marks[name] ?? []).join('\n')
  const count = (name: string): number => text(name).split(fact).length - 1
  check('the cockpit completed every gesture', result.status === 0 && result.endReason === 'ready' && Object.keys(result.marks).length === 6, `gesture script did not finish (see the printed frames; the drive is in scripts/computer/computerDriveKit.ts) ${result.status} ${result.endReason} ${result.stderr.slice(-300)}`)
  check('private thinking paints no default row', !text('default').includes('thinking…') && count('default') === 0, 'a turn whose thinking blocks came back empty must show no thinking row and no withheld note until clicked; see WITHHELD_THINKING_WORDS in src/screen/messages/thinkingGrammar.tsx.')
  check('clicking the answer discloses one fact for the whole turn', count('clicked') === 1, 'one click on the answer must show the withheld note once for the turn, found ' + count('clicked') + '; see src/screen/messages/thinkingGrammar.tsx.')
  check('clicking again closes the fact', count('closed') === 0, 'the second click must hide the withheld note, found ' + count('closed') + '; see src/screen/messages/thinkingGrammar.tsx.')
  check('ctrl+o discloses one fact for the whole turn', count('transcript') === 1, 'ctrl+o must show the withheld note once for the turn, found ' + count('transcript') + '; see src/screen/messages/thinkingGrammar.tsx.')
  check('returned thinking keeps its collapsed cue', /thinking….*(?:⌄|to expand)/.test(text('visible-default')) && !text('visible-default').includes('Visible reasoning body.'), 'a turn with returned thinking must show the thinking cue collapsed and hide the body; see ThinkingLabel in src/screen/messages/thinkingGrammar.tsx.')
  check('returned thinking still opens on click', text('visible-clicked').includes('Visible reasoning body.'), 'clicking the thinking cue must open the returned thinking body; see src/screen/messages/thinkingGrammar.tsx.')
} finally {
  await endLeg(leg)
  rmSync(scratch, { recursive: true, force: true })
}
finish('thinking-withheld-drive')
