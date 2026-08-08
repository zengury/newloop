/**
 * Proves the `robot` tool gates Pi's agent loop on physical ground truth.
 *
 * Everything runs against the real `agentLoop` from @earendil-works/pi-agent-core.
 * Nothing in Pi is patched or subclassed.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { beforeEach, describe, expect, it } from "vitest";
import { createRobotTool } from "../src/robot-tool.ts";
import { StateMatchVerifier } from "../src/verifier.ts";
import { type CapabilityModes, MockCapabilityRegistry, MockWorld } from "../src/world.ts";
import { callBatch, callRobot, robotResults, robotTexts, say, startLoop, tick } from "./harness.ts";

/** A two-step policy: go to the desk, pick up the bottle. */
const FETCH_POLICY = JSON.stringify({
	name: "fetch_bottle",
	steps: [
		{ id: "s1_goto_desk", capability: "navigate", args: { to: "front_desk" }, expect: { robot_at: "front_desk" } },
		{
			id: "s2_pick_bottle",
			capability: "manipulate",
			args: { action: "pick", object: "bottle" },
			expect: { holding: "bottle" },
			idempotent: false,
		},
	],
});

function build(opts: {
	modes?: CapabilityModes;
	settle?: () => Promise<void>;
	stepTimeoutMs?: number;
	minConfidence?: number;
	policy?: string;
}) {
	const world = new MockWorld();
	const capabilities = new MockCapabilityRegistry(opts.modes ?? {});
	const tool = createRobotTool({
		world,
		capabilities,
		verifier: new StateMatchVerifier(opts.minConfidence ?? 0),
		readArtifact: async () => opts.policy ?? FETCH_POLICY,
		settle: opts.settle,
		stepTimeoutMs: opts.stepTimeoutMs,
	});
	return { world, capabilities, tool };
}

describe("wiring", () => {
	it("declares sequential execution — Pi runs tool calls in parallel by default", () => {
		const { tool } = build({});
		// Without this the model could issue `robot run` concurrently with bash,
		// or two robot runs at once.
		expect(tool.executionMode).toBe("sequential");
	});

	it("Pi honours it: nothing else runs while a policy is executing", async () => {
		// Prove the flag has teeth rather than just asserting it is set.
		const marks: string[] = [];
		let releaseRobot!: () => void;
		const robotBlocked = new Promise<void>((r) => {
			releaseRobot = r;
		});

		const { tool } = build({
			settle: async () => {
				marks.push("robot:settle-start");
				await robotBlocked;
				marks.push("robot:settle-end");
			},
			stepTimeoutMs: 5000,
		});

		const probe: AgentTool<any, any> = {
			name: "probe",
			label: "Probe",
			description: "no-op",
			parameters: Type.Object({}),
			async execute() {
				marks.push("probe:ran");
				return { content: [{ type: "text", text: "probed" }], details: {} };
			},
		};

		// One assistant message emitting BOTH calls. Pi's default is parallel;
		// robot's executionMode="sequential" must force the whole batch serial.
		const run = startLoop(
			[tool, probe],
			[
				callBatch(
					{ id: "c1", name: "robot", args: { operation: "run", artifact: "fetch.policy" } },
					{ id: "c2", name: "probe", args: {} },
				),
				say("ok"),
			],
		);

		await tick();
		// robot is parked mid-transaction; probe must not have slipped past it.
		expect(marks).toEqual(["robot:settle-start"]);

		releaseRobot();
		await run.done;

		expect(marks[marks.length - 1]).toBe("probe:ran");
	});

	it("rejects a policy step that declares no postcondition", async () => {
		const { tool } = build({
			policy: JSON.stringify({ name: "bad", steps: [{ id: "s1", capability: "navigate", args: {} }] }),
		});
		await expect(
			tool.execute("t1", { operation: "run", artifact: "bad.policy" } as any, undefined, undefined),
		).rejects.toThrow(/declares no 'expect'/);
	});
});

describe("the gate holds", () => {
	it("agent takes no further turn while verification is outstanding", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((r) => {
			release = r;
		});

		const { tool, capabilities } = build({ settle: () => blocked, stepTimeoutMs: 5000 });
		const run = startLoop(tool, [callRobot("c1", { operation: "run", artifact: "fetch.policy" }), say("ok")]);

		await tick();

		// The first capability has actuated...
		expect(capabilities.invocations.length).toBe(1);
		// ...but no tool result exists yet, and the model has been consulted exactly once.
		expect(robotResults(run.events)).toHaveLength(0);
		expect(run.llmCalls()).toBe(1);

		release();
		await run.done;

		expect(robotResults(run.events)).toHaveLength(1);
		expect(run.llmCalls()).toBe(2);
	});

	it("a hung observation fails closed as unknown, not success", async () => {
		const { tool, capabilities } = build({
			settle: () => new Promise<void>(() => {}), // never resolves
			stepTimeoutMs: 100,
		});
		const run = startLoop(tool, [callRobot("c1", { operation: "run", artifact: "fetch.policy" }), say("ok")]);
		await run.done;

		const [d] = robotResults(run.events);
		expect(d.verdict).toBe("unknown");
		expect(d.reason_code).toBe("SENSOR_TIMEOUT");
		expect(d.policy_outcome).toBe("unknown");
		// No blind retry of a physical motion.
		expect(capabilities.invocations).toEqual(["navigate:works"]);
		expect(robotTexts(run.events)[0]).toContain("UNKNOWN");
	});
});

