/**
 * Drives the REAL Pi agent loop with a scripted model.
 *
 * Pattern lifted from pi-mono's own `packages/agent/test/agent-loop.test.ts`:
 * `agentLoop(...)` takes an injectable `streamFn`, so no network or API key is
 * needed and nothing in Pi has to be patched.
 */

import { agentLoop } from "@earendil-works/pi-agent-core";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

export function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

/** A scripted assistant turn: tool call(s) in one message, or plain text. */
export type Turn =
	| { kind: "call"; calls: { id: string; name: string; args: Record<string, unknown> }[] }
	| { kind: "text"; text: string };

export function callRobot(id: string, args: Record<string, unknown>): Turn {
	return { kind: "call", calls: [{ id, name: "robot", args }] };
}

/** Emit several tool calls in a single assistant message (Pi runs these in parallel by default). */
export function callBatch(...calls: { id: string; name: string; args: Record<string, unknown> }[]): Turn {
	return { kind: "call", calls };
}

export function say(text: string): Turn {
	return { kind: "text", text };
}

export interface RunHandle {
	/** How many times the model was consulted. The gate assertion reads this. */
	llmCalls: () => number;
	events: AgentEvent[];
	/** Resolves when the loop finishes. */
	done: Promise<void>;
}

/**
 * Start the loop. Returns immediately so a test can inspect state while the
 * loop is parked inside a tool call.
 */
export function startLoop(
	tools: AgentTool<any, any> | AgentTool<any, any>[],
	script: Turn[],
	prompt = "do the thing",
): RunHandle {
	const toolList = Array.isArray(tools) ? tools : [tools];
	let calls = 0;
	const events: AgentEvent[] = [];

	const streamFn = () => {
		const stream = new MockAssistantStream();
		const index = calls;
		calls++;
		queueMicrotask(() => {
			const turn = script[index];
			if (!turn) {
				stream.push({ type: "done", reason: "stop", message: assistant([{ type: "text", text: "done" }], "stop") });
				return;
			}
			if (turn.kind === "call") {
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistant(
						turn.calls.map((c) => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: c.args })),
						"toolUse",
					),
				});
			} else {
				stream.push({ type: "done", reason: "stop", message: assistant([{ type: "text", text: turn.text }], "stop") });
			}
		});
		return stream;
	};

	const context: AgentContext = { systemPrompt: "", messages: [], tools: toolList };
	const config: AgentLoopConfig = {
		model: model(),
		convertToLlm: (messages: AgentMessage[]) =>
			messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[],
	};

	const done = (async () => {
		for await (const event of agentLoop([userMessage(prompt)], context, config, undefined, streamFn)) {
			events.push(event);
		}
	})();

	return { llmCalls: () => calls, events, done };
}

/** Structured details from every completed robot tool call, in order. */
export function robotResults(events: AgentEvent[]): any[] {
	return events
		.filter((e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end")
		.map((e) => (e.result as any)?.details)
		.filter(Boolean);
}

/** What the model actually read back from each robot call. */
export function robotTexts(events: AgentEvent[]): string[] {
	return events
		.filter((e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end")
		.map((e) => ((e.result as any)?.content ?? []).map((c: any) => c.text).join("\n"));
}

export const tick = () => new Promise((r) => setTimeout(r, 20));
