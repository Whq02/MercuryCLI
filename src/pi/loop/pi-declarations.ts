declare const STATIC: unique symbol;
type Schema<T = unknown> = { readonly [keyword: string]: unknown } & { readonly [STATIC]?: T };

export type Static<S> = S extends { readonly "~kind": unknown } | { readonly "~unsafe": unknown }
	? TypeBoxStatic<S>
	: S extends { readonly [STATIC]?: infer T }
		? unknown extends T
			? unknown
			: T
		: unknown;

type TypeBoxStatic<S> = S extends { readonly "~kind": infer K }
	? KindStatic<S, K>
	: S extends { readonly "~unsafe": infer T }
		? T
		: unknown;

interface Primitives {
	String: string;
	Number: number;
	Integer: number;
	Boolean: boolean;
	Null: null;
	BigInt: bigint;
	Undefined: undefined;
	Unknown: unknown;
	Any: any;
}

type KindStatic<S, K> = K extends keyof Primitives
	? Primitives[K]
	: K extends "Literal"
		? S extends { readonly const: infer V }
			? V
			: unknown
		: K extends "Array"
			? S extends { readonly items: infer I }
				? Static<I>[]
				: unknown
			: K extends "Object"
				? S extends { readonly properties: infer P }
					? ObjectStatic<P>
					: unknown
				: K extends "Union"
					? S extends { readonly anyOf: readonly (infer B)[] }
						? Static<B>
						: unknown
					: K extends "Record"
						? S extends { readonly patternProperties: infer P }
							? Record<RecordKey<keyof P>, Static<P[keyof P]>>
							: unknown
						: K extends "Enum"
							? S extends { readonly enum: readonly (infer V)[] }
								? V
								: unknown
							: K extends "Tuple"
								? S extends { readonly items: infer I extends readonly unknown[] }
									? { -readonly [N in keyof I]: Static<I[N]> }
									: unknown
								: unknown;

type Optional = { readonly "~optional": true };
type Readonly = { readonly "~readonly": true };

type ObjectStatic<P> = keyof P extends never
	? object
	: Simplify<
			{ -readonly [K in keyof P as P[K] extends Optional | Readonly ? never : K]: Static<P[K]> } & {
				-readonly [K in keyof P as P[K] extends Optional ? (P[K] extends Readonly ? never : K) : never]?: Static<
					P[K]
				>;
			} & {
				readonly [K in keyof P as P[K] extends Readonly ? (P[K] extends Optional ? never : K) : never]: Static<
					P[K]
				>;
			} & {
				readonly [K in keyof P as P[K] extends Optional ? (P[K] extends Readonly ? K : never) : never]?: Static<
					P[K]
				>;
			}
		>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type RecordKey<Pattern> = Pattern extends "^-?(?:0|[1-9][0-9]*)$" | "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$"
	? number
	: string;

type AttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

interface SpanAttributes {
	[name: string]: AttributeValue | undefined;
}

type TelemetryCarrier = Record<string, string>;

interface TelemetryPropagation {
	inject(context: TelemetryContext): TelemetryCarrier | undefined;
	extract(carrier: TelemetryCarrier | undefined): TelemetryContext;
}

interface SpanLink {
	context: TelemetryContext;
	attributes?: SpanAttributes;
}

interface SpanOptions {
	name: string;
	attributes?: SpanAttributes;
	links?: readonly SpanLink[];
}

type SpanStatus = { status: "ok" } | { status: "error"; error?: { name: string; message: string } };

interface TelemetryContext {
	readonly metrics?: TelemetryMetrics;
	readonly propagation?: TelemetryPropagation;
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}

interface TelemetrySpan extends TelemetryContext {
	addLink(link: SpanLink): void;
	addEvent(name: string, attributes?: SpanAttributes): void;
	setAttributes(attributes: SpanAttributes): void;
	setStatus(status: SpanStatus): void;
}

interface InstrumentOptions {
	description?: string;
	unit?: string;
}

interface HistogramOptions extends InstrumentOptions {
	boundaries?: readonly number[];
}

interface TelemetryCounter {
	add(value: number, attributes?: SpanAttributes): void;
}

interface TelemetryUpDownCounter {
	add(value: number, attributes?: SpanAttributes): void;
}

interface TelemetryHistogram {
	record(value: number, attributes?: SpanAttributes, context?: TelemetryContext): void;
}

