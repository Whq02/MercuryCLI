import { useRef, useState } from 'react';
import type { CrashResumeStaged } from './crashResume.js';

export function useChatCrashResume() {
  const [crashResumeStaged, setCrashResumeStaged] = useState<CrashResumeStaged | null>(null);
  const crashNoticeLatchedRef = useRef(false);
  return { crashResumeStaged, setCrashResumeStaged, crashNoticeLatchedRef };
}
