import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { basename } from 'node:path';
import { Box, useInput } from '../ink.js';
import { createSplashCore, WORD_W } from '../../assets/splash/splash-core.mjs';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { reloadAgentDefinitionsIntoAppState } from '../hooks/useAgentsChange.js';
import { useSetAppStateMaybe } from '../state/AppState.js';
import {
  clearAgentDefinitionsCache,
  getAgentDefinitionsWithOverrides,
  type AgentDefinition,
  type AgentDefinitionsResult,
} from '../tools/AgentTool/loadAgentsDir.js';
import { startAgentWatch, subscribeAgentsChanged } from '../services/agents/watch.js';
import { resolveEffectiveAgentRuntime, type AgentEstateEntry } from '../services/agents/resolver.js';
import { setAgentDisabled, setAgentOverride } from '../services/agents/overrides.js';
import {
  AgentStoreError,
  deleteAgentToTrash,
  listAgentTrash,
  restoreAgentFromTrash,
  type AgentTrashEntry,
} from '../services/agents/store.js';
import {
  buildStudioRows,
  isFileBacked,
  type StudioRow,
} from './agents/studio/studioData.js';
import {
  createStudioEditorMachine,
  computeStudioValidation,
  effectiveStudioRuntime,
  fieldValueLabel,
  FIELD_ROWS,
  studioDestinationPath,
  type FieldId,
  type StudioDraftBase,
  type StudioEditorMachine,
  type StudioEditorSnapshot,
  type StudioValidation,
} from './agents/studio/studioEditorModel.js';
import { getAgentSourceDisplayName } from './agents/utils.js';
import { AGENT_COLORS } from '../tools/AgentTool/agentColorManager.js';
import { getAllBaseTools } from '../tools.js';
import type { Tools } from '../Tool.js';
import { EFFORT_LEVELS, resolveEffortTruth, type EffortValue } from '../utils/effort.js';
import {
  agentModelAvailabilityNote,
  agentModelPickOutcome,
  getAgentModelPickerRows,
  type AgentModelPickerRow,
} from '../utils/model/agentModelPicker.js';
import { PERMISSION_MODES } from '../utils/permissions/PermissionMode.js';
import { renderModelChip } from '../utils/model/model.js';
import { InteractiveRow } from './mercury-ui/InteractiveRow.js';
import { renderSceneLine } from './mercury-ui/SceneCanvas.js';
import { getSessionAccent, getSessionCritterKey } from './mercury-ui/sessionAccent.js';
import { useGreetingShimmer } from './mercury-ui/useGreetingShimmer.js';
import { useInteractiveList } from './mercury-ui/useInteractiveList.js';
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js';
import { useSplashCoreAccent } from './mercury-ui/useSplashCoreAccent.js';

/**
 * BootAgentsScreen — the agent studio's FACE skin (the
 * operator's own proposal: "create agents in the boot menu and it
 * simultaneously updates in the slash agents … with the same UI").
 *
 * The settings/kit/health/resume/saturn/logins layers' sibling over the ONE
 * ratified boot-menu design (composeBootMenu): the LIBRARY lists every
 * discovered definition through the SAME projection the in-chat studio
 * reads (studioData.buildStudioRows — one data plane, two skins), the
 * selected row's dossier fills the SETTING DETAIL panel, and CREATE/EDIT
 * drive the ONE form machine (studioEditorModel — the same draft, gates,
 * spellings and save road as /agents in the chat; the
 * two-skins-one-model law).
 *
 * FRESHNESS (the seamless law's face half): the library reads the loader
 * FRESH at mount and after every mutation, subscribes to the agents watch
 * while open (a foreign write repaints the roster as it lands on disk —
 * the KitMenu skills-watcher grammar), and arms the watch itself on a
 * fresh boot where no chat has armed it yet. After every mutation the
 * refresh is ALSO pushed into AppState when a store exists
 * (useSetAppStateMaybe — the maybe-store precedent), so an open chat's
 * /agents studio agrees instantly; the RUNNER half (a live session's own
 * roster) is C2's watch, not this screen.
 *
 * HOST TRUTH: the effective-runtime preview resolves against the BASE tool
 * roster (getAllBaseTools — the face has no session; MCP tools join at
 * session time and the dossier says so in its own words).
 *
 * Face-only vocabulary is this module's (the boot-menu grammar); the FORM's
 * gates and receipts are the machine's — this skin retains none (the §1
 * identity law). Named non-goals of the face skin, v1: fuzzy search, the
 * $EDITOR spawn, test-drive (a chat needs a composer) — the in-chat studio
 * keeps all three.
 *
 * Runtime-only: the launcher never renders this screen (its card row hands
 * over with the `agents` receipt action once C4 wires the row).
 */

interface BootAgentsScreenProps {
  onClose?: () => void;
  /** THE LAYER SWAP (rider R2): the host keeps this screen MOUNTED while
   *  its Logins layer paints over it — suspended renders nothing and every
   *  list parks, so the form/selection survive the round trip and the
   *  return restores them intact (the never-stranded law). */
  suspended?: boolean;
  /** The sign-in door (the multiauth mandate): picking an unavailable or
   *  connect model row routes here — the host swaps to its Logins layer
   *  and returns. Absent (a standalone/proof mount), the note names
   *  /logins instead; the pick never commits either way. */
  onOpenLogins?: () => void;
  /** The persistent Boot scene contract: the layer owns the whole viewport
   *  on the shared flat ground, exactly like the settings layer. */
  fullScene?: { columns: number; rows: number };
  /** Injected definitions for proofs; absent ⇒ the loader, fresh. */
  definitions?: AgentDefinitionsResult;
  /** The ground; absent ⇒ the face's (process.cwd()). */
  workspaceDir?: string;
  /** Injected tool roster for proofs; absent ⇒ the base assembly. */
  toolsOf?: () => Tools;
}

type FaceEntry = {
  label: string;
  group: string;
  groupTitle: string;
  summary: string;
  valueLabel: string;
  valueIsDefault: boolean;
  pinnedVal: string | null;
  detail: null;
  inert?: boolean;
};

// ── the library's pure composers (the stills + the pin compose the same) ────