interface TelemetryMetrics {
	counter(name: string, options?: InstrumentOptions): TelemetryCounter;
	upDownCounter(name: string, options?: InstrumentOptions): TelemetryUpDownCounter;
	histogram(name: string, options?: HistogramOptions): TelemetryHistogram;
}

declare const OpenAICompletionsCompatSchema: Schema<{
	supportsStore?: boolean | undefined;
	supportsDeveloperRole?: boolean | undefined;
	supportsReasoningEffort?: boolean | undefined;
	supportsUsageInStreaming?: boolean | undefined;
	supportsFinishReason?: boolean | undefined;
	maxTokensField?: "max_tokens" | "max_completion_tokens" | undefined;
	requiresToolResultName?: boolean | undefined;
	requiresAssistantAfterToolResult?: boolean | undefined;
	requiresNonNullAssistantContent?: boolean | undefined;
	requiresToolsWithToolHistory?: boolean | undefined;
	requiresThinkingAsText?: boolean | undefined;
	requiresReasoningContentOnAssistantMessages?: boolean | undefined;
	thinkingFormat?: "ant-ling" | "openai" | "deepseek" | "openrouter" | "zai" | "together" | "baseten" | "qwen" | "chat-template" | "qwen-chat-template" | "string-thinking" | undefined;
	chatTemplateKwargs?: Record<string, string | number | boolean | {
		$var: "thinking.enabled" | "thinking.effort" | "thinking.budget";
		omitWhenOff?: boolean | undefined;
	} | null> | undefined;
	chatTemplateArgs?: Record<string, string | number | boolean | {
		$var: "thinking.enabled" | "thinking.effort" | "thinking.budget";
		omitWhenOff?: boolean | undefined;
	} | null> | undefined;
	openRouterRouting?: {
		allow_fallbacks?: boolean | undefined;
		require_parameters?: boolean | undefined;
		data_collection?: "allow" | "deny" | undefined;
		zdr?: boolean | undefined;
		enforce_distillable_text?: boolean | undefined;
		order?: string[] | undefined;
		only?: string[] | undefined;
		ignore?: string[] | undefined;
		quantizations?: string[] | undefined;
		sort?: string | {
			by?: string | undefined;
			partition?: string | null | undefined;
		} | undefined;
		max_price?: {
			prompt?: string | number | undefined;
			completion?: string | number | undefined;
			image?: string | number | undefined;
			audio?: string | number | undefined;
			request?: string | number | undefined;
		} | undefined;
		preferred_min_throughput?: number | {
			p50?: number | undefined;
			p75?: number | undefined;
			p90?: number | undefined;
			p99?: number | undefined;
		} | undefined;
		preferred_max_latency?: number | {
			p50?: number | undefined;
			p75?: number | undefined;
			p90?: number | undefined;
			p99?: number | undefined;
		} | undefined;
	} | undefined;
	vercelGatewayRouting?: {
		only?: string[] | undefined;
		order?: string[] | undefined;
	} | undefined;
	zaiToolStream?: boolean | undefined;
	thinkingTokenBudgetField?: "thinking_token_budget" | "thinking_budget" | "thinking_budget_tokens" | undefined;
	supportsThinkingTokenBudget?: boolean | undefined;
	supportsOpenAIGrammarTools?: boolean | undefined;
	supportsMidConvoSystemMessages?: boolean | undefined;
	supportsMidConvoToolAdditions?: boolean | undefined;
	supportsStrictMode?: boolean | undefined;
	cacheControlFormat?: "anthropic" | undefined;
	sendSessionAffinityHeaders?: boolean | undefined;
	sessionAffinityFormat?: "openai" | "openrouter" | "openai-nosession" | undefined;
	promptCacheKeyMode?: "auto" | "enabled" | "disabled" | undefined;
	supportsLongCacheRetention?: boolean | undefined;
	vllmPriority?: number | undefined;
}>;

declare const OpenAIResponsesCompatSchema: Schema<{
	supportsDeveloperRole?: boolean | undefined;
	supportsMidConvoSystemMessages?: boolean | undefined;
	sessionAffinityFormat?: "openai" | "openrouter" | "openai-nosession" | undefined;
	promptCacheKeyMode?: "auto" | "enabled" | "disabled" | undefined;
	supportsLongCacheRetention?: boolean | undefined;
	supportsStrictMode?: boolean | undefined;
	supportsOpenAIGrammarTools?: boolean | undefined;
	supportsAdditionalTools?: boolean | undefined;
	supportsToolSearch?: boolean | undefined;
	supportsExplicitPromptCacheMode?: boolean | undefined;
	supportsMidConvoEffort?: boolean | undefined;
	supportsMaxOutputTokens?: boolean | undefined;
}>;

