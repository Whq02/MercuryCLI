import { waitingHeadline, type AnthropicLoginSnapshot } from '../../widgets/faces/anthropicLoginModel.js';
import { wrapPlain } from '../BootHealthScreen.js';
import { DETAIL_W } from './facts.js';

const DRAFT_DOTS_MAX = 24;

export function maskedDraftLine(draftLen: number): string {
  return `code: ${'•'.repeat(Math.min(draftLen, DRAFT_DOTS_MAX))}${draftLen > DRAFT_DOTS_MAX ? '…' : ''}▌`;
}

export function wrapHard(text: string, width: number): string[] {
  const lines: string[] = [];
  for (let at = 0; at < text.length; at += width) lines.push(text.slice(at, at + width));
  return lines.length > 0 ? lines : [''];
}

export function wrapClauses(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const clause of text.split(/(?<=,) | (?=—)/)) {
    if (line === '') line = clause;
    else if (line.length + 1 + clause.length <= width) line += ' ' + clause;
    else {
      lines.push(line);
      line = clause;
    }
  }
  if (line !== '') lines.push(line);
  return lines.flatMap(l => (l.length > width ? wrapPlain(l, width) : [l]));
}

export function anthropicFlowPaneLines(snap: AnthropicLoginSnapshot, draftLen: number, backToPicker = false): string[] {
  const flow = snap.flow;
  switch (flow.name) {
    case 'idle':
      return ['starting…'];
    case 'ready':
      return ['Opening your browser…', '', 'esc cancels — nothing is stored'];
    case 'waiting': {
      const headline = waitingHeadline(snap);
      const lines: string[] = headline.warns ? wrapPlain(headline.words, DETAIL_W) : ['A browser window has been opened —', 'finish signing in there.'];
      if (flow.forcedMethod) lines.push(`(login method pre-selected: ${flow.forcedMethod})`);
      if (snap.pastePromptUp) {
        lines.push('Browser did not open? Use this URL:');
        lines.push(...wrapHard(flow.url, DETAIL_W));
        lines.push(snap.copied ? 'copied to clipboard' : 'c copies the URL');
        lines.push('Paste code here if prompted:');
        lines.push(maskedDraftLine(draftLen));
        lines.push('esc cancels the wait');
      } else {
        lines.push('', 'the paste fallback appears in a moment');
        lines.push('', 'esc cancels the wait');
      }
      return lines;
    }
    case 'creating-key':
      return ['Minting the key…', '', 'esc cancels — nothing else is stored'];
    case 'success': {
      const lines: string[] = [`Signed in${snap.accountLabel !== null ? ` as ${snap.accountLabel}` : ''}.`];
      if (flow.warning !== undefined) {
        lines.push('');
        lines.push(...wrapPlain(flow.warning, DETAIL_W));
      }
      if (snap.shadowWarning !== null) {
        lines.push('');
        lines.push(...wrapPlain(snap.shadowWarning, DETAIL_W));
      }
      lines.push('', signedInWayOut(backToPicker));
      return lines;
    }
    case 'error': {
      const lines: string[] = [...wrapPlain(flow.message, DETAIL_W), ''];
      lines.push(flow.retry !== undefined ? '↵ retries · esc closes' : 'esc closes');
      return lines;
    }
    case 'about-to-retry':
      return ['Retrying…'];
  }
}

export function anthropicFlowLegendOf(snap: AnthropicLoginSnapshot, draftLen: number): string {
  const flow = snap.flow;
  if (flow.name === 'waiting' && snap.pastePromptUp) {
    return draftLen > 0 ? '↵ submit code · esc cancel' : '↵ submit code · c copy url · esc cancel';
  }
  if (flow.name === 'success') return '↵ done';
  if (flow.name === 'error' && flow.retry !== undefined) return '↵ retry · esc close';
  return 'esc cancel';
}

export function anthropicFlowStatusOf(snap: AnthropicLoginSnapshot, backToPicker = false): string {
  const flow = snap.flow;
  if (flow.name === 'waiting') return 'waiting on the browser sign-in';
  if (flow.name === 'creating-key') return 'minting the usage-based key';
  if (flow.name === 'success') return `signed in — ${signedInStatusWayOut(backToPicker)}`;
  if (flow.name === 'error') return 'the sign-in did not settle';
  return 'starting the sign-in';
}

const RECEIPT_PANE_MAX = 9;
export function receiptPaneLines(receipt: string, ok: boolean, backToPicker = false): string[] {
  const wrapped = wrapPlain(receipt, DETAIL_W);
  const body =
    wrapped.length > RECEIPT_PANE_MAX ? [...wrapped.slice(0, RECEIPT_PANE_MAX - 1), '…'] : wrapped;
  return [...body, signedInWayOut(ok && backToPicker)];
}

export function signedInWayOut(backToPicker: boolean): string {
  return backToPicker ? '↵ done — back to the picker' : '↵ done — the roster refreshes';
}

export function signedInStatusWayOut(backToPicker: boolean): string {
  return backToPicker ? '↵ returns to the picker' : '↵ returns to the roster';
}
