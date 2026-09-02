// The Workflow tool's wire name — LIVE (: the old
// feature('WORKFLOW_SCRIPTS') gates died with the macro fold; the
// dynamic-workflow engine is default-ON and this constant is consumed
// unconditionally by the catalog, launch plans and permission decisions).
export const WORKFLOW_TOOL_NAME = 'Workflow' as const;