/** One studio row as the face lists it. */
export function agentFaceEntryOf(row: StudioRow): FaceEntry {
  if (row.kind === 'invalid') {
    return {
      label: `invalid: ${row.invalid!.path.split(/[\\/]/).slice(-2).join('/')}`,
      group: 'needs attention',
      groupTitle: 'needs attention',
      summary: row.invalid!.error,
      valueLabel: 'unreadable',
      valueIsDefault: false,
      pinnedVal: null,
      detail: null,
    };
  }
  const agent = row.agent!;
  const disabled = agent.disabled === true;
  const group = getAgentSourceDisplayName(agent.source);
  return {
    label: agent.agentType,
    group,
    groupTitle: group,
    summary: agent.whenToUse.replace(/\n/g, ' '),
    valueLabel: disabled
      ? 'off'
      : `${agent.model ?? 'inherit'}${agent.operatorOverride ? ' (override)' : ''}${row.shadowed ? ' · shadowed' : ''}`,
    valueIsDefault: !disabled && agent.operatorOverride === undefined && row.shadowed !== true,
    pinnedVal: null,
    detail: null,
  };
}

/** The selected row's dossier — the SETTING DETAIL panel's lines. */
export function agentFaceDetailLines(
  row: StudioRow,
  estate: Map<string, AgentEstateEntry>,
  eff: ReturnType<typeof resolveEffectiveAgentRuntime> | null,
  /** The session availability note for the agent's model (C6) — injected
   *  so the stills stay catalogue-free; null wears nothing. */
  availabilityNote: string | null = null,
): string[] {
  if (row.kind === 'invalid') {
    return [
      'invalid definition',
      '',
      row.invalid!.path,
      row.invalid!.error,
      '',
      'the file stays visible until it parses —',
      'fix it in your editor; the roster repaints',
      'as it lands on disk.',
    ];
  }
  const agent = row.agent!;
  const lines: string[] = [
    `${agent.agentType}${agent.disabled ? ' (disabled)' : ''}`,
    '',
    (agent as { filePath?: string }).filePath ??
      (agent.source === 'built-in'
        ? 'built-in (no file)'
        : agent.source === 'extension'
          ? `extension: ${(agent as { extensionName?: string }).extensionName ?? '?'}`
          : 'in-memory (--agents flag)'),
    `scope: ${getAgentSourceDisplayName(agent.source)}`,
  ];
  if (eff !== null) {
    // Inherit made LEGIBLE (AGENTDIALS C1): "inherit → <resolved>" alone
    // read as a tie to whatever family the resolved id happens to be —
    // the tag names the mechanism (the agent follows the SESSION), so
    // inherit never reads as an Anthropic tie.
    lines.push(
      `model: ${eff.modelIntent} → ${eff.model}${eff.flooredFrom ? ` (floored from ${eff.flooredFrom})` : ''}${eff.modelIntent === 'inherit' ? " (your session's model)" : ''}`,
      `effort: ${eff.effortIntent !== undefined ? `${eff.effortIntent} → ` : 'session → '}${eff.effort.label}`,
    );
    if (availabilityNote !== null) lines.push(`availability: ${availabilityNote} — Logins signs in`);
    if (eff.tools) {
      lines.push(
        eff.tools.hasWildcard
          ? 'tools: all (MCP tools join at session time)'
          : `tools: ${eff.tools.validTools.length} of the base roster${eff.tools.invalidTools.length > 0 ? ` · unknown: ${eff.tools.invalidTools.join(', ')}` : ''}`,
      );
    }
  }
  if (agent.skills && agent.skills.length > 0) lines.push(`skills: ${agent.skills.join(', ')}`);
  if (agent.memory) lines.push(`memory: ${agent.memory}`);
  const entry = estate.get(agent.agentType);
  if (entry && entry.candidates.length > 1) {
    lines.push('', 'shadow chain:');
    for (const c of entry.candidates) {
      lines.push(`  ${c.winner ? '● wins' : `◌ ${c.shadowReason ?? 'shadowed'}`} — ${getAgentSourceDisplayName(c.agent.source)}`);
    }
  }
  return lines;
}

/** The AGENTS panel's rows (counts + the seamless-law truth). */
export function agentFaceSummaryRows(counts: {
  active: number;
  disabled: number;
  issues: number;
}): Array<{ key: string; value: string; tone?: 'teal' }> {
  return [
    { key: 'Agents', value: `${counts.active} active · ${counts.disabled} off` },
    { key: 'Issues', value: counts.issues > 0 ? `${counts.issues} need attention` : 'none' },
    { key: 'Applies', value: '● live sessions see new agents', tone: 'teal' },
  ];
}

/** The status bar's standing line. */
export function agentFaceStatusLine(counts: { active: number; disabled: number }): string {
  return `${counts.active} agent${counts.active === 1 ? '' : 's'} active — a create lands in every session, running ones included`;
}

export const AGENT_FACE_LEGEND = '↑↓ move · ↵ edit · n new · x on/off · ⌫ delete · u trash · esc back';
export const AGENT_FACE_LEGEND_FORM = '↑↓ move · ↵ edit field · g generate · s save · ⌫ clear · esc back';
export const AGENT_FACE_LEGEND_PROMPT = 'type · ↵ apply · esc cancel';
export const AGENT_FACE_LEGEND_PICK = '↑↓ move · ↵ pick · esc back';
export const AGENT_FACE_LEGEND_TRASH = '↑↓ move · ↵ restore · esc back';
export const AGENT_FACE_LEGEND_CONFIRM = 'y / ↵ delete (recoverable) · n / esc cancel';

/** The delete card (frozen at open; the in-chat studio's recovery truth in
 *  the face's own words). */
export function agentDeleteConfirmLines(agent: AgentDefinition): string[] {
  return [
    'delete agent',
    '',
    `delete ${agent.agentType}?`,
    '',
    'the file moves to the recovery area —',
    "never a permanent unlink; 'u' on the",
    'library restores it.',
    '',
    (agent as { filePath?: string }).filePath ?? '',
  ];
}

