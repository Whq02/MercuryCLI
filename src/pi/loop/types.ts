import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	ImageContent,
	JsonValue,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	TranscriptContext,
	Usage,
} from "./pi-declarations.ts";
import type { Static } from "./pi-declarations.ts";

export type StreamFn = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export type ToolExecutionMode = "sequential" | "parallel";

export type QueueMode = "all" | "one-at-a-time";

export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
	terminate?: boolean;
}

export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	structuredContent?: JsonValue;
	isError?: boolean;
	usage?: Usage;
	terminate?: boolean;
}

export interface BeforeToolCallContext {
	assistantMessage: AssistantMessage;
	toolCall: AgentToolCall;
	args: unknown;
	context: AgentContext;
}

export interface AfterToolCallContext {
	assistantMessage: AssistantMessage;
	toolCall: AgentToolCall;
	args: unknown;
	result: AgentToolResult<any>;
	isError: boolean;
	context: AgentContext;
}

export interface AgentTurnContext {
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
	context: AgentContext;
	newMessages: AgentMessage[];
}

export type AgentTurnDecision = { action: "continue" } | { action: "end" };

export type FinishTurn = (
	turn: AgentTurnContext,
	signal?: AbortSignal,
) => AgentTurnDecision | void | Promise<AgentTurnDecision | undefined> | Promise<void>;

export interface AgentLoopTurnUpdate {
	context?: AgentContext;
	messages?: AgentMessage[];
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
}

export interface PrepareRequestContext {
	context: AgentContext;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
}

export type AgentRequestUpdate = Omit<AgentLoopTurnUpdate, "messages">;

export type PrepareRequest = (
	request: PrepareRequestContext,
	signal?: AbortSignal,
) => AgentRequestUpdate | void | Promise<AgentRequestUpdate | undefined> | Promise<void>;

export interface PrepareNextTurnContext extends AgentTurnContext {}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	finishTurn?: FinishTurn;

	prepareRequest?: PrepareRequest;

	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	getSteeringMessages?: () => Promise<AgentMessage[]>;

	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	toolExecution?: ToolExecutionMode;

	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface CustomAgentMessages {
}

export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

export interface AgentState {
	readonly systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	readonly isStreaming: boolean;
	readonly streamingMessage?: AgentMessage;
	readonly pendingToolCalls: ReadonlySet<string>;
	readonly errorMessage?: string;
}

export interface AgentToolResult<T = JsonValue | undefined> {
	content: (TextContent | ImageContent)[];
	details: T;
	structuredContent?: JsonValue;
	usage?: Usage;
	isError?: boolean;
	terminate?: boolean;
}

export interface AgentToolCallOutcome {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
	durationMs?: number;
}

export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

export type AgentToolParams<TParameters> = IsAny<TParameters> extends true ? any : Static<TParameters>;

type IsAny<T> = boolean extends (T extends never ? true : false) ? true : false;

export interface AgentTool<TParameters extends object = object, TDetails = any> extends Tool<TParameters> {
	label: string;
	prepareArguments?: (args: unknown) => AgentToolParams<TParameters>;
	outputSchema?: object;
	execute: (
		toolCallId: string,
		params: AgentToolParams<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	replay?: "never" | "safe";
	executionMode?: ToolExecutionMode;
}

export interface AgentContext {
	messages: AgentMessage[];
	tools?: AgentTool<any>[];
}

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: any;
			isError: boolean;
			durationMs?: number;
	  };
