/**
 * The policy artifact — a stand-in for a compiled RoboOnto program.
 *
 * The only thing that matters architecturally at this stage: **each step
 * declares a postcondition (`expect`)**. That is the contract between the
 * language layer and the observation layer. Without it the verifier has no
 * spec to check against and you are back to asking the runtime whether it
 * succeeded.
 *
 * Note what is deliberately absent: nothing here names Nav2, a VLA, or a
 * dialogue model. A step names a *capability*; binding happens in the runtime.
 * That is the two-layer split — agent tools vs. policy capabilities.
 */

import type { JsonObject } from "./verifier.ts";

export interface PolicyStep {
	id: string;
	/** navigate | manipulate | perceive | dialogue | ... — bound at runtime. */
	capability: string;
	args: JsonObject;
	/** Postcondition. Empty object means "this step asserts nothing" (allowed, but visible). */
	expect: JsonObject;
	/**
	 * Whether re-running this step from scratch is safe.
	 * Non-idempotent steps are why `resume_from` exists.
	 */
	idempotent?: boolean;
}

export interface Policy {
	name: string;
	steps: PolicyStep[];
}

export function parsePolicy(source: string): Policy {
	const parsed = JSON.parse(source) as Policy;
	if (!parsed.name || !Array.isArray(parsed.steps)) {
		throw new Error("Invalid policy: expected { name, steps[] }");
	}
	for (const step of parsed.steps) {
		if (!step.id || !step.capability) {
			throw new Error(`Invalid policy step: every step needs { id, capability }`);
		}
		if (step.expect === undefined) {
			// Loud rather than silent: an unverifiable step is a design smell.
			throw new Error(
				`Policy step '${step.id}' declares no 'expect'. ` +
					`A step with no postcondition cannot be verified — declare {} to opt out explicitly.`,
			);
		}
	}
	return parsed;
}

/** Index of the step to start from, given a resume marker. */
export function resolveResumeIndex(policy: Policy, resumeFrom?: string): number {
	if (!resumeFrom) return 0;
	const index = policy.steps.findIndex((s) => s.id === resumeFrom);
	if (index < 0) {
		throw new Error(`Cannot resume: policy '${policy.name}' has no step '${resumeFrom}'`);
	}
	return index;
}