/** One recovery-area row. */
export function agentTrashEntryOf(entry: AgentTrashEntry): FaceEntry {
  return {
    label: entry.agentType,
    group: 'recovery area',
    groupTitle: 'recovery area',
    summary: `deleted ${entry.deletedAt.slice(0, 16)} · was ${entry.originalPath}`,
    valueLabel: 'restorable',
    valueIsDefault: true,
    pinnedVal: null,
    detail: null,
  };
}

// ── the form's pure composers (over the ONE machine's snapshot) ─────────────

/** The form rows: destination first on a create, then the machine's own
 *  field table — one vocabulary, both skins. */
export function agentFormRowIds(mode: 'create' | 'edit'): Array<'destination' | FieldId> {
  return mode === 'create' ? ['destination', ...FIELD_ROWS.map(r => r.id)] : FIELD_ROWS.map(r => r.id);
}

export function agentFormEntryOf(
  id: 'destination' | FieldId,
  snap: StudioEditorSnapshot,
): FaceEntry {
  if (id === 'destination') {
    return {
      label: 'destination',
      group: 'agent form',
      groupTitle: 'agent form',
      summary: 'where the definition file lands — the project repo or your personal home.',
      valueLabel: snap.scope,
      valueIsDefault: snap.scope === 'project',
      pinnedVal: null,
      detail: null,
    };
  }
  const rowMeta = FIELD_ROWS.find(r => r.id === id)!;
  return {
    label: rowMeta.label,
    group: 'agent form',
    groupTitle: 'agent form',
    summary: '',
    valueLabel: fieldValueLabel(snap.doc, id),
    valueIsDefault: false,
    pinnedVal: null,
    detail: null,
  };
}

/** The detail panel while the form is open: the live review — destination,
 *  validation verdicts, the effective preview. The machine's gates paint
 *  here exactly as the review pane paints them in the chat. */
export function agentFormDetailLines(args: {
  snap: StudioEditorSnapshot;
  validation: StudioValidation;
  destination: string;
  effectiveLine: string | null;
  mode: 'create' | 'edit';
}): string[] {
  const { snap, validation, destination, effectiveLine, mode } = args;
  if (snap.recoverOffer) {
    return [
      'unsaved draft found',
      '',
      'an unsaved draft from a previous session',
      'exists for this target.',
      '',
      'y / ↵ recover it · n discard it',
    ];
  }
  if (snap.conflict) {
    return [
      'revision conflict',
      '',
      'the file changed on disk while you edited.',
      '',
      'L load theirs + re-apply your edits',
      'esc keep editing (save will keep refusing)',
    ];
  }
  if (snap.busy) {
    return [mode === 'create' ? 'create agent' : 'edit agent', '', '◓ working … (esc cancels generation)'];
  }
  const lines: string[] = [
    mode === 'create' ? 'create agent' : `edit ${snap.doc.fields.name}`,
    '',
    `→ ${destination}`,
  ];
  if (effectiveLine !== null) lines.push(`runs: ${effectiveLine}`);
  lines.push('');
  if (validation.errors.length > 0) {
    for (const e of validation.errors) lines.push(`✗ ${e}`);
  }
  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) lines.push(`▲ ${w}`);
  }
  if (validation.errors.length === 0 && validation.warnings.length === 0) {
    lines.push('✓ ready to save');
  }
  lines.push('', validation.canSave ? 's saves it' : 'save disabled while errors exist');
  return lines;
}

/** Which editor a form row opens on the face (the routing map; the machine
 *  owns what each commit MEANS). */
export function agentFormFieldKind(
  id: 'destination' | FieldId,
): 'cycle' | 'text' | 'body' | 'pick' | 'tools' {
  switch (id) {
    case 'destination':
    case 'background':
    case 'isolation':
      return 'cycle';
    case 'name':
    case 'description':
    case 'skills':
    case 'maxTurns':
    case 'initialPrompt':
      return 'text';
    case 'body':
      return 'body';
    case 'tools':
    case 'disallowedTools':
      return 'tools';
    default:
      return 'pick';
  }
}

const BODY_CAP = 20_000;
const TEXT_CAP = 4096;

