import type { Attachment } from '../../src/utils/attachments/types.js'

export const capsuleFixtures: Record<string, Attachment[]> = {
  files: [
    { type: 'file', filename: '/proof/work.ts', displayPath: 'work.ts', content: { type: 'text', file: { filePath: '/proof/work.ts', content: 'export const answer = 42\n', numLines: 1, startLine: 1, totalLines: 1 } } },
    { type: 'edited_text_file', filename: '/proof/work.ts', snippet: '1  export const answer = 43' },
    { type: 'pdf_reference', filename: '/proof/manual.pdf', displayPath: 'manual.pdf', pageCount: 41, fileSize: 4200000 },
    { type: 'compact_file_reference', filename: '/proof/large.ts', displayPath: 'large.ts' },
  ],
  mentions: [
    { type: 'directory', path: '/proof/lib', displayPath: 'lib', content: 'one.ts\ntwo.ts' },
    { type: 'agent_mention', agentType: 'reviewer' },
    { type: 'mcp_resource', server: 'docs', uri: 'docs://guide', name: 'Guide', content: { contents: [{ uri: 'docs://guide', text: 'Guide revision 7: use stable names.' }] } },
  ],
  nestedMemory: [{ type: 'nested_memory', path: '/proof/MERCURY.md', displayPath: 'MERCURY.md', content: { path: '/proof/MERCURY.md', type: 'Project', content: 'Never change a public export. Run the nearest proof.' } }],
  skillListing: [{ type: 'skill_listing', content: '- review: Inspect the current diff.\n- verify: Check the stated contract.', skillCount: 2, isInitial: true, removedNames: ['retired-fixture-skill'], truncation: { budgetChars: 100, nameOnly: 1, withheld: 2 } }, { type: 'dynamic_skill', skillDir: '/proof/skills', skillNames: ['review'], displayPath: 'skills' }],
  taskStatus: [{ type: 'task_status', taskId: 'proof-task-17', taskType: 'local_agent', status: 'running', description: 'Inspect parser', deltaSummary: 'Found 3 callers', outputFilePath: '/proof/output.txt' }, { type: 'task_status', taskId: 'proof-task-18', taskType: 'local_bash', status: 'completed', description: 'Build parser', deltaSummary: '23 passed', outputFilePath: '/proof/build.log' }],
  diagnostics: [{ type: 'diagnostics', files: [{ uri: 'file:///proof/work.ts', diagnostics: [{ range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } }, severity: 1, message: 'Expected a number', source: 'proof', code: 17 }] }], isNew: true }],
  reminders: [{ type: 'task_reminder', content: [{ id: '41', subject: 'Preserve file facts', status: 'in_progress' }], itemCount: 1 }, { type: 'contract_reminder', text: 'Deliver the parser with its proofs.', status: 'amended', amendments: 2, ackOwed: true }],
} as unknown as Record<string, Attachment[]>
