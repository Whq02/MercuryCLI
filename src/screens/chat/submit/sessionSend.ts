import { getCommandName } from '../../../commands.js';
import { HELD_FOR_COMPACTION_LINE } from '../../../components/messages/TranscriptNameplate.js';
import * as pendingInput from '../../../input-core/pending-input.js';
import { hasFocusedSession, landingInFlight } from '../../../services/engine-connector/focusedConnector.js';
import type { SendReceiptV1 } from '../../../services/engine-connector/types.js';
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
    addNotification({
      key: 'session-command-queued',
      text: `/${getCommandName(seatCommand)} queued — runs when the current turn ends (esc interrupts the turn)`,
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
    if (receipt.note !== undefined && receipt.note !== '') {
      addNotification({
        key: 'focused-session-send-note',
        text: receipt.note,
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
