"""The minimal embodied-verification interface.

This module is deliberately tiny and knows nothing about OpenHands, LLMs, or
event streams. It is the abstract "external world verifier" boundary from the
research brief:

    verification_result = verify_world_state(expected_state, observed_state)

Everything OpenHands-specific lives in `tool.py`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol, runtime_checkable


JsonObject = Mapping[str, Any]


# Stable machine-readable reasons. Policy code should branch on these rather
# than parsing the human-readable `observation` string.
REASON_OK = "OK"
REASON_STATE_MISMATCH = "STATE_MISMATCH"
REASON_LOW_CONFIDENCE = "LOW_CONFIDENCE"
REASON_SENSOR_TIMEOUT = "SENSOR_TIMEOUT"
REASON_VERIFIER_ERROR = "VERIFIER_ERROR"
REASON_EXECUTION_FAILED = "EXECUTION_FAILED"


@dataclass(frozen=True)
class VerificationResult:
    """The verdict of an external world-state check.

    `success` is the only field the agent loop gates on. `observation` is the
    natural-language rendering handed to the LLM. `structured_state` carries the
    ground truth so the model can replan against reality rather than against its
    own assumption of what happened.
    """

    success: bool
    observation: str
    structured_state: JsonObject | None = None
    confidence: float | None = None
    reason_code: str = REASON_OK

    def __post_init__(self) -> None:
        if self.confidence is not None and not (0.0 <= self.confidence <= 1.0):
            raise ValueError(f"confidence must be in [0, 1], got {self.confidence}")


@dataclass(frozen=True)
class EmbodiedActionPayload:
    """What was asked of the physical world."""

    command: str
    arguments: JsonObject = field(default_factory=dict)
    expected_state: JsonObject = field(default_factory=dict)
    idempotency_key: str = ""


@runtime_checkable
class EmbodiedVerifier(Protocol):
    """Compares intent against physical ground truth.

    Implementations may wrap a simulator query, a perception stack, a VLM, a
    world model, or a task-specific validator. They must not actuate, must not
    retry, and must not call the LLM: this is a pure judgement.
    """

    def verify(
        self,
        *,
        action: EmbodiedActionPayload,
        execution_result: JsonObject,
        observed_state: JsonObject,
    ) -> VerificationResult: ...


class StateMatchVerifier:
    """Reference verifier: every key in `expected_state` must match observation.

    Deliberately strict. A robot command that reports success while the world
    did not change is a *failure*, which is the exact case the harness exists to
    catch.
    """

    def __init__(self, min_confidence: float = 0.0) -> None:
        self._min_confidence = min_confidence

    def verify(
        self,
        *,
        action: EmbodiedActionPayload,
        execution_result: JsonObject,
        observed_state: JsonObject,
    ) -> VerificationResult:
        confidence = execution_result.get("confidence")

        mismatches = {
            key: {"expected": value, "observed": observed_state.get(key)}
            for key, value in action.expected_state.items()
            if observed_state.get(key) != value
        }

        if mismatches:
            detail = "; ".join(
                f"{key}: expected {m['expected']!r}, observed {m['observed']!r}"
                for key, m in sorted(mismatches.items())
            )
            return VerificationResult(
                success=False,
                observation=(
                    f"VERIFICATION FAILED for {action.command}. "
                    f"The world did not reach the expected state. {detail}."
                ),
                structured_state=dict(observed_state),
                confidence=confidence,
                reason_code=REASON_STATE_MISMATCH,
            )

        # State matches, but perception may not be trustworthy enough to say so.
        if confidence is not None and confidence < self._min_confidence:
            return VerificationResult(
                success=False,
                observation=(
                    f"VERIFICATION INCONCLUSIVE for {action.command}. "
                    f"Observed state matches the expectation but sensor "
                    f"confidence {confidence:.2f} is below the required "
                    f"{self._min_confidence:.2f}."
                ),
                structured_state=dict(observed_state),
                confidence=confidence,
                reason_code=REASON_LOW_CONFIDENCE,
            )

        return VerificationResult(
            success=True,
            observation=(
                f"VERIFIED: {action.command} produced the expected world state."
            ),
            structured_state=dict(observed_state),
            confidence=confidence,
            reason_code=REASON_OK,
        )
