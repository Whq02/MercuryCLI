import { readFileSync } from 'node:fs';

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};

const MUST_RIDE_THE_BEAT = [
  'src/components/MercuryHome.tsx',
  'src/components/CockpitView.tsx',
  'src/components/mercury-ui/components.tsx',
  'src/components/MercuryFullscreen.tsx',
  'src/components/Settings/Status.tsx',
];

for (const file of MUST_RIDE_THE_BEAT) {
  const src = readFileSync(file, 'utf8');
  const rides = src.includes('useCwdState');
  const plainReads = /\bgetCwd\s*\(\s*\)/.test(src);
  check(`${file.split('/').pop()} rides the ground beat (useCwdState)`, rides);
  check(`${file.split('/').pop()} has no plain getCwd() render sample`, !plainReads);
}

{
  const src = readFileSync('src/hooks/useCwdState.ts', 'utf8');
  check(
    'useCwdState rides useSyncExternalStore over subscribeCwdState',
    src.includes('useSyncExternalStore') && src.includes('subscribeCwdState'),
  );
}

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
  const workViews = readFileSync('src/components/tasks/useFocusedWork.ts', 'utf8');
  check('the work views define no second useFocusedWorkspaceCwd', !workViews.includes('export function useFocusedWorkspaceCwd'));
  const board = readFileSync('src/components/tasks/WorkflowsBoard.tsx', 'utf8');
  check('the workflows board rides the owner hook', board.includes("from '../../hooks/useFocusedWorkspaceCwd.js'"));
}

process.exit(fail);
