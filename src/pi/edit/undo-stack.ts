export class UndoStack<S> {
	private stack: S[] = [];

	push(state: S): void {
		this.stack.push(structuredClone(state));
	}

	pop(): S | undefined {
		return this.stack.pop();
	}

	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
