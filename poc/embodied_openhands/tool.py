"""The embodied gate, expressed as an ordinary OpenHands custom tool.

This is the whole integration. There is no fork, no patched AgentController, no
EventStream hook and no custom Runtime. The gate works because of one property
of the OpenHands SDK agent loop:

    openhands/sdk/agent/agent.py::Agent._execute_action_event
        observation = tool(action_event.action, conversation)

`tool(...)` is a plain blocking call. The `ObservationEvent` that eventually
reaches the LLM is built from whatever this executor returns, and the next
`Agent.step()` cannot begin until it returns. So an executor that performs

    actuate -> observe world -> verify

before returning *is* the physical-verification gate, and its return value is
the only thing the model ever sees.
"""

from __future__ import annotations

import threading
import uuid
from collections.abc import Sequence
from typing import Any

from pydantic import Field

from openhands.sdk import Action, Observation, TextContent, ToolDefinition
from openhands.sdk.tool import ToolExecutor

from .verifier import (
    REASON_EXECUTION_FAILED,
    REASON_SENSOR_TIMEOUT,
    REASON_VERIFIER_ERROR,
    EmbodiedActionPayload,
    EmbodiedVerifier,
    VerificationResult,
)
from .world import MockRobot, MockWorld


class MoveObjectAction(Action):
    """Ask the robot to move an object, and state what that should make true."""

    object: str = Field(description="Name of the object to move, e.g. 'A'.")
    destination: str = Field(description="Where the object should end up, e.g. 'B'.")


class MoveObjectObservation(Observation):
    """The single terminal result of one embodied action.

    Emitted only after actuation, world observation and verification have all
    completed. Carries physical ground truth, not a command acknowledgement.
    """

    verified: bool
    reason_code: str
    summary: str
    expected_state: dict[str, Any] = Field(default_factory=dict)
    observed_state: dict[str, Any] = Field(default_factory=dict)
    execution_result: dict[str, Any] = Field(default_factory=dict)
    confidence: float | None = None

    @property
    def to_llm_content(self) -> Sequence[TextContent]:
        # The model must see the *verdict first*, then reality. Reporting the
        # robot's own claim first invites the model to trust it.
        lines = [
            self.summary,
            f"reason_code: {self.reason_code}",
            f"expected world state: {self.expected_state}",
            f"observed world state: {self.observed_state}",
            f"robot reported: {self.execution_result}",
        ]
        if self.confidence is not None:
            lines.append(f"sensor confidence: {self.confidence}")
        if not self.verified:
            lines.append(
                "The requested state change did NOT occur. Do not assume it did. "
                "Replan against the observed world state above."
            )
        return [TextContent(text="\n".join(lines))]


class EmbodiedTimeout(Exception):
    """Raised when the world/verifier does not answer in time."""