declare const AnthropicMessagesCompatSchema: Schema<{
	supportsEagerToolInputStreaming?: boolean | undefined;
	supportsLongCacheRetention?: boolean | undefined;
	sendSessionAffinityHeaders?: boolean | undefined;
	sessionAffinityFormat?: "openrouter" | undefined;
	supportsCacheControlOnTools?: boolean | undefined;
	supportsTemperature?: boolean | undefined;
	forceAdaptiveThinking?: boolean | undefined;
	allowEmptySignature?: boolean | undefined;
	supportsStrictTools?: boolean | undefined;
	supportsMidConvoEffort?: boolean | undefined;
	supportsMidConvoSystemMessages?: boolean | undefined;
	supportsMidConvoToolChanges?: boolean | undefined;
	supportsMessageThreads?: boolean | undefined;
	allowedFallbackModels?: {
		provider: string;
		model: string;
		cost: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			tiers?: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				inputTokensAbove: number;
			}[] | undefined;
		};
	}[] | undefined;
}>;

declare const BedrockCompatSchema: Schema<{
	supportsStrictMode?: boolean | undefined;
}>;

declare const MistralConversationsCompatSchema: Schema<{
	supportsMidConvoSystemMessages?: boolean | undefined;
	supportsStrictMode?: boolean | undefined;
}>;

interface OpenAICompletionsCompat extends Static<typeof OpenAICompletionsCompatSchema> {}
interface OpenAIResponsesCompat extends Static<typeof OpenAIResponsesCompatSchema> {}
interface AnthropicMessagesCompat extends Static<typeof AnthropicMessagesCompatSchema> {}
interface BedrockCompat extends Static<typeof BedrockCompatSchema> {}
interface MistralConversationsCompat extends Static<typeof MistralConversationsCompatSchema> {}

declare const ThinkingLevelSchema: Schema<"low" | "high" | "minimal" | "medium" | "xhigh" | "max">;
declare const ModelThinkingLevelSchema: Schema<"low" | "high" | "off" | "minimal" | "medium" | "xhigh" | "max">;
declare const ModelInputModalitySchema: Schema<"text" | "image">;
declare const CacheRetentionSchema: Schema<"short" | "long" | "none">;

declare const ThinkingLevelMapSchema: Schema<{
	off?: string | null | undefined;
	minimal?: string | null | undefined;
	low?: string | null | undefined;
	medium?: string | null | undefined;
	high?: string | null | undefined;
	xhigh?: string | null | undefined;
	max?: string | null | undefined;
}>;

declare const ModelPromptCacheSchema: Schema<{
	short?: number | undefined;
	long?: number | undefined;
}>;

declare const ModelCostSchema: Schema<{
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		inputTokensAbove: number;
	}[] | undefined;
}>;

declare const ModelInputLimitsSchema: Schema<{
	maxRequestBytes?: number | undefined;
	images?: {
		resize?: {
			maxWidth?: number | undefined;
			maxHeight?: number | undefined;
			maxBytes?: number | undefined;
			jpegQuality?: number | undefined;
		} | undefined;
		maxPerMessage?: number | undefined;
		maxPerRequest?: number | undefined;
	} | undefined;
}>;

type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
type ModelThinkingLevel = Static<typeof ModelThinkingLevelSchema>;
type ThinkingLevelMap = Static<typeof ThinkingLevelMapSchema>;
type ModelInputModality = Static<typeof ModelInputModalitySchema>;
type CacheRetention = Static<typeof CacheRetentionSchema>;
type ModelPromptCache = Static<typeof ModelPromptCacheSchema>;
type ModelCost = Static<typeof ModelCostSchema>;
type ModelInputLimits = Static<typeof ModelInputLimitsSchema>;

interface DiagnosticErrorInfo {
	name?: string;
	message: string;
	stack?: string;
	code?: string | number;
}

interface AssistantMessageDiagnostic {
	type: string;
	timestamp: number;
	error?: DiagnosticErrorInfo;
	details?: JsonObject;
}

type UserAgentMode = "short" | "detailed" | { custom: string };

interface ClientAttribution {
	name: string;
	url: string;
	categories?: string[];
}

export declare const PI_ATTRIBUTION: ClientAttribution;