describe("the capability lies", () => {
	it("reports completed policy but a state_mismatch verdict", async () => {
		const { tool, world } = build({ modes: { navigate: "lies" } });
		const run = startLoop(tool, [callRobot("c1", { operation: "run", artifact: "fetch.policy" }), say("ok")]);
		await run.done;

		const [d] = robotResults(run.events);

		// The two fields disagree — which is the entire point of separating them.
		expect(d.policy_outcome).toBe("completed");
		expect(d.verdict).toBe("state_mismatch");
		expect(d.reason_code).toBe("STATE_MISMATCH");

		// The capability claimed success.
		expect(d.steps[0].capabilityResult.ok).toBe(true);
		// The world did not move.
		expect(world.observe().robot_at).toBe("start");

		const text = robotTexts(run.events)[0];
		expect(text).toContain("STATE_MISMATCH");
		expect(text).toContain('"robot_at":"start"');
		expect(text).toContain("was NOT met");
	});

	it("an admitted failure still reports real world state", async () => {
		const { tool } = build({ modes: { navigate: "fails" } });
		const run = startLoop(tool, [callRobot("c1", { operation: "run", artifact: "fetch.policy" }), say("ok")]);
		await run.done;

		const [d] = robotResults(run.events);
		expect(d.policy_outcome).toBe("failed");
		expect(d.reason_code).toBe("CAPABILITY_FAILED");
		expect(d.observed_state.robot_at).toBe("start");
	});

	it("matching state under low perception confidence is not a pass", async () => {
		const { tool } = build({ minConfidence: 0.99 });
		const run = startLoop(tool, [callRobot("c1", { operation: "run", artifact: "fetch.policy" }), say("ok")]);
		await run.done;

		const [d] = robotResults(run.events);
		// Step 2 (manipulate) reports confidence 0.95, below the 0.99 bar.
		expect(d.verdict).toBe("unknown");
		expect(d.reason_code).toBe("LOW_CONFIDENCE");
		expect(d.failed_at).toBe("s2_pick_bottle");
	});
});

describe("repair granularity", () => {
	it("pinpoints the failing step and offers a resume point", async () => {
		// Navigation works; the grasp silently fails.
		const { tool, world } = build({ modes: { manipulate: "lies" } });
		const run = startLoop(tool, [callRobot("c1", { operation: "run", artifact: "fetch.policy" }), say("ok")]);
		await run.done;

		const [d] = robotResults(run.events);
		expect(d.steps.map((s: any) => s.verdict)).toEqual(["verified", "state_mismatch"]);
		expect(d.failed_at).toBe("s2_pick_bottle");
		expect(d.resumable_from).toBe("s2_pick_bottle");

		// Step 1 really happened, so the agent must not redo it.
		expect(world.observe().robot_at).toBe("front_desk");
		expect(robotTexts(run.events)[0]).toContain("resume_from='s2_pick_bottle'");
	});

	it("resume_from skips completed steps instead of repeating motions", async () => {
		// Grasp lies the first time it is attempted, works the second.
		let graspAttempts = 0;
		const { tool, world, capabilities } = build({
			modes: {
				manipulate: () => {
					graspAttempts++;
					return graspAttempts === 1 ? "lies" : "works";
				},
			},
		});

		const run = startLoop(tool, [
			callRobot("c1", { operation: "run", artifact: "fetch.policy" }),
			// The agent reads failed_at / resumable_from and repairs without redoing navigation.
			callRobot("c2", { operation: "run", artifact: "fetch.policy", resume_from: "s2_pick_bottle" }),
			say("done"),
		]);
		await run.done;

		const [first, second] = robotResults(run.events);
		expect(first.verdict).toBe("state_mismatch");
		expect(second.verdict).toBe("verified");
		expect(second.policy_outcome).toBe("completed");

		// The decisive assertion: navigate ran ONCE across both attempts.
		expect(capabilities.invocations.filter((i) => i.startsWith("navigate"))).toHaveLength(1);
		expect(capabilities.invocations.filter((i) => i.startsWith("manipulate"))).toHaveLength(2);
		expect(world.observe().holding).toBe("bottle");
	});
});

describe("progress streaming", () => {
	it("streams per-step updates without releasing the gate", async () => {
		const { tool } = build({});
		const run = startLoop(tool, [callRobot("c1", { operation: "run", artifact: "fetch.policy" }), say("ok")]);
		await run.done;

		const updates = run.events.filter((e) => e.type === "tool_execution_update");
		// One per verified step — visibility during a long physical action...
		expect(updates.length).toBe(2);
		// ...while the model was still consulted only twice (call + wrap-up),
		// i.e. the updates did not let it act early.
		expect(run.llmCalls()).toBe(2);
	});
});

describe("happy path", () => {
	let result: any;
	let world: MockWorld;

	beforeEach(async () => {
		const built = build({});
		world = built.world;
		const run = startLoop(built.tool, [callRobot("c1", { operation: "run", artifact: "fetch.policy" }), say("ok")]);
		await run.done;
		result = robotResults(run.events)[0];
	});

	it("verifies every step and reports entry and exit state", () => {
		expect(result.policy_outcome).toBe("completed");
		expect(result.verdict).toBe("verified");
		expect(result.steps.every((s: any) => s.verdict === "verified")).toBe(true);
		expect(result.entry_state.robot_at).toBe("start");
		expect(result.observed_state.robot_at).toBe("front_desk");
		expect(result.resumable_from).toBeUndefined();
		expect(world.observe().holding).toBe("bottle");
	});
});
