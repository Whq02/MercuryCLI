
let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};


{
  const { openStatusPart } = await import('./chatScenarios.ts');
  const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts');
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
    dialog: await slot({ toolJSX: { jsx: null, shouldHideComposer: false } as never }),
    dialogWithSpinner: await slot({ toolJSX: { jsx: null, shouldHideComposer: false, showSpinner: true } as never }),
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
    `${JSON.stringify(gates)} — what to change: the spinnerSlotReserved condition in useChatStatus, src/screen/chat/useChatStatus.tsx`,
  );
  check(
    'showSpinner = slot && the streaming-prose swap only',
    plain === 'spinner' && streaming === 'hold' && suppressed === 'spinner' && streamingUnderCard === 'none' && restingQuiet === 'none' && thinkingUnderCard === 'none',
    `${plain} · ${streaming} · ${suppressed} · ${streamingUnderCard} · ${restingQuiet} · ${thinkingUnderCard} — what to change: the showSpinner and hold rows derived from spinnerSlotReserved in useChatStatus, src/screen/chat/useChatStatus.tsx`,
  );
  check(
    'the streaming hold keeps the 1-row slot while prose streams',
    streamingSlot && streaming === 'hold',
    `${streamingSlot} · ${streaming} — what to change: the streaming hold branch beside spinnerSlotReserved in useChatStatus, src/screen/chat/useChatStatus.tsx`,
  );
}
const { SQUARE_DOCK_ART_LINES } = await import('../../src/screen/cockpit/critterData.js');
check(
  `the slot constant derives from the grids (dock=${SQUARE_DOCK_ART_LINES})`,
  Number.isInteger(SQUARE_DOCK_ART_LINES) && SQUARE_DOCK_ART_LINES >= 3,
  'what to change: SQUARE_DOCK_ART_LINES must stay an integer of at least 3, derived from CRITTERS in src/screen/cockpit/critterData.ts',
);

process.exit(fail);
