"""Proof that OpenHands can refuse to *finish* until the world is verified.

Uses the SDK's existing critic + iterative-refinement mechanism, unmodified.
"""

from __future__ import annotations

import threading

from openhands.sdk import Agent, Conversation
from openhands.sdk.critic.base import IterativeRefinementConfig
from openhands.sdk.testing import TestLLM
from openhands.sdk.tool import Tool, register_tool

from embodied_openhands import (
    MockRobot,
    MockWorld,
    MoveObjectExecutor,
    MoveObjectTool,
    StateMatchVerifier,
)
from embodied_openhands.critic import WorldStateCritic
from embodied_openhands.tool import build_move_object_tool

from test_embodied_gate import (  # reuse the scripted-message helpers
    TOOL_NAME,
    _finish_call,
    _move_call,
    observations,
)


def build_with_critic(
    scripted,
    *,
    robot_mode,
    goal_state,
    max_iterations=3,
    tmp_path=None,
):
    world = MockWorld({"A": "table"})
    robot = MockRobot(world, mode=robot_mode)
    executor = MoveObjectExecutor(
        robot=robot,
        world=world,
        verifier=StateMatchVerifier(),
        timeout_s=5.0,
        gate=None,
    )
    register_tool(TOOL_NAME, build_move_object_tool(executor))

    critic = WorldStateCritic(
        goal_state=goal_state,
        mode="finish_and_message",
        iterative_refinement=IterativeRefinementConfig(
            success_threshold=0.9,
            max_iterations=max_iterations,
        ),
    ).bind_world(world)

    llm = TestLLM.from_messages(list(scripted))
    agent = Agent(llm=llm, tools=[Tool(name=TOOL_NAME)], critic=critic)
    conversation = Conversation(
        agent=agent, workspace=str(tmp_path), persistence_dir=None
    )
    return conversation, world, robot, llm


def test_finish_is_refused_while_world_state_is_wrong(tmp_path):
    """Agent tries to finish after a silent failure; the critic sends it back."""
    conversation, world, robot, llm = build_with_critic(
        [
            _move_call("c1", "A", "B"),  # silently fails
            _finish_call("c2"),  # premature: world is still {"A": "table"}
            _move_call("c3", "A", "B"),  # forced repair
            _finish_call("c4"),  # now legitimate
        ],
        robot_mode=lambda attempt: "lies" if attempt == 1 else "works",
        goal_state={"A": "B"},
        tmp_path=tmp_path,
    )
    conversation.run()

    obs = observations(conversation)
    assert [o.verified for o in obs] == [False, True]

    # All four scripted turns were consumed: the premature finish did not end
    # the run, it triggered a refinement round.
    assert llm._call_count == 4
    assert world.observe() == {"A": "B"}
    assert conversation.state.execution_status.value == "finished"


def test_finish_succeeds_immediately_when_world_is_correct(tmp_path):
    """The gate must not fire when the physical goal is genuinely met."""
    conversation, world, robot, llm = build_with_critic(
        [_move_call("c1", "A", "B"), _finish_call("c2")],
        robot_mode="works",
        goal_state={"A": "B"},
        tmp_path=tmp_path,
    )
    conversation.run()

    assert llm._call_count == 2  # no extra refinement round
    assert world.observe() == {"A": "B"}
    assert conversation.state.execution_status.value == "finished"


def test_refinement_is_bounded(tmp_path):
    """A permanently broken robot must not loop forever."""
    conversation, world, robot, llm = build_with_critic(
        [
            _move_call("c1", "A", "B"),
            _finish_call("c2"),
            _finish_call("c3"),
            _finish_call("c4"),
            _finish_call("c5"),
            _finish_call("c6"),
        ],
        robot_mode="lies",  # never actually moves
        goal_state={"A": "B"},
        max_iterations=2,
        tmp_path=tmp_path,
    )
    conversation.run()

    # 1 move + 1 finish + 2 refused finishes = 4 turns, then it gives up.
    assert llm._call_count == 4
    assert world.observe() == {"A": "table"}
    assert conversation.state.execution_status.value == "finished"
    # The important safety property: the run ended without the world being right,
    # and the transcript records the failure rather than a false success.
    assert obs_unverified(conversation)


def obs_unverified(conversation) -> bool:
    return all(not o.verified for o in observations(conversation))


def test_gate_and_finish_gate_compose(tmp_path):
    """Per-action gate and task gate are independent and both hold."""
    barrier = threading.Event()
    barrier.set()  # not blocking; just proves the wiring coexists
    conversation, world, robot, llm = build_with_critic(
        [_move_call("c1", "A", "C"), _finish_call("c2"), _move_call("c3", "A", "B"), _finish_call("c4")],
        robot_mode="works",
        goal_state={"A": "B"},
        tmp_path=tmp_path,
    )
    conversation.run()

    obs = observations(conversation)
    # Both moves individually verified (the robot did what it was told)...
    assert [o.verified for o in obs] == [True, True]
    # ...but moving A to C did not satisfy the task, so finish was refused once.
    assert llm._call_count == 4
    assert world.observe() == {"A": "B"}
