import React, { useEffect, useMemo, useState } from 'react'
import { Ansi, Box, Text } from '../../ink.js'
import { useRealTerminalSize, useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import { tailFileSync } from '../../utils/fsOperations.js'
import { useFocusedWorkRows } from '../tasks/useFocusedWork.js'
import type { WorkRowV1 } from '../../services/engine-connector/types.js'
import { MessageResponse } from '../MessageResponse.js'
import { shellLiveTailBudget, shellLiveTailLines } from './liveShellTail.js'

const TAIL_BYTES = 8 * 1024

function readOutput(path: string | undefined): string {
  if (path === undefined) return ''
  try {
    return tailFileSync(path, TAIL_BYTES).content
  } catch {
    return ''
  }
}

function RunningShellTail({ shell }: { shell: WorkRowV1 }): React.ReactNode {
  const { columns } = useRealTerminalSize()
  const { rows } = useTerminalSize()
  const [output, setOutput] = useState(() => readOutput(shell.outputFile))
  const elapsed = useElapsedTime(shell.startTime, true, 1000)
  useEffect(() => {
    setOutput(readOutput(shell.outputFile))
    const timer = setInterval(() => setOutput(readOutput(shell.outputFile)), 200)
    return () => clearInterval(timer)
  }, [shell.outputFile])
  const budget = shellLiveTailBudget(columns, rows)
  const lines = useMemo(() => shellLiveTailLines(output, budget), [output, budget])
  return (
    <MessageResponse height={lines.length + 1}>
      <Box flexDirection="column" flexGrow={1} minWidth={0} overflow="hidden">
        {lines.map((line, index) => <Text key={index} wrap="truncate-end"><Ansi>{line}</Ansi></Text>)}
        <Text dimColor wrap="truncate-end">running · {elapsed}</Text>
      </Box>
    </MessageResponse>
  )
}

export function ShellLiveTail({ inputId }: { inputId: string }): React.ReactNode {
  const work = useFocusedWorkRows()
  const shell = work.find(row => row.kind === 'shell' && row.toolUseId === inputId && row.status === 'running')
  return shell === undefined ? null : <RunningShellTail key={shell.id} shell={shell} />
}
