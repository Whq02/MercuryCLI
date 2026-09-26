export type GrowthPoint = { size: number; ms: number }

export type GrowthStep = { from: GrowthPoint; to: GrowthPoint; factor: number; allowed: number }

export type GrowthReport = { linear: boolean; points: GrowthPoint[]; steps: GrowthStep[]; summary: string }

export type GrowthOptions = { repetitions?: number; budgetMs?: number; margin?: number; slackMs?: number; attempts?: number }

export const GROWTH_REPETITIONS = 3
export const GROWTH_BUDGET_MS = 100
export const GROWTH_MARGIN = 1.25
export const GROWTH_SLACK_MS = 1
export const GROWTH_ATTEMPTS = 3

function settle(options: GrowthOptions): Required<GrowthOptions> {
  return {
    repetitions: options.repetitions ?? GROWTH_REPETITIONS,
    budgetMs: options.budgetMs ?? GROWTH_BUDGET_MS,
    margin: options.margin ?? GROWTH_MARGIN,
    slackMs: options.slackMs ?? GROWTH_SLACK_MS,
    attempts: options.attempts ?? GROWTH_ATTEMPTS,
  }
}

function sizeLabel(size: number): string {
  if (size >= 1000 && size % 1000 === 0) return `${size / 1000}k`
  if (size >= 1000 && size % 100 === 0) return `${(size / 1000).toFixed(1)}k`
  return String(size)
}

export function judgeGrowth(points: readonly GrowthPoint[], options: GrowthOptions = {}): GrowthReport {
  const { margin, slackMs } = settle(options)
  const steps: GrowthStep[] = []
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]!
    const to = points[i]!
    const ratio = to.size / from.size
    const allowed = ratio * margin
    const factor = from.ms > 0 ? to.ms / from.ms : to.ms > slackMs ? Number.POSITIVE_INFINITY : 1
    steps.push({ from, to, factor, allowed })
  }
  const linear = steps.every(step => step.to.ms <= step.from.ms * step.allowed + slackMs)
  const times = points.map(p => `${sizeLabel(p.size)}: ${p.ms.toFixed(1)}ms`).join(', ')
  const factors = steps.map(step => `${Number.isFinite(step.factor) ? step.factor.toFixed(2) : 'inf'}x (allowed ${step.allowed.toFixed(1)}x + ${slackMs}ms)`).join(', ')
  return { linear, points: [...points], steps, summary: `${times}; a step of ${steps.map(s => `${(s.to.size / s.from.size).toFixed(0)}x`).join('/')} in size costs ${factors}` }
}

function sample(run: (size: number) => void, sizes: readonly number[], settled: Required<GrowthOptions>): GrowthPoint[] {
  const best = new Map<number, number>()
  let spent = 0
  for (let round = 0; round < settled.repetitions && (round === 0 || spent < settled.budgetMs); round++) {
    for (const size of sizes) {
      const t0 = performance.now()
      run(size)
      const ms = performance.now() - t0
      spent += ms
      const seen = best.get(size)
      if (seen === undefined || ms < seen) best.set(size, ms)
    }
  }
  return sizes.map(size => ({ size, ms: best.get(size) ?? 0 }))
}

async function sampleAsync(run: (size: number) => Promise<void>, sizes: readonly number[], settled: Required<GrowthOptions>): Promise<GrowthPoint[]> {
  const best = new Map<number, number>()
  let spent = 0
  for (let round = 0; round < settled.repetitions && (round === 0 || spent < settled.budgetMs); round++) {
    for (const size of sizes) {
      const t0 = performance.now()
      await run(size)
      const ms = performance.now() - t0
      spent += ms
      const seen = best.get(size)
      if (seen === undefined || ms < seen) best.set(size, ms)
    }
  }
  return sizes.map(size => ({ size, ms: best.get(size) ?? 0 }))
}

export function measureGrowth(run: (size: number) => void, sizes: readonly number[], options: GrowthOptions = {}): GrowthReport {
  const settled = settle(options)
  let report = judgeGrowth(sample(run, sizes, settled), settled)
  for (let attempt = 1; attempt < settled.attempts && !report.linear; attempt++) {
    report = judgeGrowth(sample(run, sizes, settled), settled)
  }
  return report
}

export async function measureGrowthAsync(run: (size: number) => Promise<void>, sizes: readonly number[], options: GrowthOptions = {}): Promise<GrowthReport> {
  const settled = settle(options)
  let report = judgeGrowth(await sampleAsync(run, sizes, settled), settled)
  for (let attempt = 1; attempt < settled.attempts && !report.linear; attempt++) {
    report = judgeGrowth(await sampleAsync(run, sizes, settled), settled)
  }
  return report
}
