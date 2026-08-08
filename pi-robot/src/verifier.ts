/**
 * The verification boundary. Knows nothing about Pi, LLMs, or robots.
 *
 * The one rule that makes this worth having: **the verifier must not be the
 * thing that executed the action.** A policy runtime reporting its own success
 * is the `accepted: true` failure mode — the robot says it moved the cup, the
 * cup did not move. Same reason a test suite is not written by the code under
 * test.
 */

export type JsonObject = Record<string, unknown>;

/** Stable codes. Branch on these, never parse the prose. */
export const Reason = {
	OK: "OK",
	STATE_MISMATCH: "STATE_MISMATCH",
	LOW_CONFIDENCE: "LOW_CONFIDENCE",
	SENSOR_TIMEOUT: "SENSOR_TIMEOUT",
	VERIFIER_ERROR: "VERIFIER_ERROR",
	CAPABILITY_FAILED: "CAPABILITY_FAILED",
	ABORTED: "ABORTED",
} as const;
export type ReasonCode = (typeof Reason)[keyof typeof Reason];

/**
 * Three-valued on purpose.
 *
 * `unknown` is not a rounding error. After an e-stop or a sensor timeout the
 * world is in a state nobody observed. Collapsing that into either "verified"
 * or "failed" is how a robot ends up re-running a motion it already completed
 * halfway.
 */
export type Verdict = "verified" | "state_mismatch" | "unknown";

export interface VerificationResult {
	verdict: Verdict;
	/** Human-readable line handed to the model. */
	summary: string;
	/** Ground truth as observed, for replanning. */
	observedState: JsonObject;
	confidence?: number;
	reasonCode: ReasonCode;
}

/** What was asked of the physical world, plus what it should make true. */
export interface VerifiableStep {
	stepId: string;
	capability: string;
	args: JsonObject;
	/** Postcondition declared by the policy. Without this there is nothing to verify. */
	expect: JsonObject;
}

export interface RobotVerifier {
	verify(input: {
		step: VerifiableStep;
		capabilityResult: JsonObject;
		observedState: JsonObject;
	}): Promise<VerificationResult>;
}

/** Reference verifier: every key in `expect` must match what was observed. */
export class StateMatchVerifier implements RobotVerifier {
	constructor(private readonly minConfidence = 0) {}

	async verify(input: {
		step: VerifiableStep;
		capabilityResult: JsonObject;
		observedState: JsonObject;
	}): Promise<VerificationResult> {
		const { step, capabilityResult, observedState } = input;
		const confidence =
			typeof capabilityResult.confidence === "number" ? (capabilityResult.confidence as number) : undefined;

		const mismatches = Object.entries(step.expect).filter(
			([key, want]) => JSON.stringify(observedState[key]) !== JSON.stringify(want),
		);

		if (mismatches.length > 0) {
			const detail = mismatches
				.map(([k, want]) => `${k}: expected ${JSON.stringify(want)}, observed ${JSON.stringify(observedState[k])}`)
				.join("; ");
			return {
				verdict: "state_mismatch",
				summary: `Step '${step.stepId}' (${step.capability}) did not reach its declared postcondition. ${detail}.`,
				observedState,
				confidence,
				reasonCode: Reason.STATE_MISMATCH,
			};
		}

		// Matching state under untrustworthy perception is not a pass.
		if (confidence !== undefined && confidence < this.minConfidence) {
			return {
				verdict: "unknown",
				summary:
					`Step '${step.stepId}' (${step.capability}) appears to match its postcondition, but ` +
					`perception confidence ${confidence.toFixed(2)} is below the required ${this.minConfidence.toFixed(2)}. ` +
					`Treat the outcome as unknown.`,
				observedState,
				confidence,
				reasonCode: Reason.LOW_CONFIDENCE,
			};
		}

		return {
			verdict: "verified",
			summary: `Step '${step.stepId}' (${step.capability}) verified.`,
			observedState,
			confidence,
			reasonCode: Reason.OK,
		};
	}
}
