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
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js';
import { getSessionId } from '../bootstrap/state.js';
import { getUserSpecifiedModelSetting, renderModelChip } from '../utils/model/model.js';
import { NO_SIGN_IN_ROW, computedDefault } from '../utils/model/computedDefault.js';
import { getSessionAccent, getSessionCritterKey } from './mercury-ui/sessionAccent.js';
import { getOauthAccountInfo } from '../utils/auth.js';
import { declaredRouteOf } from '../services/providers/routeLaw.js';
import { anthropicCredentialPresence, providerFamilyPresences } from '../services/providers/providerUsage.js';
import { healthCertSnapshot } from '../utils/cockpit/healthCertSnapshot.js';
import { projectDisplayName, scanBootCardFacts, type BootProjectFact } from '../utils/bootCardFacts.js';
import { plainWorldWhy, stripFacts, type PlainWorldWhy } from '../context/surfaceRoute.js';
import { consumeFaceDoorDeepLink, consumeKitManagerDeepLink } from '../substrate/splashHandover.js';
import { peekWornPresetKit } from '../services/switchboard/bootBirthFacts.js';
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

// ============================================================================
//  BootSplashScreen — the in-process CANONICAL Boot face (
//  operator ruling: "not one menu — not a new menu — not a
//  different menu. We have one. the original one.").
//
//  The face IS the original launcher enter screen, landed in-process: the
//  SAME nine-row card (splash-core assembleCardRows — New Session · Continue
//  Last Session · Boot Menu · MCPs & Skills · Doctor / Health Check · Saturn
//  Scheduler · Session Concourse · Projects · Resume Session; eight in a
//  `--chat` boot, where no Session Concourse row exists on either host —
//  L15; the MCPs & Skills row is on EVERY face in EVERY world, L24(5) +
//  L24(6-SUPERSEDED); the Saturn row rides the same fit fact as the
//  menu/kit doors), the SAME status strip (core composeStrip, fed
//  LIVE runtime truth instead of the launcher's file mirrors), the SAME
//  ready-line hint bytes ('↵ start · m menu'), composed by the ONE
//  core (composeLockup) and placed by the ONE placement law (placeBlock —
//  the fixed card-slot fork is retired: with one card on both hosts there
//  is no divergence left to stabilize against, and the launcher's cinematic
//  frame 0 composes THIS full block for geometry, so the hero rows byte-
//  match across the seam by construction).
//
//  Row journeys are the in-process equivalents: New Session BIRTHS a real
//  session for this workspace and enters it (the one-door law, rule 2 —
//  born = registered: the chat, the session and the board row come into
//  being together at ↵; the warm runner's claim keeps the Enter instant);
//  Doctor and Resume open FACE-NATIVE layers (the face-doors ruling:
//  BootHealthScreen · BootResumeScreen — the settings layer's
//  siblings, composed by the one boot-menu design; esc restores this face,
//  and picking a session there is still a real chat journey through the
//  one resume door). Continue opens the cwd's newest chat DIRECTLY through
//  the same door (focusResumedSession — the openProject grammar: a pending
//  note on the row, a refusal painted on it; the old armed-command road
//  through the REPL retired whole). Concourse rides the
//  route owner. Projects-↵ (ruled) opens the picked repo's NEWEST chat in
//  the main chat through the estate's one resume door (focusResumedSession;
//  a history-less row births a session there), and the harness re-grounds
//  to the pick behind the trust ledger's gate.
//  The projects picker re-emits the launcher's own composeProjects grammar.
//  'm' (and 's', unadvertised) opens the settings face — the ratified
//  three-panel boot menu (BootSettingsScreen), which replaces the whole
//  composition per the persistent-scene refinement; esc restores this
//  face's identical composition. The MCPs & Skills row OPENS the manager
//  the same way (KitMenuScreen — the settings layer's sibling, never
//  inlaid in the card; esc closes it to this face); the launcher's row
//  hands over with the `kit` receipt action whose deep-link this face
//  consumes at mount (splashHandover, the CB-09 sibling).
// ============================================================================

