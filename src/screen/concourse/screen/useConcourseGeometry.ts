import { useMemo } from 'react'
import { ROW_LINE_INSET, rowLineRows, rowNowCellWidth } from '../rowLine.js'
import { draftWindow } from '../lineDraft.js'
import { REDUCED_NOTICE_ROWS, ROW_PEEK_DESIRED_ROWS, switchboardGeometry } from '../ConcourseLayout.js'
import { compactConcourseGeometry } from '../compactBoard.js'
import type { Draft, Filter, Frame, Panes, RowLine, ScreenProps, Selection } from './state.js'

export function useConcourseGeometry({ snapshot, callbacks, reducedStage, boardGroups, cols, compactProfile, liveDraft, newSessionLine, olderList, region, rowPeekOpen, selectedRowLineOf, sessionRows, termCols, termRows }: Pick<ScreenProps, 'snapshot' | 'callbacks' | 'reducedStage'> & Pick<Filter, 'boardGroups' | 'newSessionLine' | 'sessionRows'> & Pick<Frame, 'cols' | 'compactProfile' | 'termCols' | 'termRows'> & Pick<Draft, 'liveDraft'> & Pick<Selection, 'olderList' | 'rowPeekOpen'> & Pick<Panes, 'region'> & Pick<RowLine, 'selectedRowLineOf'>) {
  const olderRows = olderList !== null ? Math.max(2, Math.min(ROW_PEEK_DESIRED_ROWS, olderList.entries.length + 1)) : 0
  const thirdPaneRows = reducedStage ? REDUCED_NOTICE_ROWS : 0
  const liveDraftDesired = reducedStage ? 0 : draftWindow(liveDraft, 3).bandRows
  const boardGroupCount = useMemo(() => boardGroups.filter(g => g.rows.length > 0).length, [boardGroups])
  const listPane = useMemo(() => {
    const bare = switchboardGeometry(cols, termRows, snapshot.needsYou.length, sessionRows.length + (newSessionLine ? 1 : 0), boardGroupCount, liveDraftDesired, 0, region, thirdPaneRows)
    const pane = bare.profile === 'wide' ? bare.rightCols[1] - bare.rightCols[0] + 1 : bare.interior
    return { lineWidth: Math.max(16, pane - ROW_LINE_INSET), nowCellWidth: rowNowCellWidth(bare.constrained ? bare.interior : pane - 4) }
  }, [cols, termRows, snapshot.needsYou.length, sessionRows.length, newSessionLine, boardGroupCount, liveDraftDesired, region, thirdPaneRows])
  const rowLineWidth = listPane.lineWidth
  const selectedRowLine = selectedRowLineOf(listPane.nowCellWidth)
  const chipRows = !rowPeekOpen && selectedRowLine !== null ? rowLineRows(selectedRowLine.words, rowLineWidth) : 0
  const geo = useMemo(
    () =>
      switchboardGeometry(
        cols,
        termRows,
        snapshot.needsYou.length,
        sessionRows.length + (newSessionLine ? 1 : 0),
        boardGroupCount,
        liveDraftDesired,
        rowPeekOpen ? ROW_PEEK_DESIRED_ROWS : olderRows > 0 ? olderRows : chipRows,
        region,
        thirdPaneRows,
      ),
    [cols, termRows, snapshot.needsYou.length, sessionRows.length, newSessionLine, boardGroupCount, liveDraftDesired, rowPeekOpen, olderRows, chipRows, region, thirdPaneRows],
  )
  const compactGeo = useMemo(
    () =>
      compactProfile === null
        ? null
        : compactConcourseGeometry(termCols, termRows, {
            sessionCount: sessionRows.length,
            newSessionDoor: !reducedStage && callbacks.newSession !== undefined,
            composerBand: reducedStage ? 0 : Math.max(1, liveDraftDesired),
          }),
    [compactProfile, termCols, termRows, sessionRows.length, reducedStage, callbacks.newSession, liveDraftDesired],
  )
  return { olderRows, thirdPaneRows, liveDraftDesired, boardGroupCount, rowLineWidth, selectedRowLine, chipRows, geo, compactGeo }
}
