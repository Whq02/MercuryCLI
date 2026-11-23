process.env.NODE_ENV = 'test';

import { execFileSync } from 'node:child_process';

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};

const { permissionQueueStatus } = await import(
  '../../src/permissions/cards/PermissionQueueContext.js'
);
const seq = [
  permissionQueueStatus(0, 3),
  permissionQueueStatus(1, 2),
  permissionQueueStatus(2, 1),
];
check('3-request sequence reads 1/3 → 2/3 → 3/3',
  seq[0]!.position === 1 && seq[0]!.total === 3 &&
  seq[1]!.position === 2 && seq[1]!.total === 3 &&
  seq[2]!.position === 3 && seq[2]!.total === 3,
  JSON.stringify(seq) + ' | fix permissionQueueStatus (position and total) in src/permissions/cards/PermissionQueueContext.ts');
const grown = permissionQueueStatus(1, 3);
check('mid-sequence arrival grows total truthfully (2/4)',
  grown.position === 2 && grown.total === 4, JSON.stringify(grown) + ' | fix permissionQueueStatus in src/permissions/cards/PermissionQueueContext.ts so total is resolved plus waiting');
const lone = permissionQueueStatus(0, 1);
check('lone request is 1/1 (marker hidden by the total>1 gate)',
  lone.position === 1 && lone.total === 1,
  JSON.stringify(lone) + ' | fix permissionQueueStatus in src/permissions/cards/PermissionQueueContext.ts');


const { mountPart, openAsksPart } = await import('./chatScenarios.ts');
const { settle, waitFor } = await import('../lib/settingsPopupHarness.ts');
const asks = await openAsksPart('consent-queue-marker');
await asks.setAsks([asks.ask('toolu_q1', 'touch one.txt'), asks.ask('toolu_q2', 'touch two.txt'), asks.ask('toolu_q3', 'touch three.txt')]);
asks.part.value().resolveHeadPermission();
await settle(80);
const afterOne = { resolved: asks.part.value().resolvedConsentCount, waiting: asks.part.value().toolUseConfirmQueue.length, calls: asks.calls.join() };
const card = await mountPart(
  () => asks.module.useChatAsksCard({ focusedInputDialog: 'tool-permission', repinToBottom: () => {}, toolUseConfirmQueue: asks.part.value().toolUseConfirmQueue, resolvedConsentCount: afterOne.resolved, resolveHeadPermission: () => {}, chatSurfaceCovered: false, verbose: false }),
  { columns: 110, rows: 24, draw: value => value.permissionOverlay },
);
await waitFor(() => card.view.lines().join('\n').includes('touch two.txt'), 4000);
const headCard = card.view.lines().join('\n');
card.unmount();
check('provider wraps the head PermissionRequest',
  headCard.includes('touch two.txt') && headCard.includes('2/3'), headCard + ' | fix useChatAsksCard in src/screen/chat/useChatAsks.tsx so the head card shows its queue marker');
check('resolve advances the sequence in the same handler as the settle (the connector owns the pop)',
  afterOne.resolved === 1 && afterOne.waiting === 2 && afterOne.calls === 'settleAsk toolu_q1', JSON.stringify(afterOne) + ' | fix resolveHeadPermission in src/screen/chat/useChatAsks.tsx so it settles the head ask and advances the resolved count in one handler');
asks.part.value().resolveHeadPermission();
await settle(80);
asks.part.value().resolveHeadPermission();
await settle(80);
check('sequence resets when the queue drains',
  asks.part.value().toolUseConfirmQueue.length === 0 && asks.part.value().resolvedConsentCount === 0, `${asks.part.value().toolUseConfirmQueue.length} waiting, ${asks.part.value().resolvedConsentCount} resolved | fix src/screen/chat/useChatAsks.tsx (resolveHeadPermission) so resolvedConsentCount returns to 0 when the queue drains`);
await asks.close();

process.exit(fail);