// CB-09: /bootmenu names the MENU — the command arms this
// one-shot after a successful route entry so the face mounts with the
// settings layer already open; esc closes the layer back to the canonical
// face, esc again pops the route. Consumed on mount, so a later chord entry
// lands on the face itself.
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

/** The key-map row's bytes: the kit's dim ink (the note line's own token)
 *  over the kit's lowercase key grammar. The text is the strip's own
 *  (surfaceRoute.stripKeyMapHint): ONLY the moves that exist from this
 *  face — "⇧→ concourse" on a fresh boot, "⇧→ chat" in the plain world once
 *  a session is focused, "⇧→ no chat open" when nothing lies to the right —
 *  so the row never advertises a screen that is not there. */
const KEY_MAP_ROW = (core: ReturnType<typeof createSplashCore>, hint: string): string =>
  '  ' + core.hexFg(core.FAINT, core.T256.faint) + hint + core.R;

/** The Session Concourse row's ctx per world (pure; the pin composes it).
 *  --concourse-off (RULING B): the row stays, because it IS the explicit
 *  door to the plain LIVE VIEW of the sessions (rule 5's reduced stage;
 *  never a strip stop), and its ctx says so with the why in the router's
 *  own spelling — "live view only — concourse off". A `--chat` boot (the
 *  operator's L15) carries NO row at all — New Session is the door and the
 *  menu is always behind the chat — so the face passes null for it and
 *  this composer is never asked for a --chat ctx. The fleet world names the
 *  live board. An unregistered surface dims with its reason. */
export function concourseRowCtx(facts: { live: boolean; why: PlainWorldWhy | null; liveCount: number }): string {
  if (!facts.live) return 'unregistered in this build';
  const count = facts.liveCount > 0 ? ` · ${facts.liveCount} live` : '';
  return facts.why !== null ? `live view only — ${facts.why}${count}` : `the live board${count}`;
}


