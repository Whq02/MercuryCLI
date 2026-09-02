import { useEffect, useRef, useState } from 'react'
import { isTopOverlayNow, useRegisterOverlay } from '../../context/overlayContext.js'
import type { DOMElement } from '../../ink.js'
import { useInput } from '../../ink.js'
import { decodeNavKey } from './navSemantics.js'
import { useOpenEventGate } from './useOpenEventGate.js'


export type NavLevel = 'list' | 'detail'

export type UseNavigablePanesArgs = {
  escOverride?: () => boolean
  sectionIds?: string[]
  sectionCount: number
  rowCount: number
  onClose: () => void
  active?: boolean
  expandable?: boolean
  detailFloor?: number
  detailCeil?: number
  onActivateRow?: (section: number, sel: number) => void
  initialSection?: number
  initialSel?: number
  sectionRowKeys?: readonly (readonly string[])[]
}

export type UseNavigablePanesResult = {
  section: number
  sel: number
  level: NavLevel
  drilled: boolean
  detailRows: number
  expanded: boolean
  pastBuffer: () => boolean
  rowRef: React.RefObject<DOMElement | null>
  setSection: (i: number) => void
  selectSection: (i: number) => void
  selectRow: (i: number) => void
  activateCurrent: () => void
}

export function crossSectionAtEdge(
  counts: readonly number[],
  section: number,
  sel: number,
  dir: -1 | 1,
): { section: number; sel: number } | null {
  const count = counts[section] ?? 0
  const atEdge = dir === -1 ? sel <= 0 : sel >= count - 1
  if (!atEdge) return null
  const t = section + dir
  if (t < 0 || t >= counts.length) return null
  const n = counts[t] ?? 0
  return { section: t, sel: dir === -1 ? Math.max(0, n - 1) : 0 }
}

