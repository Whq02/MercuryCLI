export interface ProfileFrame {
  function: string
  file: string
  line: number | null
  column: number | null
  module: string
  display?: string
}

export interface ProfileNode {
  id: number
  frame: ProfileFrame
  children: number[]
  self: number
  hits: number
  thread: string
}

export interface ProfileReading {
  format: 'V8' | 'macOS sample'
  unit: 'ms' | 'samples'
  duration: number | null
  samples: number
  weighting: string
  nodes: Map<number, ProfileNode>
  quality: Set<string>
}

export interface ProfileHotspot {
  frame: ProfileFrame
  self: number
  inclusive: number
}

export const profileNumber = (value: number): string => Number(value.toFixed(6)).toString()
export const frameKey = (frame: ProfileFrame): string => JSON.stringify([frame.function, frame.file, frame.line, frame.column, frame.module])
const synthetic = (node: ProfileNode): boolean => node.frame.function === '(root)' || node.frame.function === '(program)'
const waiting = (node: ProfileNode): boolean => node.frame.function === '(idle)' || /^(?:__?|[A-Za-z0-9_]*::)*(?:mach_msg(?:2)?_trap|mach_msg2_internal|mach_msg|__psynch_cvwait|__psynch_mutexwait|semaphore_wait_trap|kevent|kevent64|poll|select|pthread_cond_wait|pthread_cond_timedwait|__ulock_wait|__ulock_wait2|nanosleep|__workq_kernreturn)$/.test(node.frame.function)

export function summarizeProfile(reading: ProfileReading) {
  const { nodes, quality } = reading
  const parents = new Map<number, number>()
  for (const node of nodes.values()) {
    for (const child of node.children) {
      if (!nodes.has(child)) quality.add('Missing child references were ignored.')
      else if (parents.has(child) && parents.get(child) !== node.id) quality.add('Frames with multiple parents use the first recorded parent.')
      else parents.set(child, node.id)
    }
  }
  const hotspots = new Map<string, ProfileHotspot>()
  const paths = new Map<string, number>()
  const threads = new Map<string, { active: number; wait: number; waits: Map<string, number> }>()
  let cpu = 0, idle = 0
  for (const leaf of nodes.values()) {
    if (leaf.self <= 0) continue
    const blocked = waiting(leaf)
    if (blocked) idle += leaf.self
    else cpu += leaf.self
    const thread = threads.get(leaf.thread) ?? { active: 0, wait: 0, waits: new Map<string, number>() }
    threads.set(leaf.thread, thread)
    if (blocked) {
      thread.wait += leaf.self
      thread.waits.set(leaf.frame.function, (thread.waits.get(leaf.frame.function) ?? 0) + leaf.self)
    } else thread.active += leaf.self
    if (blocked) continue
    const seenNodes = new Set<number>()
    const seenFrames = new Set<string>()
    const chain: string[] = []
    let next: ProfileNode | undefined = leaf
    while (next !== undefined) {
      if (seenNodes.has(next.id)) { quality.add('Cycles were cut at the first repeated frame; inclusive paths are incomplete.'); break }
      seenNodes.add(next.id)
      if (!synthetic(next)) {
        const key = frameKey(next.frame)
        const hot = hotspots.get(key) ?? { frame: next.frame, self: 0, inclusive: 0 }
        hotspots.set(key, hot)
        if (!seenFrames.has(key)) hot.inclusive += leaf.self
        if (next === leaf) hot.self += leaf.self
        seenFrames.add(key)
        const name = next.frame.display ?? next.frame.function
        if (chain[chain.length - 1] !== name) chain.push(name)
      }
      next = nodes.get(parents.get(next.id) ?? NaN)
    }
    const path = `${leaf.thread ? `${leaf.thread}: ` : ''}${chain.reverse().join(' → ')}`
    paths.set(path, (paths.get(path) ?? 0) + leaf.self)
  }
  return { hotspots, paths, threads, cpu, idle }
}

export function profileRows(reading: ProfileReading, summary = summarizeProfile(reading)): string[] {
  const rows: string[] = []
  for (const [thread, time] of summary.threads) {
    if (!thread) continue
    const wait = [...time.waits].sort((a, b) => b[1] - a[1])[0]
    rows.push(`thread: ${thread} · ${time.active > 0 ? 'active' : 'waiting'} · active=${profileNumber(time.active)} ${reading.unit} · wait=${profileNumber(time.wait)} ${reading.unit}${wait ? ` · dominant wait=${wait[0]}` : ''}`)
  }
  const ranked = [...summary.hotspots.values()].sort((a, b) => b.self - a.self || b.inclusive - a.inclusive || frameKey(a.frame).localeCompare(frameKey(b.frame)))
  for (const hot of ranked) {
    const frame = hot.frame
    rows.push(`self=${profileNumber(hot.self)} ${reading.unit} · inclusive=${profileNumber(hot.inclusive)} ${reading.unit} · CPU-share=${profileNumber(summary.cpu ? hot.self / summary.cpu * 100 : 0)}% · function=${JSON.stringify(frame.function)}${frame.display && frame.display !== frame.function ? ` · display=${JSON.stringify(frame.display)}` : ''} · file=${JSON.stringify(frame.file)} · line=${frame.line ?? 'unresolved'} · column=${frame.column ?? 'unresolved'} · module=${JSON.stringify(frame.module)}${frame.file && frame.line !== null ? ` · source: Read(file_path: ${JSON.stringify(frame.file)}, offset: ${frame.line}, limit: 1)` : ' · source: unresolved'}`)
  }
  for (const [chain, weight] of [...summary.paths].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) rows.push(`hot path: ${chain} · self contributions=${profileNumber(weight)} ${reading.unit}`)
  return rows
}
