import type { createEventMint, RunEvent } from "../../run-core/events.js";

type RunEventMint = ReturnType<typeof createEventMint>;

type RunTerminal = Extract<RunEvent, { kind: "run_terminal" }>["terminal"];

type TurnTransition = Extract<RunEvent, { kind: "turn_settled" }>["transition"];

type FollowingTurn<TTurn> = TTurn & { transition: TurnTransition };

type TurnOutcome<TTurn> =
	| { kind: "hand_over"; next: FollowingTurn<TTurn> }
	| { kind: "end"; terminal: RunTerminal };

interface AgentLoopConfig<TTurn> {
	emit: RunEventMint;
	querySource: string;
	agentId: string | undefined;
	firstTurn: TTurn;
	runTurn: (turn: TTurn, ordinal: number) => AsyncGenerator<RunEvent, TurnOutcome<TTurn>>;
}

export async function* runAgentLoop<TTurn>(config: AgentLoopConfig<TTurn>): AsyncGenerator<RunEvent, RunTerminal> {
	yield config.emit({ kind: "run_started", querySource: config.querySource, agentId: config.agentId });
	return yield* runLoop(config);
}

async function* runLoop<TTurn>(config: AgentLoopConfig<TTurn>): AsyncGenerator<RunEvent, RunTerminal> {
	let turn = config.firstTurn;

	for (let ordinal = 1; ; ordinal++) {
		const outcome = yield* config.runTurn(turn, ordinal);

		if (outcome.kind === "end") {
			yield config.emit({ kind: "run_terminal", terminal: outcome.terminal });
			return outcome.terminal;
		}

		yield config.emit({ kind: "turn_settled", transition: outcome.next.transition });
		turn = outcome.next;
	}
}