export function useNavigablePanes({
  sectionCount,
  rowCount,
  onClose,
  active = true,
  escOverride,
  sectionIds,
  expandable = true,
  detailFloor = 3,
  detailCeil = 18,
  onActivateRow,
  initialSection = 0,
  initialSel = 0,
  sectionRowKeys,
}: UseNavigablePanesArgs): UseNavigablePanesResult {
  const [section, setSectionState] = useState(initialSection)
  const [sel, setSel] = useState(initialSel)
  const [level, setLevel] = useState<NavLevel>('list')
  const [detailRows, setDetailRows] = useState(detailFloor)
  const rowRef = useRef<DOMElement | null>(null)

  const pastBuffer = useOpenEventGate()

  const maxSection = Math.max(0, sectionCount - 1)
  const activeSectionIdRef = useRef<string | null>(null)
  const idResolved =
    activeSectionIdRef.current !== null && sectionIds
      ? sectionIds.indexOf(activeSectionIdRef.current)
      : -1
  const clampedSection = idResolved >= 0 ? idResolved : Math.min(section, maxSection)
  const keyedCount = sectionRowKeys?.[clampedSection]?.length
  const maxSel = Math.max(0, (keyedCount ?? rowCount) - 1)
  const clampedSel = Math.min(sel, maxSel)
  useEffect(() => {
    if (section !== clampedSection) setSectionState(clampedSection)
    if (sel !== clampedSel) setSel(clampedSel)
  }, [section, clampedSection, sel, clampedSel])

  const rememberedSel = useRef(new Map<string, { key: string | null; index: number }>())
  const sectionMemoKey = (i: number): string => sectionIds?.[i] ?? String(i)
  const keysRef = useRef(sectionRowKeys)
  keysRef.current = sectionRowKeys
  const setSection = (i: number): void => {
    const next = Math.min(Math.max(0, i), maxSection)
    const keys = keysRef.current
    rememberedSel.current.set(sectionMemoKey(clampedSection), {
      key: keys?.[clampedSection]?.[clampedSel] ?? null,
      index: clampedSel,
    })
    setSectionState(next)
    activeSectionIdRef.current = sectionIds?.[next] ?? null
    const remembered = rememberedSel.current.get(sectionMemoKey(next))
    const byKey =
      remembered?.key != null ? (keys?.[next]?.indexOf(remembered.key) ?? -1) : -1
    setSel(byKey >= 0 ? byKey : (remembered?.index ?? 0))
    setLevel('list')
    setDetailRows(detailFloor)
  }

  const selectRow = (i: number): void => {
    setSel(Math.min(Math.max(0, i), maxSel))
  }

  const activateCurrent = (): void => {
    if (!pastBuffer()) return
    if ((keyedCount ?? rowCount) === 0) return
    if (onActivateRow) {
      onActivateRow(clampedSection, clampedSel)
    } else {
      setLevel('detail')
      setDetailRows(detailFloor)
    }
  }

  const overlayToken = useRegisterOverlay('board', true)
  useInput(
    (input, key, event) => {
      const action = decodeNavKey(input, key, {
        orientation: 'vertical',
        leftCloses: level === 'list' && sectionCount <= 1,
      })
      if (action === 'cancel') {
        if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
        if (escOverride?.()) {
          event.stopImmediatePropagation()
          return
        }
        event.stopImmediatePropagation()
        if (level === 'detail') {
          setLevel('list')
          setDetailRows(detailFloor)
        } else {
          onClose()
        }
      }
    },
    { isActive: true },
  )

  useInput(
    (input, key, event) => {
      const action = decodeNavKey(input, key, {
        orientation: 'horizontal',
        tabFocus: true,
      })
      if (
        action === 'focusNext' ||
        action === 'focusPrevious' ||
        (action === 'moveLeft' && level === 'list')
      ) {
        event.stopImmediatePropagation()
        const dir = action === 'focusNext' ? 1 : -1
        const next = (clampedSection + dir + sectionCount) % sectionCount
        setSection(next)
        return
      }
      if (level === 'list' && input >= '1' && input <= '9') {
        const target = Number(input) - 1
        if (target < sectionCount) {
          event.stopImmediatePropagation()
          setSection(target)
        }
      }
    },
    { isActive: active && sectionCount > 1 },
  )

  const navActive = active && (rowCount > 0 || sectionCount > 1)
  useInput(
    (input, key, event) => {
      const action = decodeNavKey(input, key, {
        orientation: 'vertical',
        hierarchy: true,
      })
      const act = (fn: () => void): void => {
        event.stopImmediatePropagation()
        fn()
      }
      if (level === 'detail') {
        if (action === 'movePrevious') return act(() => setSel(s => Math.max(0, s - 1)))
        if (action === 'moveNext') return act(() => setSel(s => Math.min(maxSel, s + 1)))
        if (action === 'first') return act(() => setSel(0))
        if (action === 'last') return act(() => setSel(maxSel))
        if (expandable && input === '+') {
          return act(() => setDetailRows(r => Math.min(detailCeil, r + 1)))
        }
        if (expandable && input === '-' && detailRows > detailFloor) {
          return act(() => setDetailRows(r => Math.max(detailFloor, r - 1)))
        }
        if (action === 'leaveChild' || input === '-') {
          return act(() => {
            setLevel('list')
            setDetailRows(detailFloor)
          })
        }
        return
      }

      if (action === 'movePrevious' || action === 'moveNext') {
        const dir = action === 'movePrevious' ? -1 : 1
        const keys = keysRef.current
        const cross = keys
          ? crossSectionAtEdge(keys.map(k => k.length), clampedSection, clampedSel, dir)
          : null
        if (cross) {
          return act(() => {
            rememberedSel.current.set(sectionMemoKey(clampedSection), {
              key: keys?.[clampedSection]?.[clampedSel] ?? null,
              index: clampedSel,
            })
            setSectionState(cross.section)
            activeSectionIdRef.current = sectionIds?.[cross.section] ?? null
            setSel(cross.sel)
          })
        }
        return act(() =>
          dir === -1 ? setSel(s => Math.max(0, s - 1)) : setSel(s => Math.min(maxSel, s + 1)),
        )
      }
      if (action === 'first') return act(() => setSel(0))
      if (action === 'last') return act(() => setSel(maxSel))
      if (action === 'activate' || action === 'enterChild') {
        return act(() => activateCurrent())
      }
    },
    { isActive: navActive },
  )

  return {
    section: clampedSection,
    sel: clampedSel,
    level,
    drilled: level === 'detail',
    detailRows,
    expanded: detailRows > detailFloor,
    pastBuffer,
    rowRef,
    setSection,
    selectSection: setSection,
    selectRow,
    activateCurrent,
  }
}