export function BootAgentsScreen({
  onClose,
  suspended = false,
  onOpenLogins,
  fullScene,
  definitions: given,
  workspaceDir: givenWorkspace,
  toolsOf,
}: BootAgentsScreenProps = {}): React.ReactNode {
  const t = useMercuryTokens();
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const columns = fullScene?.columns ?? termCols;
  const rows = fullScene?.rows ?? termRows;
  const [workspaceDir] = useState(() => givenWorkspace ?? process.cwd());
  const faceTools = useMemo(() => (toolsOf ?? getAllBaseTools)(), [toolsOf]);
  const mainModel = useMainLoopModel();
  const setAppStateMaybe = useSetAppStateMaybe();

  // ── the library data (fresh loader reads + the live watch) ───────────────
  const [defs, setDefs] = useState<AgentDefinitionsResult | null>(given ?? null);
  const [note, setNote] = useState<string | null>(null);
  const reload = useCallback((): void => {
    if (given !== undefined) {
      setDefs(given);
      return;
    }
    clearAgentDefinitionsCache();
    void getAgentDefinitionsWithOverrides(workspaceDir)
      .then(fresh => setDefs(fresh))
      .catch(e => setNote(`definitions unreadable — ${String(e)}`));
  }, [given, workspaceDir]);
  useEffect(() => {
    reload();
    if (given !== undefined) return;
    // A fresh boot may reach this layer before any chat armed the watch —
    // arm it here (idempotent per cwd); foreign writes repaint the roster
    // while the layer is open (the KitMenu skills-watcher grammar).
    void startAgentWatch(workspaceDir).catch(() => {});
    const unsubscribe = subscribeAgentsChanged(reload);
    return unsubscribe;
  }, [given, reload, workspaceDir]);

  /** After every mutation: the loader refresh here, AND the AppState push
   *  when a store exists — an open chat's /agents studio agrees instantly
   *  (the maybe-store precedent). */
  const refreshEverywhere = useCallback((): void => {
    reload();
    if (setAppStateMaybe !== null) {
      void reloadAgentDefinitionsIntoAppState(workspaceDir, setAppStateMaybe, { invalidate: true }).catch(() => {});
    }
  }, [reload, setAppStateMaybe, workspaceDir]);

  const built = useMemo(
    () =>
      defs === null
        ? null
        : buildStudioRows(defs, { tab: 'all', filter: 'all', query: '' }),
    [defs],
  );
  const listRows: StudioRow[] = built?.rows ?? [];
  const counts = useMemo(() => {
    const active = listRows.filter(r => r.kind === 'agent' && r.agent!.disabled !== true).length;
    const disabled = listRows.filter(r => r.agent?.disabled === true).length;
    const issues = built?.counts.issues ?? 0;
    return { active, disabled, issues };
  }, [listRows, built]);

  // ── the layers ───────────────────────────────────────────────────────────
  const [confirm, setConfirm] = useState<AgentDefinition | null>(null);
  const [trash, setTrash] = useState<{ open: boolean; entries: AgentTrashEntry[] }>({ open: false, entries: [] });
  /** THE BUILT-IN MODEL DIAL (AGENTDIALS C1): ↵ on a built-in row opens a
   *  MODEL-ONLY pick — the same catalogue derivation the studio form uses
   *  (getAgentModelPickerRows: catalogue order, provider-equal, unavailable
   *  rows born-held sign-in doors, 'Inherit' the top row). The pick lands
   *  in CONFIG as a per-agent settings row (setAgentOverride, user scope —
   *  built-ins stay code-defined, "built-in (no file)" stays true);
   *  'Inherit' clears it. Dispatch inherits with zero new surface: the
   *  loader patches the override onto the definition, and the spawn
   *  chokepoint resolves definition.model through the landed floor and
   *  admission predicates. `effortKept` carries a prior user-scope effort
   *  override through the whole-row write so a model pick never drops it. */
  const [modelPick, setModelPick] = useState<{
    agentType: string;
    current: string;
    effortKept?: EffortValue;
    rows: AgentModelPickerRow[];
  } | null>(null);

  // ── the form (the ONE machine) ───────────────────────────────────────────
  const [form, setForm] = useState<{ machine: StudioEditorMachine; mode: 'create' | 'edit' } | null>(null);
  const [formSnap, setFormSnap] = useState<StudioEditorSnapshot | null>(null);
  const [formPrompt, setFormPrompt] = useState<'destination' | FieldId | null>(null);
  const [formPick, setFormPick] = useState<{ field: FieldId; options: string[]; toggles?: boolean; modelRows?: AgentModelPickerRow[] } | null>(null);
  const formRef = useRef(form);
  formRef.current = form;
  const formPromptRef = useRef(formPrompt);
  formPromptRef.current = formPrompt;
  const defsRef = useRef(defs);
  defsRef.current = defs;

  const closeForm = useCallback((): void => {
    formRef.current?.machine.dispose();
    setForm(null);
    setFormSnap(null);
    setFormPrompt(null);
    setFormPick(null);
  }, []);

  const openForm = useCallback(
    (mode: 'create' | 'edit', base?: StudioDraftBase): void => {
      formRef.current?.machine.dispose();
      const machine = createStudioEditorMachine(
        {
          mode,
          ...(base !== undefined ? { base } : {}),
          cwd: workspaceDir,
          getExistingAgents: () => defsRef.current?.allAgents ?? [],
          getParentModel: () => mainModel,
          onSaved: message => {
            closeForm();
            setNote(message);
            refreshEverywhere();
          },
          onCancel: () => closeForm(),
        },
        s => setFormSnap(s),
      );
      // The face drives the machine field-by-field (the advanced posture);
      // the in-chat guided walk stays the chat skin's own journey.
      machine.setView({ kind: 'advanced', cursor: 0, editing: null });
      setForm({ machine, mode });
      setFormSnap(machine.snapshot());
    },
    [workspaceDir, mainModel, closeForm, refreshEverywhere],
  );
  useEffect(() => () => formRef.current?.machine.dispose(), []);

  // ── the library verbs ────────────────────────────────────────────────────
  const toggleRow = (row: StudioRow | null): { pending: string; result: Promise<string | null> } | null => {
    if (!row?.agent || row.agent.source === 'built-in') return null;
    const target = row.agent;
    return {
      pending: 'saving…',
      result: setAgentDisabled('user', workspaceDir, target.agentType, target.disabled !== true)
        .then(() => {
          refreshEverywhere();
          return `${target.disabled ? 'enabled' : 'disabled'} ${target.agentType}`;
        })
        .catch(e => String(e)),
    };
  };

  const runDelete = (agent: AgentDefinition): void => {
    if (!isFileBacked(agent)) return;
    void deleteAgentToTrash(
      { filePath: agent.filePath, revision: agent.revision },
      {
        agentType: agent.agentType,
        source: agent.source as Exclude<typeof agent.source, 'built-in' | 'extension'>,
      },
    )
      .then(entry => {
        setNote(`deleted ${agent.agentType} — restorable in the recovery area as ${entry.id}`);
        refreshEverywhere();
      })
      .catch(e => setNote(e instanceof AgentStoreError ? e.message : String(e)))
      .finally(() => setConfirm(null));
  };

  const list = useInteractiveList<StudioRow>({
    rows: listRows,
    rowId: r => `agent-face:${r.id}`,
    idNamespace: 'boot-agents',
    active: !suspended && form === null && confirm === null && !trash.open && modelPick === null,
    onClose: () => onClose?.(),
    actions: [
      {
        key: 'return',
        hint: 'edit',
        run: r => {
          if (!r?.agent) return null;
          if (r.agent.source === 'built-in') {
            // The built-in edit door (C1): the model dial, nothing else —
            // the definition stays code. `current` is the loader-patched
            // truth (the override when one stands, else the declared
            // intent); a prior USER-scope effort override rides the write.
            const agent = r.agent;
            setModelPick({
              agentType: agent.agentType,
              current: agent.model ?? 'inherit',
              ...(agent.operatorOverride?.from === 'user' && agent.operatorOverride.effort !== undefined
                ? { effortKept: agent.operatorOverride.effort }
                : {}),
              rows: getAgentModelPickerRows(),
            });
            return null;
          }
          if (!isFileBacked(r.agent)) return 'only file-backed agents edit here — clone it in /agents first';
          openForm('edit', { identity: { filePath: r.agent.filePath, revision: r.agent.revision }, agent: r.agent });
          return null;
        },
      },
      {
        key: 'n',
        hint: 'new',
        run: () => {
          openForm('create');
          return null;
        },
      },
      { key: 'x', hint: 'on/off', run: r => toggleRow(r) },
      {
        key: 'backspace',
        hint: 'delete',
        run: r => {
          if (!r?.agent || !isFileBacked(r.agent)) return null;
          setConfirm(r.agent);
          return null;
        },
      },
      {
        key: 'u',
        hint: 'trash',
        run: () => {
          setTrash({ open: true, entries: listAgentTrash() });
          return null;
        },
      },
      {
        key: 'r',
        hint: 'reload',
        run: () => {
          refreshEverywhere();
          return 'definitions re-read from disk';
        },
      },
    ],
  });

  const trashList = useInteractiveList<AgentTrashEntry>({
    rows: trash.entries,
    rowId: e => `agent-trash:${e.id}`,
    idNamespace: 'boot-agents-trash',
    active: !suspended && trash.open,
    onClose: () => setTrash({ open: false, entries: [] }),
    actions: [
      {
        key: 'return',
        hint: 'restore',
        run: e =>
          e === null
            ? null
            : {
                pending: 'restoring…',
                result: restoreAgentFromTrash(e.id)
                  .then(r => {
                    refreshEverywhere();
                    setTrash({ open: true, entries: listAgentTrash() });
                    return `restored ${e.agentType} → ${r.path}`;
                  })
                  .catch(err => (err instanceof AgentStoreError ? err.message : String(err))),
              },
      },
    ],
  });

  // ── the built-in model dial's pick list (C1) ─────────────────────────────
  const modelPickList = useInteractiveList<string>({
    rows: modelPick?.rows.map(r => r.value) ?? [],
    rowId: v => `agent-builtin-pick:${v}`,
    idNamespace: 'boot-agents-builtin-pick',
    active: !suspended && modelPick !== null,
    onClose: () => setModelPick(null),
    actions: [
      {
        key: 'return',
        hint: 'pick',
        run: value => {
          const pick = modelPick;
          if (value === null || pick === null) return null;
          const row = pick.rows.find(r => r.value === value);
          if (row === undefined) return null;
          // The ONE pick adjudication both skins share: connect rows and
          // unavailable rows are sign-in doors; a live row commits.
          const outcome = agentModelPickOutcome(row);
          if (outcome.kind === 'needs-sign-in') {
            if (onOpenLogins) {
              // The host swaps to its Logins layer; this screen stays
              // mounted-suspended and the pick re-derives on return (R2).
              onOpenLogins();
              return null;
            }
            return `${outcome.hint} — /logins opens the sign-in catalogue`;
          }
          const cleared = outcome.model === undefined;
          setModelPick(null);
          return {
            pending: 'saving…',
            result: setAgentOverride(
              'user',
              workspaceDir,
              pick.agentType,
              cleared
                ? pick.effortKept !== undefined
                  ? { effort: pick.effortKept }
                  : undefined
                : { model: outcome.model!, ...(pick.effortKept !== undefined ? { effort: pick.effortKept } : {}) },
            )
              .then(() => {
                refreshEverywhere();
                return cleared
                  ? `${pick.agentType} follows your session's model again — override cleared`
                  : `${pick.agentType} runs ${outcome.model} — a config row, the built-in definition untouched`;
              })
              .catch(e => String(e)),
          };
        },
      },
    ],
  });

  // ── the form rows list ───────────────────────────────────────────────────
  const formRowIds = useMemo(() => (form === null ? [] : agentFormRowIds(form.mode)), [form]);
  const editFormRow = (id: 'destination' | FieldId): void => {
    const f = formRef.current;
    const snap = f?.machine.snapshot();
    if (!f || !snap) return;
    switch (agentFormFieldKind(id)) {
      case 'cycle': {
        if (id === 'destination') f.machine.setScope(snap.scope === 'project' ? 'user' : 'project');
        else if (id === 'background') f.machine.commit({ set: { background: snap.doc.fields.background ? undefined : true } });
        else f.machine.commit({ set: { isolation: snap.doc.fields.isolation ? undefined : 'worktree' } });
        return;
      }
      case 'text':
        f.machine.openFieldEditor(id as FieldId);
        setFormPrompt(id);
        return;
      case 'body':
        f.machine.setTextBuffer(snap.doc.body.trim());
        setFormPrompt('body');
        return;
      case 'tools': {
        const names = faceTools.map(tool => tool.name);
        setFormPick({ field: id as FieldId, options: names, toggles: true });
        return;
      }
      case 'pick': {
        const field = id as FieldId;
        if (field === 'model') {
          // THE MULTIAUTH MANDATE (C5): the full catalogue in its own
          // order — unavailable rows visible, connect rows the sign-in
          // doors; the pick adjudicates through the ONE outcome.
          const modelRows = getAgentModelPickerRows();
          setFormPick({ field, options: modelRows.map(r => r.value), modelRows });
          return;
        }
        const options =
          field === 'effort'
              ? (() => {
                  const previewModel =
                    snap.doc.fields.model && snap.doc.fields.model !== 'inherit'
                      ? snap.doc.fields.model
                      : mainModel;
                  const stops = resolveEffortTruth(previewModel, undefined).selectable;
                  return (stops.length > 0 ? stops : EFFORT_LEVELS).map(String);
                })()
              : field === 'permissionMode'
                ? [...PERMISSION_MODES]
                : field === 'memory'
                  ? ['user', 'project', 'local']
                  : field === 'instructionProfile'
                    ? ['auto', 'native']
                    : [...AGENT_COLORS];
        setFormPick({ field, options: [...options, '(clear — use the default)'] });
        return;
      }
    }
  };

  const clearFormRow = (id: 'destination' | FieldId): void => {
    const f = formRef.current;
    if (!f) return;
    switch (id) {
      case 'destination':
        f.machine.setScope('project');
        return;
      case 'name':
      case 'description':
      case 'body':
        return; // required fields never clear silently — the gate would just red
      case 'background':
        f.machine.commit({ set: { background: undefined } });
        return;
      case 'isolation':
        f.machine.commit({ set: { isolation: undefined } });
        return;
      default:
        f.machine.commit({ set: { [id]: undefined } as never });
        return;
    }
  };

  const formList = useInteractiveList<'destination' | FieldId>({
    rows: formRowIds,
    rowId: r => `agent-form:${r}`,
    idNamespace: 'boot-agents-form',
    active:
      !suspended &&
      form !== null &&
      formPrompt === null &&
      formPick === null &&
      formSnap?.conflict == null &&
      formSnap?.recoverOffer == null &&
      formSnap?.busy !== true,
    onClose: () => closeForm(),
    actions: [
      {
        key: 'return',
        hint: 'edit field',
        run: r => {
          if (r !== null) editFormRow(r);
          return null;
        },
      },
      {
        key: 'backspace',
        hint: 'clear',
        run: r => {
          if (r !== null) clearFormRow(r);
          return null;
        },
      },
      {
        key: 'g',
        hint: 'generate',
        run: () => {
          formRef.current?.machine.setTextBuffer('');
          setFormPrompt('describe' as never);
          return null;
        },
      },
      {
        key: 's',
        hint: 'save',
        run: () => {
          void formRef.current?.machine.save();
          return null;
        },
      },
    ],
  });

  const pickList = useInteractiveList<string>({
    rows: formPick?.options ?? [],
    rowId: r => `agent-pick:${r}`,
    idNamespace: 'boot-agents-pick',
    active: !suspended && formPick !== null,
    onClose: () => setFormPick(null),
    actions: [
      {
        key: 'return',
        hint: 'pick',
        run: value => {
          const f = formRef.current;
          const pick = formPick;
          if (value === null || !f || !pick) return null;
          const snap = f.machine.snapshot();
          if (pick.toggles) {
            // The tools membership toggles on the DRAFT (undefined = all).
            const field = pick.field as 'tools' | 'disallowedTools';
            const current = snap.doc.fields[field];
            const next =
              current === undefined
                ? [value]
                : current.includes(value)
                  ? current.filter(n => n !== value)
                  : [...current, value];
            f.machine.commit({ set: { [field]: next.length === 0 ? undefined : next } as never });
            return null;
          }
          const cleared = value === '(clear — use the default)';
          if (pick.field === 'model') {
            const row = pick.modelRows?.find(r => r.value === value);
            if (row !== undefined) {
              const outcome = agentModelPickOutcome(row);
              if (outcome.kind === 'needs-sign-in') {
                if (onOpenLogins) {
                  // The host swaps to its Logins layer; this screen stays
                  // mounted-suspended and the pick re-derives on return.
                  onOpenLogins();
                  return null;
                }
                return `${outcome.hint} — /logins opens the sign-in catalogue`;
              }
              f.machine.commit({ set: { model: outcome.model } });
              setFormPick(null);
              return null;
            }
            f.machine.commit({ set: { model: cleared || value === 'inherit' ? undefined : value } });
          } else if (pick.field === 'effort') {
            f.machine.commit({ set: { effort: cleared ? undefined : (value as never) } });
          } else if (pick.field === 'maxTurns') {
            // unreachable (text field) — typed totality
          } else {
            f.machine.commit({ set: { [pick.field]: cleared ? undefined : value } as never });
          }
          setFormPick(null);
          return null;
        },
      },
    ],
  });

  // The text prompt's keys (the machine's buffer IS the draft): printable
  // bytes type, ⌫ edits, ↵ commits through the machine's own doors, esc
  // cancels — consumed here so no owner beneath sees them.
  useInput(
    (input, key, event) => {
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
        if ((promptField as string) === 'describe') {
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
      // eslint-disable-next-line no-control-regex
      if (input.length > 0 && !/[\x00-\x1f\x7f]/.test(input)) {
        const cap = promptField === 'body' ? BODY_CAP : TEXT_CAP;
        f.machine.setTextBuffer((snap.textBuffer + input).slice(0, cap));
      }
    },
    { isActive: !suspended && form !== null && formPrompt !== null },
  );

  // The delete card's keys (frozen offer; No leads — esc/n cancel, y/↵ go).
  useInput(
    (input, key, event) => {
      event.stopImmediatePropagation();
      if (confirm === null) return;
      if (input === 'y' || key.return) runDelete(confirm);
      else if (input === 'n' || key.escape) setConfirm(null);
    },
    { isActive: !suspended && confirm !== null },
  );

  // The machine's own modal states (recover · conflict · busy) take keys.
  useInput(
    (input, key, event) => {
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
    },
    {
      isActive:
        !suspended &&
        form !== null &&
        (formSnap?.busy === true || formSnap?.recoverOffer != null || formSnap?.conflict != null),
    },
  );

  // THE RETURN (rider R2): coming back from the host's Logins layer, a
  // live model pick re-derives its rows — a sign-in moved the presence, so
  // the reasons and connect doors must repaint the new truth, never the
  // captured one. The built-in dial's pick (C1) rides the same law.
  const wasSuspended = useRef(suspended);
  useEffect(() => {
    if (wasSuspended.current && !suspended) {
      setFormPick(pick =>
        pick !== null && pick.field === 'model'
          ? (() => {
              const modelRows = getAgentModelPickerRows();
              return { field: pick.field, options: modelRows.map(r => r.value), modelRows };
            })()
          : pick,
      );
      setModelPick(pick => (pick !== null ? { ...pick, rows: getAgentModelPickerRows() } : pick));
    }
    wasSuspended.current = suspended;
  }, [suspended]);

  // ── the ratified composition (the ONE shared design) ─────────────────────
  const { accent: coreAccent, rampStops } = useSplashCoreAccent();
  const core = useMemo(
    () => createSplashCore({ nocolor: false, truecolor: true, accent: coreAccent }),
    [coreAccent],
  );
  const wordGlow = useGreetingShimmer(rampStops, WORD_W);

  const menuM = useMemo(() => {
    const critterKey = getSessionCritterKey();
    const environment = {
      model: renderModelChip(mainModel),
      critter: critterKey.charAt(0).toUpperCase() + critterKey.slice(1),
      critterHue: getSessionAccent().accent,
      dirBase: basename(workspaceDir) || workspaceDir,
      dirTail: '',
    };
    const base = {
      title: 'agents',
      summaryTitle: 'AGENTS',
      summaryRows: agentFaceSummaryRows(counts),
      environment,
      glowWord: wordGlow,
      moreHint: '… (the trail continues — a taller terminal shows it whole)',
    };
    if (form !== null && formSnap !== null) {
      const snap = formSnap;
      const validation = computeStudioValidation({
        doc: snap.doc,
        existingAgents: defs?.allAgents ?? [],
        base: undefined,
        mode: form.mode,
      });
      const destination = studioDestinationPath({
        base: undefined,
        scope: snap.scope,
        cwd: workspaceDir,
        name: snap.doc.fields.name,
      });
      const modelAvailability = agentModelAvailabilityNote(snap.doc.fields.model);
      // The `runs:` line claims dispatch truth, so it speaks the RESOLVED
      // truth in the dossier's own grammar (intent → resolved, the floor
      // named when it fires) — the raw draft intent alone would lie for a
      // floored save while the dossier one layer away tells the truth
      // (AGENTVERIFY A9; the availability note stays worn, never gating).
      const effRun = effectiveStudioRuntime({
        doc: snap.doc,
        base: undefined,
        scope: snap.scope,
        parentModel: mainModel,
        sessionEffort: undefined,
        tools: faceTools,
      });
      const effectiveLine = `${effRun.modelIntent} → ${effRun.model}${effRun.flooredFrom ? ` (floored from ${effRun.flooredFrom})` : ''} · effort ${effRun.effort.label}${modelAvailability !== null ? ` · ${modelAvailability}` : ''}`;
      if (formPick !== null) {
        // 'body' never reaches a pick (agentFormFieldKind routes it) — the
        // display read narrows through the record shape.
        const current = (snap.doc.fields as Record<string, unknown>)[formPick.field];
        if (formPick.modelRows !== undefined) {
          // THE CATALOGUE PICK (C5): the rows in the catalogue's own order
          // and grouping — no family privileged, none hidden; unavailable
          // rows wear their reason, connect rows read as the doors they are.
          const currentModel = String(snap.doc.fields.model ?? 'inherit');
          return {
            ...base,
            entries: formPick.modelRows.map(r => ({
              label: r.kind === 'connect' ? `${r.label} …` : r.label,
              group: r.group,
              groupTitle: r.group,
              summary: r.unavailable ?? r.description,
              valueLabel: r.kind === 'connect' ? 'sign in' : r.unavailable !== undefined ? 'needs sign-in' : currentModel === r.value ? 'current' : '',
              valueIsDefault: r.unavailable === undefined && r.kind !== 'connect',
              pinnedVal: null,
              detail: null,
            })),
            selIdx: pickList.selectedIndex,
            statusRight: `${formPick.modelRows.length} rows — the full catalogue; ↵ on a sign-in row opens Logins`,
            legend: AGENT_FACE_LEGEND_PICK,
            detailOverride: agentFormDetailLines({ snap, validation, destination, effectiveLine, mode: form.mode }),
          };
        }
        return {
          ...base,
          entries: formPick.options.map(o => ({
            label: o,
            group: formPick.field,
            groupTitle: `pick ${formPick.field}`,
            summary: '',
            valueLabel: formPick.toggles
              ? Array.isArray(current) && current.includes(o)
                ? 'in'
                : ''
              : String(current ?? (formPick.field === 'model' ? 'inherit' : '')) === o
                ? 'current'
                : '',
            valueIsDefault: true,
            pinnedVal: null,
            detail: null,
          })),
          selIdx: pickList.selectedIndex,
          statusRight: `${formPick.options.length} option${formPick.options.length === 1 ? '' : 's'}${formPick.toggles ? ' · ↵ toggles membership' : ''}`,
          legend: AGENT_FACE_LEGEND_PICK,
          detailOverride: agentFormDetailLines({ snap, validation, destination, effectiveLine, mode: form.mode }),
        };
      }
      const promptOpen = formPrompt !== null;
      const promptLine = promptOpen
        ? `${String(formPrompt)}: ${snap.textBuffer === '' ? '(type)' : snap.textBuffer}▌`
        : null;
      return {
        ...base,
        entries: formRowIds.map(id => agentFormEntryOf(id, snap)),
        selIdx: promptOpen ? -1 : formList.selectedIndex,
        statusRight: promptLine ?? snap.note?.text ?? note ?? 'the agent form — ↵ edits a row · s saves',
        legend: promptOpen ? AGENT_FACE_LEGEND_PROMPT : AGENT_FACE_LEGEND_FORM,
        detailOverride: agentFormDetailLines({ snap, validation, destination, effectiveLine, mode: form.mode }),
      };
    }
    if (modelPick !== null) {
      // THE BUILT-IN MODEL DIAL (C1): the catalogue in its own order and
      // grouping — no family privileged, none hidden; unavailable rows wear
      // their reason, connect rows read as the doors they are; 'Inherit'
      // tops the list as the clear.
      return {
        ...base,
        entries: modelPick.rows.map(r => ({
          label: r.kind === 'connect' ? `${r.label} …` : r.label,
          group: r.group,
          groupTitle: r.group,
          summary: r.unavailable ?? r.description,
          valueLabel:
            r.kind === 'connect'
              ? 'sign in'
              : r.unavailable !== undefined
                ? 'needs sign-in'
                : modelPick.current === r.value
                  ? 'current'
                  : '',
          valueIsDefault: r.unavailable === undefined && r.kind !== 'connect',
          pinnedVal: null,
          detail: null,
        })),
        selIdx: modelPickList.selectedIndex,
        statusRight:
          modelPickList.note ??
          `${modelPick.agentType} — the model dial; ↵ on a sign-in row opens Logins`,
        legend: AGENT_FACE_LEGEND_PICK,
        detailOverride: [
          `${modelPick.agentType} — model override`,
          '',
          'built-in (no file): the definition is',
          'code — your pick lands in config as a',
          'per-agent settings row, never a file',
          'edit; dispatch wears it on the next',
          'spawn, running sessions included.',
          '',
          "'Inherit' clears the row — the agent",
          "follows your session's model again.",
        ],
      };
    }
    if (trash.open) {
      const empty = trash.entries.length === 0;
      return {
        ...base,
        entries: empty
          ? [
              {
                label: 'the recovery area is empty — deleted agents land here, restorable',
                group: 'recovery area',
                groupTitle: 'recovery area',
                summary: '',
                valueLabel: '—',
                valueIsDefault: true,
                pinnedVal: null,
                detail: null,
                inert: true,
              } satisfies FaceEntry,
            ]
          : trash.entries.map(agentTrashEntryOf),
        selIdx: empty ? -1 : trashList.selectedIndex,
        statusRight: trashList.note ?? `${trash.entries.length} restorable`,
        legend: AGENT_FACE_LEGEND_TRASH,
      };
    }
    const entries = listRows.map(agentFaceEntryOf);
    const selected = list.selectedRow;
    const detailOverride = confirm
      ? agentDeleteConfirmLines(confirm)
      : selected !== null && built !== null
        ? agentFaceDetailLines(
            selected,
            built.estate,
            selected.agent
              ? resolveEffectiveAgentRuntime(selected.agent, {
                  parentModel: mainModel,
                  sessionEffort: undefined,
                  tools: faceTools,
                })
              : null,
            selected.agent ? agentModelAvailabilityNote(selected.agent.operatorOverride?.model ?? selected.agent.model) : null,
          )
        : [
            'no agents yet',
            '',
            "n creates one — it lands on disk and",
            'every session sees it, running ones',
            'included (the freshness law).',
          ];
    return {
      ...base,
      entries:
        entries.length > 0
          ? entries
          : [
              {
                label: 'no agents in this workspace yet — n creates one',
                group: 'agents',
                groupTitle: 'agents',
                summary: '',
                valueLabel: '—',
                valueIsDefault: true,
                pinnedVal: null,
                detail: null,
                inert: true,
              } satisfies FaceEntry,
            ],
      selIdx: entries.length > 0 ? list.selectedIndex : -1,
      statusRight:
        defs === null
          ? '◓ reading definitions …'
          : (list.note ?? note ?? agentFaceStatusLine(counts)),
      legend: confirm ? AGENT_FACE_LEGEND_CONFIRM : AGENT_FACE_LEGEND,
      detailOverride,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts, listRows, built, defs, list.selectedRow, list.selectedIndex, list.note, note, confirm, trash, trashList.selectedIndex, trashList.note, form, formSnap, formPrompt, formPick, formRowIds, formList.selectedIndex, pickList.selectedIndex, modelPick, modelPickList.selectedIndex, modelPickList.note, mainModel, faceTools, workspaceDir, wordGlow?.peakCell, wordGlow?.gainLevel]);

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

  if (suspended) return null;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {Array.from({ length: rows }, (_, i) => {
        const line = composition.placed[i] ?? '';
        const entryIdx = composition.entryAt.get(i);
        if (entryIdx !== undefined) {
          // The pointer target rides whichever list owns the screen.
          if (formPick !== null) {
            const option = formPick.options[entryIdx];
            if (option !== undefined) {
              const props = pickList.rowProps(option, entryIdx);
              return (
                <InteractiveRow key={props.id} id={props.id} selected={props.selected} unavailable={props.unavailable} onSelect={props.onSelect} onActivate={props.onActivate} selectionBand={false} hoverStyle="chrome-ink" height={1}>
                  {hover => renderSceneLine(line, hover && !props.selected ? { label: option, color: t.info } : undefined)}
                </InteractiveRow>
              );
            }
          } else if (form !== null) {
            const rowId = formRowIds[entryIdx];
            if (rowId !== undefined) {
              const props = formList.rowProps(rowId, entryIdx);
              return (
                <InteractiveRow key={props.id} id={props.id} selected={props.selected} unavailable={props.unavailable} onSelect={props.onSelect} onActivate={props.onActivate} selectionBand={false} hoverStyle="chrome-ink" height={1}>
                  {hover => renderSceneLine(line, hover && !props.selected ? { label: agentFormEntryOf(rowId, formSnap!).label, color: t.info } : undefined)}
                </InteractiveRow>
              );
            }
          } else if (modelPick !== null) {
            const row = modelPick.rows[entryIdx];
            if (row !== undefined) {
              const props = modelPickList.rowProps(row.value, entryIdx);
              return (
                <InteractiveRow key={props.id} id={props.id} selected={props.selected} unavailable={props.unavailable} onSelect={props.onSelect} onActivate={props.onActivate} selectionBand={false} hoverStyle="chrome-ink" height={1}>
                  {hover => renderSceneLine(line, hover && !props.selected ? { label: row.label, color: t.info } : undefined)}
                </InteractiveRow>
              );
            }
          } else if (trash.open) {
            const entry = trash.entries[entryIdx];
            if (entry !== undefined) {
              const props = trashList.rowProps(entry, entryIdx);
              return (
                <InteractiveRow key={props.id} id={props.id} selected={props.selected} unavailable={props.unavailable} onSelect={props.onSelect} onActivate={props.onActivate} selectionBand={false} hoverStyle="chrome-ink" height={1}>
                  {hover => renderSceneLine(line, hover && !props.selected ? { label: entry.agentType, color: t.info } : undefined)}
                </InteractiveRow>
              );
            }
          } else {
            const row = listRows[entryIdx];
            if (row !== undefined) {
              const props = list.rowProps(row, entryIdx);
              return (
                <InteractiveRow key={props.id} id={props.id} selected={props.selected} unavailable={props.unavailable} onSelect={props.onSelect} onActivate={props.onActivate} selectionBand={false} hoverStyle="chrome-ink" height={1}>
                  {hover => renderSceneLine(line, hover && !props.selected ? { label: agentFaceEntryOf(row).label, color: t.info } : undefined)}
                </InteractiveRow>
              );
            }
          }
        }
        return (
          <Box key={`agentline-${i}`} height={1} flexShrink={0}>
            {line.length > 0 ? renderSceneLine(line) : null}
          </Box>
        );
      })}
    </Box>
  );
}