export interface ClientIdentity {
	userAgent?: UserAgentMode;
	attribution?: ClientAttribution | null;
	version?: string;
}

export declare function mergeClientIdentity(...sources: (ClientIdentity | undefined)[]): ClientIdentity | undefined;

type KnownApi =
	| "openai-completions"
	| "mistral-conversations"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex"
	| "pi-messages";

export type Api = KnownApi | (string & {});

type KnownProvider =
	| "amazon-bedrock"
	| "ant-ling"
	| "anthropic"
	| "google"
	| "google-vertex"
	| "openai"
	| "azure"
	| "openai-codex"
	| "radius"
	| "typesafe"
	| "nvidia"
	| "deepseek"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "vercel-ai-gateway"
	| "zai"
	| "zai-coding-cn"
	| "mistral"
	| "minimax"
	| "minimax-cn"
	| "moonshotai"
	| "moonshotai-cn"
	| "huggingface"
	| "fireworks"
	| "together"
	| "baseten"
	| "opencode"
	| "opencode-go"
	| "kimi-coding"
	| "meta"
	| "cloudflare-workers-ai"
	| "cloudflare-ai-gateway"
	| "qwen-token-plan"
	| "qwen-token-plan-cn"
	| "qwen-token-plan-individual"
	| "qwen-token-plan-individual-cn"
	| "xiaomi"
	| "xiaomi-token-plan-cn"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-sgp";

type ProviderId = KnownProvider | string;
type ToolChoice = "auto" | "none";
type SamplingParams = Record<string, unknown>;
type SamplingParamsByThinkingLevel = Partial<Record<ModelThinkingLevel, SamplingParams>>;

export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
type ProviderEnv = Record<string, string>;
type ProviderHeaders = Record<string, string | null>;
type FetchFunction = typeof globalThis.fetch;

interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

interface ProviderRequestOptions<TModel = Model<Api>> {
	signal?: AbortSignal;
	telemetry?: TelemetrySpan;
	apiKey?: string;
	fetch?: FetchFunction;
	env?: ProviderEnv;
	onPayload?: (payload: unknown, model: TModel) => unknown | undefined | Promise<unknown | undefined>;
	onResponse?: (response: ProviderResponse, model: TModel) => void | Promise<void>;
	headers?: ProviderHeaders;
	identity?: ClientIdentity;
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
}

interface StreamOptions extends ProviderRequestOptions<Model<Api>> {
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	onProviderStreamEvent?: (data: unknown, model: Model<Api>) => void | Promise<void>;
	temperature?: number;
	samplingParams?: SamplingParams;
	maxTokens?: number;
	transport?: Transport;
	cacheRetention?: CacheRetention;
	sessionId?: string;
	disableContinuation?: boolean;
	websocketConnectTimeoutMs?: number;
	metadata?: Record<string, unknown>;
}

export interface SimpleStreamOptions extends StreamOptions {
	toolChoice?: ToolChoice;
	reasoning?: ThinkingLevel;
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
	thinkingBudgets?: ThinkingBudgets;
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	thoughtSignature?: string;
	namespace?: string;
	argumentsError?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
		totalFromProvider?: boolean;
	};
}

type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsExactlyJsonValue<T> = [T] extends [JsonValue] ? ([JsonValue] extends [T] ? true : false) : false;

type IsJsonProperty<T> = IsAny<T> extends true
	? false
	: unknown extends T
		? false
		: [Exclude<T, undefined>] extends [never]
			? true
			: IsJsonCompatible<Exclude<T, undefined>>;

type InvalidJsonKeys<T extends object> = {
	[TKey in keyof T]-?: TKey extends string | number ? (IsJsonProperty<T[TKey]> extends true ? never : TKey) : TKey;
}[keyof T];

type IsJsonCompatible<T> = IsAny<T> extends true
	? false
	: unknown extends T
		? false
		: IsExactlyJsonValue<T> extends true
			? true
			: T extends null | boolean | number | string
				? true
				: T extends undefined
					? false
					: T extends readonly (infer TItem)[]
						? IsJsonCompatible<TItem>
						: T extends (...args: never[]) => unknown
							? false
							: T extends object
								? [InvalidJsonKeys<T>] extends [never]
									? true
									: false
								: false;

type JsonRepresentation<T> = IsAny<T> extends true
	? JsonValue
	: unknown extends T
		? JsonValue
		: [T] extends [JsonValue]
			? T
			: T extends readonly unknown[]
				? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
				: T extends object
					? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
					: never;

