/**
 * The `robot` tool — a fifth sibling to read/write/edit/bash.
 *
 * Design decisions this file encodes, in order of how easy they are to get wrong:
 *
 * 1. `executionMode: "sequential"`. Pi executes tool calls in PARALLEL by
 *    default (`executeToolCallsParallel`). Without this the model can fire
 *    `robot run` alongside a `bash`, or two `robot run`s at once.
 *
 * 2. `run` BLOCKS. That is where the gate comes from: Pi's loop awaits
 *    `executeToolCalls`, so the agent cannot take another turn until this
 *    resolves. The consequence is that the agent cannot call `robot status`
 *    mid-flight — it is blocked. Progress goes out through `onUpdate`
 *    (visibility), and stopping belongs to the human/safety layer (agency).
 *    Do not "fix" this by making run non-blocking; that is what removes the gate.
 *
 * 3. `policy_outcome` and `verdict` are SEPARATE fields. `completed` +
 *    `state_mismatch` is the robot-lied case and it must be expressible.
 *
 * 4. Verification is per-step, and the failing step id plus `resumable_from`
 *    come back in the result. A whole-policy pass/fail would force the agent to
 *    re-run physical steps that already happened.
 */

import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { type Policy, parsePolicy, resolveResumeIndex } from "./policy.ts";
import type { MockCapabilityRegistry, MockWorld } from "./world.ts";
import { type JsonObject, Reason, type ReasonCode, type RobotVerifier, type Verdict } from "./verifier.ts";

export const robotParams = Type.Object({
	operation: Type.Union([Type.Literal("run"), Type.Literal("observe")], {
		description: "run: execute a policy artifact. observe: snapshot current world state without acting.",
	}),
	artifact: Type.Optional(Type.String({ description: "Path of the policy artifact to run, e.g. 'get_water.policy'." })),
	target: Type.Optional(Type.String({ description: "Robot URI, e.g. 'robot://R001'." })),
	resume_from: Type.Optional(
		Type.String({ description: "Step id to resume from. Use after a partial failure to avoid repeating motions." }),
	),
	dry_run: Type.Optional(Type.Boolean({ description: "Execute against the simulator instead of hardware." })),
});

export type RobotParams = {
	operation: "run" | "observe";
	artifact?: string;
	target?: string;
	resume_from?: string;
	dry_run?: boolean;
};

export type PolicyOutcome = "completed" | "failed" | "aborted" | "unknown";

export interface StepReport {
	stepId: string;
	capability: string;
	verdict: Verdict;
	reasonCode: ReasonCode;
	summary: string;
	expected: JsonObject;
	observed: JsonObject;
	capabilityResult: JsonObject;
}

export interface RobotToolDetails {
	operation: "run" | "observe";
	artifact?: string;
	target?: string;
	/** Did the policy program run to the end? Says nothing about the world. */
	policy_outcome: PolicyOutcome;
	/** Did the world actually end up as declared? Independent of the above. */
	verdict: Verdict;
	reason_code: ReasonCode;
	failed_at?: string;
	/** Step to pass as `resume_from` on the repair attempt. */
	resumable_from?: string;
	entry_state: JsonObject;
	observed_state: JsonObject;
	steps: StepReport[];
}

export interface RobotToolOptions {
	world: MockWorld;
	capabilities: MockCapabilityRegistry;
	verifier: RobotVerifier;
	/** Reads a policy artifact by path. */
	readArtifact: (path: string) => Promise<string>;
	/** Per-step ceiling. Pi imposes none — a hung verifier would hang the session. */
	stepTimeoutMs?: number;
	/**
	 * Test seam standing in for sensor settling time. Awaited between actuation
	 * and observation, so a test can park the loop mid-transaction and prove
	 * the agent did not advance.
	 */
	settle?: () => Promise<void>;
}

class StepTimeout extends Error {}

async function withTimeout<T>(p: Promise<T>, ms: number | undefined, label: string): Promise<T> {
	if (!ms) return p;
	let handle: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			p,
			new Promise<never>((_, reject) => {
				handle = setTimeout(() => reject(new StepTimeout(`${label} exceeded ${ms}ms`)), ms);
			}),
		]);
	} finally {
		if (handle) clearTimeout(handle);
	}
}

