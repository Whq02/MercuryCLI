import { useRef, useState } from 'react';
import type { CrashResumeStaged } from './crashResume.js';

export const loadHopIntoSession = () => import('../../services/switchboard/hopIntoSession.js');
export const loadEnsureDaemon = () => import('../../services/switchboard/ensureDaemon.js');
export const loadContextWindowWarmup = () => import('../../utils/model/contextWindowWarmup.js');
export const loadDaemonHandshake = () => import('../../daemon/handshake.js');
export const loadProjectSnapshot = () => import('../../services/projectIntel/snapshot.js');

export function useChatCrashResume() {
  const [crashResumeStaged, setCrashResumeStaged] = useState<CrashResumeStaged | null>(null);
  const crashNoticeLatchedRef = useRef(false);
  return { crashResumeStaged, setCrashResumeStaged, crashNoticeLatchedRef };
}
