import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { basename } from 'node:path';
import { getCwd } from '../utils/cwd.js';
import { Box } from '../ink.js';
import { adoptGroundFamily, createSplashCore, assembleCardRows, CARD_LABEL_W, WORD_W } from '../../assets/splash/splash-core.mjs';
import { useTheme } from './design-system/ThemeProvider.js';
import {
  chatOnlyBoot,
  enterConcourse,
  enterRootRepl,
  leaveCurrentSurface,
  routeSurfaceRegistered,
  stripKeyMapHint,
  subscribeSurfaceRoute,
  surfaceRouteVersion,
} from '../context/surfaceRoute.js';
import { getProjectDir } from '../utils/sessionStoragePortable.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useLayoutChrome } from '../context/layoutChromeContext.js';
import { truncateToWidth } from './mercury-ui/glyphs.js';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js';
import { getSessionId } from '../bootstrap/state.js';
import { getUserSpecifiedModelSetting, renderModelChip } from '../utils/model/model.js';
import { computedDefault } from '../utils/model/computedDefault.js';
import { getSessionAccent, getSessionCritterKey } from './mercury-ui/sessionAccent.js';
import { providerFamilyPresences } from '../services/providers/providerUsage.js';
import { sessionAccountWords } from '../utils/accounts/sessionAccount.js';
import { useSignInEpoch } from '../utils/accounts/useSignInEpoch.js';
import { useCatalogueEpoch } from '../hooks/useCatalogueEpoch.js';
import { healthCertSnapshot } from '../utils/cockpit/healthCertSnapshot.js';
import { projectDisplayName, scanBootCardFacts, type BootProjectFact } from '../utils/bootCardFacts.js';
import { plainWorldWhy, stripFacts, type PlainWorldWhy } from '../context/surfaceRoute.js';
import { consumeFaceDoorDeepLink, consumeKitManagerDeepLink } from '../substrate/splashHandover.js';
import { peekWornPresetKit } from '../services/switchboard/bootBirthFacts.js';
import { enterBootSettings, settleAbsentChat } from '../context/surfaceRoute.js';
import { recordLaunchMilestone } from '../substrate/launchMilestones.js';
import { mintImmediateReceipt, recentWarningReceipt, subscribeSeatReceipts } from '../utils/model/seatReceipts.js';
import { BootAgentsScreen } from './BootAgentsScreen.js';
import { BootHealthScreen } from './BootHealthScreen.js';
import { BootLoginsScreen } from './BootLoginsScreen.js';
import { BootResumeScreen } from './BootResumeScreen.js';
import { BootSaturnScreen, fireDeltaWords } from './BootSaturnScreen.js';
import { BootSettingsScreen } from './BootSettingsScreen.js';
import { KitMenuScreen } from './KitMenuScreen.js';
import { InteractiveRow } from './mercury-ui/InteractiveRow.js';
import { renderSceneLine } from './mercury-ui/SceneCanvas.js';
import { useGreetingShimmer } from './mercury-ui/useGreetingShimmer.js';
import { useInteractiveList, type AsyncListNote } from './mercury-ui/useInteractiveList.js';
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js';
import { useSplashCoreAccent } from './mercury-ui/useSplashCoreAccent.js';


let settingsLayerDeepLink = false;
export function armBootSettingsLayerDeepLink(): void {
  settingsLayerDeepLink = true;
}
function consumeBootSettingsLayerDeepLink(): boolean {
  const armed = settingsLayerDeepLink;
  settingsLayerDeepLink = false;
  return armed;
}

type BootRow = {
  key: string;
  icon: string;
  label: string;
  ctx: string;
  dim?: boolean;
};

const KEY_MAP_ROW = (core: ReturnType<typeof createSplashCore>, hint: string): string =>
  '  ' + core.hexFg(core.FAINT, core.T256.faint) + hint + core.R;