function renderForModel(d: RobotToolDetails): string {
	if (d.operation === "observe") {
		return `world state: ${JSON.stringify(d.observed_state)}`;
	}

	const lines: string[] = [];
	// Verdict first. Reporting the runtime's own claim first invites the model
	// to trust it.
	lines.push(`verdict: ${d.verdict.toUpperCase()} (${d.reason_code})`);
	lines.push(`policy_outcome: ${d.policy_outcome}`);
	if (d.failed_at) lines.push(`failed_at: ${d.failed_at}`);
	lines.push(`entry world state:    ${JSON.stringify(d.entry_state)}`);
	lines.push(`observed world state: ${JSON.stringify(d.observed_state)}`);

	if (d.steps.length > 0) {
		lines.push("steps:");
		for (const s of d.steps) {
			const mark = s.verdict === "verified" ? "ok  " : s.verdict === "unknown" ? "?   " : "FAIL";
			lines.push(`  [${mark}] ${s.stepId} (${s.capability}) — ${s.summary}`);
		}
	}

	if (d.verdict === "state_mismatch") {
		lines.push(
			"The declared postcondition was NOT met. Do not assume the change happened. " +
				"Replan against the observed world state above.",
		);
	} else if (d.verdict === "unknown") {
		lines.push(
			"The physical outcome is UNKNOWN — the world was not successfully observed. " +
				"Do not assume either success or that nothing happened. Re-observe before acting.",
		);
	}

	if (d.resumable_from) {
		lines.push(
			`Steps before '${d.resumable_from}' already executed physically. ` +
				`To repair, fix the policy and re-run with resume_from='${d.resumable_from}' ` +
				`rather than repeating completed motions.`,
		);
	}
	return lines.join("\n");
}

