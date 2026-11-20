import React, { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useDerivedState, useLoad, useSubscription, useTimer } from '../hooks/effects.js';
import 'figures';
import { getCwd } from '../utils/cwd.js';
import { adoptGroundFamily, createSplashCore, assembleCardRows, CARD_LABEL_W, WORD_W } from '../../assets/splash/splash-core.mjs';
import { useTheme } from './design-system/ThemeProvider.js';
import {
  chatOnlyBoot,
  enterConcourse,
  enterRootChat,
  leaveCurrentSurface,
  routeSurfaceRegistered,
  stripKeyMapHint,
  subscribeSurfaceRoute,
  surfaceRouteVersion,
} from '../context/surfaceRoute.js';
import { getProjectDir } from '../utils/sessionStoragePortable.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useLayoutChrome } from '../context/layoutChromeContext.js';
import { useEngineModel } from '../hooks/useEngineModel.js';
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js';
import { getSessionId } from '../bootstrap/state.js';
import { getUserSpecifiedModelSetting, renderModelChip } from '../utils/model/model.js';
import { computedDefault, readComputedDefaultCatalogue } from '../utils/model/computedDefault.js';
import { getSessionAccent, getSessionCritterKey } from './mercury-ui/sessionAccent.js';
import { takeFaceUpdateNotice, UPDATE_NOTICE_STAY_MS } from '../services/privateChannel/quietUpdateNotice.js';
import { deriveFamilySlotGroups } from '../services/providers/accountSlots.js';
import { sessionAccountWords } from '../utils/accounts/sessionAccount.js';
import { useSignInEpoch } from '../utils/accounts/useSignInEpoch.js';
import { useCatalogueEpoch } from '../hooks/useCatalogueEpoch.js';
import { healthCertSnapshot } from '../utils/cockpit/healthCertSnapshot.js';
import { projectDisplayName, scanBootCardFacts, type BootProjectFact } from '../utils/bootCardFacts.js';
import { plainWorldWhy, stripFacts, type PlainWorldWhy } from '../context/surfaceRoute.js';
import { consumeFaceDoorDeepLink, consumeKitManagerDeepLink, peekFaceDoorOpener } from '../substrate/splashHandover.js';
import { peekWornPresetKit } from '../services/switchboard/bootBirthFacts.js';
import { enterBootSettings, settleAbsentChat } from '../context/surfaceRoute.js';
import { recordLaunchMilestone } from '../substrate/launchMilestones.js';
import { mintImmediateReceipt, recentWarningReceipt, subscribeSeatReceipts } from '../utils/model/seatReceipts.js';
import { loginsGlance } from './BootLoginsScreen.js';
import { fireDeltaWords } from './BootSaturnScreen.js';
import { SESSION_DEFAULTS_KEY_HINT, sessionDefaultsKeyOn } from '../services/switchboard/sessionDefaultsKey.js';
import { useGreetingShimmer } from './mercury-ui/useGreetingShimmer.js';
import { useInteractiveList, type AsyncListNote } from './mercury-ui/useInteractiveList.js';
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js';
import { useSplashCoreAccent } from './mercury-ui/useSplashCoreAccent.js';
import { openProjectOf, runRowOf, type BootRow } from './bootSplash/rowActions.js';
import { bootSplashCompositionOf, bootSplashFaceView } from './bootSplash/face.js';
import { armBootSettingsLayerDeepLink, consumeBootSettingsLayerDeepLink } from './bootSplash/settingsLayerDeepLink.js';
import { passedOver } from '../utils/passedOver.js';
import { startTimeout, stopTimeout } from '../utils/timers.js';


export { armBootSettingsLayerDeepLink };

const KEY_MAP_ROW = (core: ReturnType<typeof createSplashCore>, hint: string): string =>
  '  ' + core.hexFg(core.FAINT, core.T256.faint) + hint + core.R;

export function faceKeyMapHintOf(stripHint: string, modelDefaultDoor: boolean): string {
  if (!modelDefaultDoor) return stripHint;
  const phrase = `m ${SESSION_DEFAULTS_KEY_HINT}`;
  return stripHint === '' ? phrase : `${stripHint} · ${phrase}`;
}

