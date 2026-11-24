import { finishOpenaiSubscriptionConnect, openaiConnectFailedReceipt } from '../../../models/roads/openai/openaiLogin.js';
import { runXaiDeviceLogin } from '../../../models/roads/xai/xaiLogin.js';
import { runMetaDeviceLogin } from '../../../models/roads/meta/metaLogin.js';
import { runNousDeviceLogin } from '../../../models/roads/nous/nousLogin.js';
import { runOrcarouterDeviceLogin } from '../../../models/roads/orcarouter/orcarouterLogin.js';
import { runKimiDeviceLogin } from '../../../models/roads/moonshot/moonshotLogin.js';
import type { KimiRegion } from '../../../models/roads/moonshot/moonshotAccounts.js';
import { runHuggingfaceDeviceLogin } from '../../../models/roads/huggingface/huggingfaceLogin.js';
import { beginOpenaiBrowserConnect, beginOpenaiDeviceConnect } from '../../../models/roads/openai/openaiAccounts.js';
import { finishOpenrouterConnect, openrouterConnectFailedReceipt } from '../../../models/roads/openrouter/openrouterLogin.js';
import { beginOpenrouterConnect } from '../../../models/roads/openrouter/openrouterAccounts.js';
import { finishGeminiPlanConnect, finishGeminiOauthConnect, geminiConnectFailedReceipt } from '../../../models/roads/gemini/geminiLogin.js';
import { beginGeminiPlanBrowserConnect, beginGeminiBrowserConnect, geminiOauthClientConfig } from '../../../models/roads/gemini/geminiAccounts.js';
import { geminiGuideReturnStep, geminiGuideStep } from '../../../models/sign-in/gemini-connect/geminiConnectGuide.js';
import { errorMessage, errorMessageWithCause } from '../../../platform/errors/errors.js';
import { openBrowser } from '../../../platform/host-os/browser.js';
import { lateSettleNotice } from './facts.js';
import type { FaceDeviceFamily, HandlesLegId, DeviceWaitStateV1 } from './flowLines.js';
import type { LoginsFlowContext } from './context.js';
import { enqueueNotification } from '../../notifications/notifications.js';
import { logError } from '../../../platform/logs/errorLog.js';

export function postLoginSettleOf(ctx: LoginsFlowContext): void {
  const { given, setAppStateMaybe } = ctx;
  if (given !== undefined) return;
  void (async () => {
    try {
      const [user, killswitch] = await Promise.all([
        import('../../../platform/environment/user.js'),
        import('../../../permissions/rules/sovereignKillswitch.js'),
      ]);
      user.resetUserCache();
      killswitch.resetSovereignCheck();
      if (setAppStateMaybe !== null) {
        let capturedContext: Parameters<typeof killswitch.checkAndDisableSovereignIfNeeded>[0] | null = null;
        setAppStateMaybe(prev => {
          capturedContext = prev.toolPermissionContext;
          return { ...prev, authVersion: (prev.authVersion ?? 0) + 1 };
        });
        if (capturedContext !== null) {
          void killswitch.checkAndDisableSovereignIfNeeded(capturedContext, setAppStateMaybe).catch((error: unknown) => {
            logError(error);
            enqueueNotification(setAppStateMaybe, {
              key: 'bypass-killswitch',
              text: `bypass permissions stays on: your organization's security policy could not be checked (${errorMessage(error)})`,
              priority: 'high',
              color: 'warning',
              timeoutMs: 30_000,
            });
          });
        }
      }
    } catch (error) {
      logError(error);
    }
  })();
}