export function concourseRowCtx(facts: { live: boolean; why: PlainWorldWhy | null; liveCount: number }): string {
  if (!facts.live) return 'unregistered in this build';
  const count = facts.liveCount > 0 ? ` · ${facts.liveCount} live` : '';
  return facts.why !== null ? `live view only — ${facts.why}${count}` : `the live board${count}`;
}


type BornSessionFn = typeof import('../services/switchboard/bornSession.js')['bornSession'];

async function flipFirstBirth(start: (bornSession: BornSessionFn) => ReturnType<BornSessionFn>): Promise<string | null> {
  const { bornSession } = await import('../services/switchboard/bornSession.js');
  const birth = start(bornSession);
  const flipped = enterRootRepl().ok;
  if (flipped) recordLaunchMilestone('chat-flipped');
  const born = await birth;
  if (!born.ok) {
    recordLaunchMilestone('birth-refused');
    if (flipped) {
      if (!settleAbsentChat().ok) enterBootSettings();
      setTimeout(() => mintImmediateReceipt(`▲ the chat could not start — ${born.reason}`, 'warning'), 0);
    }
    return born.reason;
  }
  recordLaunchMilestone('birth-landed');
  if (!flipped) enterRootRepl();
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
  const [faceDoor] = useState(() => consumeFaceDoorDeepLink());
  const [healthOpen, setHealthOpen] = useState(faceDoor === 'health');
  const [resumeOpen, setResumeOpen] = useState(faceDoor === 'resume');
  const [saturnOpen, setSaturnOpen] = useState(faceDoor === 'saturn');
  const [agentsOpen, setAgentsOpen] = useState(faceDoor === 'agents');
  const [loginsOpen, setLoginsOpen] = useState(faceDoor === 'logins');
  const [presenceEpoch, setPresenceEpoch] = useState(0);
  const signInEpoch = useSignInEpoch();

  const [facts] = useState(() => scanBootCardFacts(getCwd(), getSessionId()));

  const concourseLive = routeSurfaceRegistered('concourse');
  const plainWhy = plainWorldWhy();
  const chatBoot = stripFacts().chatBoot;
  useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion);
  const keyMapHint = stripKeyMapHint();
  const menuAvailable = isCompact || (columns >= 64 && rows >= 13);

  const [birthReceipt, setBirthReceipt] = useState<string | null>(() => recentWarningReceipt()?.text ?? null);
  useEffect(
    () =>
      subscribeSeatReceipts(r => {
        if (r.level === 'warning') setBirthReceipt(r.text);
      }),
    [],
  );

  const [liveCount, setLiveCount] = useState<number>(0);
  useEffect(() => {
    if (chatBoot) return;
    let cancelled = false;
    void import('../daemon/concourseSupervisor.js')
      .then(sup => {
        if (!cancelled) setLiveCount(sup.countLiveConcourseWorkers());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [chatBoot]);
  const [runningByKey, setRunningByKey] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEffect(() => {
    if (chatOnlyBoot()) return;
    let cancelled = false;
    void import('../services/concourse/projectActivity.js')
      .then(async m => {
        const counts = await m.runningByProjectKey();
        if (!cancelled && counts.size > 0) setRunningByKey(counts);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const runningOf = (dir: string): number => {
    try {
      return runningByKey.get(getProjectDir(dir)) ?? 0;
    } catch {
      return 0;
    }
  };

  const [saturnCtx, setSaturnCtx] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [sup, saturn, box] = await Promise.all([
          import('../daemon/concourseSupervisor.js'),
          import('../daemon/saturn.js'),
          import('../daemon/saturnBoxSchedules.js'),
        ]);
        const records = Object.values(sup.readSessionWorkers()).filter(r => r.endedAt === undefined);
        const glance = saturn.saturnWakeGlanceOf([...records, box.readBoxSchedules()], Date.now());
        if (!cancelled && glance.count > 0) {
          setSaturnCtx(
            `${glance.count} schedule${glance.count === 1 ? '' : 's'}${glance.nextFireMs !== null ? ` · next ${fireDeltaWords(glance.nextFireMs, Date.now())}` : ''}`,
          );
        }
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [agentsCtx, setAgentsCtx] = useState<string | null>(null);
  const [agentsEpoch, setAgentsEpoch] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void import('../tools/AgentTool/loadAgentsDir.js')
      .then(async loader => {
        const defs = await loader.getAgentDefinitionsWithOverrides(getCwd());
        const n = defs.activeAgents.length;
        if (!cancelled && n > 0) setAgentsCtx(`${n} agent${n === 1 ? '' : 's'}`);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agentsEpoch]);

  const loginsCtx = useMemo(() => {
    try {
      const presences = providerFamilyPresences();
      const signed = presences.filter(f => f.credentialed).length;
      return signed > 0 ? `${signed} of ${presences.length} signed in` : null;
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenceEpoch, signInEpoch]);

  const repoCount = facts.pickerProjects.length + (facts.cwdProject !== null ? 1 : 0);
  const sessionsCtx = repoCount > 0 ? `${repoCount} repo${repoCount === 1 ? '' : 's'} · pick a session` : null;

  const goHome = (): void => {
    if (!leaveCurrentSurface().ok) enterRootRepl();
  };

  const openProject = (p: BootProjectFact): AsyncListNote => {
    return {
      pending: 'opening…',
      result: (async (): Promise<string | null> => {
        try {
          const [{ isPathTrusted }, snap] = await Promise.all([
            import('../utils/config.js'),
            import('../services/concourse/concourseSnapshot.js'),
          ]);
          if (isPathTrusted(p.dir)) {
            await snap.writeConcourseSeedOverride({ projectDir: p.dir });
            const ground = await import('../services/switchboard/harnessGround.js');
            await ground.applyHarnessGround(p.dir);
          }
          if (p.sessionId !== null) {
            const hop = await import('../services/switchboard/hopIntoSession.js');
            await hop.focusResumedSession(p.sessionId, p.transcriptPath ?? undefined, { title: p.base });
          } else if (
            p.firstSessionId !== null &&
            (await import('../daemon/concourseSupervisor.js')).sessionOwnedByLiveWorker(p.firstSessionId) !== null
          ) {
            const hop = await import('../services/switchboard/hopIntoSession.js');
            const outcome = await hop.hopIntoBoardSession(p.firstSessionId);
            if (!outcome.ok) return outcome.reason;
          } else {
            return await flipFirstBirth(bornSession => bornSession({ workspaceDir: p.dir }));
          }
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
        enterRootRepl();
        return null;
      })(),
    };
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
        menuAvailable,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [facts, menuAvailable, concourseLive, plainWhy, chatBoot, liveCount, armedPresetName, saturnCtx, agentsCtx, loginsCtx, sessionsCtx],
  );

  const runRow = (row: BootRow | null): AsyncListNote | null => {
    if (row == null || row.dim) return null;
    switch (row.key) {
      case 'new': {
        return {
          pending: 'starting a session…',
          result: flipFirstBirth(bornSession => bornSession({ workspaceDir: getCwd() })),
        };
      }
      case 'continue': {
        const target = facts.cwdProject;
        if (!target?.sessionId) return null;
        const sid = target.sessionId;
        return {
          pending: 'opening…',
          result: (async (): Promise<string | null> => {
            try {
              const hop = await import('../services/switchboard/hopIntoSession.js');
              const outcome = await hop.focusResumedSession(sid, target.transcriptPath ?? undefined, {
                permissionMode: permissionModeRef.current,
              });
              if (!outcome.ok) return outcome.reason;
            } catch (e) {
              return e instanceof Error ? e.message : String(e);
            }
            enterRootRepl();
            return null;
          })(),
        };
      }
      case 'menu':
        setSettingsOpen(true);
        return null;
      case 'kit':
        setKitOpen(true);
        return null;
      case 'doctor':
        setHealthOpen(true);
        return null;
      case 'saturn':
        setSaturnOpen(true);
        return null;
      case 'agents':
        setAgentsOpen(true);
        return null;
      case 'logins':
        setLoginsOpen(true);
        return null;
      case 'concourse':
        enterConcourse();
        return null;
      case 'sessions':
        setResumeOpen(true);
        return null;
    }
    return null;
  };

  const [selCleared, setSelCleared] = useState(false);
  const selClearedRef = useRef(selCleared);
  selClearedRef.current = selCleared;

  const list = useInteractiveList<BootRow>({
    rows: composedRows,
    rowId: r => r.key,
    idNamespace: 'boot-splash',
    active: !settingsOpen && !kitOpen && !healthOpen && !resumeOpen && !saturnOpen && !agentsOpen && !loginsOpen,
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
        hint: 'menu',
        run: () => (menuAvailable ? (setSettingsOpen(true), null) : 'the boot menu needs at least 64×13'),
      },
      { key: 's', hint: 'menu', run: () => (menuAvailable ? (setSettingsOpen(true), null) : 'the boot menu needs at least 64×13') },
      ...(chatBoot ? [] : [{ key: 'o', hint: 'concourse', run: (): null => (enterConcourse(), null) }]),
    ],
    unavailable: r => r.dim === true,
    reasonUnavailable: r => r.ctx,
  });
  const selIdx = list.selectedIndex;
  const prevSelRef = useRef(selIdx);
  useEffect(() => {
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
  const mainModel = useMainLoopModel();

  const catalogueEpoch = useCatalogueEpoch();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainModel, presenceEpoch, catalogueEpoch, signInEpoch]);

  const selectedIndex = selCleared ? -1 : list.selectedIndex;
  const composition = useMemo(() => {
    if (isCompact) {
      const keyRows = rows > 2 && keyMapHint !== '' ? 1 : 0;
      const count = Math.min(composedRows.length, Math.max(0, rows - keyRows - 1));
      const start = Math.max(0, Math.min(Math.max(0, selectedIndex) - count + 1, composedRows.length - count));
      const placed = composedRows.slice(start, start + count).map((row, i) => truncateToWidth(`${start + i === selectedIndex ? '❯' : ' '} ${row.label}${row.ctx !== '' ? ` · ${row.ctx}` : ''}`, columns));
      const actionAt = new Map<number, number>(placed.map((_, i) => [i, start + i]));
      const selected = composedRows[Math.max(0, selectedIndex)];
      const verb = selected && ['menu', 'kit', 'agents', 'doctor', 'saturn', 'logins'].includes(selected.key) ? 'open' : 'start';
      if (rows > 0) placed.push(truncateToWidth(`↵ ${verb} · ↑↓ choose · m menu`, columns));
      return { placed, actionAt, lastRowFree: keyRows > 0 };
    }
    const faceRows = plainWhy !== null && keyMapHint !== '' ? Math.max(1, rows - 1) : rows;
    const composed = core.composeLockup(columns, faceRows, {
      cardRows: composedRows.map(r => ({
        icon: r.icon,
        label: r.label,
        ctx: r.ctx,
        ...(r.dim ? { dim: true } : {}),
      })),
      cardSel: selectedIndex,
      hintSegments: [
        {
          key: '↵ ',
          label:
            composedRows[Math.max(0, selectedIndex)] !== undefined &&
            ['menu', 'kit', 'agents', 'doctor', 'saturn', 'logins'].includes(
              composedRows[Math.max(0, selectedIndex)]!.key,
            )
              ? 'open'
              : 'start',
          tone: 'ivory' as const,
        },
        ...(menuAvailable ? [{ key: 'm', label: ' menu', tone: 'faint' as const }] : []),
      ],
      tinyHint: '↵ start',
      stripLines: (w: number) => core.composeStrip(chips, w) as string[],
      glowWord: wordGlow,
      glowRow: rowGlow,
    });
    const { placed, top } = core.placeBlock(composed.lines, faceRows);
    return {
      placed: placed as string[],
      actionAt: new Map<number, number>((composed.actionLines as number[]).map((line, i) => [line + top, i])),
      lastRowFree: faceRows !== rows || top + (composed.lines as string[]).length <= rows - 1,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core, columns, rows, isCompact, plainWhy, keyMapHint, selectedIndex, composedRows, chips, menuAvailable, wordGlow?.peakCell, wordGlow?.gainLevel, rowGlow?.peakCell, rowGlow?.gainLevel]);


  if (settingsOpen) {
    return (
      <BootSettingsScreen
        fullScene={{ columns, rows }}
        onClose={() => setSettingsOpen(false)}
      />
    );
  }
  if (kitOpen) {
    return (
      <KitMenuScreen
        fullScene={{ columns, rows }}
        onClose={() => setKitOpen(false)}
      />
    );
  }
  if (healthOpen) {
    return (
      <BootHealthScreen
        fullScene={{ columns, rows }}
        onClose={() => setHealthOpen(false)}
      />
    );
  }
  if (saturnOpen) {
    return (
      <BootSaturnScreen
        fullScene={{ columns, rows }}
        onClose={() => setSaturnOpen(false)}
      />
    );
  }
  if (agentsOpen) {
    return (
      <>
        <BootAgentsScreen
          suspended={loginsOpen}
          onOpenLogins={() => setLoginsOpen(true)}
          fullScene={{ columns, rows }}
          onClose={() => {
            setAgentsOpen(false);
            setAgentsEpoch(e => e + 1);
          }}
        />
        {loginsOpen ? (
          <BootLoginsScreen
            fullScene={{ columns, rows }}
            onClose={() => {
              setLoginsOpen(false);
              setPresenceEpoch(e => e + 1);
            }}
          />
        ) : null}
      </>
    );
  }
  if (loginsOpen) {
    return (
      <BootLoginsScreen
        fullScene={{ columns, rows }}
        onClose={() => {
          setLoginsOpen(false);
          setPresenceEpoch(e => e + 1);
        }}
      />
    );
  }
  if (resumeOpen) {
    return (
      <BootResumeScreen
        fullScene={{ columns, rows }}
        onClose={() => setResumeOpen(false)}
        projects={facts.pickerProjects.map(p => {
          const running = runningOf(p.dir);
          return running > 0 ? { ...p, running } : p;
        })}
        openProject={openProject}
      />
    );
  }


  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {Array.from({ length: rows }, (_, i) => {
        const line = composition.placed[i] ?? '';
        if (i === rows - 1 && (list.note !== null || birthReceipt !== null)) {
          const noteLine = '  ' + core.hexFg(core.FAINT, core.T256.faint) + (list.note ?? birthReceipt ?? '') + core.R;
          return (
            <Box key="boot-note" height={1} flexShrink={0}>
              {renderSceneLine(isCompact ? truncateToWidth(noteLine, columns) : noteLine)}
            </Box>
          );
        }
        if (i === rows - 1 && composition.lastRowFree && keyMapHint !== '') {
          return (
            <Box key="boot-keymap" height={1} flexShrink={0}>
              {renderSceneLine(isCompact ? truncateToWidth(KEY_MAP_ROW(core, keyMapHint), columns) : KEY_MAP_ROW(core, keyMapHint))}
            </Box>
          );
        }
        const actionIdx = composition.actionAt.get(i);
        if (actionIdx !== undefined && composedRows[actionIdx] !== undefined) {
          const row = composedRows[actionIdx]!;
          const props = list.rowProps(row, actionIdx);
          const glowLabel = row.label;
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
                renderSceneLine(line, hover && !props.selected ? { label: glowLabel, color: t.info } : undefined)
              }
            </InteractiveRow>
          );
        }
        return (
          <Box key={`bootline-${i}`} height={1} flexShrink={0}>
            {line.length > 0 ? renderSceneLine(line) : null}
          </Box>
        );
      })}
    </Box>
  );
}
