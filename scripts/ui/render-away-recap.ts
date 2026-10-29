#!/usr/bin/env bun
process.env.NODE_ENV = 'test';
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '1.0.0',
  ISSUES_EXPLAINER: '',
  PACKAGE_URL: '',
  README_URL: '',
  IS_DEV: false,
  MERCURY_DEMO: false,
};

import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveProofHome } from '../lib/proofHome.ts';
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const SELF = fileURLToPath(import.meta.url);
const VSHOT = new URL('./vshot.py', import.meta.url).pathname;
const CONFIG_HOME = resolveProofHome([process.cwd()]);
const NOW = Date.parse('2026-01-01T12:00:00.000Z');

async function richLine(): Promise<string> {
  const { buildAwaySummary } = await import('../../src/utils/cockpit/awaySummary.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const A = (id: string, uses: Array<{ name: string; file?: string }>, err = false): any => ({
    type: 'assistant', uuid: id, timestamp: '2026-01-01T10:00:00.000Z',
    ...(err ? { isApiErrorMessage: true } : {}),
    message: { id, role: 'assistant', content: uses.map(u => ({ type: 'tool_use', id: u.name + id, name: u.name, input: u.file ? { file_path: u.file } : {} })) },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const U = (t: string): any => ({ type: 'user', uuid: 'u' + t, timestamp: '2026-01-01T09:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: t }] } });
  const msgs = [
    U('a'), A('1', [{ name: 'Edit', file: 'x.ts' }, { name: 'Read', file: 'y.ts' }]),
    U('b'), A('2', [{ name: 'Bash' }, { name: 'Edit', file: 'z.ts' }]),
    A('3', [{ name: 'Grep' }], true),
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return buildAwaySummary(msgs as any, NOW, { files: 5, added: 340, removed: 85 }) ?? '';
}

if (process.env.RECAP_RENDER_CHILD) {
  const React = await import('react');
  const { render, Text } = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Text: any;
  };
  const line = await richLine();
  void render(React.createElement(Text, { wrap: 'truncate' }, line));
  setTimeout(() => process.exit(0), 800);
} else {
  if (!existsSync(VSHOT)) {
    console.error(`vshot.py not found at ${VSHOT} — the render-verify harness (scripts/ui/vshot.py) is required.`);
    process.exit(1);
  }
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{FE0F}]/u;
  let failures = 0;
  const check = (label: string, cond: boolean, detail = ''): void => {
    if (!cond) failures++;
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  };
  const capture = (cols: number): string => {
    const cfg = `/tmp/vs-recap-${cols}.json`;
    writeFileSync(cfg, JSON.stringify({
      argv: [process.execPath, 'run', SELF],
      sends: [], total: 2, cols, rows: 4,
      out: `/tmp/recap-${cols}.html`,
      title: `away recap ${cols}`,
    }));
    return execFileSync('/usr/bin/python3', [VSHOT, cfg], {
      encoding: 'utf-8',
      timeout: vshotBudgetMs(30000),
      env: { ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME, RECAP_RENDER_CHILD: '1' },
    });
  };
  console.log('============================================================');
  console.log(' away-recap LINE-BUILDER render check (card path: resume-2turn scenario)');
  console.log('============================================================');
  for (const cols of [120, 80]) {
    const grid = capture(cols);
    const line = grid.split('\n').find(l => /Resumed/.test(l)) ?? '';
    console.log(`  recap @${cols}: ${line.trim().slice(0, 78) || '(none)'}`);
    check(`@${cols}: recap line present + leads with "Resumed"`, /Resumed/.test(grid));
    check(`@${cols}: the highest-signal error flag survives first`, /Resumed — prior run ended on an error/.test(grid));
    check(`@${cols}: NO emoji in the grid`, !EMOJI.test(grid));
  }
  {
    const full = capture(120);
    check('@120: full line shows turns + uncommitted + a tool', /turns/.test(full) && /uncommitted/.test(full) && /Edit/.test(full));
    const narrow = capture(80);
    const narrowLine = (narrow.split('\n').find(l => /Resumed/.test(l)) ?? '').replace(/\s+$/, '');
    check('@80: single truncated line, width-clamped (<= 80 cells)', narrowLine.length > 0 && narrowLine.length <= 80, `len=${narrowLine.length}`);
  }
  console.log('='.repeat(60));
  if (failures === 0) {
    console.log(' ✅ away-recap line renders @80 + @120');
    process.exit(0);
  }
  console.log(` ❌ away recap — ${failures} check(s) failed`);
  process.exit(1);
}
