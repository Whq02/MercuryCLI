// prove-cwd-ground-beat — chrome that names the session's folder SUBSCRIBES
// to the ground-move beat (bootstrap subscribeCwdState, ridden as
// useCwdState()).
//
// The bug class (Law 9 residue, census rows A1/A2): standing chrome read
// getCwd() at render with no subscription channel, so a concourse repo pick
// painted the BOOT folder until an unrelated re-render healed it. Each row's
// poison is the residue shape it names — re-introduce a plain getCwd()
// render sample in a listed file and its row goes red.
//
// The beat's runtime semantics (emit-after-write, normalized value, reset
// law) are proven in scripts/core-runtime/prove-state-contract.ts LAW 14b;
// the same-frame repaint evidence is the picked-repo PTY drive. This
// file locks the SOURCE SHAPE so the class cannot silently return.
import { readFileSync } from 'node:fs';

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};

// Standing chrome whose dir chip must ride the beat: the hook present, the
// plain ambient read gone. (getCwd() ANYWHERE in these files is the poison:
// every one of their cwd reads is a folder-naming render read.)
const MUST_RIDE_THE_BEAT = [
  'src/components/MercuryHome.tsx',
  'src/components/CockpitView.tsx',
  'src/components/mercury-ui/components.tsx',
  'src/components/MercuryFullscreen.tsx',
  // census A12: the /status panel's cwd row (the screen's ground, live).
  'src/components/Settings/Status.tsx',
];

for (const file of MUST_RIDE_THE_BEAT) {
  const src = readFileSync(file, 'utf8');
  const rides = src.includes('useCwdState');
  const plainReads = /\bgetCwd\s*\(\s*\)/.test(src);
  check(`${file.split('/').pop()} rides the ground beat (useCwdState)`, rides);
  check(`${file.split('/').pop()} has no plain getCwd() render sample`, !plainReads);
}

// The hook IS the seam ride: useSyncExternalStore over the one subscribable
// cwd cell. A rewrite to polling or to a mount-pinned useState is the poison.
{
  const src = readFileSync('src/hooks/useCwdState.ts', 'utf8');
  check(
    'useCwdState rides useSyncExternalStore over subscribeCwdState',
    src.includes('useSyncExternalStore') && src.includes('subscribeCwdState'),
  );
}

// /export homes by the SESSION (census A3): both the dialog and the
// `/export <name>` args path read the connector's workspace door, never the
// screen process's cwd. The poison is a getCwd() return in either file —
// the export landing in the boot folder for a hopped session. The dialog's
// SHOWN path rides the door's full feed (both beats — the feed block below);
// a private ride on the ground beat alone is the half-feed poison:
// harnessGround emits that beat BEFORE the blank chat re-grounds, and a hop
// never emits it, so the shown path re-read the OLD folder every time.
{
  const dialog = readFileSync('src/components/ExportDialog.tsx', 'utf8');
  check('ExportDialog shows the door through the shared feed hook', dialog.includes('useFocusedWorkspaceCwd()'));
  check('ExportDialog writes by the door at call time', dialog.includes('getFocusedWorkspaceCwd()'));
  check('ExportDialog carries no private half-feed (no direct subscribeCwdState ride)', !dialog.includes('subscribeCwdState'));
  check('ExportDialog has no screen-cwd read (getCwd)', !/\bgetCwd\s*\(\s*\)/.test(dialog));
  const cmd = readFileSync('src/commands/export/export.tsx', 'utf8');
  check(
    '/export args path homes by the workspace door',
    cmd.includes('.workspace().cwd') && cmd.includes('getFocusedSessionConnector'),
  );
  check('/export args path has no screen-cwd read (getCwd)', !/\bgetCwd\s*\(\s*\)/.test(cmd));
}

// THE DOOR'S FEED (one owner, hooks/useFocusedWorkspaceCwd): the FOCUSED
// SESSION's folder (the connector's workspace door) through a feed that
// hears BOTH the ground beat and the focused-slot signal. MercuryFrame's
// strip is the class exemplar (census A1): the always-mounted, memo'd strip
// named the boot folder after a repo pick until an unrelated re-render.
// Poison: a feed missing either beat (the slot signal is what harnessGround
// emits AFTER the in-place re-ground; the ground beat is what every other
// ground move emits), a consumer sampling the door unsubscribed, or a
// second private copy of the feed beside the owner.
{
  const feed = readFileSync('src/hooks/useFocusedWorkspaceCwd.ts', 'utf8');
  check('the feed reads the workspace door', feed.includes('.workspace().cwd'));
  check('the feed hears the ground beat (subscribeCwdState)', feed.includes('subscribeCwdState(listener)'));
  check('the feed hears the focused-slot signal', feed.includes('subscribeFocusedSessionConnector(listener)'));
  check(
    'the feed rides useSyncExternalStore over both beats',
    /useSyncExternalStore\(\s*subscribeFocusedWorkspace,\s*getFocusedWorkspaceCwd/.test(feed),
  );
  const frame = readFileSync('src/components/MercuryFrame.tsx', 'utf8');
  check('MercuryFrame rides the shared feed hook', frame.includes('useFocusedWorkspaceCwd()'));
  check(
    'MercuryFrame has no plain unsubscribed cwd sample',
    !/const cwd = getFocusedSessionConnector\(\)\.workspace\(\)\.cwd/.test(frame),
  );
  check('MercuryFrame keeps no private copy of the feed', !frame.includes('subscribeCwdState('));
  // The work views ride the same owner: a second `useFocusedWorkspaceCwd`
  // beside the hook (fed off the roster's beat) split the concept in two —
  // one name, two feeds.
  const workViews = readFileSync('src/components/tasks/useFocusedWork.ts', 'utf8');
  check('the work views define no second useFocusedWorkspaceCwd', !workViews.includes('export function useFocusedWorkspaceCwd'));
  const board = readFileSync('src/components/tasks/WorkflowsBoard.tsx', 'utf8');
  check('the workflows board rides the owner hook', board.includes("from '../../hooks/useFocusedWorkspaceCwd.js'"));
}

process.exit(fail);
