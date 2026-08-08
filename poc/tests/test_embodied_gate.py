"""Proof that OpenHands cannot advance past an unverified physical action.

Every test here runs the real `openhands.sdk` agent loop (real Conversation,
real Agent, real tool dispatch) against a scripted `TestLLM` and a fake world.
Nothing in the SDK is patched or subclassed.
"""

from __future__ import annotations

import json
import threading

import pytest
from openhands.sdk import Agent, Conversation, Message, TextContent
from openhands.sdk.event import ActionEvent, ObservationEvent
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
from embodied_openhands.tool import build_move_object_tool
from embodied_openhands.verifier import (
    REASON_EXECUTION_FAILED,
    REASON_OK,
    REASON_SENSOR_TIMEOUT,
    REASON_STATE_MISMATCH,
)


# ToolDefinition derives its LLM-facing name from the class name:
# "MoveObjectTool" -> "move_object".
TOOL_NAME = MoveObjectTool.name
assert TOOL_NAME == "move_object"


def _move_call(call_id: str, obj: str, destination: str) -> Message:
    return Message(
        role="assistant",
        content=[TextContent(text="")],
        tool_calls=[
            MessageToolCall(
                id=call_id,
                name=TOOL_NAME,
                arguments=json.dumps({"object": obj, "destination": destination}),
                origin="completion",
            )
        ],
    )


def _finish_call(call_id: str, message: str = "done") -> Message:
    return Message(
        role="assistant",
        content=[TextContent(text="")],
        tool_calls=[
            MessageToolCall(
                id=call_id,
                name="finish",
                arguments=json.dumps({"message": message}),
                origin="completion",
            )
        ],
    )


def build(
    scripted: list[Message],
    *,
    robot_mode="works",
    initial: dict[str, str] | None = None,
    gate: threading.Event | None = None,
    timeout_s: float = 30.0,
    min_confidence: float = 0.0,
    confidence: float | None = None,
    tmp_path=None,
):
    """Wire a real Conversation around the fake world. Returns (conv, world, robot)."""
    world = MockWorld(initial or {"A": "table"})
    robot = MockRobot(world, mode=robot_mode, confidence=confidence)
    executor = MoveObjectExecutor(
        robot=robot,
        world=world,
        verifier=StateMatchVerifier(min_confidence=min_confidence),
        timeout_s=timeout_s,
        gate=gate,
    )

    # Register a live instance: Tool.params is JSON-serialized, so a robot
    # bridge cannot travel through it.
    register_tool(TOOL_NAME, build_move_object_tool(executor))

    llm = TestLLM.from_messages(list(scripted))
    agent = Agent(llm=llm, tools=[Tool(name=TOOL_NAME)])
    conversation = Conversation(
        agent=agent,
        workspace=str(tmp_path),
        persistence_dir=None,
    )
    return conversation, world, robot, llm


def observations(conversation) -> list[MoveObjectObservation]:
    return [
        e.observation
        for e in conversation.state.events
        if isinstance(e, ObservationEvent)
        and isinstance(e.observation, MoveObjectObservation)
    ]


def llm_texts(conversation) -> list[str]:
    """Everything the model would see rendered from embodied observations."""
    return [
        "\n".join(c.text for c in obs.to_llm_content)
        for obs in observations(conversation)
    ]


# ---------------------------------------------------------------------------
# 1. The gate holds: no progress until verification returns.
# ---------------------------------------------------------------------------


def test_loop_blocks_until_verification_returns(tmp_path):
    """The agent must not take a second step while verification is outstanding."""
    gate = threading.Event()
    conversation, world, robot, llm = build(
        [_move_call("c1", "A", "B"), _finish_call("c2")],
        robot_mode="works",
        gate=gate,
        timeout_s=10.0,
        tmp_path=tmp_path,
    )

    runner = threading.Thread(target=conversation.run, daemon=True)
    runner.start()

    # Give the loop time to reach the blocked verifier and then sit there.
    threading.Event().wait(1.0)

    # Actuation happened...
    assert robot.attempts == 1
    # ...but the loop is parked inside the executor: no observation was emitted,
    # and crucially the LLM has been consulted exactly once.
    assert observations(conversation) == []
    assert llm._call_count == 1, (
        "agent took another step before physical verification completed"
    )
    assert runner.is_alive()

    # Release the world observation; the loop resumes.
    gate.set()
    runner.join(timeout=15)
    assert not runner.is_alive(), "conversation did not resume after verification"

    obs = observations(conversation)
    assert len(obs) == 1
    assert obs[0].verified is True
    assert llm._call_count == 2