export function startDeviceRunOf(ctx: LoginsFlowContext, family: FaceDeviceFamily, region?: KimiRegion): void {
  const { deviceRunRef, setFlow, setDraft, discloseLateSettle } = ctx;
  const run = (deviceRunRef.current += 1);
  const live = (): boolean => run === deviceRunRef.current;
  const regionWords = family === 'moonshot' ? (region === 'mainland-cn' ? 'Mainland China — kimi.com' : 'Global — kimi.ai') : undefined;
  const seed: DeviceWaitStateV1 = {
    family,
    ...(regionWords !== undefined ? { regionWords } : {}),
    phase: 'starting',
    polls: 0,
    copied: false,
  };
  setFlow({ kind: 'device', device: seed });
  const patchDevice = (over: Partial<DeviceWaitStateV1>): void => {
    if (!live()) return;
    setFlow(current => (current?.kind === 'device' ? { kind: 'device', device: { ...current.device, ...over } } : current));
  };
  const onEvent = (event: {
    phase: 'starting' | 'waiting' | 'finishing';
    start?: { userCode: string; verificationUri: string; verificationUriComplete?: string; expiresAtMs: number };
    polls?: number;
    note?: string;
  }): void => {
    if (!live()) return;
    if (event.phase === 'starting') {
      patchDevice({ phase: 'starting' });
      return;
    }
    if (event.phase === 'finishing') {
      patchDevice({ phase: 'finishing' });
      return;
    }
    const uri = event.start !== undefined ? (event.start.verificationUriComplete ?? event.start.verificationUri) : undefined;
    patchDevice({
      phase: 'waiting',
      ...(event.start !== undefined
        ? { userCode: event.start.userCode, verificationUri: uri, expiresAtMs: event.start.expiresAtMs }
        : {}),
      polls: event.polls ?? 0,
      ...(event.note !== undefined ? { note: event.note } : { note: undefined }),
    });
    if (event.polls === 0 && uri !== undefined) void openBrowser(uri);
  };
  const land = (outcome: { ok: boolean; receipt: string }): void => {
    if (!live()) return;
    setDraft('');
    setFlow({ kind: 'receipt', receipt: outcome.receipt, ok: outcome.ok });
  };
  const landOrDisclose = (outcome: { ok: boolean; receipt: string; settledAfterCancel?: true }): void => {
    if (outcome.settledAfterCancel === true) {
      discloseLateSettle(outcome.receipt);
      return;
    }
    land(outcome);
  };
  if (family === 'moonshot') {
    void runKimiDeviceLogin({ region: region ?? 'global', cancelled: () => !live(), onEvent }).then(landOrDisclose);
  } else if (family === 'xai') {
    void runXaiDeviceLogin({ cancelled: () => !live(), onEvent }).then(landOrDisclose);
  } else if (family === 'nous') {
    void runNousDeviceLogin({ cancelled: () => !live(), onEvent }).then(landOrDisclose);
  } else if (family === 'orcarouter') {
    void runOrcarouterDeviceLogin({ cancelled: () => !live(), onEvent }).then(landOrDisclose);
  } else if (family === 'meta') {
    void runMetaDeviceLogin({ cancelled: () => !live(), onEvent }).then(landOrDisclose);
  } else {
    void runHuggingfaceDeviceLogin({ cancelled: () => !live(), onEvent }).then(landOrDisclose);
  }
}

export function openGuideStepOf(ctx: LoginsFlowContext, step: 1 | 2 | 3 | 4 | 5, from: 'walk' | 'pick', note: string | null = null): void {
  const { setFlow, setDraft } = ctx;
  const stored = geminiOauthClientConfig()?.clientId ?? '';
  const page = geminiGuideStep(step).page;
  setDraft(step === 5 ? stored : '');
  setFlow({ kind: 'client', client: { step, from, field: 'id', clientId: stored, note, ...(page ? { opened: 'opening' as const } : {}) } });
  if (!page) return;
  void openBrowser(page.address).then(ok => {
    setFlow(f => (f?.kind === 'client' && f.client.step === step ? { kind: 'client', client: { ...f.client, opened: ok ? 'opened' : 'failed' } } : f));
  });
}

