/**
 * The structured-output return tool's wire name — transcript contract data.
 * It lives in this leaf so the roster constants, the query engine, the agent
 * hook and the workflow structured-output tool read it without loading the
 * tool module: that module reaches, through the ink root and the tool
 * roster (ink → the paint engine → app state → permissions → api → tools →
 * AgentTool), the workflow structured-output tool, which reads the name
 * back at module level — a read that lands in the temporal dead zone (a
 * ReferenceError before initialization) whenever the ring is entered from
 * the roster constants.
 */
export const SYNTHETIC_OUTPUT_TOOL_NAME = 'StructuredOutput'
