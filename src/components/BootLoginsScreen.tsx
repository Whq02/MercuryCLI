import React, { useEffect, useMemo, useRef, useState } from 'react';
import { basename } from 'node:path';
import { useSignInEpoch } from '../utils/accounts/useSignInEpoch.js';
import { useCatalogueEpoch } from '../hooks/useCatalogueEpoch.js';
import { Box, useInput } from '../ink.js';
import { createSplashCore, WORD_W } from '../../assets/splash/splash-core.mjs';
import { useAnthropicLoginModel } from './mercury-ui/screens/anthropicLoginModel.js';
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js';
import { storeCompatApiKeyLogin } from '../services/providers/openaicompat/compatLogin.js';
import { storeOpenaiApiKeyLogin, OPENAI_DEVICE_STOPPED_RECEIPT, finishOpenaiSubscriptionConnect, openaiConnectFailedReceipt } from '../services/providers/openai/openaiLogin.js';
import { storeAnthropicApiKeyLogin } from '../services/providers/anthropic/anthropicLogin.js';
import { storeZaiApiKeyLogin } from '../services/providers/zai/zaiLogin.js';
import { storeDeepseekApiKeyLogin } from '../services/providers/deepseek/deepseekLogin.js';
import { storeXaiApiKeyLogin, storeXaiManagementKeyLogin, runXaiDeviceLogin } from '../services/providers/xai/xaiLogin.js';
import { resolveXaiApiKey } from '../services/providers/xai/xaiAccounts.js';
import { activateMetaSource, liveMetaConnectFacts, metaConnectRowAction, runMetaDeviceLogin, storeMetaApiKeyLogin } from '../services/providers/meta/metaLogin.js';
import { storeMistralApiKeyLogin, storeMistralAdminKeyLogin } from '../services/providers/mistral/mistralLogin.js';
import { storeNousApiKeyLogin, runNousDeviceLogin } from '../services/providers/nous/nousLogin.js';
import { storeZenApiKeyLogin } from '../services/providers/zen/zenLogin.js';
import { storeMinimaxApiKeyLogin } from '../services/providers/minimax/minimaxLogin.js';
import { storeTogetherApiKeyLogin } from '../services/providers/together/togetherLogin.js';
import { storeCohereApiKeyLogin } from '../services/providers/cohere/cohereLogin.js';
import { storeGroqApiKeyLogin } from '../services/providers/groq/groqLogin.js';
import { storeMeliousApiKeyLogin } from '../services/providers/melious/meliousLogin.js';
import { storeOrcarouterApiKeyLogin, runOrcarouterDeviceLogin } from '../services/providers/orcarouter/orcarouterLogin.js';
import { storeCerebrasApiKeyLogin } from '../services/providers/cerebras/cerebrasLogin.js';
import { storeFireworksApiKeyLogin } from '../services/providers/fireworks/fireworksLogin.js';
import { storeQwenApiKeyLogin } from '../services/providers/qwen/qwenLogin.js';
import { runKimiDeviceLogin, storeMoonshotApiKeyLogin } from '../services/providers/moonshot/moonshotLogin.js';
import { moonshotStoredRegion, type KimiRegion } from '../services/providers/moonshot/moonshotAccounts.js';
import { runHuggingfaceDeviceLogin, storeHuggingfaceTokenLogin } from '../services/providers/huggingface/huggingfaceLogin.js';
import { beginOpenaiBrowserConnect, beginOpenaiDeviceConnect } from '../services/providers/openai/openaiAccounts.js';
import { finishOpenrouterConnect, openrouterConnectFailedReceipt, storeOpenrouterApiKeyLogin } from '../services/providers/openrouter/openrouterLogin.js';
import { beginOpenrouterConnect } from '../services/providers/openrouter/openrouterAccounts.js';
import { activateGeminiSource, finishGeminiPlanConnect, finishGeminiOauthConnect, geminiConnectFailedReceipt, storeGeminiApiKeyLogin } from '../services/providers/gemini/geminiLogin.js';
import { beginGeminiPlanBrowserConnect, beginGeminiBrowserConnect, geminiOauthClientConfig, writeGeminiOauthClientConfig } from '../services/providers/gemini/geminiAccounts.js';
import { GEMINI_API_KEY_PAGE, geminiGuideOpeningStep, geminiGuideReturnStep, geminiGuideStep, liveGeminiConnectFacts, geminiConnectRowAction } from './geminiConnectGuide.js';
import { errorMessageWithCause } from '../utils/errors.js';
import { useSetAppStateMaybe } from '../state/AppState.js';
import { openBrowser } from '../utils/browser.js';
import { setClipboard } from '../ink/termio/osc.js';
import { resolveProviderUsability } from '../services/providers/providerUsability.js';
import { mostRecentSignInFamily } from '../utils/model/computedDefault.js';
import { useEngineModel } from '../hooks/useEngineModel.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { renderModelChip } from '../utils/model/model.js';
import { loginFamilyFocusFor, loginFamilyInitialFocus } from './loginFamilyRows.js';
import { InteractiveRow } from './mercury-ui/InteractiveRow.js';
import { renderSceneLine } from './mercury-ui/SceneCanvas.js';
import { getSessionAccent, getSessionCritterKey } from './mercury-ui/sessionAccent.js';
import { useGreetingShimmer } from './mercury-ui/useGreetingShimmer.js';
import { useInteractiveList } from './mercury-ui/useInteractiveList.js';
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js';
import { useSplashCoreAccent } from './mercury-ui/useSplashCoreAccent.js';
import { loginsSwitchableFamily, loginsFlowReady, lateSettleNotice, type LoginsScreenFactsV1, loginsSortedArms, collectLoginsScreenFacts, type LoginsArmV1 } from './bootLogins/facts.js';
import { keyLegGuardOpts, loginsPickOptions, type FaceKeyLegId, type LoginsPickId } from './bootLogins/pickLines.js';
import type { OpenFlowState, FaceDeviceFamily, HandlesLegId, DeviceWaitStateV1 } from './bootLogins/flowLines.js';
import { loginsMenuModelOf, loginsFlowPaneOf } from './bootLogins/menuModel.js';
export type { LoginsScreenFactsV1, LoginsArmV1, LoginsRowStateV1, LoginsEntry } from './bootLogins/facts.js';
export { collectLoginsScreenFacts, loginsCatalogue, loginsFamilyCounts, loginsExpiredFamilies, loginsGlance, loginsArmSlots, loginsSwitchableFamily, loginsRowStateOf, loginsSortedArms, loginsEntryOf, loginsDetailLines, lateSettleNotice, loginsSummaryRows, loginsStatusLine, loginsFlowReady, loginsLegendOf } from './bootLogins/facts.js';
export { maskedDraftLine, wrapHard, wrapClauses, anthropicFlowPaneLines, anthropicFlowLegendOf, anthropicFlowStatusOf, receiptPaneLines, signedInWayOut, signedInStatusWayOut } from './bootLogins/anthropicLines.js';
export type { LoginsPickId, FaceKeyLegId } from './bootLogins/pickLines.js';
export { geminiPickOptions, metaPickOptions, loginsPickOptions, loginsPickPaneLines, keyLegTitle, keyLegStoreLine, keyLegGuardOpts, keyPromptPaneLines } from './bootLogins/pickLines.js';
export type { FaceDeviceFamily, DeviceWaitStateV1, HandlesLegId, HandlesWaitStateV1, OpenaiDeviceStateV1, GeminiClientStateV1, LoginsFlowPaneV1 } from './bootLogins/flowLines.js';
export { deviceFamilyWords, deviceWaitPaneLines, handlesWaitPaneLines, handlesWaitWayOut, openaiDevicePaneLines, geminiClientPaneLines, loginsFlowLegendOf, loginsFlowStatusOf, loginsFlowPaneLines } from './bootLogins/flowLines.js';
export { loginsMenuModelOf } from './bootLogins/menuModel.js';

