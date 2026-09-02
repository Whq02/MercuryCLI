import React from 'react';
import { Text } from '../../ink.js';
import { parseSplashRuns } from './splashRuns.js';

/**
 * SceneCanvas — the ONE composed-line → Ink re-emitter for the Boot scene
 * both the
 * Boot face (the original card) and the settings menu render
 * splash-core-composed lines through THIS helper. No per-cell background is
 * painted — the scene rides the flat estate ground exactly like the main
 * REPL. (The retired vignette's banding was two of our own constants
 * fighting: vignette cells painted #070D12 under an OSC-11 ground the
 * runtime re-asserts to NIGHT at handoff — one unpainted ground retires
 * the drift by construction.) A run's own explicit bg (rasterHard art
 * cells, the PLATE_TONE box plate) always wins.
 */
export function renderSceneLine(line: string, glow?: { label: string; color: string }): React.ReactNode {
  const runs = parseSplashRuns(line);
  const nodes: React.ReactNode[] = [];
  for (let k = 0; k < runs.length; k++) {
    const run = runs[k]!;
    const color = glow !== undefined && run.text.includes(glow.label) ? glow.color : run.fg;
    nodes.push(
      <Text key={k} color={color} backgroundColor={run.bg} bold={run.bold} dimColor={run.dim} underline={run.underline}>
        {run.text}
      </Text>,
    );
  }
  return <Text wrap="truncate-end">{nodes}</Text>;
}
