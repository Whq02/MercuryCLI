import { wrapText } from '../../themedRenderer.js';
import { jevKeyPresence, jevKeySourceWords } from '../../../models/jev/jevKey.js';
import { jevSettingLines, readJevSettings } from '../../../models/jev/jevSetting.js';
import { jevStatusLine } from '../../../models/jev/jevStatus.js';
import { backgroundLaunchDetailLines } from '../../../daemon/switchboard/backgroundLaunch.js';

export const JEV_BOOT_DETAIL_WIDTH = 41;

function bootDetailLines(facts: readonly string[]): string[] {
  return facts.flatMap(line => wrapText(line, JEV_BOOT_DETAIL_WIDTH, 'wrap').split('\n'));
}

export function jevBootDetailLines(): string[] {
  const settings = readJevSettings();
  return bootDetailLines([jevStatusLine(), jevKeySourceWords(jevKeyPresence()), ...jevSettingLines(settings)]);
}

export function backgroundLaunchBootDetailLines(on: boolean): string[] {
  return bootDetailLines(backgroundLaunchDetailLines(on));
}
