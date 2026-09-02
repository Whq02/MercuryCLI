// ============================================================================
//  scripts/streaming/streamHarness.tsx — the bench's measured subject.
//
//  Mounts a faithful replica of REPL.tsx's streaming wiring (the transcript
//  ballast + the streaming text surface + a composer-shaped footer) under a
//  real Ink render, and drives it through the REAL fan-out
//  (handleMessageFromStream) with a deterministic fixture.
//
//  FIDELITY CONTRACT (keep in lockstep with REPL.tsx — the bench measures
//  whatever the app actually does):
//   • text: the per-REPL StreamingTailStore + the ONE
//     subscribed <LiveStreamingTail> leaf; the root tree keeps only the
//     streamingActive boolean (boundary flips). tailCommits now counts
//     store PUBLISHES (leaf re-renders), rootCommits the root tree;
//   • tool input: StreamBatcher, flushNow on length change, SILENT deltas,
//     flushSilent at block stop (REPL.tsx onStreamingToolUses verbatim);
//   • stream end: text cleared in the same fan-out call as the message
//     append (streaming.ts), full text then rendered as a settled message.
// ============================================================================

import React, { useCallback, useRef, useState } from 'react'
import { appendFileSync, writeFileSync } from 'node:fs'
import { buildFixture } from './fixtures.ts'

