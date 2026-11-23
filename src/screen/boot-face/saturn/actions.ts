import type { Dispatch, RefObject, SetStateAction } from 'react';
import { daemonControlRpc } from '../../../daemon/control/controlSocket.js';
import { MERCURY_DAEMON_PROTO } from '../../../daemon/control/protocol.js';
import { deriveScheduleAccountForModel, readLiveAccountFacts, scheduleAccountVerdict } from '../../../daemon/saturn/saturnAccount.js';
import { addBoxSchedule } from '../../../daemon/saturn/saturnBoxSchedules.js';
import { compileWhenSpelling } from '../../../daemon/saturn/whenSpelling.js';
import type { SaturnFormStateV1, SaturnScreenRowV1, saturnOpeningPickOptions as saturnOpeningPickOptionsDoor, saturnWorkspacePickOptions as saturnWorkspacePickOptionsDoor } from '../BootSaturnScreen.js';

export type SaturnFormRowId = 'when' | 'model' | 'workspace' | 'presence' | 'kit' | 'opening' | 'title' | 'note';

export function scheduleEditRpcOf({ busy, setNote, refresh }: { busy: RefObject<boolean>; setNote: Dispatch<SetStateAction<string | null>>; refresh: () => void }, row: SaturnScreenRowV1, op: 'remove' | 'pause' | 'resume', pendingWord: string, doneWord: string): void {
  if (busy.current) return;
  busy.current = true;
  setNote(`${pendingWord} '${row.facts.id}'…`);
  void daemonControlRpc(
    {
      op: 'sessionControl',
      proto: MERCURY_DAEMON_PROTO,
      action: 'set-schedule',
      sessionId: row.sessionId,
      by: 'operator:saturn-screen',
      scheduleEdit: { op, scheduleId: row.facts.id },
    },
    { timeoutMs: 3000 },
  )
    .then(reply => {
      const r = reply as { ok?: boolean; outcome?: string; detail?: string; error?: string };
      setNote(
        r.ok === true && (r.outcome === 'applied' || r.outcome === 'noop')
          ? `${doneWord} '${row.facts.id}' — ${r.detail ?? 'receipted'}`
          : `${op} refused — ${r.detail ?? r.error ?? 'no detail'}`,
      );
    })
    .catch(e => setNote(`${op} failed — ${String(e)}`))
    .finally(() => {
      busy.current = false;
      refresh();
    });
}

export function runNowOf({ busy, setNote, refresh }: { busy: RefObject<boolean>; setNote: Dispatch<SetStateAction<string | null>>; refresh: () => void }, row: SaturnScreenRowV1): void {
  if (busy.current) return;
  if (row.schedule.action.kind !== 'fire') {
    setNote('run-now takes fire schedules; a birth fires on its own clock');
    return;
  }
  busy.current = true;
  setNote(`running '${row.facts.id}' now…`);
  void daemonControlRpc(
    {
      op: 'sessionDispatch',
      proto: MERCURY_DAEMON_PROTO,
      clientMessageId: `saturn-screen-run-${row.facts.id}-${Date.now()}`,
      prompt: row.schedule.action.prompt,
      workspaceDir: row.workspaceId,
      by: 'operator:saturn-screen',
      ...(row.parked ? { resumeSessionId: row.sessionId } : { targetSessionId: row.sessionId }),
    },
    { timeoutMs: 5000 },
  )
    .then(reply => {
      const r = reply as { ok?: boolean; error?: string };
      setNote(r.ok === true ? `fired '${row.facts.id}' into ${row.sessionTitle}` : `run-now refused — ${r.error ?? 'no detail'}`);
    })
    .catch(e => setNote(`run-now failed — ${String(e)}`))
    .finally(() => {
      busy.current = false;
      refresh();
    });
}

export function commitPromptOf({ setForm }: { setForm: Dispatch<SetStateAction<SaturnFormStateV1 | null>> }, field: SaturnFormRowId, draft: string): void {
  const text = draft.trim();
  setForm(f => {
    if (f === null) return f;
    switch (field) {
      case 'when':
        return { ...f, when: text };
      case 'workspace':
        return text === '' ? f : { ...f, workspaceDir: text };
      case 'opening':
        return { ...f, opening: text === '' ? null : text };
      case 'title':
        return { ...f, title: text === '' ? null : text };
      case 'note':
        return { ...f, note: text === '' ? null : text };
      default:
        return f;
    }
  });
}