export function BootSplashScreen(): React.ReactNode {
  const t = useMercuryTokens();
  const { columns, rows } = useTerminalSize();
  // The boot's resolved permission posture — it rides the Continue row's
  // resume (parity with the blank chat's first message; the REPL road
  // passed the same fact). A ref so the row's async landing reads the
  // press-time truth.
  const permissionMode = useAppStateMaybeOutsideOfProvider(state => state.toolPermissionContext.mode);
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  const [settingsOpen, setSettingsOpen] = useState(() => consumeBootSettingsLayerDeepLink());
  // The MCPs & Skills manager layer (the settings layer's sibling): armed by
  // the launcher's `kit` receipt action (consumed once, at mount), opened
  // by the card's row in-process; esc closes it back to this face.
  const [kitOpen, setKitOpen] = useState(() => consumeKitManagerDeepLink());
  // The face-native Health and Resume layers: the settings/kit
  // layers' siblings — opened by their rows IN PLACE (no route transition,
  // no chat chrome, nothing armed); esc restores this face's identical
  // composition with the list selection intact (the component stays
  // mounted; only its render output switches — the layer precedent). The
  // splash's doctor/resume picks arm the same layers through the face-door
  // deep-link (C5, Way A — consumed once, at mount, the kit grammar).
  const [faceDoor] = useState(() => consumeFaceDoorDeepLink());
  const [healthOpen, setHealthOpen] = useState(faceDoor === 'health');
  const [resumeOpen, setResumeOpen] = useState(faceDoor === 'resume');
  // The scheduler layer — the same face-door grammar (the
  // row opens it in place; the launcher's `saturn` receipt action arms it).
  const [saturnOpen, setSaturnOpen] = useState(faceDoor === 'saturn');
  // The agent studio layer — the same face-door grammar (the
  // row opens it in place; the launcher's `agents` receipt action arms it).
  const [agentsOpen, setAgentsOpen] = useState(faceDoor === 'agents');
  // The layer swap's return law: an unavailable
  // model pick inside the agents layer opens the LOGINS layer while the
  // agents layer stays MOUNTED-SUSPENDED beneath it (the agents render
  // branch outranks the plain logins branch, so the close returns there
  // with form and selection intact; the presence epoch bump repaints the
  // new sign-in truth everywhere).
  // The sign-in layer — the same face-door grammar, DARK
  // until the card recut wires its row (the deep-link alone reaches it);
  // closing it re-reads the strip's account chip (the presence epoch).
  const [loginsOpen, setLoginsOpen] = useState(faceDoor === 'logins');
  const [presenceEpoch, setPresenceEpoch] = useState(0);

  // Session-store facts, gathered SYNCHRONOUSLY at mount (the launcher's own
  // bounded pre-paint scan, same law): the presence rows must exist before
  // the first composition or the hero would shift under the seam.
  const [facts] = useState(() => scanBootCardFacts(getCwd(), getSessionId()));

  const concourseLive = routeSurfaceRegistered('concourse');
  // The world and its why, from the router (the one fact; read at render —
  // the switch can flip through /config beneath a live face).
  const plainWhy = plainWorldWhy();
  // The `--chat` MARK alone (not the world fact) drops the concourse row and
  // its 'o' door: the --concourse-off twin keeps them as its live-view door
  // (L15; RULING B for that twin).
  const chatBoot = stripFacts().chatBoot;
  // The strip's stops move under the face (a session born, the last chat
  // closed): the key-map row re-reads them from the route store's own
  // version, which bumps on every presence change.
  useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion);
  const keyMapHint = stripKeyMapHint();
  // The canonical menu fit floor (the launcher's computeMenuAvailable law).
  const menuAvailable = columns >= 64 && rows >= 13;

  // Live board count for the concourse ctx (bounded records read — dynamic
  // import keeps the Concourse subsystem off the face's static boot graph).
  const [liveCount, setLiveCount] = useState<number>(0);
  useEffect(() => {
    if (chatBoot) return; // no row to count for — the supervisor stays off this face's graph
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
  // THE INDICATOR ON THE BOOT FACE (cross-project awareness, law 6): the
  // Projects rows read the running count per project from the SAME owner
  // the concourse's count lines read (projectActivity — the daemon's roster
  // through the one running predicate), keyed by the catalog's project key.
  // One read at mount, like the live count above. ABSENT IN THE PLAIN WORLD
  // (`--chat`, the concourse switched off): there is no live viewer to
  // switch to, so the rows say nothing of it — the strip's own fact gates it.
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

  // The Saturn row's live ctx (HOST TRUTH — the wake-glance words over the
  // session records + the box tier; the launcher wears the standing words).
  // One bounded read at mount, fail-soft: no truth ⇒ the standing ctx.
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
        /* the standing words stand */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // THE AGENTS ROW's live ctx (HOST TRUTH — the roster glance through the
  // ONE loader; the launcher wears the standing words). One bounded read
  // at mount, fail-soft: no truth ⇒ the standing ctx. Re-read when the
  // layer closes (a face create moves the count).
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

  // THE LOGINS ROW's live ctx (HOST TRUTH — the sign-in glance from the
  // ONE presence owner; the launcher wears the standing words). Re-read on
  // the presence epoch (a face sign-in moves it).
  const loginsCtx = useMemo(() => {
    try {
      const presences = providerFamilyPresences();
      const signed = presences.filter(f => f.credentialed).length;
      return signed > 0 ? `${signed} of ${presences.length} signed in` : null;
    } catch {
      return null; // K3: a failed read never claims signed-out
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenceEpoch]);

  // THE MERGED ROW's live ctx (HOST TRUTH): the repos count is the boot
  // scan's own fact; a session TOTAL has no cheap owner at compose time,
  // so the glance speaks the honest fact it has.
  const repoCount = facts.pickerProjects.length + (facts.cwdProject !== null ? 1 : 0);
  const sessionsCtx = repoCount > 0 ? `${repoCount} repo${repoCount === 1 ? '' : 's'} · pick a session` : null;

  const goHome = (): void => {
    // Boot-seeded faces have an empty return stack — esc still moves toward
    // the focused chat (the same HOME semantics the strip and the Concourse
    // use); with no chat open home is no movement and the face stays (a
    // chat is not there until a session starts — never a bounce off the
    // empty REPL).
    if (!leaveCurrentSurface().ok) enterRootRepl();
  };

  const openProject = (p: BootProjectFact): AsyncListNote => {
    // Projects-↵ (ruled): open THAT repo's MOST RECENT chat in the main
    // chat — the estate's one resume door (focusResumedSession) scoped to
    // the row's newest transcript; a repo with no resumable history births
    // a session there instead (the one-door law — never a chat off the
    // board). The harness re-grounds to the picked repo (the ground law:
    // seed + cwd move together) so New Session and the concourse agree
    // afterwards — gated on the trust ledger exactly like the concourse's
    // own picker (hardening law 3: an untrusted folder is never chdir'd
    // silently; the chat still opens — a daemon session carries its own
    // ground). A birth the daemon refuses paints its reason on the row;
    // the face stays.
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
            // THE CARD-AWARE HOP (the folder-as-project follow-up): a folder
            // whose only chat is a wordless LIVE newborn has no transcript to
            // resume but a runner to enter — the card names the session; hop
            // into it instead of birthing a second chat beside it.
            const hop = await import('../services/switchboard/hopIntoSession.js');
            const outcome = await hop.hopIntoBoardSession(p.firstSessionId);
            if (!outcome.ok) return outcome.reason;
          } else {
            const { bornSession } = await import('../services/switchboard/bornSession.js');
            const born = await bornSession({ workspaceDir: p.dir });
            if (!born.ok) return born.reason;
          }
        } catch (e) {
          // fail-soft: the face stays; the row is re-pressable
          return e instanceof Error ? e.message : String(e);
        }
        enterRootRepl();
        return null;
      })(),
    };
  };

  // The armed one-shot preset's name (fresh each render: the kit layer's
  // close and a birth's consumption both re-render this face).
  const armedPresetName = peekWornPresetKit()?.name;

  // ── the ORIGINAL rows (core-assembled strings + runtime activations) ─────
  const composedRows: BootRow[] = useMemo(
    () =>
      assembleCardRows({
        // THE FOLDER IS THE PROJECT, by its name, from boot: the card names
        // the launched folder through the one naming seam (a `.mercury`
        // folder wears its parent's name) — the launcher's frame 0 composes
        // the same seam, so the hero rows stay byte-equal across the boot.
        cwdBase: projectDisplayName(getCwd()),
        continueTarget: facts.cwdProject
          ? { base: facts.cwdProject.base, ageMs: facts.cwdProject.ageMs, cross: false }
          : facts.recentLast
            ? // The cross-repo form: in-process there is no honest "continue
              // it here" (cross-project resume refuses by design; repo moves
              // belong to Projects) — the row stays VISIBLE and dim, naming
              // the crossing (dimmed, never dropped).
              { base: facts.recentLast.base, ageMs: facts.recentLast.ageMs, cross: true, dim: true }
            : null,
        menuAvailable,
        // A `--chat` boot composes NO concourse row (L15: New Session is the
        // door); with the concourse switched off the row still enters — it
        // IS the door to the plain LIVE VIEW of the sessions (rule 5's
        // reduced stage), the strip carries no concourse stop there, so the
        // row is never a dead row, and its ctx names the world.
        concourse: chatBoot
          ? null
          : {
              ctx: concourseRowCtx({ live: concourseLive, why: plainWhy, liveCount }),
              ...(concourseLive ? {} : { dim: true }),
            },
        // THE ARMED WEAR IS VISIBLE: while a one-shot
        // preset is armed the kit row's ctx names it. Read fresh each
        // compose — arming happens in the kit layer (whose close re-renders
        // this face) and a birth's consumption repaints it the same way.
        ...(armedPresetName !== undefined ? { kitArmedPreset: armedPresetName } : {}),
        // The Saturn row's live wake-glance ctx (host truth; absent ⇒ the
        // standing words, byte-identical to the launcher's frame).
        ...(saturnCtx !== null ? { saturnCtx } : {}),
        // The roster glance (host truth; absent => the
        // standing words, byte-identical to the launcher's frame).
        ...(agentsCtx !== null ? { agentsCtx } : {}),
        // The sign-in glance + the merged row's repos glance
        // (host truth both; absent ⇒ the standing words on either host).
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
        // CREATE-ON-ENTER (Law 9, rule 2 — born = registered): ↵ births a
        // REAL session for this workspace on the model shown and enters it
        // — the chat, the session and the board row come into being
        // together; nothing existed behind the face before this keypress
        // (rule 1: a fresh boot has no chat). The boot's own facts (-n's
        // title, the resolved permission posture, the effort, the runner
        // options) ride the birth through the one birth door, so the
        // session runs the operator's posture, never the seat's default.
        // Every ↵ births anew: whatever session held the slot keeps running
        // and shows on the board (the line-7d law); nothing is stopped by
        // asking for a fresh chat. A birth the daemon refuses paints its
        // reason on the row and enters nothing.
        return {
          pending: 'starting a session…',
          result: (async (): Promise<string | null> => {
            const { bornSession } = await import('../services/switchboard/bornSession.js');
            // The birth reads the next-session facts (L18) — no explicit
            // model here: the record's choice, else the screen's main model.
            const born = await bornSession({ workspaceDir: getCwd() });
            if (!born.ok) return born.reason;
            enterRootRepl();
            return null;
          })(),
        };
      }
      // The armed road's final retirement: Continue opens
      // the cwd's newest chat DIRECTLY through the estate's one resume
      // door — the openProject grammar: a pending note on the row, the
      // landing then the plain chat step; a refusal paints its reason ON
      // the row and the face stays (the old armed '/resume <id>' flashed
      // the chat chrome and buried the reason under the settle). The
      // boot's resolved posture rides the resume (parity with the blank
      // chat's first message); the title is the door's own L16 precedence.
      case 'continue': {
        const target = facts.cwdProject;
        if (!target?.sessionId) return null; // composed dim/absent without a resumable target
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
              // fail-soft: the face stays; the row is re-pressable
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
        // The row OPENS the manager (L24(5): never inlaid in the card) —
        // the same layer grammar as the Boot Menu row.
        setKitOpen(true);
        return null;
      case 'doctor':
        // The operator's ruling: the row opens the face's OWN
        // health layer — the same certificate plane, the menu's containers;
        // no chat chrome, nothing armed, esc lands back on this row.
        setHealthOpen(true);
        return null;
      case 'saturn':
        // The row opens the scheduler layer the same way —
        // the board + the birth composer, esc lands back on this row.
        setSaturnOpen(true);
        return null;
      case 'agents':
        // The row opens the agent studio layer the same way
        // — the library + the form over the ONE machine; esc lands back on
        // this row and the roster glance re-reads.
        setAgentsOpen(true);
        return null;
      case 'logins':
        // The row opens the face's OWN sign-in layer — the
        // full catalogue in the boot-menu design; never the chat; esc
        // lands back on this row and the account chip re-reads.
        setLoginsOpen(true);
        return null;
      case 'concourse':
        enterConcourse();
        return null;
      case 'sessions':
        // The operator's merge: the row opens the MERGED
        // sessions·projects screen — the landed picker grown its second
        // container (the face hands it the project facts + its one landing
        // below); PICKING either granularity is still the real chat
        // journey, CANCEL returns here with zero chat-chrome flash. The
        // standalone Projects and Resume rows retired with this row's
        // birth (same commit — no half state).
        setResumeOpen(true);
        return null;
    }
    return null;
  };

  // esc topology (the launcher's own two-step): the first esc CLEARS the
  // selection (the plain ↵-boots state), the second goes home. Any motion or
  // pointer select re-engages.
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
          // While cleared, ↵ is the plain boot — the default New Session row
          // (the launcher's bare-↵ law).
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
      // Unadvertised alias (the pre-unification key) — same destination.
      { key: 's', hint: 'menu', run: () => (menuAvailable ? (setSettingsOpen(true), null) : 'the boot menu needs at least 64×13') },
      // 'o' — the pre-unification concourse hop (the D2/G route-back key):
      // the wave's rewrite dropped it and the round-trip journeys stuck.
      // Same destination as the Session Concourse row and the crumb — and
      // absent with the row in a `--chat` boot (L15).
      ...(chatBoot ? [] : [{ key: 'o', hint: 'concourse', run: (): null => (enterConcourse(), null) }]),
    ],
    unavailable: r => r.dim === true,
    reasonUnavailable: r => r.ctx,
  });
  // Motion or pointer selection re-engages a cleared cursor.
  const selIdx = list.selectedIndex;
  const prevSelRef = useRef(selIdx);
  useEffect(() => {
    if (prevSelRef.current !== selIdx) {
      prevSelRef.current = selIdx;
      setSelCleared(false);
    }
  }, [selIdx]);


  // ── the canonical composition at live geometry ────────────────────────────
  // The core is bound full-fidelity ({nocolor:false, truecolor:true}) —
  // in-process color degradation is Ink's colorize law, never a second env
  // resolver (CB-06) — and to the LIVE session accent (GLOW: the
  // boot face wears the selected critter's family, the same selection truth
  // the REPL wears).
  const { accent: coreAccent, rampStops } = useSplashCoreAccent();
  // The launcher-estate ground follows the appearance (the one VOID anchor:
  // plate fills, park ink, AA mixes): adopt the family BEFORE binding the
  // core so this face paints the persisted ground — a dark theme leaves the
  // module bytes untouched, and a live theme switch re-adopts on re-mount.
  const [resolvedTheme] = useTheme();
  const core = useMemo(() => {
    adoptGroundFamily(resolvedTheme === 'true-black' ? 'true-black' : 'dark');
    return createSplashCore({ nocolor: false, truecolor: true, accent: coreAccent });
  }, [coreAccent, resolvedTheme]);
  // The greeting phases (GLOW): the pixel word greets this surface's mount;
  // the selected card row greets each fresh selection (the settle law —
  // ~10 s, then the exact settled composition; the kit hook owns the gates:
  // reduced motion, MERCURY_LIVE_GLYPHS=0 captures, single-stop families).
  const wordGlow = useGreetingShimmer(rampStops, WORD_W);
  const rowGlow = useGreetingShimmer(
    rampStops,
    CARD_LABEL_W,
    `card:${selCleared ? -1 : list.selectedIndex}`,
  );
  const mainModel = useMainLoopModel();

  // The strip's five chips from LIVE owners (each strictly better than the
  // launcher's cold file mirror — the frozen-stale chip classes retire here).
  const chips = useMemo(() => {
    let acct: { state: 'email' | 'none' | 'unreadable'; text?: string };
    try {
      // The account chip follows the MAIN MODEL'S route (the routing law)
      // to that family's credential in the ONE presence owner — never the
      // Anthropic snapshot whatever the route. On the Anthropic family a
      // present credential paints its snapshot email (the board's live
      // verification heals that snapshot); a key or bearer paints its
      // label; every other family paints its owning resolver's label.
      const route = declaredRouteOf(mainModel);
      const fit = (text: string): string => (text.length > 26 ? text.slice(0, 25) + '…' : text);
      if (route === 'anthropic') {
        const presence = anthropicCredentialPresence();
        const email = presence.credentialed ? (getOauthAccountInfo()?.emailAddress ?? null) : null;
        const label = presence.credentialLabel ?? null;
        const subscription = label !== null && label.startsWith('Claude subscription');
        acct = presence.credentialed
          ? { state: 'email', text: fit(subscription && email ? email : (label ?? 'signed in')) }
          : { state: 'none' };
      } else {
        const presence = providerFamilyPresences().find(family => (family.id as string) === route);
        acct = presence?.credentialed
          ? { state: 'email', text: fit(presence.credentialLabel ?? 'signed in') }
          : { state: 'none' };
      }
    } catch {
      acct = { state: 'unreadable' }; // K3: a failed read never claims not-signed-in
    }
    const cert = healthCertSnapshot();
    const critterKey = getSessionCritterKey();
    // The model chip names the row the session runs. A session on the
    // default with no sign-in anywhere has NO computed default (the neutral-
    // default ruling): the chip says so and never names a provider the user
    // cannot use; the logins door is one row down the card.
    let noSignIn = false;
    try {
      noSignIn = getUserSpecifiedModelSetting() === null && computedDefault().source === 'keyless';
    } catch {
      noSignIn = false; // an unreadable read paints the resolved chip, never a claim
    }
    return {
      model: noSignIn ? NO_SIGN_IN_ROW : renderModelChip(mainModel),
      critter: critterKey.charAt(0).toUpperCase() + critterKey.slice(1),
      critterHue: getSessionAccent().accent,
      dir: projectDisplayName(getCwd()),
      acct,
      health:
        cert.state === 'live' && cert.data.verdict
          ? { verdict: cert.data.verdict, age: cert.data.ageLabel }
          : null,
    };
    // presenceEpoch: the logins layer's close bumps it so the account chip
    // re-reads the presence owner after a face sign-in (never optimistic).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainModel, presenceEpoch]);

  const selectedIndex = selCleared ? -1 : list.selectedIndex;
  const composition = useMemo(() => {
    const composed = core.composeLockup(columns, rows, {
      cardRows: composedRows.map(r => ({
        icon: r.icon,
        label: r.label,
        ctx: r.ctx,
        ...(r.dim ? { dim: true } : {}),
      })),
      cardSel: selectedIndex,
      // The canon ready-line bytes: '↵ start' + 'm menu' — byte-identical
      // to the launcher's deck hint at the default (frame-0) selection;
      // '↑↓ choose' joins via the core exactly when the card is on screen.
      // THE PRESENT-MOVES VERB (the board's regionKeysFor law one level
      // up): ↵'s label follows the SELECTED row — a journey row starts,
      // a screen row opens — because 'start' was a lie on six of the ten
      // rows (Doctor does not start anything). Row 0 is a journey row, so
      // the launcher's frame-0 bytes stand unchanged.
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
      // GLOW: the greeting phases (null once settled — the settled
      // composition is byte-identical to the pre-GLOW frame).
      glowWord: wordGlow,
      glowRow: rowGlow,
    });
    // THE ONE PLACEMENT LAW: placeBlock over the full composition —
    // the same call the launcher's cinematic frame makes at this geometry,
    // so the hero rows and the wordmark row are equal across the seam BY
    // CONSTRUCTION (the fixed card-slot constant is retired).
    const { placed, top } = core.placeBlock(composed.lines, rows);
    return {
      placed: placed as string[],
      actionAt: new Map<number, number>((composed.actionLines as number[]).map((line, i) => [line + top, i])),
      // THE KEY-MAP ROW's threshold: the face's last row lies OUTSIDE the
      // placed block (so the row never squeezes the block or overlaps the
      // strip); a geometry the block fills to the bottom carries no row.
      lastRowFree: top + (composed.lines as string[]).length <= rows - 1,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core, columns, rows, selectedIndex, composedRows, chips, menuAvailable, wordGlow?.peakCell, wordGlow?.gainLevel, rowGlow?.peakCell, rowGlow?.gainLevel]);

  // FLAT GROUND (round 7): the scene paints no backdrop of its own — the
  // composed lines ride the estate ground exactly like the main REPL.

  if (settingsOpen) {
    // The ratified boot-menu design replaces the face's composition wholesale
    // (the persistent-scene refinement: the wordmark persists at the MENU
    // header; esc restores this face's identical composition).
    return (
      <BootSettingsScreen
        fullScene={{ columns, rows }}
        onClose={() => setSettingsOpen(false)}
      />
    );
  }
  if (kitOpen) {
    // The MCPs & Skills manager replaces the composition the same way (the
    // persistent-scene refinement); esc restores this face's identical
    // composition. Runtime-only — the launcher never renders it.
    return (
      <KitMenuScreen
        fullScene={{ columns, rows }}
        onClose={() => setKitOpen(false)}
      />
    );
  }
  if (healthOpen) {
    // The face's own health entrance — the same layer grammar;
    // esc restores this face's identical composition, focus on the Doctor
    // row that opened it (the component never unmounted).
    return (
      <BootHealthScreen
        fullScene={{ columns, rows }}
        onClose={() => setHealthOpen(false)}
      />
    );
  }
  if (saturnOpen) {
    // The scheduler layer — the board + the birth composer
    // in the same layer grammar; esc restores this face's identical
    // composition, focus on the row that opened it.
    return (
      <BootSaturnScreen
        fullScene={{ columns, rows }}
        onClose={() => setSaturnOpen(false)}
      />
    );
  }
  if (agentsOpen) {
    // The agent studio layer — the same layer grammar; esc
    // restores this face's identical composition, focus on the row that
    // opened it, and the roster glance re-reads (a create moves the count).
    // C5 (rider R2): while the sign-in door is open the agents layer stays
    // MOUNTED beneath it (suspended: renders nothing, every list parked) —
    // the logins close returns here with the form and selection intact.
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
    // The sign-in catalogue in the face's own container — the
    // same layer grammar; esc restores this face's identical composition,
    // and the strip's account chip re-reads the presence owner.
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
    // The face's own picker grew into the
    // MERGED sessions·projects screen — the face hands it the boot scan's
    // project facts (running counts aboard) and its ONE landing
    // (openProject: trust-gate → ground → the one resume door / the
    // card-aware hop / a birth). Cancel lands here with zero chat-chrome
    // flash; a pick on either container is the real chat journey.
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
        if (i === rows - 1 && list.note !== null) {
          // The note rides the canvas (the bottom-left break fix): a styled
          // faint line through the scene renderer, never a bare unvignetted
          // strip across the last row.
          const noteLine = '  ' + core.hexFg(core.FAINT, core.T256.faint) + list.note + core.R;
          return (
            <Box key="boot-note" height={1} flexShrink={0}>
              {renderSceneLine(noteLine)}
            </Box>
          );
        }
        if (i === rows - 1 && composition.lastRowFree && keyMapHint !== '') {
          // THE KEY-MAP ROW (the operator's amendment at the line-4 signing):
          // one dim row at the bottom of the face, in the kit's lowercase
          // key grammar, naming the move that exists from here (the strip
          // counts its stops from what exists — a fresh boot's face names
          // the concourse alone; no reserved chat is ever advertised). It
          // lives on this in-process face only (the launcher's splash has no
          // screens to move between) and OUTSIDE the placed block — the
          // splash → face seam stays byte-identical on every block row —
          // present exactly when the last row is free (never squeezed).
          return (
            <Box key="boot-keymap" height={1} flexShrink={0}>
              {renderSceneLine(KEY_MAP_ROW(core, keyMapHint))}
            </Box>
          );
        }
        const actionIdx = composition.actionAt.get(i);
        if (actionIdx !== undefined && composedRows[actionIdx] !== undefined) {
          const row = composedRows[actionIdx]!;
          const props = list.rowProps(row, actionIdx);
          const glowLabel = row.label;
          return (
            // The composed action line IS the pointer target: click parity
            // rides InteractiveRow while the selected paint stays the core's
            // own grammar (teal edge-bar + ramped label) — the band and the
            // dead-row annotation are opted out; the composition carries
            // both truths (a dim row's ctx IS its visible why).
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
