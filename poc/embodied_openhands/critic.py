"""Task-level completion gate, built on the SDK's existing `CriticBase`.

Per-action verification (see `tool.py`) answers "did this motion happen?".
It does not answer "is the task actually done?". An agent can call `finish`
while the world is still wrong.

OpenHands already ships the mechanism for that second gate: a `CriticBase` with
`iterative_refinement`. When the agent emits `FinishAction`, the SDK evaluates
the critic and, if the score is below threshold, refuses to finish and injects a
follow-up message instead
(`openhands/sdk/agent/critic_mixin.py::_check_iterative_refinement`).

Pointing that at a world-state goal turns it into a physical task validator with
no core changes.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from pydantic import Field

from openhands.sdk.critic.base import CriticBase
from openhands.sdk.critic.result import CriticResult


if TYPE_CHECKING:
    from openhands.sdk.event.base import LLMConvertibleEvent


class WorldStateCritic(CriticBase):
    """Scores 1.0 only when the observed world matches the task goal.

    `world` is excluded from serialization: it is a live handle to the world /
    perception source, not configuration.
    """

    goal_state: dict[str, Any] = Field(
        description="World state the task requires, e.g. {'A': 'B'}."
    )

    model_config = {"arbitrary_types_allowed": True}

    # Live handle, set after construction so pydantic never tries to serialize it.
    _world: Any = None

    def bind_world(self, world: Any) -> WorldStateCritic:
        self._world = world
        return self

    def evaluate(
        self,
        events: Sequence["LLMConvertibleEvent"],  # noqa: ARG002
        git_patch: str | None = None,  # noqa: ARG002
    ) -> CriticResult:
        if self._world is None:
            raise RuntimeError("WorldStateCritic.bind_world() was never called")

        observed = self._world.observe()
        mismatches = {
            key: {"expected": value, "observed": observed.get(key)}
            for key, value in self.goal_state.items()
            if observed.get(key) != value
        }

        if not mismatches:
            return CriticResult(
                score=1.0,
                message="Task goal verified against observed world state.",
                metadata={"observed_state": observed},
            )

        detail = "; ".join(
            f"{key}: expected {m['expected']!r}, observed {m['observed']!r}"
            for key, m in sorted(mismatches.items())
        )
        return CriticResult(
            score=0.0,
            message=(
                f"Task goal NOT met in the physical world. {detail}. "
                f"Observed state: {observed}."
            ),
            metadata={"observed_state": observed, "mismatches": mismatches},
        )

    def get_followup_prompt(self, critic_result: CriticResult, iteration: int) -> str:
        return (
            f"You attempted to finish, but external world-state verification "
            f"failed (attempt {iteration}).\n\n"
            f"{critic_result.message}\n\n"
            "The task is not complete. Act on the physical world to reach the "
            "goal state, then finish."
        )
