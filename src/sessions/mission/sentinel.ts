export const MISSION_MET_SENTINEL = '<<<GOAL-MET>>>'

export function withoutMissionMetSentinel(text: string): string {
  if (!text.includes(MISSION_MET_SENTINEL)) return text
  const lines = text.split('\n')
  let end = lines.length
  while (end > 0 && lines[end - 1]!.trim() === '') end -= 1
  if (end === 0 || lines[end - 1]!.trim() !== MISSION_MET_SENTINEL) return text
  return lines.slice(0, end - 1).join('\n').replace(/\s+$/, '')
}