interface BootLoginsScreenProps {
  onClose?: () => void;
  onSignedIn?: () => void;
  family?: string;
  fullScene?: { columns: number; rows: number };
  facts?: LoginsScreenFactsV1;
}

export function BootLoginsScreen({ onClose, onSignedIn, family, fullScene, facts: given }: BootLoginsScreenProps = {}): React.ReactNode {
  const t = useMercuryTokens();
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const columns = fullScene?.columns ?? termCols;
  const rows = fullScene?.rows ?? termRows;

  const [facts, setFacts] = useState<LoginsScreenFactsV1>(() => given ?? collectLoginsScreenFacts());
  const arms = useMemo(() => loginsSortedArms(facts), [facts]);

  const [flow, setFlow] = useState<OpenFlowState | null>(null);
  const flowRef = useRef(flow);
  const xaiApiReceipt = useRef('xAI API key kept.');
  const mistralApiReceipt = useRef('Mistral API key kept.');
  flowRef.current = flow;
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraftState] = useState('');
  const draftRef = useRef('');
  const setDraft = (next: string | ((current: string) => string)): void => {
    const value = typeof next === 'function' ? next(draftRef.current) : next;
    draftRef.current = value;
    setDraftState(value);
  };
  const deviceRunRef = useRef(0);
  const handlesRef = useRef<{ cancel: (reason?: string) => void; completeWithRedirect: (pasted: string) => void } | null>(null);

  const anthropicKeyDraft = useRef('');
  const anthropicKeyRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { anthropicKeyRequest.current?.abort(); anthropicKeyDraft.current = ''; }, []);
  const refreshFacts = (): void => {
    if (given === undefined) setFacts(collectLoginsScreenFacts());
  };
  const signInEpoch = useSignInEpoch();
  const mountSignInEpoch = useRef(signInEpoch);
  useEffect(() => {
    if (signInEpoch === mountSignInEpoch.current) return;
    if (given === undefined) setFacts(collectLoginsScreenFacts());
  }, [signInEpoch, given]);
  const catalogueEpoch = useCatalogueEpoch();
  const mountCatalogueEpoch = useRef(catalogueEpoch);
  useEffect(() => {
    if (given !== undefined) return;
    resolveProviderUsability(undefined, { fetchCatalogues: true });
  }, [given]);
  useEffect(() => {
    if (catalogueEpoch === mountCatalogueEpoch.current) return;
    if (given === undefined) setFacts(collectLoginsScreenFacts());
  }, [catalogueEpoch, given]);

  const setAppStateMaybe = useSetAppStateMaybe();
  const postLoginSettle = (): void => {
    if (given !== undefined) return;
    void (async () => {
      try {
        const [user, killswitch] = await Promise.all([
          import('../utils/user.js'),
          import('../utils/permissions/bypassPermissionsKillswitch.js'),
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
            void killswitch.checkAndDisableSovereignIfNeeded(capturedContext, setAppStateMaybe).catch(() => {});
          }
        }
      } catch {
      }
    })();
  };
  const closeFlow = (): void => {
    anthropicKeyRequest.current?.abort();
    anthropicKeyRequest.current = null;
    anthropicKeyDraft.current = '';
    deviceRunRef.current += 1;
    handlesRef.current?.cancel('cancelled from the logins layer');
    handlesRef.current = null;
    setFlow(null);
    setDraft('');
  };
  const settleSignedIn = (): void => {
    refreshFacts();
    postLoginSettle();
    closeFlow();
    onSignedIn?.();
  };

  const discloseLateSettle = (sentence: string): void => {
    setNotice(sentence);
    refreshFacts();
    postLoginSettle();
  };

  const startDeviceRun = (family: FaceDeviceFamily, region?: KimiRegion): void => {
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
  };

  const openGuideStep = (step: 1 | 2 | 3 | 4 | 5, from: 'walk' | 'pick', note: string | null = null): void => {
    const stored = geminiOauthClientConfig()?.clientId ?? '';
    const page = geminiGuideStep(step).page;
    setDraft(step === 5 ? stored : '');
    setFlow({ kind: 'client', client: { step, from, field: 'id', clientId: stored, note, ...(page ? { opened: 'opening' as const } : {}) } });
    if (!page) return;
    void openBrowser(page.address).then(ok => {
      setFlow(f => (f?.kind === 'client' && f.client.step === step ? { kind: 'client', client: { ...f.client, opened: ok ? 'opened' : 'failed' } } : f));
    });
  };

  const startHandlesRun = (leg: HandlesLegId): void => {
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
  };

  const startOpenaiDeviceRun = (): void => {
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
  };

  const model = useAnthropicLoginModel({
    onDone: () => {
      settleSignedIn();
    },
  });
  const openPick = (pick: LoginsPickId, cursor = 0): void => {
    setFlow({ kind: 'pick', pick });
    pickList.moveTo(cursor);
  };

  const openFlow = (arm: LoginsArmV1): void => {
    setDraft('');
    setNotice(null);
    if (arm.row.value.startsWith('compat/')) {
      setFlow({ kind: 'key', leg: arm.row.value as `compat/${string}`, note: null, storing: false });
      return;
    }
    switch (arm.row.value) {
      case 'anthropic':
        openPick('anthropic');
        return;
      case 'zai':
        openPick('zai');
        return;
      case 'meta':
        openPick('meta');
        return;
      case 'mistral':
        mistralApiReceipt.current = 'Mistral API key kept.';
        setFlow({ kind: 'key', leg: 'mistral', note: null, storing: false });
        return;
      case 'nous':
        openPick('nous');
        return;
      case 'orcarouter':
        openPick('orcarouter');
        return;
      case 'zen':
        setFlow({ kind: 'key', leg: 'zen', note: null, storing: false });
        return;
      case 'minimax':
      case 'together':
      case 'cohere':
      case 'groq':
      case 'melious':
        setFlow({ kind: 'key', leg: arm.row.value, note: null, storing: false });
        return;
      case 'cerebras':
        setFlow({ kind: 'key', leg: 'cerebras', note: null, storing: false });
        return;
      case 'fireworks':
        setFlow({ kind: 'key', leg: 'fireworks', note: null, storing: false });
        return;
      case 'qwen':
        setFlow({ kind: 'key', leg: 'qwen', note: null, storing: false });
        return;
      case 'deepseek':
        setFlow({ kind: 'key', leg: 'deepseek', note: null, storing: false });
        return;
      case 'xai':
        xaiApiReceipt.current = 'xAI API key kept.';
        openPick('xai');
        return;
      case 'moonshot':
        openPick('moonshot');
        return;
      case 'huggingface':
        openPick('huggingface');
        return;
      case 'openai':
        openPick('openai');
        return;
      case 'openrouter':
        openPick('openrouter');
        return;
      case 'gemini':
        openPick('gemini');
        return;
    }
  };

  const resolvePick = (pick: LoginsPickId, value: string): void => {
    setDraft('');
    switch (pick) {
      case 'anthropic':
        if (value === 'key') {
          setFlow({ kind: 'key', leg: 'anthropic-key', note: null, storing: false });
          return;
        }
        setFlow({ kind: 'anthropic' });
        model.reset();
        model.start(value === 'claudeai');
        return;
      case 'xai':
        if (value === 'key') setFlow({ kind: 'key', leg: 'xai', note: null, storing: false });
        else startDeviceRun('xai');
        return;
      case 'nous':
        if (value === 'key') setFlow({ kind: 'key', leg: 'nous', note: null, storing: false });
        else startDeviceRun('nous');
        return;
      case 'orcarouter':
        if (value === 'key') setFlow({ kind: 'key', leg: 'orcarouter', note: null, storing: false });
        else startDeviceRun('orcarouter');
        return;
      case 'meta':
        if ((value === 'key' || value === 'device') && metaConnectRowAction(liveMetaConnectFacts(), value) === 'activate') {
          setFlow({ kind: 'receipt', ...activateMetaSource(value === 'key' ? 'api-key' : 'muse-code') });
          return;
        }
        if (value === 'key') setFlow({ kind: 'key', leg: 'meta', note: null, storing: false });
        else startDeviceRun('meta');
        return;
      case 'openai':
        if (value === 'key') {
          setFlow({ kind: 'key', leg: 'openai-key', note: null, storing: false });
          return;
        }
        startHandlesRun('openai-browser');
        return;
      case 'zai':
        setFlow({ kind: 'key', leg: value === 'coding' ? 'zai-coding' : 'zai-general', note: null, storing: false });
        return;
      case 'moonshot':
        if (value === 'key') {
          setFlow({ kind: 'key', leg: 'moonshot-key', note: null, storing: false });
          return;
        }
        openPick('kimi-region', moonshotStoredRegion() === 'mainland-cn' ? 1 : 0);
        return;
      case 'huggingface':
        if (value === 'token') {
          setFlow({ kind: 'key', leg: 'hf-token', note: null, storing: false });
          return;
        }
        startDeviceRun('huggingface');
        return;
      case 'kimi-region':
        startDeviceRun('moonshot', value === 'mainland-cn' ? 'mainland-cn' : 'global');
        return;
      case 'openrouter':
        if (value === 'key') {
          setFlow({ kind: 'key', leg: 'openrouter-key', note: null, storing: false });
          return;
        }
        startHandlesRun(value === 'browser' ? 'openrouter-browser' : 'openrouter-headless');
        return;
      case 'gemini':
        if ((value === 'key' || value === 'google' || value === 'plan') && geminiConnectRowAction(liveGeminiConnectFacts(), value) === 'activate') {
          setFlow({ kind: 'receipt', ...activateGeminiSource(value === 'key' ? 'api-key' : value === 'plan' ? 'plan' : 'oauth') });
          return;
        }
        if (value === 'plan') {
          startHandlesRun('gemini-plan');
          return;
        }
        if (value === 'key') {
          setFlow({ kind: 'key', leg: 'gemini-key', note: null, storing: false, opened: 'opening' });
          void openBrowser(GEMINI_API_KEY_PAGE.address).then(ok => {
            setFlow(f => (f?.kind === 'key' && f.leg === 'gemini-key' ? { ...f, opened: ok ? 'opened' : 'failed' } : f));
          });
          return;
        }
        if (value === 'client') {
          openGuideStep(5, 'pick');
          return;
        }
        if (geminiGuideOpeningStep(liveGeminiConnectFacts()) === 6) {
          startHandlesRun('gemini-oauth');
          return;
        }
        openGuideStep(1, 'walk');
        return;
    }
  };

  const submitKey = (leg: FaceKeyLegId, raw: string): void => {
    const value = raw.trim();
    if (leg === 'anthropic-key' || leg === 'anthropic-workspace') {
      if (!value || anthropicKeyRequest.current) return;
      const request = new AbortController();
      anthropicKeyRequest.current = request;
      const key = leg === 'anthropic-workspace' ? anthropicKeyDraft.current : value;
      setFlow({ kind: 'key', leg, note: null, storing: true });
      void storeAnthropicApiKeyLogin(key, { workspaceId: leg === 'anthropic-workspace' ? value : undefined, signal: request.signal }).then(outcome => {
        if (request.signal.aborted) return;
        anthropicKeyRequest.current = null;
        if (outcome.stored) {
          anthropicKeyDraft.current = '';
          setDraft('');
          setFlow({ kind: 'receipt', receipt: outcome.receipt, ok: true });
        } else if (outcome.needsWorkspace) {
          anthropicKeyDraft.current = key;
          setDraft('');
          setFlow({ kind: 'key', leg: 'anthropic-workspace', note: null, storing: false });
        } else setFlow({ kind: 'key', leg, note: outcome.receipt, storing: false });
      });
      return;
    }
    if (!value) {
      if (leg === 'xai-management') setFlow({ kind: 'receipt', receipt: `${xaiApiReceipt.current} Management key unchanged; /logins xai adds it later.`, ok: true });
      else if (leg === 'xai' && resolveXaiApiKey()) setFlow({ kind: 'key', leg: 'xai-management', note: null, storing: false });
      else if (leg === 'mistral-admin') setFlow({ kind: 'receipt', receipt: `${mistralApiReceipt.current} Admin API key unchanged; /logins mistral adds it later.`, ok: true });
      return;
    }
    const guard = keyPasteGuardNote(value, keyLegGuardOpts(leg));
    if (guard !== null) {
      setFlow({ kind: 'key', leg, note: guard, storing: false });
      return;
    }
    setFlow({ kind: 'key', leg, note: null, storing: true });
    const settle = (outcome: { ok: boolean; stored: boolean; receipt: string }): void => {
      if (flowRef.current?.kind !== 'key') return;
      if (!outcome.stored) {
        setFlow({ kind: 'key', leg, note: outcome.receipt, storing: false });
        return;
      }
      setDraft('');
      if (leg === 'xai') {
        xaiApiReceipt.current = outcome.receipt;
        setFlow({ kind: 'key', leg: 'xai-management', note: null, storing: false });
      } else if (leg === 'mistral') {
        mistralApiReceipt.current = outcome.receipt;
        setFlow({ kind: 'key', leg: 'mistral-admin', note: null, storing: false });
      } else setFlow({ kind: 'receipt', receipt: leg === 'xai-management' ? `${xaiApiReceipt.current} ${outcome.receipt}` : leg === 'mistral-admin' ? `${mistralApiReceipt.current} ${outcome.receipt}` : outcome.receipt, ok: outcome.ok });
    };
    if (leg.startsWith('compat/')) void storeCompatApiKeyLogin(leg.slice(7), value).then(settle);
    else if (leg === 'openai-key') void storeOpenaiApiKeyLogin(value).then(settle);
    else if (leg === 'deepseek') void storeDeepseekApiKeyLogin(value).then(settle);
    else if (leg === 'xai') void storeXaiApiKeyLogin(value).then(settle);
    else if (leg === 'xai-management') void storeXaiManagementKeyLogin(value).then(settle);
    else if (leg === 'meta') void storeMetaApiKeyLogin(value).then(settle);
    else if (leg === 'mistral') void storeMistralApiKeyLogin(value).then(settle);
    else if (leg === 'mistral-admin') void storeMistralAdminKeyLogin(value).then(settle);
    else if (leg === 'nous') void storeNousApiKeyLogin(value).then(outcome => settle({ ok: outcome.ok, stored: outcome.stored, receipt: outcome.receipt }));
    else if (leg === 'zen') void storeZenApiKeyLogin(value).then(settle);
    else if (leg === 'minimax') void storeMinimaxApiKeyLogin(value).then(settle);
    else if (leg === 'together') void storeTogetherApiKeyLogin(value).then(settle);
    else if (leg === 'cohere') void storeCohereApiKeyLogin(value).then(settle);
    else if (leg === 'groq') void storeGroqApiKeyLogin(value).then(settle);
    else if (leg === 'melious') void storeMeliousApiKeyLogin(value).then(settle);
    else if (leg === 'orcarouter') void storeOrcarouterApiKeyLogin(value).then(settle);
    else if (leg === 'cerebras') void storeCerebrasApiKeyLogin(value).then(settle);
    else if (leg === 'fireworks') void storeFireworksApiKeyLogin(value).then(settle);
    else if (leg === 'qwen') void storeQwenApiKeyLogin(value).then(settle);
    else if (leg === 'moonshot-key')
      void storeMoonshotApiKeyLogin(value).then(outcome => settle({ ok: outcome.ok, stored: outcome.stored, receipt: outcome.receipt }));
    else if (leg === 'hf-token') void storeHuggingfaceTokenLogin(value).then(settle);
    else if (leg === 'openrouter-key') void storeOpenrouterApiKeyLogin(value).then(settle);
    else if (leg === 'gemini-key') void storeGeminiApiKeyLogin(value).then(settle);
    else void storeZaiApiKeyLogin(value, leg === 'zai-coding' ? 'coding' : 'general').then(settle);
  };

  const keyEscape = (leg: FaceKeyLegId): void => {
    setDraft('');
    if (leg === 'anthropic-key' || leg === 'anthropic-workspace') {
      anthropicKeyRequest.current?.abort();
      anthropicKeyRequest.current = null;
      anthropicKeyDraft.current = '';
      openPick('anthropic');
      return;
    }
    if (leg === 'xai-management') setFlow({ kind: 'receipt', receipt: `${xaiApiReceipt.current} Management key unchanged; /logins xai adds it later.`, ok: true });
    else if (leg === 'mistral-admin') setFlow({ kind: 'receipt', receipt: `${mistralApiReceipt.current} Admin API key unchanged; /logins mistral adds it later.`, ok: true });
    else if (leg === 'openai-key') openPick('openai');
    else if (leg === 'zai-general' || leg === 'zai-coding') openPick('zai');
    else if (leg === 'moonshot-key') openPick('moonshot');
    else if (leg === 'hf-token') openPick('huggingface');
    else if (leg === 'openrouter-key') openPick('openrouter');
    else if (leg === 'gemini-key') openPick('gemini');
    else if (leg === 'meta') openPick('meta');
    else closeFlow();
  };

  const recordedFocus = loginFamilyFocusFor(mostRecentSignInFamily());
  const initialFocus = loginFamilyInitialFocus(arms.map(arm => arm.row), recordedFocus, loginFamilyFocusFor(family));

  const list = useInteractiveList<LoginsArmV1>({
    rows: arms,
    rowId: a => `logins:${a.row.value}`,
    idNamespace: 'boot-logins',
    ...(initialFocus !== undefined ? { initialId: `logins:${initialFocus}` } : {}),
    active: flow === null,
    onClose: () => onClose?.(),
    actions: [
      {
        key: 'return',
        hint: 'sign in',
        when: a => loginsFlowReady(a.row.value),
        run: a => {
          if (a !== null && loginsFlowReady(a.row.value)) openFlow(a);
          return null;
        },
      },
      {
        key: 's',
        hint: 'switch active slot',
        when: a => given === undefined && loginsSwitchableFamily(a, facts) !== null,
        run: a => {
          if (a === null || given !== undefined) return null;
          const family = loginsSwitchableFamily(a, facts);
          if (family === null) return null;
          const { switchActiveSlot } =
            require('../services/providers/slotSwitch.js') as typeof import('../services/providers/slotSwitch.js');
          const outcome = switchActiveSlot(family);
          refreshFacts();
          return outcome.receipt;
        },
      },
    ],
  });

  const pickOptions = flow?.kind === 'pick' ? loginsPickOptions(flow.pick) : [];
  const pickList = useInteractiveList<{ label: string; value: string }>({
    rows: pickOptions,
    rowId: r => `logins-pick:${r.value}`,
    idNamespace: 'boot-logins-pick',
    active: flow?.kind === 'pick',
    onClose: () => {
      if (flowRef.current?.kind === 'pick' && flowRef.current.pick === 'kimi-region') {
        openPick('moonshot');
        return;
      }
      closeFlow();
    },
    actions: [
      {
        key: 'return',
        hint: 'pick',
        run: r => {
          const current = flowRef.current;
          if (r !== null && current?.kind === 'pick') resolvePick(current.pick, r.value);
          return null;
        },
      },
    ],
  });

  useInput(
    (input, key, event) => {
      event.stopImmediatePropagation();
      const current = flowRef.current;
      if (current === null) return;
      if (current.kind === 'receipt') {
        if (key.return || key.escape) {
          if (current.ok) settleSignedIn();
          else {
            refreshFacts();
            closeFlow();
          }
        }
        return;
      }
      if (current.kind === 'device') {
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
            setTimeout(() => {
              if (run !== deviceRunRef.current) return;
              setFlow(f => (f?.kind === 'device' ? { kind: 'device', device: { ...f.device, copied: false } } : f));
            }, 2000);
          });
        }
        return;
      }
      if (current.kind === 'handles') {
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
            setTimeout(() => {
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
        return;
      }
      if (current.kind === 'opdevice') {
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
            setTimeout(() => {
              if (run !== deviceRunRef.current) return;
              setFlow(f => (f?.kind === 'opdevice' ? { kind: 'opdevice', opdevice: { ...f.opdevice, copied: false } } : f));
            }, 2000);
          });
        }
        return;
      }
      if (current.kind === 'client') {
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
        return;
      }
      if (current.kind === 'key') {
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
        return;
      }
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
    },
    { isActive: flow !== null && flow.kind !== 'pick' },
  );

  useInput(
    (_input, key, event) => {
      if (!key.leftArrow) return;
      event.stopImmediatePropagation();
      onClose?.();
    },
    { isActive: flow === null },
  );

  const { accent: coreAccent, rampStops } = useSplashCoreAccent();
  const core = useMemo(
    () => createSplashCore({ nocolor: false, truecolor: true, accent: coreAccent }),
    [coreAccent],
  );
  const wordGlow = useGreetingShimmer(rampStops, WORD_W);
  const mainModel = useEngineModel();

  const menuM = useMemo(() => {
    const critterKey = getSessionCritterKey();
    return loginsMenuModelOf(facts, {
      selIdx: list.selectedIndex,
      environment: {
        model: renderModelChip(mainModel),
        critter: critterKey.charAt(0).toUpperCase() + critterKey.slice(1),
        critterHue: getSessionAccent().accent,
        dirBase: basename(process.cwd()) || process.cwd(),
        dirTail: '',
      },
      statusNote: list.note,
      glowWord: wordGlow,
      notice,
      ...(flow !== null
        ? {
            flow: loginsFlowPaneOf(flow, model, draft, pickList, onSignedIn),
          }
        : {}),
    });
  }, [facts, list.selectedIndex, list.note, mainModel, flow, pickList.selectedIndex, model.flow, model.pastePromptUp, model.copied, model.shadowWarning, model.accountLabel, draft, wordGlow?.peakCell, wordGlow?.gainLevel]);

  const composition = useMemo(() => {
    const menu = core.composeBootMenu(columns, rows, menuM) as {
      lines: string[];
      entryLines: Array<{ entry: number; line: number }>;
    };
    const { placed, top } = core.placeBlock(menu.lines, rows) as { placed: string[]; top: number };
    return {
      placed,
      entryAt: new Map<number, number>(menu.entryLines.map(e => [e.line + top, e.entry])),
    };
  }, [core, columns, rows, menuM]);

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {Array.from({ length: rows }, (_, i) => {
        const line = composition.placed[i] ?? '';
        const entryIdx = composition.entryAt.get(i);
        const target =
          entryIdx === undefined
            ? null
            : flow === null && arms[entryIdx] !== undefined
              ? { props: list.rowProps(arms[entryIdx]!, entryIdx), hoverLabel: arms[entryIdx]!.row.label }
              : flow?.kind === 'pick' && pickOptions[entryIdx] !== undefined
                ? { props: pickList.rowProps(pickOptions[entryIdx]!, entryIdx), hoverLabel: pickOptions[entryIdx]!.label }
                : null;
        if (target !== null) {
          const { props, hoverLabel } = target;
          return (
            <InteractiveRow
              key={props.id}
              id={props.id}
              selected={props.selected}
              unavailable={props.unavailable}
              onSelect={props.onSelect}
              onActivate={props.onActivate}
              selectionBand={false}
              hoverStyle="chrome-ink"
              height={1}
            >
              {hover =>
                renderSceneLine(line, hover && !props.selected ? { label: hoverLabel, color: t.info } : undefined)
              }
            </InteractiveRow>
          );
        }
        return (
          <Box key={`loginsline-${i}`} height={1} flexShrink={0}>
            {line.length > 0 ? renderSceneLine(line) : null}
          </Box>
        );
      })}
    </Box>
  );
}
