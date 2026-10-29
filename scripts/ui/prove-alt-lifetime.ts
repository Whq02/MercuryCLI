import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};

const alt = readFileSync('src/ink/components/AlternateScreen.tsx', 'utf8');
check(
  'alt-screen effect deps exclude the mouse prop (lifetime never cycles on it)',
  alt.includes('}, [writeRaw, inkFromContext]);') && !alt.includes('mouseTracking]'),
);
check(
  'mouse pref read through a mount-time ref',
  alt.includes('mouseTrackingRef.current') && alt.includes('const mouseTrackingRef = useRef(mouseTracking)'),
);
check(
  'final exit disables tracking unconditionally (mid-life /mouse on covered)',
  alt.includes('DISABLE_ALTERNATE_SCROLL + DISABLE_MOUSE_TRACKING + EXIT_ALT_SCREEN'),
);

check(
  'outermost mount skips ENTER/2J when the launcher holds the buffer',
  alt.includes('const launcherHolds = consumeLauncherAltHold();') &&
    alt.includes("writeRaw(RESET_SCROLL_REGION + '\\x1b[0m' + armBytes);"),
);
check(
  'no-hold mount defers entry through ink.armAltScreenEntry',
  alt.includes('ink.armAltScreenEntry(ENTER_ALT_SCREEN + RESET_SCROLL_REGION') &&
    !alt.includes("writeRaw(\n        (launcherHolds ? '' : ENTER_ALT_SCREEN)"),
);
{
  const inkSrcEarly = readFileSync('src/ink/ink.tsx', 'utf8');
  check(
    'armAltScreenEntry flushes only into a NON-EMPTY frame write',
    /pendingAltEntry !== null && this\.altScreenActive && hasDiff/.test(inkSrcEarly),
  );
  check(
    'an armed entry dies when the alt mode drops before flushing',
    /setAltScreenActive\(active[\s\S]{0,900}pendingAltEntry = null/.test(inkSrcEarly),
  );
}
check(
  'takeover arms the atomic first-frame erase',
  alt.includes('if (launcherHolds) ink?.armAltScreenTakeover();'),
);
const ink = readFileSync('src/ink/ink.tsx', 'utf8');
check(
  'armAltScreenTakeover rides the SAME atomic seam as resize (needsEraseBeforePaint)',
  /armAltScreenTakeover\(\): void \{\s*\n\s*this\.needsEraseBeforePaint = true;/.test(ink),
);

const out = execFileSync(
  process.execPath.includes('bun') ? process.execPath : `${process.env.HOME}/.bun/bin/bun`,
  [
    '-e',
    `const m = await import('./src/ink/launcherAltHold.ts');
     console.log(JSON.stringify([m.launcherAltHoldPending(), m.consumeLauncherAltHold(), m.consumeLauncherAltHold(), process.env.MERCURY_ALT_HELD ?? null]));`,
  ],
  { encoding: 'utf8', env: { ...process.env, MERCURY_ALT_HELD: '1' } },
).trim();
check(
  'one-shot semantics: pending → consumed once → env deleted',
  out === '[true,true,false,null]',
  out,
);
const module_ = readFileSync('src/ink/launcherAltHold.ts', 'utf8');
check(
  'early-exit safety net releases an unconsumed hold',
  module_.includes("process.on('exit'") && module_.includes('\\x1b[0m\\x1b[?1007l\\x1b[?1049l\\x1b[?25h'),
);

const launcher = readFileSync('scripts/ops/launcher-mercury.sh', 'utf8');
check(
  'launcher exports MERCURY_ALT_HELD=1 on the exit-0 held handoff, NO_FLICKER-gated',
  launcher.includes('export MERCURY_ALT_HELD=1') &&
    launcher.includes('[ "$MERCURY_SA_EXIT" = "0" ] && [ "${MERCURY_FULLSCREEN:-}" != "0" ]'),
);

process.exit(fail);
