import { getCommandName } from '../../../commands/catalogue/commands.js';
import { HELD_FOR_COMPACTION_LINE } from '../../messages/TranscriptNameplate.js';
import * as pendingInput from '../../composer/input-core/pending-input.js';
import { hasFocusedSession, landingInFlight } from '../../../engine/connector/focusedConnector.js';
import type { SendReceiptV1 } from '../../../engine/connector/types.js';
import { RECEIPT_TIMEOUT_MS } from '../limits.js';
import { armForLanding, takeComposer, type SubmitDeps, type SubmitLine } from './submitLine.js';

export function holdForLanding(deps: SubmitDeps, line: SubmitLine): boolean {
  const { addNotification } = deps;
  if (landingInFlight() && !hasFocusedSession()) {
    armForLanding(deps, line);
    addNotification({ key: 'landing-hold', text: 'the session is landing — your line sends when it lands', priority: 'immediate', timeoutMs: RECEIPT_TIMEOUT_MS });
    return true;
  }
  return false;
}

export function sendToSession(deps: SubmitDeps, line: SubmitLine): Promise<void> {
  const { addNotification, repinToBottom, setSubmitCount, isLoadingRef, getFocusedSeatLive } = deps;
  const { text, options, focusedNow, seatMode, seatPastes, seatCommand } = line;
  takeComposer(deps, line);
  repinToBottom();
  setSubmitCount(count => count + 1);
  if (seatCommand !== undefined && isLoadingRef.current) {
    const name = getCommandName(seatCommand);
    const when = name === 'compact' ? 'at the next step or when the turn ends' : 'when the current turn ends';
    addNotification({
      key: 'session-command-queued',
      text: `/${name} queued — runs ${when} (esc interrupts the turn)`,
      priority: 'immediate',
      timeoutMs: RECEIPT_TIMEOUT_MS,
    });
  }
  if (getFocusedSeatLive().phase === 'compacting') {
    addNotification({
      key: 'held-for-compaction',
      text: HELD_FOR_COMPACTION_LINE,
      priority: 'immediate',
      timeoutMs: RECEIPT_TIMEOUT_MS,
    });
  }
  const sent = focusedNow
    .sendWords(text, {
      mode: seatMode,
      pastedContents: seatPastes,
      ...(options?.fromKeybinding ? { fromKeybinding: true } : {}),
    })
    .then(receipt => handBackRefusedLine(deps, line, receipt));
  return sent;
}

function handBackRefusedLine(deps: SubmitDeps, line: SubmitLine, receipt: SendReceiptV1): void {
  const { addNotification, setInputValue, setInputMode, setPastedContents, armedHandedBackRef } = deps;
  const { input, seatPastes } = line;
  if (receipt.state !== 'refused') {
    const note = receipt.state === 'pending' ? receipt.detail : receipt.note;
    if (note !== undefined && note !== '') {
      addNotification({
        key: 'focused-session-send-note',
        text: note,
        priority: 'high',
        timeoutMs: RECEIPT_TIMEOUT_MS,
      });
    }
    return;
  }
  const handedBack = armedHandedBackRef.current;
  if (pendingInput.text() === '') {
    if (pendingInput.restoreStaged(input) === null) setInputValue(input);
    setPastedContents(seatPastes);
    if (handedBack !== null) {
      setInputMode('prompt');
      armedHandedBackRef.current = { text: pendingInput.text(), pastedContents: seatPastes };
    }
  } else if (handedBack !== null && handedBack.text !== '' && pendingInput.text() === handedBack.text) {
    const pastedContents = { ...handedBack.pastedContents, ...seatPastes };
    setInputValue(`${handedBack.text}\n${input}`);
    setPastedContents(pastedContents);
    armedHandedBackRef.current = { text: pendingInput.text(), pastedContents };
  }
  addNotification({
    key: 'focused-session-send',
    text: receipt.detail,
    priority: 'high',
    color: 'error' as const,
    timeoutMs: RECEIPT_TIMEOUT_MS,
  });
}
