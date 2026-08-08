# Embodied verification gate for OpenHands — proof of concept

Proves one claim:

> **OpenHands can be prevented from progressing until an external world-state
> verification event is returned.**

It does so against the **real** `openhands-sdk` agent loop. No SDK file is patched,
subclassed, or forked. 11/11 tests pass.

Full analysis: [`../docs/openhands-embodied-harness.md`](../docs/openhands-embodied-harness.md).

## Why it works

`openhands/sdk/agent/agent.py:1373`:

```python
observation = tool(action_event.action, conversation)
```

That call is synchronous and blocking, and the model's next context is built solely
from what it returns. So a `ToolExecutor` that does `actuate → observe world → verify`
before returning **is** the gate — there is no code path by which the agent could
advance past unverified physical state.

## Layout

| File | LOC | Purpose |
|---|---|---|
| `embodied_openhands/verifier.py` | 145 | `VerificationResult`, `EmbodiedVerifier`, `StateMatchVerifier`. Imports nothing from OpenHands. |
| `embodied_openhands/world.py` | 118 | `MockWorld` + `MockRobot` with modes `works` / `fails` / **`lies`**. |
| `embodied_openhands/tool.py` | 243 | The gating `ToolExecutor` and its typed Action/Observation pair. |
| `embodied_openhands/critic.py` | 94 | `WorldStateCritic` — vetoes `finish` until the task goal is physically verified. |
| `tests/` | 464 | 11 tests. |
| `demo.py` | 127 | Runnable transcript. |

The scenario that matters is `mode="lies"`: the robot reports success without moving
anything. An exit-code-only agent loop cannot detect this. The gate catches it.

## Run

Requires Python ≥3.12.

```bash
git clone https://github.com/OpenHands/software-agent-sdk
cd software-agent-sdk
git checkout c7e270aae43a6e9bcc8723d27b85c680ab38e156   # openhands-sdk v1.41.0
uv sync --group dev
SDK_PY="$PWD/.venv/bin/python"

cd /path/to/this/poc
PYTHONPATH=. "$SDK_PY" -m pytest tests/ -q     # 11 passed
PYTHONPATH=. "$SDK_PY" demo.py
```

No API key, no network, no robot — a scripted `openhands.sdk.testing.TestLLM`
drives the real loop.

## Expected demo output

```
[ACTION]      move_object {'object': 'A', 'destination': 'B'}
[VERIFY FAIL]  STATE_MISMATCH
              expected world state: {'A': 'B'}
              observed world state: {'A': 'table'}
              robot reported: {'accepted': True, ...}        ← the lie
[ACTION]      finish {'message': 'Moved A to B.'}            ← premature
[FEEDBACK]    ...external world-state verification failed    ← finish VETOED
[ACTION]      move_object {'object': 'A', 'destination': 'B'}
[VERIFY PASS]  OK
[ACTION]      finish {'message': 'Verified: A is on B.'}     ← accepted
```

## Two gates

1. **Per-action** (`tool.py`) — the loop cannot step until `actuate → observe → verify`
   returns one terminal observation carrying ground truth.
2. **Task-level** (`critic.py`) — uses the SDK's existing `CriticBase` +
   `IterativeRefinementConfig`, which already refuses `FinishAction` below a score
   threshold and injects a follow-up. Bounded by `max_iterations`.

## Integration gotchas

- **Register a tool *instance*, not the class.** `Tool.params` is JSON-serialized when
  the agent spec is persisted, so a live robot bridge cannot pass through it. Use
  `register_tool(MoveObjectTool.name, build_move_object_tool(executor))`.
- **Tool names are derived from the class name** (`tool/tool.py:391`), camel→snake with
  `_tool` stripped: `MoveObjectTool` → `move_object`. That is the name the LLM calls.
- **Keep `tool_concurrency_limit` at its default of 1**, or declare a robot resource key
  via `DeclaredResources` so embodied actions serialize.

## This is not a safety system

The gate guarantees *honest feedback*, not *safe motion*. Force/velocity limits,
workspace bounds, collision avoidance, e-stop and watchdogs must live in an independent
deterministic layer beneath the agent. See §9 of the analysis document.
