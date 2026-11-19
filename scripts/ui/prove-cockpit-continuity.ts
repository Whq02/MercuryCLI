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

{
  const { openStatusPart } = await import('./chatScenarios.ts');
  const { IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.ts');
  const status = await openStatusPart('cockpit-continuity-status', { keepHome: true });
  const flying = { ...IDLE_LIVE, inFlight: true, phase: 'thinking' as const };
  const quiet = { seatLive: flying, toolJSX: null, toolUseConfirmQueue: [], isStopping: false, textActive: false, streamingSuppressed: false, messages: [] };
  const slot = async (over: Parameters<typeof status.plant>[0]): Promise<boolean> => {
    await status.plant({ ...quiet, ...over } as never);
    return status.part.value().spinnerSlotReserved;
  };
  const row = (): string => (status.handed.spinner !== null ? 'spinner' : status.handed.hold !== null ? 'hold' : 'none');
  const gates = {
    flying: await slot({}),
    stopping: await slot({ seatLive: IDLE_LIVE, isStopping: true }),
    resting: await slot({ seatLive: IDLE_LIVE }),
    dialog: await slot({ toolJSX: { jsx: null, shouldHidePromptInput: false } as never }),
    dialogWithSpinner: await slot({ toolJSX: { jsx: null, shouldHidePromptInput: false, showSpinner: true } as never }),
    card: await slot({ toolUseConfirmQueue: [{ toolUseID: 'toolu_gate' }] as never }),
  };
  await slot({});
  const plain = row();
  const streamingSlot = await slot({ textActive: true });
  const streaming = row();
  await slot({ textActive: true, streamingSuppressed: true });
  const suppressed = row();
  await slot({ textActive: true, toolUseConfirmQueue: [{ toolUseID: 'toolu_gate' }] as never });
  const streamingUnderCard = row();
  await slot({ seatLive: IDLE_LIVE });
  const restingQuiet = row();
  await slot({ toolUseConfirmQueue: [{ toolUseID: 'toolu_gate' }] as never });
  const thinkingUnderCard = row();
  await status.close();
  check(
    'spinnerSlotReserved carries every non-streaming gate',
    gates.flying && gates.stopping && !gates.resting && !gates.dialog && gates.dialogWithSpinner && !gates.card,
    JSON.stringify(gates),
  );
  check(
    'showSpinner = slot && the streaming-prose swap only',
    plain === 'spinner' && streaming === 'hold' && suppressed === 'spinner' && streamingUnderCard === 'none' && restingQuiet === 'none' && thinkingUnderCard === 'none',
    `${plain} · ${streaming} · ${suppressed} · ${streamingUnderCard} · ${restingQuiet} · ${thinkingUnderCard}`,
  );
  check(
    'the streaming hold keeps the 1-row slot while prose streams',
    streamingSlot && streaming === 'hold',
    `${streamingSlot} · ${streaming}`,
  );
}
const holdRow = readFileSync('src/components/Spinner/StreamingHoldRow.tsx', 'utf8');
check(
  'StreamingHoldRow itself is the slot footprint: one row until the turn took two (the strip height latch, keyed by the turn clock)',
  /<Box height=\{stripLines\} width="100%">/.test(holdRow) &&
    holdRow.includes('const stripLines = turnStripLines(loadingStartTimeRef.current, 1)'),
);

const home = readFileSync('src/components/MercuryHome.tsx', 'utf8');
check(
  'berth art rides a fixed dock-height slot, bottom-aligned',
  /height=\{SQUARE_DOCK_ART_LINES\}[\s\S]{0,120}justifyContent="flex-end"/.test(home.slice(home.indexOf('export function PinnedCritterBerth'))),
);
const { SQUARE_DOCK_ART_LINES } = await import('../../src/utils/cockpit/critterData.js');
check(
  `the slot constant derives from the grids (dock=${SQUARE_DOCK_ART_LINES})`,
  Number.isInteger(SQUARE_DOCK_ART_LINES) && SQUARE_DOCK_ART_LINES >= 3,
);

process.exit(fail);
