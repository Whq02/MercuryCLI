import { commandOffInPlainWorld, commandSeat, getCommandName, isCommandEnabled, type Command } from '../../../commands/catalogue/commands.js';
import { addToHistory, expandPastedTextRefs } from '../../../sessions/promptHistory.js';
import * as pendingInput from '../../composer/input-core/pending-input.js';
import { getFocusedSessionConnector } from '../../../engine/connector/focusedConnector.js';
import type { CommandSeat } from '../../../commands/catalogue/command.js';
import type { PromptInputHelpers } from '../../composer/input-core/promptInputHelpers.js';
import type { PromptInputMode } from '../../composer/input-core/textInput.js';
import type { PastedContent } from '../../../platform/config/schema.js';
import { createUserMessage } from '../../../engine/messages/messages.js';
import { resolveUnknownSlashName, unavailableCommandLine, unknownCommandLine } from '../../../engine/user-input/processSlashCommand.js';
import type { useChatSubmit } from '../useChatSubmit.js';

export const INERT_PROMPT_HELPERS: PromptInputHelpers = {
  setCursorOffset: () => {},
  clearBuffer: () => {},
  resetHistory: () => {},
};

export type SubmitOptions = { fromKeybinding?: boolean; rearmed?: boolean; submittedAt?: string; pastedContents?: Record<number, PastedContent>; armedMode?: PromptInputMode };
type OnSubmit = (input: string, helpers: PromptInputHelpers, _speculationAccept?: unknown, options?: SubmitOptions) => Promise<void>;
export type SubmitDeps = Omit<Parameters<typeof useChatSubmit>[0], 'toolJSX' | 'lastCompletedAt'> & { drainQueuedDialogCommand: () => void; onSubmitRef: { current: OnSubmit } };
export type SubmitLine = {
  input: string;
  helpers: PromptInputHelpers;
  options: SubmitOptions | undefined;
  submittedAt: string;
  text: string;
  focusedNow: ReturnType<typeof getFocusedSessionConnector>;
  seatMode: PromptInputMode;
  seatPastes: Record<number, PastedContent>;
  seatCommand: Command | undefined;
  seat: 'session' | CommandSeat;
};

function resolveSlashCommand(input: string, commands: Command[]): Command | undefined {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return undefined;
  const spaceIndex = trimmed.indexOf(' ');
  const name = (spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)).trim();
  if (!name) return undefined;
  return commands.find(
    command =>
      isCommandEnabled(command) &&
      (command.name === name || command.aliases?.includes(name) === true || getCommandName(command) === name),
  );
}

function resolveGatedPlainWorldCommand(input: string, commands: Command[]): Command | undefined {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return undefined;
  const spaceIndex = trimmed.indexOf(' ');
  const name = (spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)).trim();
  if (!name) return undefined;
  const real = commands.find(
    command => command.name === name || command.aliases?.includes(name) === true || getCommandName(command) === name,
  );
  return real !== undefined && commandOffInPlainWorld(real) ? real : undefined;
}

export function readSubmitLine({ commandsRef }: SubmitDeps, input: string, helpers: PromptInputHelpers, options: SubmitOptions | undefined, submittedAt: string, text: string): SubmitLine {
  const focusedNow = getFocusedSessionConnector();
  const seatMode = options?.armedMode ?? pendingInput.mode();
  const seatPastes = options?.pastedContents ?? pendingInput.pastedContents();
  const seatCommand = text.startsWith('/') && seatMode !== 'bash' ? resolveSlashCommand(text, commandsRef.current) : undefined;
  const seat = seatCommand === undefined ? 'session' : commandSeat(seatCommand);
  return { input, helpers, options, submittedAt, text, focusedNow, seatMode, seatPastes, seatCommand, seat };
}

export function takeComposer({ setInputValue, setPastedContents, setInputMode }: SubmitDeps, { input, helpers, options, seatMode, seatPastes }: SubmitLine): void {
  if (options?.armedMode !== undefined) return;
  const composerLine = pendingInput.text().replace(/\s+$/, '');
  if (composerLine === input) pendingInput.clearForSubmit(input);
  if (composerLine === '' || composerLine === input) {
    setInputValue('');
    setPastedContents({});
    helpers.clearBuffer();
    helpers.setCursorOffset(0);
    helpers.resetHistory();
    setInputMode('prompt');
  }
  if (!options?.fromKeybinding && !options?.rearmed) addToHistory({ display: seatMode === 'bash' ? `!${input}` : input, pastedContents: seatPastes });
}

export function armForLanding(deps: SubmitDeps, submit: SubmitLine): void {
  const { setAppState } = deps;
  const { text, seatMode, seatPastes } = submit;
  takeComposer(deps, submit);
  const line = { message: createUserMessage({ content: text }), ...(seatMode === 'bash' ? { bashMode: true } : {}), pastedContents: seatPastes };
  setAppState(prev => ({
    ...prev,
    initialMessage: prev.initialMessage === null ? { ...line, armedAtLanding: true } : { ...prev.initialMessage, armedBehind: [...(prev.initialMessage.armedBehind ?? []), line] },
  }));
}

export function refuseUnknownSlash(deps: SubmitDeps, line: SubmitLine): boolean {
  const { paintScreenCommandReceipt, commandsRef } = deps;
  const { text, seatPastes, seatCommand, seatMode } = line;
  const words = expandPastedTextRefs(text, seatPastes).trim();
  if (seatCommand === undefined && words.startsWith('/') && seatMode !== 'bash') {
    const gated = resolveGatedPlainWorldCommand(words, commandsRef.current);
    if (gated !== undefined) {
      takeComposer(deps, line);
      paintScreenCommandReceipt(getCommandName(gated), '', unavailableCommandLine(gated));
      return true;
    }
    const unknownName = resolveUnknownSlashName(words, commandsRef.current);
    if (unknownName !== undefined) {
      takeComposer(deps, line);
      paintScreenCommandReceipt(unknownName, '', unknownCommandLine(unknownName, commandsRef.current));
      return true;
    }
  }
  return false;
}
