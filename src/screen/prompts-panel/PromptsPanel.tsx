import * as React from 'react'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useInput } from '../themedRenderer.js'
import { usePublish } from '../effects/effects.js'
import { useSessionConnector } from '../focused-session/useSessionConnector.js'
import {
  addSavedPrompt,
  clearSavedPrompts,
  deleteSavedPrompt,
  editSavedPrompt,
  getSavedPromptsProblem,
  getSavedPromptsSnapshot,
  moveSavedPrompt,
  subscribeSavedPrompts,
} from '../../sessions/saved-prompts/savedPromptsStore.js'
import { truncateToWidth } from '../theme/glyphs.js'
import type {
  ColumnDef,
  RowAction,
  SectionDef,
} from '../widgets/NavigablePanes.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import {
  crewTrafficRows,
  promptRows,
  recordLimits,
  type PromptRow,
} from './rows.js'
import { panelColumnsOf, panelViewOf, type Editor, type Held, type Note, type Row, type SavedRow, type SectionId } from './panelParts.js'


const SIDE_BODY_CHARS = 240

function modeLabel(mode: PromptRow['mode']): string {
  return mode === 'plain' ? 'plain' : mode === 'bash' ? 'bash' : 'slash'
}

function processStartedAtIso(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString()
}

export function PromptsPanel({
  onClose,
  initialSection = 'prompts',
  held = {},
}: {
  onClose: (nextInput?: string) => void
  initialSection?: SectionId
  held?: Held
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const connector = useSessionConnector()
  const subscribeRecords = useCallback((cb: () => void) => connector.subscribeRecords(cb), [connector])
  const readRecords = useCallback(() => connector.records(), [connector])
  const records = useSyncExternalStore(subscribeRecords, readRecords, readRecords)
  const workspace = connector.workspace()
  const sessionId = connector.sessionId()
  const project = workspace.projectRoot || workspace.cwd

  const drafts = useSyncExternalStore(
    useCallback((cb: () => void) => subscribeSavedPrompts(project, cb), [project]),
    useCallback(() => getSavedPromptsSnapshot(project), [project]),
    useCallback(() => getSavedPromptsSnapshot(project), [project]),
  )
  const problem = useSyncExternalStore(
    useCallback((cb: () => void) => subscribeSavedPrompts(project, cb), [project]),
    useCallback(() => getSavedPromptsProblem(project), [project]),
    useCallback(() => getSavedPromptsProblem(project), [project]),
  )

  const [section, setSection] = useState<SectionId>(held.section ?? initialSection)
  const subscribeWork = useCallback((cb: () => void) => connector.subscribeWork(cb), [connector])
  const readBoard = useCallback(() => connector.swarmBoard?.() ?? null, [connector])
  const board = useSyncExternalStore(subscribeWork, readBoard, readBoard)
  const [editor, setEditor] = useState<Editor>(held.editor ?? null)
  const [editorCursor, setEditorCursor] = useState(held.editorCursor ?? 0)
  usePublish(() => {
    held.section = section
    held.editor = editor
    held.editorCursor = editorCursor
  }, [held, section, editor, editorCursor])
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [note, setNote] = useState<Note>(null)
  const startedAtRef = useRef(processStartedAtIso())

  const prompts = useMemo(() => promptRows(records), [records])
  const queuedCount = prompts.filter(row => row.queued === true).length
  const crew = useMemo(() => crewTrafficRows(records), [records])
  const saved = useMemo<SavedRow[]>(
    () => (drafts ?? []).map((d, i) => ({ kind: 'saved', key: `saved:${d.id}`, n: i + 1, draft: d })),
    [drafts],
  )
  const limits = useMemo(() => recordLimits(records, startedAtRef.current), [records])

  const sections = useMemo<SectionDef<Row>[]>(
    () => [
      {
        id: 'prompts',
        label: 'PROMPTS',
        rows: prompts,
        emptyHint: 'no prompts sent in this chat yet — the roll fills as you send',
      },
      {
        id: 'crew',
        label: board?.on ? 'Crew chat' : 'CREW TRAFFIC',
        count: crew.filter(r => r.kind === 'crew').length,
        rows: crew,
        emptyHint: 'no crewmate traffic this session',
      },
      {
        id: 'saved',
        label: 'SAVED PROMPTS',
        rows: saved,
        emptyHint:
          problem !== null
            ? `the saved-prompts file could not be read (${truncateToWidth(problem, 40)}) — a writes a fresh list; the damaged copy is kept beside it`
            : drafts === null
              ? 'reading saved prompts…'
              : 'no saved prompts yet — a writes one',
      },
    ],
    [prompts, crew, saved, drafts, problem, board?.on],
  )

  const columns = useMemo<ColumnDef<Row>[]>(() => panelColumnsOf({ section, tokens, modeLabel }), [section, tokens])

  const receipt = useCallback((r: { ok: boolean; reason?: string }, okText: string): void => {
    if (r.ok) setNote({ text: okText, tone: 'ok' })
    else setNote({ text: r.reason ?? 'refused', tone: 'warn' })
  }, [])

  const openAdd = useCallback((): void => {
    setConfirmDelete(null)
    setEditor({ kind: 'add', buffer: '' })
    setEditorCursor(0)
  }, [])

  const rowActions = useMemo<RowAction<Row>[]>(
    () => [
      {
        key: 's',
        label: 'to composer',
        when: row => row.kind === 'saved',
        run: row => {
          if (row.kind !== 'saved') return
          onClose(row.draft.text)
        },
      },
      {
        key: 'e',
        label: 'edit',
        when: row => row.kind === 'saved',
        run: row => {
          if (row.kind !== 'saved') return
          setConfirmDelete(null)
          setEditor({ kind: 'edit', id: row.draft.id, n: row.n, buffer: row.draft.text })
          setEditorCursor(row.draft.text.length)
        },
      },
      {
        key: '[',
        label: 'up',
        when: row => row.kind === 'saved' && row.n > 1,
        run: row => {
          if (row.kind !== 'saved') return
          void moveSavedPrompt(project, row.draft.id, -1).then(r => receipt(r, `moved #${row.n} up`))
        },
      },
      {
        key: ']',
        label: 'down',
        when: row => row.kind === 'saved' && row.n < saved.length,
        run: row => {
          if (row.kind !== 'saved') return
          void moveSavedPrompt(project, row.draft.id, 1).then(r => receipt(r, `moved #${row.n} down`))
        },
      },
      {
        key: 'd',
        label: 'delete',
        when: row => row.kind === 'saved',
        run: row => {
          if (row.kind !== 'saved') return
          if (confirmDelete === row.draft.id) {
            setConfirmDelete(null)
            void deleteSavedPrompt(project, row.draft.id).then(r => receipt(r, `deleted #${row.n}`))
            return
          }
          setConfirmDelete(row.draft.id)
          setNote({ text: `delete saved prompt #${row.n}? d again confirms`, tone: 'warn' })
        },
      },
      {
        key: 'c',
        label: 'clear',
        when: row => row.kind === 'saved',
        run: () => {
          setConfirmDelete(null)
          setEditor({ kind: 'confirm-clear', count: saved.length })
        },
      },
    ],
    [confirmDelete, onClose, project, receipt, saved.length],
  )

  const confirmClear = useCallback((): void => {
    setEditor(null)
    void clearSavedPrompts(project).then(r =>
      setNote({ text: r.cleared === 0 ? 'nothing to clear' : `cleared ${r.cleared === 1 ? '1 saved prompt' : `${r.cleared} saved prompts`} — the list is empty`, tone: 'ok' }),
    )
  }, [project])

  useInput(
    (input, key) => {
      if (key.ctrl || key.meta) return
      if (input === 'a') openAdd()
    },
    { isActive: section === 'saved' && editor === null },
  )

  const commitEditor = useCallback(
    (value: string): void => {
      const ed = editor
      if (ed === null || ed.kind === 'confirm-clear') return
      setEditor(null)
      if (ed.kind === 'add') {
        void addSavedPrompt(project, value).then(r =>
          receipt(r, r.ok ? `saved prompt #${saved.length + 1} written — s hands it to the composer` : ''),
        )
      } else {
        void editSavedPrompt(project, ed.id, value).then(r => receipt(r, `edited #${ed.n}`))
      }
    },
    [editor, project, receipt, saved.length],
  )

  const [confirmDeleteSection, setConfirmDeleteSection] = useState<SectionId>(section)
  if (confirmDeleteSection !== section) {
    setConfirmDeleteSection(section)
    if (confirmDelete !== null) {
      setConfirmDelete(null)
      setNote(null)
    }
  }

  return panelViewOf({ held, prompts, saved, tokens, section, limits, queuedCount, crew, problem, drafts, note, editor, setEditor, editorCursor, setEditorCursor, commitEditor, board, records, onClose, setSection, workspace, sessionId, sections, columns, rowActions, confirmClear, modeLabel, SIDE_BODY_CHARS })
}
