
export type ZzzFrame = {
  critter: string
  form: 'hero' | 'art' | 'mini'
  state: 'awake' | 'z0' | 'z1' | 'z2'
  grid: string[]
  plain: string
  ansi: string
  zTint: string
}

export type ZzzFixture = {
  base: string
  composedBy: string
  frames: ZzzFrame[]
}

export async function composeZzzFrames(root: string, critters?: readonly string[]): Promise<ZzzFrame[]> {
  const { enableConfigs } = await import(`${root}/src/utils/config/globalConfig.js`)
  enableConfigs()
  const React = (await import(`${root}/node_modules/react/index.js`)).default
  const cd = await import(`${root}/src/utils/cockpit/critterData.js`)
  const idle = await import(`${root}/src/utils/cockpit/critterIdle.js`)
  const { renderToString, renderToAnsiString } = await import(`${root}/src/utils/staticRender.tsx`)
  const { CritterArt } = await import(`${root}/src/components/mercury-ui/CritterArt.js`)

  const names: readonly string[] = critters ?? cd.CRITTERS.map((d: { name: string }) => d.name)
  const frames: ZzzFrame[] = []
  for (const name of names) {
    const def = cd.CRITTERS.find((d: { name: string }) => d.name === name)
    if (!def) continue
    for (const form of ['hero', 'art', 'mini'] as const) {
      const renderDef = form === 'mini' ? { ...def, art: cd.miniArtFor(def.name) } : def
      for (const state of ['awake', 'z0', 'z1', 'z2'] as const) {
        const asleep = state !== 'awake'
        const sleepPhase = asleep ? Number(state.slice(1)) : null
        const pose = asleep ? cd.sleepPoseFor(def, form) : null
        const flowDepth = pose ? pose.flow : cd.flowDepthFor(def, form)
        let grid: string[]
        if (form === 'hero') {
          const base: string[] = pose ? pose.art : def.heroArt
          const blinked = asleep ? cd.heroBlinkRows(base) : base
          const breathed = pose ? cd.sleepBreathArt(blinked, 0) : blinked
          const rows = cd.swayRows(breathed, flowDepth, 0)
          const [s, e] = cd.heroContentBounds(rows)
          grid = rows.map((r: string) => r.slice(s, e))
        } else {
          const base: string[] = pose ? pose.art : form === 'mini' ? cd.miniArtFor(def.name) : def.art
          const breathed = pose ? cd.sleepBreathArt(base, 0) : base
          grid = cd.swayRows(breathed, flowDepth, 0)
        }
        if (sleepPhase !== null) grid = cd.sleepZzzArt(grid, sleepPhase)
        const props: Record<string, unknown> = {
          def: renderDef,
          hero: form === 'hero',
          mini: form === 'mini',
          swayPhase: 0,
          ...(asleep ? { pupil: idle.EYE_SHUT, sleepPhase } : {}),
        }
        const plain: string = await renderToString(React.createElement(CritterArt, props), 60)
        const ansi: string = await renderToAnsiString(React.createElement(CritterArt, props), 60)
        frames.push({ critter: name, form, state, grid, plain, ansi, zTint: cd.cellColor(renderDef, cd.SLEEP_CELL) ?? '' })
      }
    }
  }
  return frames
}

export const ZZZ_FIXTURE_PATH = 'scripts/critters/fixtures/zzz-frames.json'