export function createRobotTool(options: RobotToolOptions): AgentTool<typeof robotParams, RobotToolDetails> {
	const { world, capabilities, verifier, readArtifact, stepTimeoutMs, settle } = options;

	return {
		name: "robot",
		label: "Robot",
		// `executionMode` is load-bearing, not cosmetic. See header note 1.
		executionMode: "sequential",
		description: [
			"Run a robot policy artifact in the physical world, or observe world state.",
			"",
			"This is to the physical world what `bash` is to the computer: you author a policy",
			"with read/write/edit, then run it here. Unlike `bash`, a zero exit code proves nothing —",
			"the result carries an independently verified `verdict` alongside `policy_outcome`.",
			"",
			"`verdict: state_mismatch` means the world did not change as the policy declared,",
			"even if every capability reported success. `verdict: unknown` means nobody observed",
			"the outcome; treat it as neither success nor failure and re-observe.",
			"",
			"On partial failure, use `resume_from` to continue rather than repeating motions that",
			"already physically happened.",
		].join("\n"),
		parameters: robotParams,

		async execute(
			_toolCallId: string,
			params: RobotParams,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<RobotToolDetails>,
		): Promise<AgentToolResult<RobotToolDetails>> {
			const entryState = world.observe();

			if (params.operation === "observe") {
				const details: RobotToolDetails = {
					operation: "observe",
					policy_outcome: "completed",
					verdict: "verified",
					reason_code: Reason.OK,
					entry_state: entryState,
					observed_state: world.observe(),
					steps: [],
				};
				return { content: [{ type: "text", text: renderForModel(details) }], details };
			}

			if (!params.artifact) {
				throw new Error("robot run requires an 'artifact' (path to a policy file)");
			}

			let policy: Policy;
			let startIndex: number;
			try {
				policy = parsePolicy(await readArtifact(params.artifact));
				startIndex = resolveResumeIndex(policy, params.resume_from);
			} catch (err) {
				// Authoring errors are ordinary tool errors: nothing was actuated.
				throw new Error(`Cannot run '${params.artifact}': ${(err as Error).message}`);
			}

			const steps: StepReport[] = [];
			const base = (): RobotToolDetails => ({
				operation: "run",
				artifact: params.artifact,
				target: params.target,
				policy_outcome: "unknown",
				verdict: "unknown",
				reason_code: Reason.OK,
				entry_state: entryState,
				observed_state: world.observe(),
				steps: [...steps],
			});

			for (let i = startIndex; i < policy.steps.length; i++) {
				const step = policy.steps[i];

				if (signal?.aborted) {
					// An abort mid-policy leaves the world in a state nobody observed.
					// It is emphatically not a rollback.
					const d = base();
					d.policy_outcome = "aborted";
					d.verdict = "unknown";
					d.reason_code = Reason.ABORTED;
					d.failed_at = step.id;
					d.resumable_from = step.id;
					d.observed_state = world.observe();
					return { content: [{ type: "text", text: renderForModel(d) }], details: d };
				}

				let capabilityResult: JsonObject;
				let observed: JsonObject;
				try {
					const outcome = await withTimeout(
						capabilities.invoke(step.capability, step.args, world),
						stepTimeoutMs,
						`capability '${step.capability}'`,
					);
					capabilityResult = { ...outcome };

					if (settle) await withTimeout(settle(), stepTimeoutMs, "world observation");
					observed = world.observe();

					if (!outcome.ok) {
						// The capability admitted failure. Still report real state —
						// a failed motion can leave the world partially changed.
						const d = base();
						d.policy_outcome = "failed";
						d.verdict = "state_mismatch";
						d.reason_code = Reason.CAPABILITY_FAILED;
						d.failed_at = step.id;
						d.resumable_from = step.id;
						d.observed_state = observed;
						steps.push({
							stepId: step.id,
							capability: step.capability,
							verdict: "state_mismatch",
							reasonCode: Reason.CAPABILITY_FAILED,
							summary: `capability failed: ${outcome.detail}`,
							expected: step.expect,
							observed,
							capabilityResult,
						});
						d.steps = [...steps];
						return { content: [{ type: "text", text: renderForModel(d) }], details: d };
					}
				} catch (err) {
					// Timeout or thrown capability: fail closed, outcome unknown.
					const isTimeout = err instanceof StepTimeout;
					const d = base();
					d.policy_outcome = "unknown";
					d.verdict = "unknown";
					d.reason_code = isTimeout ? Reason.SENSOR_TIMEOUT : Reason.VERIFIER_ERROR;
					d.failed_at = step.id;
					d.resumable_from = step.id;
					d.observed_state = world.observe();
					steps.push({
						stepId: step.id,
						capability: step.capability,
						verdict: "unknown",
						reasonCode: d.reason_code,
						summary: `${isTimeout ? "timed out" : "errored"}: ${(err as Error).message}. Physical outcome unknown.`,
						expected: step.expect,
						observed: d.observed_state,
						capabilityResult: {},
					});
					d.steps = [...steps];
					return { content: [{ type: "text", text: renderForModel(d) }], details: d };
				}

				// Independent verification. Note this does not ask the capability
				// whether it worked — it compares the policy's declared postcondition
				// against an observation the capability did not produce.
				const verification = await verifier.verify({
					step: { stepId: step.id, capability: step.capability, args: step.args, expect: step.expect },
					capabilityResult,
					observedState: observed,
				});

				steps.push({
					stepId: step.id,
					capability: step.capability,
					verdict: verification.verdict,
					reasonCode: verification.reasonCode,
					summary: verification.summary,
					expected: step.expect,
					observed: verification.observedState,
					capabilityResult,
				});

				// Progress streams out without releasing the gate — the loop is still
				// awaiting this promise.
				onUpdate?.({ content: [{ type: "text", text: verification.summary }], details: base() });

				if (verification.verdict !== "verified") {
					const d = base();
					// The program ran fine; the world disagrees. Two different facts.
					d.policy_outcome = "completed";
					d.verdict = verification.verdict;
					d.reason_code = verification.reasonCode;
					d.failed_at = step.id;
					d.resumable_from = step.id;
					d.observed_state = verification.observedState;
					return { content: [{ type: "text", text: renderForModel(d) }], details: d };
				}
			}

			const done = base();
			done.policy_outcome = "completed";
			done.verdict = "verified";
			done.reason_code = Reason.OK;
			done.observed_state = world.observe();
			return { content: [{ type: "text", text: renderForModel(done) }], details: done };
		},
	};
}