function bottomRowWithNotice(
  core: ReturnType<typeof createSplashCore>,
  columns: number,
  keyMapHint: string,
  notice: string | null,
  compact: boolean,
): string | null {
  if (notice === null) return null;
  const faint = (text: string): string => core.hexFg(core.FAINT, core.T256.faint) + text + core.R;
  const warning = (text: string): string => core.paint(core.AMBERC) + text + core.R;
  const noticeW = core.vis(notice);
  if (keyMapHint === '') {
    return noticeW + 2 <= columns ? ' '.repeat(columns - noticeW - 2) + warning(notice) : null;
  }
  const hintW = core.vis(keyMapHint);
  if (compact) {
    if (noticeW + 3 + hintW + 2 > columns) return null;
    return ' '.repeat(columns - noticeW - 3 - hintW - 2) + warning(notice) + '   ' + faint(keyMapHint);
  }
  if (2 + hintW + 2 + noticeW + 2 > columns) return null;
  return KEY_MAP_ROW(core, keyMapHint) + ' '.repeat(columns - 2 - hintW - noticeW - 2) + warning(notice);
}

export function concourseRowCtx(facts: { live: boolean; why: PlainWorldWhy | null; liveCount: number }): string {
  if (!facts.live) return 'unregistered in this build';
  const count = facts.liveCount > 0 ? ` · ${facts.liveCount} live` : '';
  return facts.why !== null ? `live view only — ${facts.why}${count}` : `the live board${count}`;
}


type BornSessionFn = typeof import('../services/switchboard/bornSession.js')['bornSession'];

async function flipFirstBirth(start: (bornSession: BornSessionFn) => ReturnType<BornSessionFn>): Promise<string | null> {
  const { bornSession } = await import('../services/switchboard/bornSession.js');
  const birth = start(bornSession);
  const flipped = enterRootChat().ok;
  if (flipped) recordLaunchMilestone('chat-flipped');
  const born = await birth;
  if (!born.ok) {
    recordLaunchMilestone('birth-refused');
    if (flipped) {
      if (!settleAbsentChat().ok) enterBootSettings();
      startTimeout(() => mintImmediateReceipt(`▲ the chat could not start — ${born.reason}`, 'warning'), 0);
    }
    return born.reason;
  }
  recordLaunchMilestone('birth-landed');
  if (!flipped) enterRootChat();
  return null;
}

