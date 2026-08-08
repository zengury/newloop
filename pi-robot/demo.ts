/**
 * Runnable transcript: the embodied loop catching a lying capability, then
 * repairing via resume rather than repeating a motion that already happened.
 *
 *   npx tsx demo.ts     (or: npm run demo)
 *
 * No API key, no network, no robot.
 */

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { createRobotTool } from "./src/robot-tool.ts";
import { StateMatchVerifier } from "./src/verifier.ts";
import { MockCapabilityRegistry, MockWorld } from "./src/world.ts";
import { callRobot, robotResults, say, startLoop } from "./test/harness.ts";

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

async function main(): Promise<number> {
	const world = new MockWorld();

	// The grasp reports success without doing anything the first time.
	let grasps = 0;
	const capabilities = new MockCapabilityRegistry({
		manipulate: () => {
			grasps++;
			return grasps === 1 ? "lies" : "works";
		},
	});

	const tool = createRobotTool({
		world,
		capabilities,
		verifier: new StateMatchVerifier(),
		readArtifact: async () => FETCH_POLICY,
		stepTimeoutMs: 5000,
	});

	console.log(`initial world state: ${JSON.stringify(world.observe())}\n`);

	const run = startLoop(
		tool,
		[
			callRobot("c1", { operation: "run", artifact: "fetch_bottle.policy", target: "robot://R001" }),
			// Agent reads failed_at / resumable_from and repairs without re-navigating.
			callRobot("c2", {
				operation: "run",
				artifact: "fetch_bottle.policy",
				target: "robot://R001",
				resume_from: "s2_pick_bottle",
			}),
			say("Bottle is in hand, verified."),
		],
		"Fetch the bottle from the front desk.",
	);
	await run.done;

	console.log("=".repeat(72));
	console.log("TRANSCRIPT");
	console.log("=".repeat(72));

	for (const event of run.events as AgentEvent[]) {
		if (event.type === "tool_execution_start") {
			console.log(`\n[TOOL CALL]  ${event.toolName} ${JSON.stringify(event.args)}`);
		} else if (event.type === "tool_execution_update") {
			console.log(`[  progress]  ${(event.partialResult?.content ?? []).map((c: any) => c.text).join(" ")}`);
		} else if (event.type === "tool_execution_end") {
			const text = ((event.result as any)?.content ?? []).map((c: any) => c.text).join("\n");
			for (const line of text.split("\n")) console.log(`[   RESULT ]  ${line}`);
		}
	}

	const results = robotResults(run.events);
	console.log(`\n${"=".repeat(72)}`);
	console.log(`final world state:  ${JSON.stringify(world.observe())}`);
	console.log(`capability calls:   ${JSON.stringify(capabilities.invocations)}`);
	console.log(`LLM turns consumed: ${run.llmCalls()}`);

	const navigateCalls = capabilities.invocations.filter((i) => i.startsWith("navigate")).length;
	const ok =
		results.length === 2 &&
		results[0].verdict === "state_mismatch" &&
		results[1].verdict === "verified" &&
		world.observe().holding === "bottle" &&
		navigateCalls === 1;

	console.log(
		`\nRESULT: ${
			ok
				? "loop closed on physical ground truth; navigation was NOT repeated"
				: "UNEXPECTED — check the assertions above"
		}`,
	);
	return ok ? 0 : 1;
}

main().then((code) => process.exit(code));
