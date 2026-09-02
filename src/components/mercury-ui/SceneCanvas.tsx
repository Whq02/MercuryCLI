import React from 'react';
import { Text } from '../../ink.js';
import { parseSplashRuns } from './splashRuns.js';

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
