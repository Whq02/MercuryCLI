import { OPENAI_DEVICE_STOPPED_RECEIPT } from '../../../models/roads/openai/openaiLogin.js';
import { writeGeminiOauthClientConfig } from '../../../models/roads/gemini/geminiAccounts.js';
import { setClipboard } from '../../renderer/termio/osc.js';
import type { OpenFlowState } from './flowLines.js';
import type { LoginsFlowContext } from './context.js';
import type { Key } from '../../themedRenderer.js';
import { startTimeout } from '../../../platform/async/timers.js';

export function receiptFlowKeys(ctx: LoginsFlowContext, current: Extract<OpenFlowState, { kind: 'receipt' }>, input: string, key: Key): void {
  const { refreshFacts, closeFlow, settleSignedIn } = ctx;
  if (key.return || key.escape) {
    if (current.ok) settleSignedIn();
    else {
      refreshFacts();
      closeFlow();
    }
  }
}

export function deviceFlowKeys(ctx: LoginsFlowContext, current: Extract<OpenFlowState, { kind: 'device' }>, input: string, key: Key): void {
  const { deviceRunRef, setFlow, setDraft, openPick } = ctx;
  if (key.escape) {
    deviceRunRef.current += 1;
    setDraft('');
    openPick(current.device.family);
    return;
  }
  if (
    input === 'c' &&
    !key.ctrl &&
    !key.meta &&
    current.device.phase === 'waiting' &&
    current.device.verificationUri !== undefined
  ) {
    const run = deviceRunRef.current;
    void setClipboard(current.device.verificationUri).then(sequence => {
      if (sequence) process.stdout.write(sequence);
      if (run !== deviceRunRef.current) return;
      setFlow(f => (f?.kind === 'device' ? { kind: 'device', device: { ...f.device, copied: true } } : f));
      startTimeout(() => {
        if (run !== deviceRunRef.current) return;
        setFlow(f => (f?.kind === 'device' ? { kind: 'device', device: { ...f.device, copied: false } } : f));
      }, 2000);
    });
  }
}

export function handlesFlowKeys(ctx: LoginsFlowContext, current: Extract<OpenFlowState, { kind: 'handles' }>, input: string, key: Key): void {
  const { draftRef, deviceRunRef, handlesRef, setFlow, setDraft, closeFlow, startOpenaiDeviceRun, openPick } = ctx;
  const h = current.handles;
  if (key.escape) {
    deviceRunRef.current += 1;
    handlesRef.current?.cancel('cancelled from the logins layer');
    handlesRef.current = null;
    setDraft('');
    if (h.leg === 'openai-browser') closeFlow();
    else if (h.leg === 'gemini-oauth' || h.leg === 'gemini-plan') openPick('gemini');
    else openPick('openrouter');
    return;
  }
  if (key.return) {
    const value = draftRef.current.trim();
    if (value === '' || h.phase !== 'waiting') return;
    setDraft('');
    setFlow(f => (f?.kind === 'handles' ? { kind: 'handles', handles: { ...f.handles, phase: 'exchanging' } } : f));
    handlesRef.current?.completeWithRedirect(value);
    return;
  }
  if (input === 'c' && !key.ctrl && !key.meta && h.phase === 'waiting' && draftRef.current === '' && h.authorizeUrl !== undefined) {
    const run = deviceRunRef.current;
    void setClipboard(h.authorizeUrl).then(sequence => {
      if (sequence) process.stdout.write(sequence);
      if (run !== deviceRunRef.current) return;
      setFlow(f => (f?.kind === 'handles' ? { kind: 'handles', handles: { ...f.handles, copied: true } } : f));
      startTimeout(() => {
        if (run !== deviceRunRef.current) return;
        setFlow(f => (f?.kind === 'handles' ? { kind: 'handles', handles: { ...f.handles, copied: false } } : f));
      }, 2000);
    });
    return;
  }
  if (input === 'd' && !key.ctrl && !key.meta && h.leg === 'openai-browser' && h.phase === 'waiting' && draftRef.current === '') {
    handlesRef.current?.cancel('switching to the device-code flow');
    handlesRef.current = null;
    setDraft('');
    startOpenaiDeviceRun();
    return;
  }
  if (h.phase !== 'waiting') return;
  if (key.backspace || key.delete) {
    setDraft(d => d.slice(0, -1));
    return;
  }
  if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
  if (input.length > 0 && !/[\x00-\x1f\x7f]/.test(input)) setDraft(d => d + input);
}