export function editFormRowOf({ form, setFormNote, setFormPrompt, setFormPick, modelOptionsOf, liveModelOptions, saturnWorkspacePickOptions, projectsOf, liveProjectDirs, setForm, presetsOf, livePresets, saturnOpeningPickOptions }: { form: SaturnFormStateV1 | null; setFormNote: Dispatch<SetStateAction<string | null>>; setFormPrompt: Dispatch<SetStateAction<{ field: SaturnFormRowId; draft: string } | null>>; setFormPick: Dispatch<SetStateAction<{ field: 'model' | 'kit' | 'workspace' | 'opening'; options: string[] } | null>>; modelOptionsOf: (() => string[]) | undefined; liveModelOptions: () => string[]; saturnWorkspacePickOptions: typeof saturnWorkspacePickOptionsDoor; projectsOf: (() => string[]) | undefined; liveProjectDirs: () => string[]; setForm: Dispatch<SetStateAction<SaturnFormStateV1 | null>>; presetsOf: (() => string[]) | undefined; livePresets: () => string[]; saturnOpeningPickOptions: typeof saturnOpeningPickOptionsDoor }, id: SaturnFormRowId): void {
  const f = form;
  if (f === null) return;
  setFormNote(null);
  switch (id) {
    case 'when':
      setFormPrompt({ field: 'when', draft: f.when });
      return;
    case 'model':
      setFormPick({ field: 'model', options: (modelOptionsOf ?? liveModelOptions)() });
      return;
    case 'workspace':
      setFormPick({ field: 'workspace', options: saturnWorkspacePickOptions((projectsOf ?? liveProjectDirs)()) });
      return;
    case 'presence':
      setForm({ ...f, presence: f.presence === 'headless' ? 'screen-present' : 'headless' });
      return;
    case 'kit':
      setFormPick({ field: 'kit', options: ['none', ...(presetsOf ?? livePresets)()] });
      return;
    case 'opening':
      setFormPick({ field: 'opening', options: saturnOpeningPickOptions() });
      return;
    case 'title':
      setFormPrompt({ field: 'title', draft: f.title ?? '' });
      return;
    case 'note':
      setFormPrompt({ field: 'note', draft: f.note ?? '' });
      return;
  }
}

export function clearFormRowOf({ setForm }: { setForm: Dispatch<SetStateAction<SaturnFormStateV1 | null>> }, id: SaturnFormRowId): void {
  setForm(f => {
    if (f === null) return f;
    switch (id) {
      case 'when':
        return { ...f, when: '' };
      case 'kit':
        return { ...f, kitPreset: null };
      case 'opening':
        return { ...f, opening: null };
      case 'title':
        return { ...f, title: null };
      case 'note':
        return { ...f, note: null };
      default:
        return f;
    }
  });
}

export function submitFormOf({ form, setFormNote, setForm, setFormPrompt, setFormPick, setNote, refresh }: { form: SaturnFormStateV1 | null; setFormNote: Dispatch<SetStateAction<string | null>>; setForm: Dispatch<SetStateAction<SaturnFormStateV1 | null>>; setFormPrompt: Dispatch<SetStateAction<{ field: SaturnFormRowId; draft: string } | null>>; setFormPick: Dispatch<SetStateAction<{ field: 'model' | 'kit' | 'workspace' | 'opening'; options: string[] } | null>>; setNote: Dispatch<SetStateAction<string | null>>; refresh: () => void }): void {
  const f = form;
  if (f === null) return;
  if (f.when === '') {
    setFormNote('say when first — ↵ on the When row');
    return;
  }
  const compiled = compileWhenSpelling(f.when, Date.now());
  if (!compiled.ok) {
    setFormNote(compiled.reason);
    return;
  }
  const birth = {
    workspaceDir: f.workspaceDir,
    modelKey: f.modelKey,
    presence: f.presence,
    ...(f.kitPreset !== null ? { kitPreset: f.kitPreset } : {}),
    ...(f.opening !== null ? { opening: f.opening } : {}),
    ...(f.title !== null ? { title: f.title } : {}),
  };
  const res = addBoxSchedule(
    { when: compiled.when, action: { kind: 'birth', birth }, ...(f.note !== null ? { note: f.note } : {}) },
    'operator:saturn-screen',
    {
      deriveAccount: m => deriveScheduleAccountForModel(m),
      preflight: (account, nextFireMs) =>
        scheduleAccountVerdict({ account, nextFireMs, nowMs: Date.now(), live: readLiveAccountFacts(account) }),
    },
  );
  if (!res.ok) {
    setFormNote(res.reason);
    return;
  }
  setForm(null);
  setFormPrompt(null);
  setFormPick(null);
  setNote(`schedule '${res.id}' set — a ${f.presence} box birth, ${compiled.when.spelling ?? f.when}; the next daemon tick sees it`);
  refresh();
}