export function startHandlesRunOf(ctx: LoginsFlowContext, leg: HandlesLegId): void {
  const { deviceRunRef, handlesRef, setFlow, setDraft, discloseLateSettle, openGuideStep } = ctx;
  const run = (deviceRunRef.current += 1);
  const live = (): boolean => run === deviceRunRef.current;
  const onListenerIssue = (message: string): void => {
    if (!live()) return;
    setFlow(f => (f?.kind === 'handles' ? { kind: 'handles', handles: { ...f.handles, listenerNote: message } } : f));
  };
  const legFamily = leg === 'openai-browser' ? 'openai' : leg === 'gemini-oauth' || leg === 'gemini-plan' ? 'gemini' : 'openrouter';
  const onSettledAfterCancel = (): void => discloseLateSettle(lateSettleNotice(legFamily));
  const handles =
    leg === 'openai-browser'
      ? beginOpenaiBrowserConnect({ onListenerIssue, onSettledAfterCancel })
      : leg === 'gemini-oauth'
        ? beginGeminiBrowserConnect({ onListenerIssue, onSettledAfterCancel })
        : leg === 'gemini-plan'
          ? beginGeminiPlanBrowserConnect({ onListenerIssue, onSettledAfterCancel })
          : beginOpenrouterConnect({ mode: leg === 'openrouter-browser' ? 'browser' : 'headless', onListenerIssue, onSettledAfterCancel });
  handlesRef.current = { cancel: reason => handles.cancel(reason), completeWithRedirect: pasted => handles.completeWithRedirect(pasted) };
  setFlow({
    kind: 'handles',
    handles: { leg, phase: 'waiting', ...(handles.authorizeUrl ? { authorizeUrl: handles.authorizeUrl } : {}), copied: false },
  });
  const land = (outcome: { ok: boolean; receipt: string }): void => {
    if (!live()) return;
    handlesRef.current = null;
    setDraft('');
    setFlow({ kind: 'receipt', receipt: outcome.receipt, ok: outcome.ok });
  };
  if (leg === 'openai-browser') {
    (handles.result as Promise<Parameters<typeof finishOpenaiSubscriptionConnect>[0]>)
      .then(async ref => land(await finishOpenaiSubscriptionConnect(ref)))
      .catch(error => land({ ok: false, receipt: openaiConnectFailedReceipt(error, 'browser') }));
  } else if (leg === 'gemini-plan') {
    (handles.result as Promise<unknown>)
      .then(async () => land(await finishGeminiPlanConnect()))
      .catch(error => land({ ok: false, receipt: geminiConnectFailedReceipt(error) }));
  } else if (leg === 'gemini-oauth') {
    (handles.result as Promise<unknown>)
      .then(async () => land(await finishGeminiOauthConnect()))
      .catch(error => {
        const back = geminiGuideReturnStep(errorMessageWithCause(error));
        if (back === undefined || back === 6 || !live()) {
          land({ ok: false, receipt: geminiConnectFailedReceipt(error) });
          return;
        }
        handlesRef.current = null;
        setDraft('');
        openGuideStep(back, 'walk', errorMessageWithCause(error));
      });
  } else {
    (handles.result as Promise<Parameters<typeof finishOpenrouterConnect>[0]>)
      .then(async ref => land(await finishOpenrouterConnect(ref)))
      .catch(error => land({ ok: false, receipt: openrouterConnectFailedReceipt(error) }));
  }
}

export function startOpenaiDeviceRunOf(ctx: LoginsFlowContext): void {
  const { deviceRunRef, setFlow, setDraft, discloseLateSettle } = ctx;
  const run = (deviceRunRef.current += 1);
  const live = (): boolean => run === deviceRunRef.current;
  setFlow({ kind: 'opdevice', opdevice: { copied: false } });
  beginOpenaiDeviceConnect()
    .then(start => {
      if (!live()) return;
      setFlow(f => (f?.kind === 'opdevice' ? { kind: 'opdevice', opdevice: { ...f.opdevice, userCode: start.userCode, verifyHint: start.verifyHint } } : f));
      start.result
        .then(async ref => {
          if (!live()) {
            void ref;
            discloseLateSettle(lateSettleNotice('openai'));
            return;
          }
          setDraft('');
          setFlow({ kind: 'receipt', ...(await finishOpenaiSubscriptionConnect(ref)) });
        })
        .catch(error => {
          if (!live()) return;
          setFlow({ kind: 'receipt', receipt: openaiConnectFailedReceipt(error, 'device'), ok: false });
        });
    })
    .catch(error => {
      if (!live()) return;
      setFlow({ kind: 'receipt', receipt: openaiConnectFailedReceipt(error, 'device'), ok: false });
    });
}
