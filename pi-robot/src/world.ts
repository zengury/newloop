/**
 * Fake physical world + fake capability implementations.
 *
 * The capability table is the point of this file: `navigate` binds to a nav
 * stack, `manipulate` binds to a VLA, `dialogue` binds to a speech stack. The
 * policy never names any of them. Swapping Nav2 for something else is a change
 * here, not a change to the policy or the agent.
 */

import type { JsonObject } from "./verifier.ts";

export type CapabilityOutcome = {
	/** The capability's own claim about itself. UNTRUSTED. */
	ok: boolean;
	detail: string;
	confidence?: number;
};

/** A bound capability implementation: nav stack, VLA, dialogue model, ... */
export type CapabilityImpl = (args: JsonObject, world: MockWorld) => Promise<CapabilityOutcome>;

export class MockWorld {
	private state: JsonObject;

	constructor(initial: JsonObject = { robot_at: "start", holding: null, bottle_at: "front_desk" }) {
		this.state = { ...initial };
	}

	/** Stands in for perception / state estimation. */
	observe(): JsonObject {
		return { ...this.state };
	}

	set(key: string, value: unknown): void {
		this.state[key] = value;
	}
}

export type CapabilityMode = "works" | "fails" | "lies";

/**
 * Capability behaviour, selectable per capability name.
 *
 * "lies" is the case the whole harness exists for: the capability reports
 * success and the world does not change.
 */
export type CapabilityModes = Record<string, CapabilityMode | ((attempt: number) => CapabilityMode)>;

export class MockCapabilityRegistry {
	/** Per-capability attempt counters, so tests can script "fails once then works". */
	readonly attempts: Record<string, number> = {};
	/** Every capability actually invoked, in order. Lets tests assert no double-actuation. */
	readonly invocations: string[] = [];

	constructor(private readonly modes: CapabilityModes = {}) {}

	private modeFor(capability: string, attempt: number): CapabilityMode {
		const mode = this.modes[capability] ?? "works";
		return typeof mode === "function" ? mode(attempt) : mode;
	}

	/** The binding table. In a real system: Nav2, OpenVLA, π0.5, a TTS stack, ... */
	private readonly impls: Record<string, CapabilityImpl> = {
		navigate: async (args, world) => {
			world.set("robot_at", args.to);
			return { ok: true, detail: `navigated to ${String(args.to)}` };
		},
		manipulate: async (args, world) => {
			// A pick only succeeds if the object is where the robot is.
			if (args.action === "pick") {
				world.set("holding", args.object);
				world.set(`${String(args.object)}_at`, "held");
			} else if (args.action === "place") {
				world.set("holding", null);
				world.set(`${String(args.object)}_at`, args.to);
			}
			return { ok: true, detail: `${String(args.action)} ${String(args.object)}`, confidence: 0.95 };
		},
		perceive: async (_args, world) => {
			return { ok: true, detail: `scene observed: ${JSON.stringify(world.observe())}`, confidence: 0.9 };
		},
		dialogue: async (args) => {
			return { ok: true, detail: `said: ${String(args.message)}` };
		},
	};

	async invoke(capability: string, args: JsonObject, world: MockWorld): Promise<CapabilityOutcome> {
		const impl = this.impls[capability];
		if (!impl) {
			return { ok: false, detail: `no implementation bound for capability '${capability}'` };
		}

		this.attempts[capability] = (this.attempts[capability] ?? 0) + 1;
		const mode = this.modeFor(capability, this.attempts[capability]);
		this.invocations.push(`${capability}:${mode}`);

		if (mode === "fails") {
			return { ok: false, detail: `${capability} hardware error` };
		}
		if (mode === "lies") {
			// Report success, touch nothing. The exact failure an exit code cannot catch.
			return { ok: true, detail: `${capability} reported success`, confidence: 0.95 };
		}
		return impl(args, world);
	}
}
