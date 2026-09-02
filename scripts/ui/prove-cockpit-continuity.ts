import { readFileSync } from 'node:fs';

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};

const capsule = readFileSync('src/components/mercury-ui/WorkCapsule.tsx', 'utf8');
check(
  'WorkCapsule never early-returns bare children (stable tree shape)',
  !/if \(!active[^)]*\) return children/.test(capsule) && !/return children\b/.test(capsule),
);
check(
  'chassis toggles by PROP VALUES (borderStyle/paddingX conditional on dressed)',
  capsule.includes("borderStyle={dressed ? 'round' : undefined}") &&
    capsule.includes('paddingX={dressed ? 1 : 0}'),
);
check(
  'providers always mounted (WorkCapsuleContext + TerminalSizeContext)',
  capsule.includes('<WorkCapsuleContext.Provider value={dressed}>') &&
    capsule.includes('<TerminalSizeContext.Provider value={sizeVal}>'),
);
check(
  'inner size context memoized (no per-render identity churn for consumers)',
  capsule.includes('React.useMemo'),
);

const repl = readFileSync('src/screens/REPL.tsx', 'utf8');
check(
  'spinnerSlotReserved carries every non-streaming gate',
  repl.includes('const spinnerSlotReserved = (!toolJSX || toolJSX.showSpinner === true)'),
);
check(
  'showSpinner = slot && the streaming-prose swap only',
  /const showSpinner = spinnerSlotReserved && \(\s*\n\s*\/\/ Hide spinner when streaming text is visible/.test(repl),
);
check(
  'the streaming hold keeps the 1-row slot while prose streams',
  /: spinnerSlotReserved \? <StreamingHoldRow [\s\S]{0,220}\/> : null\}/.test(repl),
);
check(
  'StreamingHoldRow itself is a height-1 row (the slot footprint)',
  /<Box height=\{1\} width="100%">/.test(
    readFileSync('src/components/Spinner/StreamingHoldRow.tsx', 'utf8'),
  ),
);

const home = readFileSync('src/components/MercuryHome.tsx', 'utf8');
check(
  'berth art rides a fixed per-form slot (hero/square), bottom-aligned',
  home.includes('height={heroFits ? HERO_ART_LINES : SQUARE_ART_LINES}') &&
    /height=\{heroFits \? HERO_ART_LINES : SQUARE_ART_LINES\}[\s\S]{0,120}justifyContent="flex-end"/.test(home),
);
const { HERO_ART_LINES, SQUARE_ART_LINES } = await import('../../src/utils/cockpit/critterData.js');
check(
  `slot constants derive from the grids (hero=${HERO_ART_LINES}, square=${SQUARE_ART_LINES})`,
  Number.isInteger(HERO_ART_LINES) && HERO_ART_LINES >= 7 &&
    Number.isInteger(SQUARE_ART_LINES) && SQUARE_ART_LINES >= 6,
);

process.exit(fail);
