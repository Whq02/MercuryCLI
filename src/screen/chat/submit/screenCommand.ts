import { featureReached } from '../../../platform/substrate/featureReached.js';
import { getCommandName, type Command } from '../../../commands/catalogue/commands.js';
import { performUiRouteAlias } from '../../routes/routeAliases.js';
import { expandPastedTextRefs, resolvePastedContents } from '../../../sessions/promptHistory.js';
import * as pendingInput from '../../composer/input-core/pending-input.js';
import { hasFocusedSession, landingInFlight } from '../../../engine/connector/focusedConnector.js';
import { createAbortController } from '../../../platform/async/abortController.js';
import { logForDebugging } from '../../../platform/logs/debugLog.js';
import { RECEIPT_TIMEOUT_MS } from '../limits.js';
import { armForLanding, type SubmitDeps, type SubmitLine } from './submitLine.js';

const HELD_FOR_LANDING: ReadonlySet<string> = new Set(['swarm', 'swarmchat', 'general', 'team', 'whisper', 'rename', 'title', 'crewmates', 'context']);

export type CommandArgs = { spaceAt: number; args: string; argsWithPastes: () => Promise<string> };

export function readCommandArgs({ text, seatPastes }: SubmitLine): CommandArgs {
  const spaceAt = text.indexOf(' ');
  const args = spaceAt === -1 ? '' : text.slice(spaceAt + 1).trim();
  const argsWithPastes = async (): Promise<string> => expandPastedTextRefs(args, (await resolvePastedContents(args, seatPastes)).pastedContents).trim();
  return { spaceAt, args, argsWithPastes };
}

export function holdCommandForLanding(deps: SubmitDeps, line: SubmitLine, { args }: CommandArgs): boolean {
  const { addNotification } = deps;
  const { seatCommand } = line;
  if (seatCommand !== undefined && (seatCommand.type === 'local-jsx' && seatCommand.name === 'mission' ? args !== '' : HELD_FOR_LANDING.has(seatCommand.name)) && landingInFlight() && !hasFocusedSession()) {
    armForLanding(deps, line);
    addNotification({ key: 'landing-hold', text: `the session is landing — /${getCommandName(seatCommand)} sends when it lands`, priority: 'immediate', timeoutMs: Infinity });
    return true;
  }
  return false;
}

export async function runLocalCommand({ addNotification, getToolUseContext, paintScreenCommandReceipt }: SubmitDeps, { submittedAt, focusedNow }: SubmitLine, seatCommand: Extract<Command, { type: 'local' }>, { args, argsWithPastes }: CommandArgs): Promise<void> {
  try {
    if (seatCommand.interruptFirst === true && focusedNow.turnActive()) {
      focusedNow.interrupt();
    }
    const context = getToolUseContext([...focusedNow.records()], [], createAbortController(), focusedNow.modelFacts().effective);
    const module = await seatCommand.load();
    featureReached('command', seatCommand.name);
    const result = await module.call(await argsWithPastes(), context);
    if (result.type === 'text' && result.value.trim() !== '') paintScreenCommandReceipt(getCommandName(seatCommand), args, result.value, submittedAt);
  } catch (error) {
    logForDebugging(`screen command /${seatCommand.name} failed: ${String(error)}`);
    addNotification({ key: `command-${seatCommand.name}`, text: `/${getCommandName(seatCommand)} failed — ${error instanceof Error ? error.message : String(error)}`, priority: 'high', color: 'error' as const, timeoutMs: RECEIPT_TIMEOUT_MS });
  }
}

export function followRouteAlias({ addNotification, setInputValue }: SubmitDeps, { input }: SubmitLine, routeAlias: 'concourse'): void {
  if (pendingInput.text().replace(/\s+$/, '') === input) setInputValue('');
  const outcome = performUiRouteAlias(routeAlias);
  if (outcome.note) {
    addNotification({ key: 'route-alias', text: outcome.note, priority: 'immediate', timeoutMs: RECEIPT_TIMEOUT_MS });
  }
}