export function opdeviceFlowKeys(ctx: LoginsFlowContext, current: Extract<OpenFlowState, { kind: 'opdevice' }>, input: string, key: Key): void {
  const { deviceRunRef, setFlow, setDraft } = ctx;
  if (key.escape) {
    deviceRunRef.current += 1;
    setDraft('');
    setFlow({ kind: 'receipt', receipt: OPENAI_DEVICE_STOPPED_RECEIPT, ok: false });
    return;
  }
  if (input === 'c' && !key.ctrl && !key.meta && current.opdevice.userCode !== undefined) {
    const run = deviceRunRef.current;
    void setClipboard(current.opdevice.userCode).then(sequence => {
      if (sequence) process.stdout.write(sequence);
      if (run !== deviceRunRef.current) return;
      setFlow(f => (f?.kind === 'opdevice' ? { kind: 'opdevice', opdevice: { ...f.opdevice, copied: true } } : f));
      startTimeout(() => {
        if (run !== deviceRunRef.current) return;
        setFlow(f => (f?.kind === 'opdevice' ? { kind: 'opdevice', opdevice: { ...f.opdevice, copied: false } } : f));
      }, 2000);
    });
  }
}

export function clientFlowKeys(ctx: LoginsFlowContext, current: Extract<OpenFlowState, { kind: 'client' }>, input: string, key: Key): void {
  const { draftRef, setFlow, setDraft, openGuideStep, startHandlesRun, openPick } = ctx;
  const c = current.client;
  if (c.step !== 5) {
    if (key.escape) {
      if (c.step === 1) {
        setDraft('');
        openPick('gemini');
        return;
      }
      openGuideStep((c.step - 1) as 1 | 2 | 3 | 4, c.from);
      return;
    }
    if (key.return) {
      openGuideStep((c.step + 1) as 2 | 3 | 4 | 5, c.from);
      return;
    }
    if (input === 'o' && !key.ctrl && !key.meta) openGuideStep(c.step, c.from, c.note);
    return;
  }
  if (key.escape) {
    if (c.field === 'secret') {
      setDraft(c.clientId);
      setFlow({ kind: 'client', client: { ...c, field: 'id', note: null } });
      return;
    }
    setDraft('');
    if (c.from === 'pick') openPick('gemini');
    else openGuideStep(4, 'walk');
    return;
  }
  if (key.return) {
    if (c.field === 'id') {
      const value = draftRef.current.trim();
      if (!value) {
        setFlow({ kind: 'client', client: { ...c, note: 'The client id is required (the secret is optional for Desktop clients).' } });
        return;
      }
      setDraft('');
      setFlow({ kind: 'client', client: { ...c, field: 'secret', clientId: value, note: null } });
      return;
    }
    try {
      writeGeminiOauthClientConfig({
        clientId: c.clientId,
        ...(draftRef.current.trim() ? { clientSecret: draftRef.current.trim() } : {}),
      });
    } catch (error) {
      setFlow({ kind: 'client', client: { ...c, note: `Could not store the client config: ${String((error as Error).message ?? error)}` } });
      return;
    }
    setDraft('');
    startHandlesRun('gemini-oauth');
    return;
  }
  if (key.backspace || key.delete) {
    setDraft(d => d.slice(0, -1));
    return;
  }
  if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
  if (input.length > 0 && !/[\x00-\x1f\x7f]/.test(input)) setDraft(d => d + input);
}

export function keyFlowKeys(ctx: LoginsFlowContext, current: Extract<OpenFlowState, { kind: 'key' }>, input: string, key: Key): void {
  const { draftRef, setDraft, submitKey, keyEscape } = ctx;
  if (key.escape) {
    if (!current.storing) keyEscape(current.leg);
    return;
  }
  if (key.return) {
    if (!current.storing) submitKey(current.leg, draftRef.current);
    return;
  }
  if (current.storing) return;
  if (key.backspace || key.delete) {
    setDraft(d => d.slice(0, -1));
    return;
  }
  if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
  if (input.length > 0 && !/[\x00-\x1f\x7f]/.test(input)) setDraft(d => d + input);
}

export function anthropicFlowKeys(ctx: LoginsFlowContext, input: string, key: Key): void {
  const { draftRef, setDraft, closeFlow, settleSignedIn, model } = ctx;
  const snap = model.flow;
  if (key.escape) {
    if (snap.name === 'success') {
      settleSignedIn();
      return;
    }
    model.reset();
    closeFlow();
    return;
  }
  if (key.return) {
    if (snap.name === 'success') {
      settleSignedIn();
      return;
    }
    if (snap.name === 'error') {
      setDraft('');
      model.retry();
      return;
    }
    if (snap.name === 'waiting' && model.pastePromptUp) {
      if (!model.submitCode(draftRef.current)) setDraft('');
      return;
    }
    return;
  }
  if (input === 'c' && !key.ctrl && !key.meta && snap.name === 'waiting' && model.pastePromptUp && draftRef.current === '') {
    model.copyUrl();
    return;
  }
  if (key.backspace || key.delete) {
    setDraft(d => d.slice(0, -1));
    return;
  }
  if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
  if (snap.name === 'waiting' && model.pastePromptUp && input.length > 0 && !/[\x00-\x1f\x7f]/.test(input)) {
    setDraft(d => d + input);
  }
}
