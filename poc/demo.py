"""Runnable demo: the embodied loop catching a lying robot.

    python demo.py

No API key, no network, no robot. A scripted TestLLM drives the real OpenHands
agent loop against a fake world whose robot reports success without moving
anything.
"""

from __future__ import annotations

import json
import sys
import tempfile

from openhands.sdk import Agent, Conversation, Message, TextContent
from openhands.sdk.critic.base import IterativeRefinementConfig
from openhands.sdk.event import ActionEvent, MessageEvent, ObservationEvent
from openhands.sdk.llm import MessageToolCall
from openhands.sdk.testing import TestLLM
from openhands.sdk.tool import Tool, register_tool

from embodied_openhands import (
    MockRobot,
    MockWorld,
    MoveObjectExecutor,
    MoveObjectObservation,
    MoveObjectTool,
    StateMatchVerifier,
)
from embodied_openhands.critic import WorldStateCritic
from embodied_openhands.tool import build_move_object_tool


TOOL_NAME = MoveObjectTool.name


def call(call_id: str, name: str, args: dict) -> Message:
    return Message(
        role="assistant",
        content=[TextContent(text="")],
        tool_calls=[
            MessageToolCall(
                id=call_id,
                name=name,
                arguments=json.dumps(args),
                origin="completion",
            )
        ],
    )


def main() -> int:
    world = MockWorld({"A": "table"})
    # Attempt 1: the robot reports success but does not move the object.
    # Attempt 2: it actually works.
    robot = MockRobot(world, mode=lambda n: "lies" if n == 1 else "works")

    executor = MoveObjectExecutor(
        robot=robot,
        world=world,
        verifier=StateMatchVerifier(),
        timeout_s=5.0,
    )
    register_tool(TOOL_NAME, build_move_object_tool(executor))

    critic = WorldStateCritic(
        goal_state={"A": "B"},
        iterative_refinement=IterativeRefinementConfig(
            success_threshold=0.9, max_iterations=3
        ),
    ).bind_world(world)

    llm = TestLLM.from_messages(
        [
            call("c1", TOOL_NAME, {"object": "A", "destination": "B"}),
            call("c2", "finish", {"message": "Moved A to B."}),  # premature
            call("c3", TOOL_NAME, {"object": "A", "destination": "B"}),  # repair
            call("c4", "finish", {"message": "Verified: A is on B."}),
        ]
    )

    agent = Agent(llm=llm, tools=[Tool(name=TOOL_NAME)], critic=critic)

    with tempfile.TemporaryDirectory() as tmp:
        conversation = Conversation(agent=agent, workspace=tmp, persistence_dir=None)
        print(f"initial world state: {world.observe()}\n")
        conversation.send_message("Move object A onto B.")
        conversation.run()

        print("=" * 72)
        print("TRANSCRIPT")
        print("=" * 72)
        for event in conversation.state.events:
            if isinstance(event, ActionEvent):
                args = getattr(event.action, "model_dump", lambda: {})()
                print(f"\n[ACTION]      {event.tool_name} {args}")
            elif isinstance(event, ObservationEvent) and isinstance(
                event.observation, MoveObjectObservation
            ):
                obs = event.observation
                mark = "PASS" if obs.verified else "FAIL"
                print(f"[VERIFY {mark}]  {obs.reason_code}")
                for line in obs.to_llm_content[0].text.splitlines():
                    print(f"              {line}")
            elif isinstance(event, MessageEvent):
                role = event.llm_message.role
                text = " ".join(
                    c.text for c in event.llm_message.content if hasattr(c, "text")
                ).strip()
                if text and role == "user":
                    first = text.splitlines()[0]
                    print(f"\n[FEEDBACK]    {first}")

        print("\n" + "=" * 72)
        print(f"final world state:   {world.observe()}")
        print(f"robot actuations:    {robot.attempts}")
        print(f"LLM turns consumed:  {llm._call_count}")
        print(f"execution status:    {conversation.state.execution_status.value}")

    ok = world.observe() == {"A": "B"} and robot.attempts == 2
    print("\nRESULT:", "loop closed on physical ground truth" if ok else "UNEXPECTED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
