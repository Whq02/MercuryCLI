// ============================================================================
//  scripts/critters/zzzFrames.ts — the SLEEP-FRAME composer shared by the
//  fixture generator (gen-zzz-frames.ts) and the sleep prover's byte A/B.
//
//  For a tree ROOT it composes, for every pool critter × form × state, the
//  exact frame the painter draws: the pure-transform grid (pose → blink →
//  breath → sway → content slice → sleep glyphs, at sway phase 0) and the
//  REAL render of CritterArt through the estate's static renderer, plain
//  and ANSI. Rooted imports so the SAME composer runs against a historical
//  checkout (the fixture's provenance) and the working tree (the prover):
//  the fixture is the pre-ladder bytes, and the prover proves the Zzz path
//  still produces them byte for byte.
// ============================================================================

export type ZzzFrame = {
  critter: string
  form: 'hero' | 'art' | 'mini'
  /** 'awake' or the sleep phase */
  state: 'awake' | 'z0' | 'z1' | 'z2'
  grid: string[]
  plain: string
  ansi: string
  /** The hex the sleep glyph paints in (cellColor of the sleep cell) — the
   *  colour half of the frame bytes, recorded because the static renderer
   *  emits no colour escapes on a non-TTY run. */
  zTint: string
}

export type ZzzFixture = {
  /** The git sha of the tree the fixture was composed from. */
  base: string
  composedBy: string
  frames: ZzzFrame[]
}

/** Compose every frame for the tree at `root`. The caller must have set the
 *  MACRO global and a sandboxed MERCURY_CONFIG_DIR before calling (the
 *  static renderer's theme reads go through the config gate, enabled here
 *  on the root's own module instance). */
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
        // The pure grid, mirroring CritterArt's transform order at sway phase 0.
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
        // Two-argument call: the pre-ladder signature had no count, the
        // ladder-era one defaults it to the Zzz's three — same bytes either way.
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