export async function runStreamScene(sceneName: string, outPath: string): Promise<void> {
  const { render, Box, Text, useInput } = await import('../../src/ink.js')
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { enableConfigs } = await import('../../src/utils/config.js')
  const { handleMessageFromStream } = await import('../../src/utils/messages/streaming.js')
  type StreamingToolUse = import('../../src/utils/messages/streaming.js').StreamingToolUse
  const { StreamBatcher } = await import('../../src/utils/messages/streamBatcher.js')
  const { createStreamingTailStore } = await import('../../src/utils/messages/streamingTailStore.js')
  const { LiveStreamingTail } = await import('../../src/components/LiveStreamingTail.js')
  const { Markdown, StreamingMarkdown } = await import('../../src/components/Markdown.js')
  // FLUX_HARNESS_LEGACY=1 re-mounts the pre-S2 wiring (streamingTextRef +
  // per-LINE state) — the preserved baseline subject for regression compares.
  const legacy = process.env.FLUX_HARNESS_LEGACY === '1'

  // Production config gate — test mode would bypass the 16ms throttle
  // (the measure-render-traffic lesson).
  enableConfigs()

  // typing-under-stream: the fast-tiny fixture + a live composer replica —
  // input value as ROOT state (REPL.tsx's inputValue shape: every keystroke
  // re-renders the whole tree), fed by the REAL input stack (raw-mode PTY →
  // parse-keypress → useInput). The parent injects glyphs via ptydrive.py
  // and times echo from its send log to the write tee.
  const typing = sceneName === 'typing-under-stream'
  const fixture = buildFixture(typing ? 'fast-tiny' : sceneName)

  const counters = {
    rootCommits: 0,
    tailCommits: 0,
    deltas: 0,
  }
  const sentinelEmit: Record<string, number> = {}
  let firstDeltaAt = 0

  // delta index → sentinels whose last char that delta carries
  const sentinelsByDelta = new Map<number, string[]>()
  {
    let off = 0
    const offsets: [string, number][] = []
    {
      let cursor = 0
      for (const [tok] of fixture.sentinels) {
        const at = fixture.fullText.indexOf(tok, cursor)
        if (at >= 0) {
          offsets.push([tok, at + tok.length])
          cursor = at + 1
        }
      }
    }
    fixture.deltas.forEach((d, i) => {
      if (d.text === null) return
      const end = off + d.text.length
      for (const [tok, tokEnd] of offsets) {
        if (tokEnd > off && tokEnd <= end) {
          const arr = sentinelsByDelta.get(i) ?? []
          arr.push(tok)
          sentinelsByDelta.set(i, arr)
        }
      }
      off = end
    })
  }

  type Driver = {
    onStreamingText: (f: (cur: string | null) => string | null) => void
    onStreamingToolUses: (
      f: (cur: StreamingToolUse[]) => StreamingToolUse[],
      opts?: { silent?: boolean; flushSilent?: boolean },
    ) => void
    appendMessage: (text: string) => void
  }
  let driver: Driver | null = null

  function Scene(): React.ReactNode {
    counters.rootCommits++
    const [tailStore] = useState(() => {
      const s = createStreamingTailStore()
      s.subscribe(() => {
        counters.tailCommits++
      })
      return s
    })
    const [streamingActive, setStreamingActive] = useState(false)
    const legacyTextRef = useRef<string | null>(null)
    const [legacyLines, setLegacyLines] = useState<string | null>(null)
    const [settled, setSettled] = useState<string | null>(null)
    const [toolUses, setToolUses] = useState<StreamingToolUse[]>([])
    const [typed, setTyped] = useState('')
    useInput(
      (input: string) => {
        if (input) setTyped(t => t + input)
      },
      { isActive: typing },
    )
    const batcher = useRef<InstanceType<typeof StreamBatcher<StreamingToolUse[]>> | null>(null)
    if (batcher.current === null) {
      batcher.current = new StreamBatcher<StreamingToolUse[]>([], {
        sink: value => setToolUses(prev => (prev === value ? prev : value)),
        flushNow: (prev, next) => prev.length !== next.length,
      })
    }
    const onStreamingText = useCallback((f: (cur: string | null) => string | null) => {
      if (legacy) {
        // pre-S2 wiring verbatim: complete-line prefix only, root state.
        const next = f(legacyTextRef.current)
        legacyTextRef.current = next
        const vis = next ? next.substring(0, next.lastIndexOf('\n') + 1) || null : null
        setLegacyLines(prev => {
          if (prev === vis) return prev
          counters.tailCommits++
          return vis
        })
        return
      }
      // REPL.tsx verbatim: store update + boundary-only boolean.
      tailStore.update(f)
      setStreamingActive(tailStore.read() !== null)
    }, [tailStore])
    const onStreamingToolUses = useCallback(
      (
        f: (cur: StreamingToolUse[]) => StreamingToolUse[],
        opts?: { silent?: boolean; flushSilent?: boolean },
      ) => {
        const b = batcher.current!
        if (opts?.silent) b.updateSilent(f)
        else b.update(f)
        if (opts?.flushSilent) b.flushSilent()
      },
      [],
    )
    driver = {
      onStreamingText,
      onStreamingToolUses,
      appendMessage: text => setSettled(text),
    }
    return (
      <Box flexDirection="column" width="100%">
        {Array.from({ length: 14 }, (_, i) => (
          <Text key={`t${i}`}>
            transcript row {i} — steady prose ballast that never changes
          </Text>
        ))}
        {settled !== null && <Markdown>{settled}</Markdown>}
        {toolUses.length > 0 && (
          <Box flexDirection="column">
            {toolUses.map(tu => (
              <Text key={tu.index} color="yellow">
                ◐ {tu.contentBlock.name}({tu.unparsedToolInput.length}b)
              </Text>
            ))}
          </Box>
        )}
        {legacy
          ? legacyLines !== null && (
              <Box marginTop={1} width="100%">
                <StreamingMarkdown>{legacyLines}</StreamingMarkdown>
              </Box>
            )
          : streamingActive && <LiveStreamingTail store={tailStore} />}
        <Box borderStyle="round" paddingX={1} marginTop={1}>
          <Text>{typing ? `> ${typed}` : '> composer at rest'}</Text>
        </Box>
      </Box>
    )
  }

  await render(
    <AppStateProvider>
      <Scene />
    </AppStateProvider>,
  )

  const streamEvent = (event: Record<string, unknown>) => ({ type: 'stream_event', event }) as never
  const dispatch = (frame: never) =>
    handleMessageFromStream(
      frame,
      m => {
        // real flow: append settles the full text as a message row
        const content = (m as { message?: { content?: { type: string; text?: string }[] } })
          .message?.content
        const text = content?.find(b => b.type === 'text')?.text ?? fixture.fullText
        driver!.appendMessage(text)
      },
      () => {},
      () => {},
      driver!.onStreamingToolUses,
      undefined,
      undefined,
      undefined,
      driver!.onStreamingText,
    )

  // Open the text block, then run the fixture schedule on real timers.
  dispatch(
    streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  )
  if (fixture.hasToolBlock) {
    dispatch(
      streamEvent({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_flux', name: 'Write', input: {} },
      }),
    )
  }

  const t0 = Date.now()
  firstDeltaAt = t0
  let dispatched = 0
  const total = fixture.deltas.length
  const debug = process.env.MEASURE_DEBUG
  fixture.deltas.forEach((d, i) => {
    setTimeout(() => {
      dispatched++
      if (d.text !== null) {
        counters.deltas++
        for (const tok of sentinelsByDelta.get(i) ?? []) sentinelEmit[tok] = Date.now()
        dispatch(
          streamEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: d.text },
          }),
        )
      } else {
        counters.deltas++
        dispatch(
          streamEvent({
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: d.toolJson ?? '' },
          }),
        )
      }
      if (dispatched === total) {
        // Stream end: block stops, then the settled assistant message —
        // streaming.ts clears text in the same fan-out call as the append.
        dispatch(streamEvent({ type: 'content_block_stop', index: 0 }))
        if (fixture.hasToolBlock) dispatch(streamEvent({ type: 'content_block_stop', index: 1 }))
        dispatch({
          type: 'assistant',
          message: { content: [{ type: 'text', text: fixture.fullText }] },
          uuid: 'flux-final',
        } as never)
        const endedAt = Date.now()
        // Let the final settle frame paint before reporting.
        setTimeout(() => {
          writeFileSync(
            outPath,
            JSON.stringify({
              startedAt: t0,
              endedAt,
              rootCommits: counters.rootCommits,
              tailCommits: counters.tailCommits,
              deltas: counters.deltas,
              sentinelEmit,
              fullTextTail: fixture.fullText.slice(-64),
              firstDeltaAt,
            }),
          )
          if (debug) appendFileSync(debug, `scene ${sceneName} done\n`)
          process.exit(0)
        }, 700)
      }
    }, d.atMs)
  })
}
