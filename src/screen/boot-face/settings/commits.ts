import { menuRowChoices, saveBootDefaultsProfile, type MenuRow } from '../../../platform/substrate/startupMenu.js';
import { seatCostWarning, seatSourceWords, setOperatorSeats } from '../../../daemon/switchboard-capacity/capacityCheck.js';
import { MOTION_SETTINGS, motionReceiptWords, setMotionSetting, type MotionSetting } from '../../cockpit/motionSetting.js';
import { jevReceiptWords, setJevEnabled } from '../../../models/jev/jevSetting.js';
import { backgroundLaunchReceiptWords, setBackgroundSessionsLaunchCrewmates } from '../../../daemon/switchboard/backgroundLaunch.js';
import { getFocusedSessionConnector, hasFocusedSession } from '../../../engine/connector/focusedConnector.js';
import { spawnSwitchKindOfEnv, spawnSwitchOnFromValue } from '../../../daemon/switchboard/spawnSwitches.js';
import type { SettingsContext } from './context.js';

export function commitBackgroundLaunchOf(ctx: SettingsContext, next: boolean): string {
  const { setBackgroundLaunchTick, setLastReceipt } = ctx;
  const on = setBackgroundSessionsLaunchCrewmates(next);
  setBackgroundLaunchTick(n => n + 1);
  const words = backgroundLaunchReceiptWords(on);
  setLastReceipt(words);
  return words;
}

export function commitMotionOf(ctx: SettingsContext, next: MotionSetting): string {
  const { setLastReceipt, setMotionTick } = ctx;
  setMotionSetting(next);
  setMotionTick(n => n + 1);
  const words = motionReceiptWords(next);
  setLastReceipt(words);
  return words;
}

export function commitJevOf(ctx: SettingsContext, next: boolean): string {
  const { setJevTick, setLastReceipt } = ctx;
  const settings = setJevEnabled(next);
  setJevTick(n => n + 1);
  const words = jevReceiptWords(settings);
  setLastReceipt(words);
  return words;
}

export function commitSeatsOf(ctx: SettingsContext, next: number | null): string {
  const { setLastReceipt, setSeatFacts, setSeatsTick } = ctx;
  const facts = setOperatorSeats(next);
  setSeatFacts(facts);
  setSeatsTick(n => n + 1);
  const warning = seatCostWarning(facts);
  const words =
    next === null
      ? `seats follow ${seatSourceWords(facts.source)}: ${facts.seats} — applies to the next admission`
      : `seats ${facts.seats} · set by you — applies to the next admission${warning !== null ? ` · ${warning}` : ''}`;
  setLastReceipt(words);
  return words;
}

export function commitRowOf(ctx: SettingsContext, row: MenuRow, value: string | null): string {
  const { commitBackgroundLaunch, commitJev, commitMotion, commitSeats, isBackgroundLaunchRow, isJevRow, isMotionRow, isSeatsRow, liveCount, path, saved, setLastReceipt, setSaveTick } = ctx;
  if (isSeatsRow(row)) return commitSeats(value === null ? null : Number(value));
  if (isMotionRow(row)) return commitMotion(value === null ? 'auto' : (value as MotionSetting));
  if (isJevRow(row)) return commitJev(value === 'on');
  if (isBackgroundLaunchRow(row)) return commitBackgroundLaunch(value === 'on');
  const env: Record<string, string> = { ...saved };
  if (value === null) delete env[row.env];
  else env[row.env] = value;
  const res = saveBootDefaultsProfile(env, path, {
    ...(liveCount !== null ? { existingSessionsUnchanged: liveCount } : {}),
  });
  if (!res.ok) return `save refused — ${res.reason}`;
  setSaveTick(n => n + 1);
  setLastReceipt(`r${res.revision} · ${res.receipt}`);
  const kind = spawnSwitchKindOfEnv(row.env);
  if (row.applicationClass === 'live' && kind !== null && hasFocusedSession()) {
    void getFocusedSessionConnector()
      .setSpawnSwitch(kind, spawnSwitchOnFromValue(value))
      .then(receipt => setLastReceipt(`r${res.revision} · saved for new sessions · this session: ${receipt.detail ?? receipt.outcome}`));
  }
  return `r${res.revision} · ${res.receipt}`;
}

export function cycleRowOf(ctx: SettingsContext, row: MenuRow, direction: 1 | -1): string {
  const { backgroundLaunchOn, commitBackgroundLaunch, commitJev, commitMotion, commitRow, commitSeats, isBackgroundLaunchRow, isJevRow, isMotionRow, isSeatsRow, jevSettings, motionSetting, saved, seatFacts } = ctx;
  if (isSeatsRow(row)) return seatFacts === null ? 'capacity reading is pending — try again shortly' : commitSeats(direction > 0 ? seatFacts.seats + 1 : Math.max(1, seatFacts.seats - 1));
  if (isMotionRow(row)) {
    const at = MOTION_SETTINGS.indexOf(motionSetting);
    return commitMotion(MOTION_SETTINGS[((at < 0 ? 0 : at) + direction + MOTION_SETTINGS.length) % MOTION_SETTINGS.length]!);
  }
  if (isJevRow(row)) return commitJev(!jevSettings.enabled);
  if (isBackgroundLaunchRow(row)) return commitBackgroundLaunch(!backgroundLaunchOn);
  const choices = menuRowChoices(row);
  const currentValue = saved[row.env] ?? null;
  const idx = Math.max(0, choices.findIndex(c => c.value === currentValue));
  const next = choices[(idx + direction + choices.length) % choices.length]!;
  return commitRow(row, next.value);
}