export function BootSplashScreen(): React.ReactNode {
  const t = useMercuryTokens();
  const { columns, rows } = useTerminalSize();
  const { isCompact } = useLayoutChrome();
  const permissionMode = useAppStateMaybeOutsideOfProvider(state => state.toolPermissionContext.mode);
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  const [settingsOpen, setSettingsOpen] = useState(() => consumeBootSettingsLayerDeepLink());
  const [kitOpen, setKitOpen] = useState(() => consumeKitManagerDeepLink());
  const [faceDoorOpener] = useState(() => peekFaceDoorOpener());
  const [faceDoor] = useState(() => consumeFaceDoorDeepLink());
  const [healthOpen, setHealthOpen] = useState(faceDoor === 'health');
  const [resumeOpen, setResumeOpen] = useState(faceDoor === 'resume');
  const [saturnOpen, setSaturnOpen] = useState(faceDoor === 'saturn');
  const [agentsOpen, setAgentsOpen] = useState(faceDoor === 'agents');
  const [loginsOpen, setLoginsOpen] = useState(faceDoor === 'logins');
  const [loginsFamily, setLoginsFamily] = useState<string | undefined>(faceDoor === 'logins' ? faceDoorOpener?.family : undefined);
  const [loginsBack, setLoginsBack] = useState<'route' | 'picker' | null>(faceDoor === 'logins' && faceDoorOpener?.returnToOpener === true ? 'route' : null);
  const [modelDefaultOpen, setModelDefaultOpen] = useState(faceDoor === 'model' && sessionDefaultsKeyOn());
  const [presenceEpoch, setPresenceEpoch] = useState(0);
  const closeLogins = (): void => {
    const back = loginsBack;
    setLoginsBack(null);
    setLoginsFamily(undefined);
    if (back === 'route' && leaveCurrentSurface().ok) return;
    setLoginsOpen(false);
    setPresenceEpoch(e => e + 1);
    if (back === 'picker') setModelDefaultOpen(true);
  };
  const signInEpoch = useSignInEpoch();

  const [facts] = useState(() => scanBootCardFacts(getCwd(), getSessionId()));
  const [updateLine, setUpdateLine] = useState(() => takeFaceUpdateNotice());
  useTimer(() => {
    if (updateLine === null) return;
    const timer = startTimeout(() => setUpdateLine(null), UPDATE_NOTICE_STAY_MS);
    return () => stopTimeout(timer);
  }, [updateLine]);

  const concourseLive = routeSurfaceRegistered('concourse');
  const plainWhy = plainWorldWhy();
  const chatBoot = stripFacts().chatBoot;
  const modelDefaultDoor = sessionDefaultsKeyOn();
  useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion);
  const stripHint = stripKeyMapHint();
  const keyMapHint = faceKeyMapHintOf(stripHint, modelDefaultDoor);

  const [birthReceipt, setBirthReceipt] = useState<string | null>(() => recentWarningReceipt()?.text ?? null);
  useSubscription(
    () =>
      subscribeSeatReceipts(r => {
        if (r.level === 'warning') setBirthReceipt(r.text);
      }, r => r.level === 'warning'),
    [],
  );

  const [liveCount, setLiveCount] = useState<number>(0);
  useLoad(() => {
    if (chatBoot) return;
    let cancelled = false;
    void import('../daemon/concourseWorkers.js')
      .then(sup => {
        if (!cancelled) setLiveCount(sup.countLiveConcourseWorkers());
      })
      .catch(passedOver);
    return () => {
      cancelled = true;
    };
  }, [chatBoot]);
  const [runningByKey, setRunningByKey] = useState<ReadonlyMap<string, number>>(() => new Map());
  useLoad(() => {
    if (chatOnlyBoot()) return;
    let cancelled = false;
    void import('../services/concourse/projectActivity.js')
      .then(async m => {
        const counts = await m.runningByProjectKey();
        if (!cancelled && counts.size > 0) setRunningByKey(counts);
      })
      .catch(passedOver);
    return () => {
      cancelled = true;
    };
  }, []);
  const runningOf = (dir: string): number => {
    try {
      return runningByKey.get(getProjectDir(dir)) ?? 0;
    } catch (error) {
      passedOver(error)
      return 0;
    }
  };

  const [saturnCtx, setSaturnCtx] = useState<string | null>(null);
  useLoad(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [sup, saturn, box] = await Promise.all([
          import('../daemon/concourseWorkers.js'),
          import('../daemon/saturn.js'),
          import('../daemon/saturnBoxSchedules.js'),
        ]);
        const records = Object.values(sup.readSessionWorkers()).filter(r => r.endedAt === undefined);
        const glance = saturn.saturnWakeGlanceOf([...records, box.readBoxSchedules()]);
        if (!cancelled && glance.count > 0) {
          setSaturnCtx(
            `${glance.count} schedule${glance.count === 1 ? '' : 's'}${glance.nextFireMs !== null ? ` · next ${fireDeltaWords(glance.nextFireMs, Date.now())}` : ''}${glance.held > 0 ? ` · ${glance.held} held` : ''}`,
          );
        }
      } catch (error) {
        passedOver(error)
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [agentsCtx, setAgentsCtx] = useState<string | null>(null);
  const [agentsEpoch, setAgentsEpoch] = useState(0);
  useLoad(() => {
    let cancelled = false;
    void import('../tools/AgentTool/loadAgentsDir.js')
      .then(async loader => {
        const defs = await loader.getAgentDefinitionsWithOverrides(getCwd());
        const n = defs.activeAgents.length;
        if (!cancelled && n > 0) setAgentsCtx(`${n} agent${n === 1 ? '' : 's'}`);
      })
      .catch(passedOver);
    return () => {
      cancelled = true;
    };
  }, [agentsEpoch]);

  const loginsCtx = useMemo(() => {
    try {
      return loginsGlance(deriveFamilySlotGroups());
    } catch (error) {
      passedOver(error)
      return null;
    }
  }, [presenceEpoch, signInEpoch]);

  const repoCount = facts.pickerProjects.length + (facts.cwdProject !== null ? 1 : 0);
  const sessionsCtx = repoCount > 0 ? `${repoCount} repo${repoCount === 1 ? '' : 's'} · pick a session` : null;

  const goHome = (): void => {
    if (!leaveCurrentSurface().ok) enterRootChat();
  };

  const openProject = (p: BootProjectFact): AsyncListNote => {
    return openProjectOf({ flipFirstBirth }, p);
  };

  const armedPresetName = peekWornPresetKit()?.name;

  const composedRows: BootRow[] = useMemo(
    () =>
      assembleCardRows({
        cwdBase: projectDisplayName(getCwd()),
        continueTarget: facts.cwdProject
          ? { base: facts.cwdProject.base, ageMs: facts.cwdProject.ageMs, cross: false }
          : facts.recentLast
            ?
              { base: facts.recentLast.base, ageMs: facts.recentLast.ageMs, cross: true, dim: true }
            : null,
        menuAvailable: true,
        concourse: chatBoot
          ? null
          : {
              ctx: concourseRowCtx({ live: concourseLive, why: plainWhy, liveCount }),
              ...(concourseLive ? {} : { dim: true }),
            },
        ...(armedPresetName !== undefined ? { kitArmedPreset: armedPresetName } : {}),
        ...(saturnCtx !== null ? { saturnCtx } : {}),
        ...(agentsCtx !== null ? { agentsCtx } : {}),
        ...(loginsCtx !== null ? { loginsCtx } : {}),
        ...(sessionsCtx !== null ? { sessionsCtx } : {}),
      }) as BootRow[],
    [facts, concourseLive, plainWhy, chatBoot, liveCount, armedPresetName, saturnCtx, agentsCtx, loginsCtx, sessionsCtx],
  );

  const runRow = (row: BootRow | null): AsyncListNote | null => {
    return runRowOf({ flipFirstBirth, facts, permissionModeRef, setSettingsOpen, setKitOpen, setHealthOpen, setSaturnOpen, setAgentsOpen, setLoginsOpen, setResumeOpen }, row);
  };

  const [selCleared, setSelCleared] = useState(false);
  const selClearedRef = useRef(selCleared);
  selClearedRef.current = selCleared;

  const list = useInteractiveList<BootRow>({
    rows: composedRows,
    rowId: r => r.key,
    idNamespace: 'boot-splash',
    active: !settingsOpen && !kitOpen && !healthOpen && !resumeOpen && !saturnOpen && !agentsOpen && !loginsOpen && !modelDefaultOpen,
    onClose: () => {
      if (!selClearedRef.current) {
        setSelCleared(true);
        return;
      }
      goHome();
    },
    actions: [
      {
        key: 'return',
        hint: 'start',
        run: r => {
          const target = selClearedRef.current ? (composedRows[0] ?? null) : r;
          setSelCleared(false);
          return runRow(target);
        },
      },
      {
        key: 'm',
        hint: modelDefaultDoor ? SESSION_DEFAULTS_KEY_HINT : 'menu',
        run: () => ((modelDefaultDoor ? setModelDefaultOpen(true) : setSettingsOpen(true)), null),
      },
      { key: 's', hint: 'menu', run: (): null => (setSettingsOpen(true), null) },
      ...(chatBoot ? [] : [{ key: 'o', hint: 'concourse', run: (): null => (enterConcourse(), null) }]),
    ],
    unavailable: r => r.dim === true,
    reasonUnavailable: r => r.ctx,
  });
  const selIdx = list.selectedIndex;
  const prevSelRef = useRef(selIdx);
  useDerivedState(() => {
    if (prevSelRef.current !== selIdx) {
      prevSelRef.current = selIdx;
      setSelCleared(false);
    }
  }, [selIdx]);


  const { accent: coreAccent, rampStops } = useSplashCoreAccent();
  const [resolvedTheme] = useTheme();
  const core = useMemo(() => {
    adoptGroundFamily(resolvedTheme === 'true-black' ? 'true-black' : 'dark');
    return createSplashCore({ nocolor: false, truecolor: true, accent: coreAccent });
  }, [coreAccent, resolvedTheme]);
  const wordGlow = useGreetingShimmer(rampStops, isCompact ? 0 : WORD_W);
  const rowGlow = useGreetingShimmer(
    rampStops,
    isCompact ? 0 : CARD_LABEL_W,
    `card:${selCleared ? -1 : list.selectedIndex}`,
  );
  const mainModel = useEngineModel();

  const catalogueEpoch = useCatalogueEpoch();
  useLoad(() => {
    let pending = false;
    try {
      const decision = computedDefault();
      pending = getUserSpecifiedModelSetting() === null && decision.considered.length > 0 && decision.considered[0]?.verdict.usable !== true;
    } catch {
      pending = false;
    }
    if (!pending) return;
    void readComputedDefaultCatalogue().catch(passedOver);
  }, [signInEpoch, catalogueEpoch]);
  const chips = useMemo(() => {
    let acct: { state: 'email' | 'none' | 'unreadable'; text?: string };
    try {
      const fit = (text: string): string => (text.length > 26 ? text.slice(0, 25) + '…' : text);
      const words = sessionAccountWords(mainModel);
      acct = words.state === 'email' ? { state: 'email', text: fit(words.text) } : { state: 'none' };
    } catch {
      acct = { state: 'unreadable' };
    }
    const cert = healthCertSnapshot();
    const critterKey = getSessionCritterKey();
    let keylessRow: string | null = null;
    try {
      const decision = computedDefault();
      keylessRow = getUserSpecifiedModelSetting() === null && decision.source === 'keyless' ? decision.row : null;
    } catch {
      keylessRow = null;
    }
    return {
      model: keylessRow ?? renderModelChip(mainModel),
      critter: critterKey.charAt(0).toUpperCase() + critterKey.slice(1),
      critterHue: getSessionAccent().accent,
      dir: projectDisplayName(getCwd()),
      acct,
      health:
        cert.state === 'live' && cert.data.verdict
          ? { verdict: cert.data.verdict, age: cert.data.ageLabel }
          : null,
    };
  }, [mainModel, presenceEpoch, catalogueEpoch, signInEpoch]);

  const selectedIndex = selCleared ? -1 : list.selectedIndex;
  const composition = useMemo(() => {
    return bootSplashCompositionOf({ isCompact, composedRows, selectedIndex, core, columns, rows, modelDefaultDoor, stripHint, wordGlow, rowGlow, bottomRowWithNotice, updateLine, chips, plainWhy, keyMapHint });
  }, [core, columns, rows, isCompact, plainWhy, stripHint, keyMapHint, modelDefaultDoor, updateLine, selectedIndex, composedRows, chips, wordGlow?.peakCell, wordGlow?.gainLevel, rowGlow?.peakCell, rowGlow?.gainLevel]);


  return bootSplashFaceView({ settingsOpen, columns, rows, setSettingsOpen, kitOpen, setKitOpen, healthOpen, setHealthOpen, saturnOpen, setSaturnOpen, agentsOpen, loginsOpen, setLoginsOpen, setAgentsOpen, setAgentsEpoch, closeLogins, loginsFamily, loginsBack, resumeOpen, setResumeOpen, facts, runningOf, openProject, composition, list, birthReceipt, core, isCompact, keyMapHint, updateLine, bottomRowWithNotice, KEY_MAP_ROW, composedRows, t, modelDefaultOpen, setModelDefaultOpen, setLoginsFamily, setLoginsBack });
}