def test_timeout_fails_closed_without_claiming_success(tmp_path):
    """A verifier that never answers must not be treated as success."""
    gate = threading.Event()  # never set
    conversation, world, robot, llm = build(
        [_move_call("c1", "A", "B"), _finish_call("c2")],
        robot_mode="works",
        gate=gate,
        timeout_s=0.5,
        tmp_path=tmp_path,
    )
    conversation.run()

    obs = observations(conversation)
    assert len(obs) == 1
    assert obs[0].verified is False
    assert obs[0].reason_code == REASON_SENSOR_TIMEOUT
    # No automatic re-actuation on timeout.
    assert robot.attempts == 1
    assert "physical outcome is unknown" in obs[0].summary.lower()


# ---------------------------------------------------------------------------
# 2. The interesting failure: the robot lies.
# ---------------------------------------------------------------------------


def test_silent_physical_failure_is_caught_and_surfaced(tmp_path):
    """Robot reports success, world did not change -> the model is told the truth."""
    conversation, world, robot, llm = build(
        [_move_call("c1", "A", "B"), _finish_call("c2")],
        robot_mode="lies",
        tmp_path=tmp_path,
    )
    conversation.run()

    # Ground truth: nothing moved.
    assert world.observe() == {"A": "table"}

    obs = observations(conversation)
    assert len(obs) == 1
    # The robot claimed success...
    assert obs[0].execution_result["accepted"] is True
    # ...and the gate still failed it.
    assert obs[0].verified is False
    assert obs[0].reason_code == REASON_STATE_MISMATCH

    text = llm_texts(conversation)[0]
    assert "VERIFICATION FAILED" in text
    assert "'A': 'B'" in text or '"A": "B"' in text  # expected
    assert "table" in text  # observed reality
    assert "did NOT occur" in text


def test_agent_repairs_after_failed_verification(tmp_path):
    """The full embodied cycle: act -> verify fails -> replan -> verify passes."""
    # Robot lies on attempt 1, then actually works on attempt 2.
    conversation, world, robot, llm = build(
        [
            _move_call("c1", "A", "B"),  # will silently fail
            _move_call("c2", "A", "B"),  # repair attempt
            _finish_call("c3"),
        ],
        robot_mode=lambda attempt: "lies" if attempt == 1 else "works",
        tmp_path=tmp_path,
    )
    conversation.run()

    obs = observations(conversation)
    assert len(obs) == 2
    assert [o.verified for o in obs] == [False, True]
    assert [o.reason_code for o in obs] == [REASON_STATE_MISMATCH, REASON_OK]
    assert world.observe() == {"A": "B"}
    assert robot.attempts == 2


def test_explicit_execution_failure_reports_real_state(tmp_path):
    """A robot that admits failure still gets its world state checked."""
    conversation, world, robot, llm = build(
        [_move_call("c1", "A", "B"), _finish_call("c2")],
        robot_mode="fails",
        tmp_path=tmp_path,
    )
    conversation.run()

    obs = observations(conversation)
    assert obs[0].verified is False
    assert obs[0].reason_code == REASON_EXECUTION_FAILED
    assert obs[0].observed_state == {"A": "table"}
    assert world.observe() == {"A": "table"}


# ---------------------------------------------------------------------------
# 3. Ordering and structure.
# ---------------------------------------------------------------------------


def test_exactly_one_terminal_observation_per_action(tmp_path):
    """No intermediate 'command accepted' observation ever reaches the model."""
    conversation, world, robot, llm = build(
        [_move_call("c1", "A", "B"), _finish_call("c2")],
        robot_mode="works",
        tmp_path=tmp_path,
    )
    conversation.run()

    events = list(conversation.state.events)
    move_actions = [
        e for e in events if isinstance(e, ActionEvent) and e.tool_name == TOOL_NAME
    ]
    move_obs = [
        e
        for e in events
        if isinstance(e, ObservationEvent)
        and isinstance(e.observation, MoveObjectObservation)
    ]
    assert len(move_actions) == 1
    assert len(move_obs) == 1

    # Strict interleaving: action, then its single verified observation.
    assert events.index(move_actions[0]) < events.index(move_obs[0])
    assert move_obs[0].action_id == move_actions[0].id


def test_low_confidence_blocks_even_when_state_matches(tmp_path):
    """Matching state under untrustworthy perception is not a pass."""
    conversation, world, robot, llm = build(
        [_move_call("c1", "A", "B"), _finish_call("c2")],
        robot_mode="works",
        confidence=0.3,
        min_confidence=0.9,
        tmp_path=tmp_path,
    )
    conversation.run()

    obs = observations(conversation)
    assert obs[0].verified is False
    assert obs[0].confidence == pytest.approx(0.3)
    # World really did change; we simply refuse to certify it.
    assert world.observe() == {"A": "B"}
