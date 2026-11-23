export type CrashResumeStaged = {
  origin: string;
  component: string | null;
  message: string;
  sessionId: string;
  cwd: string | null;
  transcriptPath: string | undefined;
  moreCount: number;
};