class MoveObjectExecutor(ToolExecutor[MoveObjectAction, MoveObjectObservation]):
    """actuate -> observe -> verify, as one synchronous transaction.

    The executor never returns a "command accepted" observation. It returns
    exactly one terminal observation carrying the verification verdict, so the
    agent loop physically cannot advance on an unverified action.
    """

    def __init__(
        self,
        robot: MockRobot,
        world: MockWorld,
        verifier: EmbodiedVerifier,
        timeout_s: float = 30.0,
        # Test seam: blocks between actuation and verification so a test can
        # prove the loop is stalled. Stands in for real sensor latency.
        gate: threading.Event | None = None,
    ) -> None:
        self._robot = robot
        self._world = world
        self._verifier = verifier
        self._timeout_s = timeout_s
        self._gate = gate
        # Serializes embodied actions even if tool concurrency is raised.
        self._actuation_lock = threading.Lock()

    def __call__(
        self, action: MoveObjectAction, conversation=None
    ) -> MoveObjectObservation:
        payload = EmbodiedActionPayload(
            command="move_object",
            arguments={"object": action.object, "destination": action.destination},
            expected_state={action.object: action.destination},
            idempotency_key=f"move:{action.object}->{action.destination}:{uuid.uuid4()}",
        )

        with self._actuation_lock:
            return self._run_transaction(payload)

    def _run_transaction(
        self, payload: EmbodiedActionPayload
    ) -> MoveObjectObservation:
        execution: dict[str, Any] = {}
        try:
            result = self._robot.move_object(
                obj=str(payload.arguments["object"]),
                destination=str(payload.arguments["destination"]),
                idempotency_key=payload.idempotency_key,
            )
            execution = result.as_dict()

            # Sensor latency / settling time.
            if self._gate is not None and not self._gate.wait(self._timeout_s):
                raise EmbodiedTimeout("world observation did not settle in time")

            observed = self._world.observe()

            if not result.accepted:
                # The robot itself reported failure. Still report real state:
                # a failed command can leave the world partially changed.
                verification = VerificationResult(
                    success=False,
                    observation=(
                        f"EXECUTION FAILED for {payload.command}: {result.detail}."
                    ),
                    structured_state=observed,
                    confidence=result.confidence,
                    reason_code=REASON_EXECUTION_FAILED,
                )
            else:
                verification = self._verifier.verify(
                    action=payload,
                    execution_result=execution,
                    observed_state=observed,
                )
        except EmbodiedTimeout as exc:
            # Fail closed. A timeout is not a rollback: report last known state
            # and explicitly refuse to claim the transition happened.
            observed = self._world.observe()
            verification = VerificationResult(
                success=False,
                observation=(
                    f"VERIFICATION TIMED OUT for {payload.command}: {exc}. "
                    "The physical outcome is unknown."
                ),
                structured_state=observed,
                reason_code=REASON_SENSOR_TIMEOUT,
            )
        except Exception as exc:  # noqa: BLE001 - fail closed on anything
            observed = self._world.observe()
            verification = VerificationResult(
                success=False,
                observation=(
                    f"VERIFIER ERROR for {payload.command}: "
                    f"{type(exc).__name__}: {exc}. The physical outcome is unknown."
                ),
                structured_state=observed,
                reason_code=REASON_VERIFIER_ERROR,
            )

        return MoveObjectObservation(
            verified=verification.success,
            reason_code=verification.reason_code,
            summary=verification.observation,
            expected_state=dict(payload.expected_state),
            observed_state=dict(verification.structured_state or {}),
            execution_result=execution,
            confidence=verification.confidence,
        )


_MOVE_DESCRIPTION = """Move a physical object to a destination using the robot.

This action touches the real world. It returns only after the resulting world
state has been independently observed and verified against the expectation.

The result tells you what ACTUALLY happened, which may differ from what the
robot's control stack reported. If `verified` is false, the state change did not
occur: replan from the reported observed world state. Never assume success.
"""


class MoveObjectTool(ToolDefinition[MoveObjectAction, MoveObjectObservation]):
    """A verification-gated embodied tool.

    Register this with `register_tool(MoveObjectTool.name, build_move_object_tool(...))`
    — i.e. as a live *instance*, not as the class. `Tool.params` is JSON-serialized
    when the agent spec is persisted or shipped to an agent-server, so a live robot
    bridge cannot be passed through it.
    """

    @classmethod
    def create(
        cls,
        conv_state=None,  # noqa: ARG003
        *,
        executor: MoveObjectExecutor,
        **params,  # noqa: ARG003
    ) -> Sequence[ToolDefinition]:
        return [
            cls(
                description=_MOVE_DESCRIPTION,
                action_type=MoveObjectAction,
                observation_type=MoveObjectObservation,
                executor=executor,
            )
        ]


def build_move_object_tool(executor: MoveObjectExecutor) -> MoveObjectTool:
    """Build a ready-to-register tool instance bound to a live executor."""
    tool = MoveObjectTool.create(executor=executor)[0]
    assert isinstance(tool, MoveObjectTool)
    return tool
