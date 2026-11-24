import type { ReactNode } from 'react';
import { getCommandName, type Command } from '../../../commands/catalogue/commands.js';
import * as pendingInput from '../../composer/input-core/pending-input.js';
import { createAbortController } from '../../../platform/async/abortController.js';
import { isSettingsPopupOpen } from '../../cockpit/settingsPopup.js';
import { logForDebugging } from '../../../platform/logs/debugLog.js';
import { submitTrace } from '../submitTrace.js';
import { RECEIPT_TIMEOUT_MS } from '../limits.js';
import type { CommandArgs } from './screenCommand.js';
import { INERT_PROMPT_HELPERS, takeComposer, type SubmitDeps, type SubmitLine } from './submitLine.js';

type DialogCommand = Extract<Command, { type: 'local-jsx' }>;
type DialogSlot = { name: string; mounted: boolean };
type DialogDoneOptions = { display?: 'skip' | 'system' | 'user'; nextInput?: string; submitNextInput?: boolean; shouldStartTurn?: boolean; metaMessages?: string[] };

export function queueBehindDialog(deps: SubmitDeps, line: SubmitLine, dialogName: string): boolean {
  const { addNotification, dialogInFlightRef, queuedDialogCommandsRef } = deps;
  const { input, submittedAt, seatPastes } = line;
  const inFlight = dialogInFlightRef.current;
  if (inFlight !== null) {
    takeComposer(deps, line);
    queuedDialogCommandsRef.current.push({ input, name: dialogName, submittedAt, pastedContents: seatPastes });
    submitTrace('repl-dialog-queued', input, { name: dialogName, behind: inFlight.name });
    addNotification({
      key: 'dialog-command-queued',
      text: `/${dialogName} queued — runs when /${inFlight.name} settles`,
      priority: 'immediate',
      timeoutMs: RECEIPT_TIMEOUT_MS,
    });
    return true;
  }
  return false;
}

function releaseDialogSlot({ dialogInFlightRef, drainQueuedDialogCommand }: SubmitDeps, slot: DialogSlot): void {
  if (dialogInFlightRef.current !== slot) return;
  dialogInFlightRef.current = null;
  if (!slot.mounted) drainQueuedDialogCommand();
}

function sendAfterDialog({ addNotification }: SubmitDeps, { input, focusedNow }: SubmitLine, seatCommand: DialogCommand, dialogName: string, doneOptions: DialogDoneOptions): void {
  const metaRows = (doneOptions.metaMessages ?? []).filter(words => words.trim() !== '');
  submitTrace('repl-dialog-query', input, { name: dialogName, metaRows: metaRows.length });
  void (async () => {
    for (const words of metaRows) {
      const receipt = await focusedNow.sendWords(words, { metaFrom: { command: seatCommand.name } });
      if (receipt.state === 'refused') {
        addNotification({ key: `command-${seatCommand.name}-query`, text: `/${dialogName} could not start the turn — ${receipt.detail}`, priority: 'high', color: 'error' as const, timeoutMs: RECEIPT_TIMEOUT_MS });
        return;
      }
    }
  })();
}

export function openDialogCommand(deps: SubmitDeps, line: SubmitLine, seatCommand: DialogCommand, dialogName: string, { args }: CommandArgs) {
  const { addNotification, setInputValue, authWallHold, setToolJSX, getToolUseContext, paintScreenCommandReceipt, dialogInFlightRef, onSubmitRef } = deps;
  const { input, options, submittedAt, focusedNow } = line;
  const slot = { name: dialogName, mounted: false };
  dialogInFlightRef.current = slot;
  submitTrace('repl-dialog-dispatch', input, { name: dialogName, rearmed: options?.rearmed === true });
  if (pendingInput.text().replace(/\s+$/, '') === input) {
    pendingInput.clearForSubmit(input);
    setInputValue('');
  }
  const context = getToolUseContext([...focusedNow.records()], [], createAbortController(), focusedNow.modelFacts().effective);
  let completed = false;
  const onDone = (
    result?: string,
    doneOptions?: DialogDoneOptions,
  ): void => {
    completed = true;
    submitTrace('repl-dialog-done', input, { name: dialogName, result: (result ?? '').slice(0, 80), display: doneOptions?.display ?? 'user', shouldQuery: doneOptions?.shouldStartTurn === true });
    releaseDialogSlot(deps, slot);
    setToolJSX(null);
    if (result && doneOptions?.display !== 'skip') {
      const resultLines = result.split(/\r?\n/).filter(line => line.trim() !== '').length;
      if (resultLines > 1) paintScreenCommandReceipt(dialogName, args, result, submittedAt);
      else addNotification({ key: `command-${seatCommand.name}`, text: result, priority: 'immediate' });
    }
    if (doneOptions?.shouldStartTurn === true) {
      sendAfterDialog(deps, line, seatCommand, dialogName, doneOptions);
    }
    if (doneOptions?.nextInput) {
      if (doneOptions.submitNextInput) void onSubmitRef.current(doneOptions.nextInput, INERT_PROMPT_HELPERS);
      else setInputValue(doneOptions.nextInput);
    }
    pendingInput.popStash();
    if (seatCommand.name === 'logins' || seatCommand.name === 'model') {
      authWallHold.afterDoor(seatCommand.name, hold => {
        void onSubmitRef.current(hold.text, INERT_PROMPT_HELPERS, undefined, { rearmed: true });
      });
    }
  };
  const mountDialog = (element: ReactNode): void => {
    if (element && !completed) {
      slot.mounted = true;
      setToolJSX({ jsx: element, shouldHideComposer: false, isLocalJSXCommand: true, isImmediate: true });
    } else if (!element && !completed && !isSettingsPopupOpen()) {
      addNotification({
        key: `command-${seatCommand.name}`,
        text: `/${getCommandName(seatCommand)} had nothing to show`,
        priority: 'immediate',
        timeoutMs: RECEIPT_TIMEOUT_MS,
      });
      releaseDialogSlot(deps, slot);
    }
  };
  const failDialog = (error: unknown): void => {
    logForDebugging(`dialog command /${seatCommand.name} failed: ${String(error)}`);
    addNotification({
      key: `command-${seatCommand.name}`,
      text: `/${getCommandName(seatCommand)} failed — ${error instanceof Error ? error.message : String(error)}`,
      priority: 'high',
      color: 'error' as const,
      timeoutMs: RECEIPT_TIMEOUT_MS,
    });
    releaseDialogSlot(deps, slot);
  };
  return { context, onDone, mountDialog, failDialog };
}
