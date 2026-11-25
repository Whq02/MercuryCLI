import React, { useMemo, useRef, useState } from 'react';
import { useSignInEpoch } from '../../models/sign-in/account-ledger/useSignInEpoch.js';
import { useCatalogueEpoch } from '../model-picker/useCatalogueEpoch.js';
import { useClaim, useLoad } from '../effects/effects.js';
import { Box, useInput } from '../themedRenderer.js';
import { createSplashCore, WORD_W } from '../../../assets/splash/splash-core.mjs';
import { useAnthropicLoginModel } from '../widgets/faces/anthropicLoginModel.js';
import type { KimiRegion } from '../../models/roads/moonshot/moonshotAccounts.js';
import { useSetAppStateMaybe } from '../app-state/AppState.js';
import { resolveProviderUsability } from '../../models/roads/providerUsability.js';
import { mostRecentSignInFamily } from '../../models/catalogue/computedDefault.js';
import { useEngineModel } from '../model-picker/useEngineModel.js';
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js';
import { loginFamilyFocusFor, loginFamilyInitialFocus } from '../../models/sign-in/flow-cards/loginFamilyRows.js';
import { InteractiveRow } from '../widgets/InteractiveRow.js';
import { renderSceneLine } from '../widgets/SceneCanvas.js';
import { bootEnvironment } from './bootEnvironment.js';
import { useGreetingShimmer } from '../widgets/useGreetingShimmer.js';
import { useInteractiveList } from '../widgets/useInteractiveList.js';
import { useMercuryTokens } from '../widgets/useMercuryTokens.js';
import { useSplashCoreAccent } from '../widgets/useSplashCoreAccent.js';
import { useBootComposition } from './useBootComposition.js';
import { loginsSwitchableFamily, loginsFlowReady, type LoginsScreenFactsV1, loginsSortedArms, collectLoginsScreenFacts, type LoginsArmV1 } from './logins/facts.js';
import { loginsPickOptions, type FaceKeyLegId, type LoginsPickId } from './logins/pickLines.js';
import type { OpenFlowState, FaceDeviceFamily, HandlesLegId } from './logins/flowLines.js';
import { loginsMenuModelOf, loginsFlowPaneOf } from './logins/menuModel.js';
import { postLoginSettleOf, startDeviceRunOf, openGuideStepOf, startHandlesRunOf, startOpenaiDeviceRunOf } from './logins/runs.js';
import { openFlowOf, resolvePickOf } from './logins/picks.js';
import { submitKeyOf, keyEscapeOf } from './logins/keyLegs.js';
import { receiptFlowKeys, deviceFlowKeys, handlesFlowKeys, opdeviceFlowKeys, clientFlowKeys, keyFlowKeys, anthropicFlowKeys } from './logins/flowKeys.js';
import type { LoginsFlowContext } from './logins/context.js';
export type { LoginsScreenFactsV1, LoginsArmV1, LoginsRowStateV1, LoginsEntry } from './logins/facts.js';
export { collectLoginsScreenFacts, loginsCatalogue, loginsFamilyCounts, loginsExpiredFamilies, loginsGlance, loginsArmSlots, loginsSwitchableFamily, loginsRowStateOf, loginsSortedArms, loginsEntryOf, loginsDetailLines, lateSettleNotice, loginsSummaryRows, loginsStatusLine, loginsFlowReady, loginsLegendOf } from './logins/facts.js';
export { maskedDraftLine, wrapHard, wrapClauses, anthropicFlowPaneLines, anthropicFlowLegendOf, anthropicFlowStatusOf, receiptPaneLines, signedInWayOut, signedInStatusWayOut } from './logins/anthropicLines.js';
export type { LoginsPickId, FaceKeyLegId } from './logins/pickLines.js';
export { geminiPickOptions, metaPickOptions, loginsPickOptions, loginsPickPaneLines, keyLegTitle, keyLegStoreLine, keyLegGuardOpts, keyPromptPaneLines } from './logins/pickLines.js';
export type { FaceDeviceFamily, DeviceWaitStateV1, HandlesLegId, HandlesWaitStateV1, OpenaiDeviceStateV1, GeminiClientStateV1, LoginsFlowPaneV1 } from './logins/flowLines.js';
export { deviceFamilyWords, deviceWaitPaneLines, handlesWaitPaneLines, handlesWaitWayOut, openaiDevicePaneLines, geminiClientPaneLines, loginsFlowLegendOf, loginsFlowStatusOf, loginsFlowPaneLines } from './logins/flowLines.js';
export { loginsMenuModelOf } from './logins/menuModel.js';

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

  const [factsTick, setFactsTick] = useState(0);
  const signInEpoch = useSignInEpoch();
  const catalogueEpoch = useCatalogueEpoch();
  const facts = useMemo<LoginsScreenFactsV1>(
    () => given ?? collectLoginsScreenFacts(),
    [given, signInEpoch, catalogueEpoch, factsTick],
  );
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
  useClaim(() => () => { anthropicKeyRequest.current?.abort(); anthropicKeyDraft.current = ''; }, []);
  const refreshFacts = (): void => {
    if (given === undefined) setFactsTick(n => n + 1);
  };
  useLoad(() => {
    if (given !== undefined) return;
    resolveProviderUsability(undefined, { fetchCatalogues: true });
  }, [given]);

  const setAppStateMaybe = useSetAppStateMaybe();
  const postLoginSettle = (): void => postLoginSettleOf(ctx);
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

  const startDeviceRun = (family: FaceDeviceFamily, region?: KimiRegion): void => startDeviceRunOf(ctx, family, region);

  const openGuideStep = (step: 1 | 2 | 3 | 4 | 5, from: 'walk' | 'pick', note: string | null = null): void => openGuideStepOf(ctx, step, from, note);

  const startHandlesRun = (leg: HandlesLegId): void => startHandlesRunOf(ctx, leg);

  const startOpenaiDeviceRun = (): void => startOpenaiDeviceRunOf(ctx);

  const model = useAnthropicLoginModel({
    onDone: () => {
      settleSignedIn();
    },
  });
  const openPick = (pick: LoginsPickId, cursor = 0): void => {
    setFlow({ kind: 'pick', pick });
    pickList.moveTo(cursor);
  };

  const openFlow = (arm: LoginsArmV1): void => openFlowOf(ctx, arm);

  const resolvePick = (pick: LoginsPickId, value: string): void => resolvePickOf(ctx, pick, value);

  const submitKey = (leg: FaceKeyLegId, raw: string): void => submitKeyOf(ctx, leg, raw);

  const keyEscape = (leg: FaceKeyLegId): void => keyEscapeOf(ctx, leg);
  const ctx: LoginsFlowContext = { given, setAppStateMaybe, flowRef, draftRef, deviceRunRef, handlesRef, anthropicKeyDraft, anthropicKeyRequest, xaiApiReceipt, mistralApiReceipt, setFlow, setNotice, setDraft, refreshFacts, closeFlow, settleSignedIn, discloseLateSettle, startDeviceRun, openGuideStep, startHandlesRun, startOpenaiDeviceRun, model, openPick, submitKey, keyEscape };

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
            require('../../models/roads/slotSwitch.js') as typeof import('../../models/roads/slotSwitch.js');
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
        receiptFlowKeys(ctx, current, key);
        return;
      }
      if (current.kind === 'device') {
        deviceFlowKeys(ctx, current, input, key);
        return;
      }
      if (current.kind === 'handles') {
        handlesFlowKeys(ctx, current, input, key);
        return;
      }
      if (current.kind === 'opdevice') {
        opdeviceFlowKeys(ctx, current, input, key);
        return;
      }
      if (current.kind === 'client') {
        clientFlowKeys(ctx, current, input, key);
        return;
      }
      if (current.kind === 'key') {
        keyFlowKeys(ctx, current, input, key);
        return;
      }
      anthropicFlowKeys(ctx, input, key);
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
    return loginsMenuModelOf(facts, {
      selIdx: list.selectedIndex,
      environment: bootEnvironment(mainModel, process.cwd()),
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

  const composition = useBootComposition(core, columns, rows, menuM);

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

