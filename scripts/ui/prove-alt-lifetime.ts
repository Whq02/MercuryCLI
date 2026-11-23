import { execFileSync } from 'node:child_process';

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};

const out = execFileSync(
  process.execPath.includes('bun') ? process.execPath : `${process.env.HOME}/.bun/bin/bun`,
  [
    '-e',
    `const m = await import('./src/screen/renderer/launcherAltHold.ts');
     console.log(JSON.stringify([m.launcherAltHoldPending(), m.consumeLauncherAltHold(), m.consumeLauncherAltHold(), process.env.MERCURY_ALT_HELD ?? null]));`,
  ],
  { encoding: 'utf8', env: { ...process.env, MERCURY_ALT_HELD: '1' } },
).trim();
check(
  'one-shot semantics: pending → consumed once → env deleted',
  out === '[true,true,false,null]',
  `${out} (expected [true,true,false,null]); to fix, make consumeLauncherAltHold in src/screen/renderer/launcherAltHold.ts return true once and delete MERCURY_ALT_HELD`,
);

process.exit(fail);
