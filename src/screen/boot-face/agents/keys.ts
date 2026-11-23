import type { FieldId } from '../../agents/studio/studioEditorModel.js';
import { BODY_CAP, TEXT_CAP } from './face.js';
import type { AgentsFaceContext } from './context.js';
import type { Key, InputEvent } from '../../themedRenderer.js';

export function formPromptKeys(ctx: AgentsFaceContext, input: string, key: Key, event: InputEvent): void {
  const { formPromptRef, formRef, setFormPrompt } = ctx;
  event.stopImmediatePropagation();
  const f = formRef.current;
  const promptField = formPromptRef.current;
  if (!f || promptField === null) return;
  const snap = f.machine.snapshot();
  if (key.escape) {
    f.machine.closeFieldEditor();
    setFormPrompt(null);
    return;
  }
  if (key.return) {
    const draft = snap.textBuffer;
    if (promptField === 'describe') {
      if (draft.trim() !== '') f.machine.guidedDescribe(draft.trim());
    } else if (promptField === 'body') {
      f.machine.commit({ body: draft.trim() === '' ? '' : draft.trim() + '\n' });
    } else {
      f.machine.commitTextField(promptField as FieldId, draft);
    }
    setFormPrompt(null);
    return;
  }
  if (key.backspace || key.delete) {
    f.machine.setTextBuffer(snap.textBuffer.slice(0, -1));
    return;
  }
  if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
  if (input.length > 0 && !/[\x00-\x1f\x7f]/.test(input)) {
    const cap = promptField === 'body' ? BODY_CAP : TEXT_CAP;
    f.machine.setTextBuffer((snap.textBuffer + input).slice(0, cap));
  }
}

export function confirmKeys(ctx: AgentsFaceContext, input: string, key: Key, event: InputEvent): void {
  const { confirm, runDelete, setConfirm } = ctx;
  event.stopImmediatePropagation();
  if (confirm === null) return;
  if (input === 'y' || key.return) runDelete(confirm);
  else if (input === 'n' || key.escape) setConfirm(null);
}

export function formSnapKeys(ctx: AgentsFaceContext, input: string, key: Key, event: InputEvent): void {
  const { formRef, formSnap } = ctx;
  const f = formRef.current;
  const snap = formSnap;
  if (!f || !snap) return;
  if (snap.busy) {
    event.stopImmediatePropagation();
    if (key.escape) f.machine.abortGeneration();
    return;
  }
  if (snap.recoverOffer) {
    event.stopImmediatePropagation();
    if (input === 'y' || key.return) f.machine.acceptRecover();
    else if (input === 'n' || key.escape) f.machine.declineRecover();
    return;
  }
  if (snap.conflict) {
    event.stopImmediatePropagation();
    if (input === 'l' || input === 'L') f.machine.mergeOntoTheirs();
    else if (key.escape) f.machine.clearConflict();
    return;
  }
}
