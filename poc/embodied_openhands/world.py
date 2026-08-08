"""A deterministic fake physical world.

No robot, no simulator, no perception. Just enough to reproduce the failure mode
that motivates the whole harness: **a robot that reports success while the world
does not change.**
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Callable, Literal


RobotMode = Literal["works", "fails", "lies"]


@dataclass
class ExecutionResult:
    """What the robot's own control stack claims happened.

    This is the *untrustworthy* channel. `accepted=True` means the command was
    acknowledged, which is emphatically not the same as the world having changed.
    """

    accepted: bool
    detail: str
    confidence: float | None = None

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"accepted": self.accepted, "detail": self.detail}
        if self.confidence is not None:
            out["confidence"] = self.confidence
        return out


class MockWorld:
    """Ground truth: object name -> location."""

    def __init__(self, initial: dict[str, str] | None = None) -> None:
        self._state: dict[str, str] = dict(initial or {"A": "table"})
        self._lock = threading.Lock()

    def observe(self) -> dict[str, str]:
        """Snapshot the world. Stands in for a perception system."""
        with self._lock:
            return dict(self._state)

    def _set(self, obj: str, location: str) -> None:
        with self._lock:
            self._state[obj] = location


class MockRobot:
    """Executes move commands against a MockWorld with a selectable failure mode.

    Modes:
      - "works": moves the object and reports success.
      - "fails": does not move the object and reports failure.
      - "lies":  does NOT move the object but reports success. This is the case
                 an exit-code-only agent loop cannot detect.

    `mode` may also be a callable taking the attempt number (1-indexed) so a test
    can script "lies once, then works".
    """

    def __init__(
        self,
        world: MockWorld,
        mode: RobotMode | Callable[[int], RobotMode] = "works",
        confidence: float | None = None,
    ) -> None:
        self._world = world
        self._mode = mode
        self._confidence = confidence
        self.attempts = 0
        # Records idempotency keys already actuated, so a replayed event never
        # re-actuates a non-idempotent motion.
        self._executed_keys: dict[str, ExecutionResult] = {}

    def _mode_for(self, attempt: int) -> RobotMode:
        return self._mode(attempt) if callable(self._mode) else self._mode

    def move_object(
        self, obj: str, destination: str, idempotency_key: str = ""
    ) -> ExecutionResult:
        if idempotency_key and idempotency_key in self._executed_keys:
            return self._executed_keys[idempotency_key]

        self.attempts += 1
        mode = self._mode_for(self.attempts)

        if mode == "works":
            self._world._set(obj, destination)
            result = ExecutionResult(
                accepted=True,
                detail=f"moved {obj} to {destination}",
                confidence=self._confidence,
            )
        elif mode == "fails":
            result = ExecutionResult(
                accepted=False,
                detail=f"gripper error while moving {obj}",
                confidence=self._confidence,
            )
        elif mode == "lies":
            # The command is acknowledged; the world is untouched.
            result = ExecutionResult(
                accepted=True,
                detail=f"moved {obj} to {destination}",
                confidence=self._confidence,
            )
        else:  # pragma: no cover - guarded by typing
            raise ValueError(f"unknown robot mode: {mode}")

        if idempotency_key:
            self._executed_keys[idempotency_key] = result
        return result