interface DeferredHandle {
	provider: string;
	modelId: string;
	api: string;
	id: string;
	expiresAt?: number;
	pollAfterMs?: number;
	data?: JsonValue;
}

export interface SystemMessage {
	role: "system";
	content: string | TextContent[];
	sections?: Record<string, string | null>;
	toolsAdded?: Tool[];
	toolsRemoved?: ToolReference[];
	timestamp: number;
}

interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	responseModel?: string;
	responseId?: string;
	providerThinkingLevel?: string;
	thinkingLevel?: ModelThinkingLevel;
	diagnostics?: AssistantMessageDiagnostic[];
	usage: Usage;
	stopReason: StopReason;
	deferred?: DeferredHandle;
	errorMessage?: string;
	rawStopReason?: string;
	endTurn?: boolean;
	timestamp: number;
	durationMs?: number;
}

interface NestedToolCallRecord {
	id: string;
	name: string;
	arguments?: JsonObject;
	argumentsBytes?: number;
	status: "ok" | "error" | "unfinished";
	durationMs?: number;
	error?: string;
}

interface NestedToolCalls {
	calls: NestedToolCallRecord[];
	complete: boolean;
}

export type ToolResultMessage<TDetails = JsonValue> = IsJsonCompatible<TDetails> extends true
	? {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: (TextContent | ImageContent)[];
			details?: JsonRepresentation<TDetails>;
			usage?: Usage;
			nestedCalls?: NestedToolCalls;
			isError: boolean;
			timestamp: number;
			durationMs?: number;
		}
	: never;

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;
type GrammarFormat = "openai_lark" | "openai_regex";
type GrammarVariants = Partial<Record<GrammarFormat, string>>;

type ConstrainedSamplingConfig =
	| {
			type: "json_schema";
			strict: "prefer" | "require";
	  }
	| {
			type: "grammar";
			variants: GrammarVariants;
	  };

export interface Tool<TParameters extends object = object> {
	name: string;
	description: string;
	parameters: TParameters;
	constrainedSampling?: false | ConstrainedSamplingConfig;
}

interface ToolReference {
	name: string;
}

interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

declare const transcriptContextBrand: unique symbol;

export type TranscriptContext = {
	messages: Message[];
	readonly [transcriptContextBrand]: true;
};

export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
			message: AssistantMessage;
	  }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

interface BaseModel<TApi extends string> {
	id: string;
	name: string;
	api: TApi;
	provider: ProviderId;
	baseUrl: string;
	input: ModelInputModality[];
	inputLimits?: ModelInputLimits;
	cost: ModelCost;
	headers?: Record<string, string>;
}

export interface Model<TApi extends Api> extends BaseModel<TApi> {
	type?: "chat";
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	promptCache?: ModelPromptCache;
	contextWindow: number;
	maxTokens: number;
	samplingParams?: SamplingParams;
	samplingParamsByThinkingLevel?: SamplingParamsByThinkingLevel;
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: TApi extends "bedrock-converse-stream"
					? BedrockCompat
					: TApi extends "mistral-conversations"
						? MistralConversationsCompat
						: never;
}

export declare class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue;
	private waiting;
	protected done: boolean;
	private finalResultPromise;
	private resolveFinalResult;
	private isComplete;
	private extractResult;
	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R);
	push(event: T): void;
	end(result?: R): void;
	[Symbol.asyncIterator](): AsyncIterator<T>;
	result(): Promise<R>;
}

export declare class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	#private;
	constructor();
	push(event: AssistantMessageEvent): void;
	end(result?: AssistantMessage): void;
}

export declare function createInitialSystemMessage(systemPrompt: string | undefined, tools: Tool[] | undefined): SystemMessage | undefined;
export declare function normalizeContext(context: Context): TranscriptContext;
type TranscriptMessages = readonly { role: string }[];
export declare function getCurrentTools(messages: TranscriptMessages): Tool[];
export declare function getCurrentSystemMessage(messages: TranscriptMessages): SystemMessage | undefined;
export declare function getCurrentSystemPrompt(messages: TranscriptMessages): string;
export declare function toToolDeclaration(tool: Tool): Tool;

export interface ToolStateChanges {
	toolsAdded: Tool[];
	toolsRemoved: ToolReference[];
}

export declare function getToolStateChanges(previous: readonly Tool[], current: readonly Tool[]): ToolStateChanges;

export declare function validateToolArguments(tool: Tool, toolCall: ToolCall): any;
