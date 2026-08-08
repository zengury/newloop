# OpenHands as an Embodied Coding Agent Harness

**Research date:** 2026-08-08
**Verdict:** **YES** — and with less modification than expected. No fork required.

**Pinned upstream:** `OpenHands/software-agent-sdk` @ `c7e270aae43a6e9bcc8723d27b85c680ab38e156`
(2026-08-07), packages `openhands-sdk` / `openhands-tools` / `openhands-agent-server` /
`openhands-workspace` all at **v1.41.0**.

Everything below was read from that checkout, and the central claim is backed by a
**working proof-of-concept that runs the real agent loop** — see [`poc/`](../poc).
11/11 tests pass. Nothing in the SDK is patched, subclassed, or forked.

> **Supersedes** [`openhands-embodied-verification.md`](./openhands-embodied-verification.md).
> That document was written without a checkout and describes the legacy (v0)
> `openhands/controller/agent_controller.py` + `EventStream` architecture. **That
> architecture is no longer the mainline**, and its recommended integration point
> (a Runtime that withholds a terminal observation from an EventStream) does not
> exist in current OpenHands. Details in §0.

---

## 0. First finding: the repository moved, and so did the architecture

This changes the answer, so it comes first.

1. **`All-Hands-AI/OpenHands` now redirects to `OpenHands/OpenHands`, which is no longer
   the Python agent.** It is **Agent Canvas** — a TypeScript/React self-hosted control
   center (`@openhands/agent-canvas` v1.12.0). It contains 4 Python files, none of them
   an agent loop.
2. **The agent loop lives in a separate repo: `OpenHands/software-agent-sdk`**, published
   as the `openhands-sdk` package.
3. **There is no `AgentController`. There is no `EventStream`.** The v0 model — controller
   publishes an `Action` to a pub-sub stream, a `Runtime` subscribes, executes, and
   publishes an `Observation` back — has been replaced by a direct, synchronous call
   chain. Tools are executed **inline inside `Agent.step()`**, not by a separate runtime
   process reacting to a stream.

The practical consequence is good news. The old design required you to hold a distributed
async protocol open across a process boundary to gate the loop. The new design gates on a
**plain blocking function call**, which is far easier to make correct.

---

## 1. The current agent loop

### 1.1 Call flow

```
LocalConversation.run()                      conversation/impl/local_conversation.py:1850
│
└─ while True:                                                                     :1878
   ├─ if PAUSED / STUCK                      → break                               :1884
   ├─ if FINISHED → Stop hooks may veto      → run_stop()                          :1891
   ├─ _check_stuck_or_nudge()                                                      :1921
   ├─ agent.step(conversation, on_event)                                           :1938
   │  │
   │  └─ Agent.step()                                    agent/agent.py:637
   │     ├─ pending (unmatched) actions? execute those first and return       :646
   │     ├─ prepare_llm_messages(state.view, condenser)                       :675
   │     ├─ llm.completion(...)                       ← LLM REASONING
   │     ├─ classify_response(message)                agent/response_dispatch.py:53
   │     └─ _handle_tool_calls(...)                   agent/response_dispatch.py:143
   │        ├─ _get_action_event() per tool_call      agent/agent.py:1189
   │        │     ← ACTION GENERATION; emits ActionEvent
   │        ├─ _requires_user_confirmation()          agent/agent.py:1015
   │        │     ← if true: set WAITING_FOR_CONFIRMATION and RETURN (loop breaks)
   │        └─ _execute_actions()                     agent/agent.py:571
   │           ├─ _ActionBatch.prepare()              agent/agent.py:229
   │           │  ├─ _truncate_at_finish()            agent/agent.py:201
   │           │  ├─ pop_blocked_action()   ← PreToolUse hook verdicts
   │           │  └─ ParallelToolExecutor.execute_batch(tool_runner)
   │           │     └─ Agent._execute_action_event() agent/agent.py:1334
   │           │        └─ observation = tool(action, conversation)          :1373
   │           │           ★★★ THE GATE — blocking call, returns Observation
   │           ├─ batch.emit()                        agent/agent.py:312
   │           │     ← OBSERVATION COLLECTION: wraps in ObservationEvent → on_event
   │           └─ batch.finalize()                    agent/agent.py:341
   │              ├─ _check_iterative_refinement()    agent/critic_mixin.py:76
   │              │     ← CRITIC may VETO finish and inject a follow-up message
   │              └─ mark_finished() → status = FINISHED
   │
   ├─ if WAITING_FOR_CONFIRMATION            → break                               :1953
   ├─ budget exceeded                        → break                               :1959
   └─ iteration >= max_iteration_per_run     → break                               :1967
```

### 1.2 Answers to the specific questions asked

| Concern | Location |
|---|---|
| **LLM reasoning** | `Agent.step()` / `astep()` — `agent/agent.py:637`, `:822`. Message construction via `prepare_llm_messages(state.view, ...)` at `:675`. |
| **Action generation** | `ResponseDispatchMixin._handle_tool_calls` → `Agent._get_action_event` — `agent/response_dispatch.py:143`, `agent/agent.py:1189`. Produces `ActionEvent`. |
| **Action execution** | `Agent._execute_actions` → `_ActionBatch.prepare` → `ParallelToolExecutor.execute_batch` → `Agent._execute_action_event` → **`tool(action, conversation)`** — `agent/agent.py:571, 229, 1334, 1373`. |
| **Observation collection** | `_ActionBatch.emit` wraps the returned `Observation` in an `ObservationEvent` and calls `on_event` — `agent/agent.py:312`. |
| **Feeding observations back to the model** | `ObservationEvent` is an `LLMConvertibleEvent`; `Observation.to_llm_content` (`tool/schema.py:411`) renders it. The incrementally-maintained `state.view` is projected to messages on the next step. |
| **Deciding whether to iterate again** | The `while True` in `LocalConversation.run()` — `local_conversation.py:1878`. It iterates unconditionally until a break condition. **There is no "should I continue?" predicate the agent evaluates**; continuation is the default. |
| **Terminating** | `FinishTool` → `_ActionBatch.finalize` → `mark_finished()` sets `FINISHED` (`agent/agent.py:341`). Other exits: Stop-hook-vetoed finish (`local_conversation.py:1891`), `WAITING_FOR_CONFIRMATION`, budget, `max_iteration_per_run` (default 500), pause/stuck, exception. |

### 1.3 The single most important property

```python
# openhands/sdk/agent/agent.py:1373
observation = tool(action_event.action, conversation)
```

`tool(...)` is a **synchronous, blocking call on the step thread**. The `ObservationEvent`
the LLM eventually sees is constructed from its return value, and `Agent.step()` cannot
return — so `run()` cannot begin another iteration — until it does.

The async path has the same property: `_aexecute_actions` (`agent/agent.py:601`) *awaits*
`_ActionBatch.aprepare`, which awaits `aexecute_batch`. The await point is the same barrier.

**Therefore: a tool executor that does `actuate → observe world → verify` before returning
is already a hard physical-verification gate.** That is the entire finding.

---

## 2. Best interception point

### Recommendation: a `ToolExecutor`. Nothing else. Zero core changes.

The brief asked which of {new Observation type, Action/Observation pair, execution
middleware, Environment extension, Runtime extension, EventStream hook, AgentController
modification} to use. The correct answer is **an option not on that list**, because the
list was drawn from the v0 architecture:

> Implement `ToolExecutor.__call__` so it does not return until external verification
> completes, and return exactly one terminal `Observation` carrying the verdict plus
> observed ground truth.

You do need a typed action/observation pair (`MoveObjectAction` / `MoveObjectObservation`),
but they are ordinary pydantic models registered with a tool — not core types.

### Why each alternative is worse (or impossible)

| Candidate | Verdict |
|---|---|
| **`ToolExecutor`** | ✅ **Use this.** Zero core changes. Blocking by construction. Observation content is fully under your control. Proven in `poc/`. |
| **Critic (`CriticBase`) for the *task-level* gate** | ✅ **Also use this.** Already exists, already vetoes `finish`. See §3. |
| **New Observation type alone** | Insufficient — an Observation is a return value, not a dispatch point. It cannot carry `expected_state` into execution. Use it *with* the executor. |
| **Middleware around execution** | No such seam exists. `_execute_action_event` calls the tool directly. You would have to subclass `Agent` — strictly worse than owning the executor. |
| **Environment extension** | Doesn't exist as a concept. `Workspace` (`workspace/base.py`) models *where files live*, not action dispatch. |
| **Runtime extension** | **Does not exist.** There is no `Runtime` class. Remote execution means running the whole `LocalConversation` inside `openhands-agent-server` — it is not an execution-interception seam. |
| **EventStream hook** | **Does not exist.** There is no `EventStream`. The nearest thing is `callbacks` passed to `Conversation`, which are *observational*: `on_event` fires **after** the observation is already built and recorded. Blocking inside a callback would stall the loop, but too late to change what the model sees. Anti-pattern. |
| **`AgentController` modification** | **The class does not exist.** The equivalent is `LocalConversation.run()`. Modifying it is unnecessary. |
| **`PostToolUse` hook** | ❌ **Trap — looks right, does not work.** See below. |

### The `PostToolUse` trap (verified)

A PostToolUse hook is the obvious-looking place for "check the world after the action."
It cannot work. In `hooks/conversation_hooks.py:220-241`:

```python
results = self.hook_manager.run_post_tool_use(...)
for hook, result in zip(hooks, results, strict=False):
    self._emit_hook_execution_event(...)
    if result.error:
        logger.warning(f"PostToolUse hook error: {result.error}")
```

The hook's **decision is discarded**. Unlike `_handle_pre_tool_use` (`:162-176`), which
calls `state.block_action(...)`, PostToolUse has no path to block, retry, or inject
feedback. It is telemetry only. Do not build the gate on it.

---

## 3. What OpenHands already has, and whether robotics can reuse it

| Mechanism | Present? | Where | Robotics verdict |
|---|---|---|---|
| **Asynchronous actions** | Yes | `arun`/`astep`, `_aexecute_actions` (`agent/agent.py:601`) | **Reuse.** `await`ing sensor I/O keeps the gate closed without burning a thread. |
| **Long-running actions** | Yes | Tools may block indefinitely; `ToolExecutor.interrupt()` (`tool/tool.py:317`) is called cross-thread on cancel | **Reuse + extend.** Implement `interrupt()` as *e-stop*. Add your own timeout — the SDK imposes none on a tool. |
| **External tool execution** | Yes | `ToolExecutor`; also MCP (`sdk/mcp/`) | **Direct fit.** A robot bridge is just an executor. MCP is a viable out-of-process transport if the robot stack isn't Python. |
| **Execution callbacks** | Partial | `Conversation(callbacks=[...])`, `on_event` | **Observability only.** Fires after the fact. Never gate on it. |
| **Human confirmation** | Yes | `security/confirmation_policy.py`, `Agent._requires_user_confirmation` (`agent/agent.py:1015`) | **Different question.** Answers "may this start?" not "what happened?". Also it *breaks the run loop* pending external resumption — useful precedent that the loop **can** be held, but it's an authorization gate. Keep both. |
| **Action rejection** | Yes | PreToolUse hook → `block_action` → `UserRejectObservation` (`agent/agent.py:322`) | **Reuse for the interlock.** A PreToolUse hook can refuse a *second* embodied action while one is outstanding, and the rejection reason reaches the LLM. |
| **Retry** | No automatic motion retry | Agent replans from observations | **Correct as-is.** Do not add blind retry to actuation. Idempotency keys belong in the robot bridge (`poc/embodied_openhands/world.py`). |
| **Error observations** | Yes | `AgentErrorEvent` on `ValueError` (`agent/agent.py:1377`) | **Reuse, but prefer typed failure.** A failed verification is a *normal* observation, not an error — the model must see structured state, not a stack trace. |
| **Environment state** | Partial | `Workspace` = filesystem; `ConversationState` = conversation/control | **Neither is world state.** Keep world state in your verifier/observation. Do not overload `ConversationState`. |
| **Task completion verification** | **Yes — and it's exactly what you need** | `CriticBase` + `IterativeRefinementConfig` (`critic/base.py`), wired at `critic_mixin.py:76` and `agent/agent.py:360` | **Reuse directly.** On `FinishAction` the critic runs; if `score < success_threshold` the SDK **refuses to finish** and injects `get_followup_prompt(...)` as a user message, bounded by `max_iterations`. Point it at observed world state and it becomes a physical task validator. Proven in `poc/tests/test_finish_gate.py`. |
| **Custom runtimes** | **No** | — | Concept removed. Not needed. |
| **Custom observation sources** | Yes | Any `Observation` subclass with `to_llm_content` | **Reuse.** This is how ground truth reaches the model. |
| **Concurrency control** | Yes | `tool_concurrency_limit` **defaults to 1** (`agent/base.py:292`); `DeclaredResources` + `ResourceLockManager` (`tool/tool.py:251, 513`) | **Important safety win.** Sequential by default. If concurrency is ever raised, declare a `"robot:arm0"` resource key so embodied actions serialize. |

---

## 4. Minimal interface

Implemented in [`poc/embodied_openhands/verifier.py`](../poc/embodied_openhands/verifier.py) —
145 lines, and it imports nothing from OpenHands.

```python
@dataclass(frozen=True)
class VerificationResult:
    success: bool
    observation: str                       # what the LLM reads
    structured_state: JsonObject | None = None   # ground truth for replanning
    confidence: float | None = None
    reason_code: str = REASON_OK           # STATE_MISMATCH | LOW_CONFIDENCE |
                                           # SENSOR_TIMEOUT | VERIFIER_ERROR |
                                           # EXECUTION_FAILED

@dataclass(frozen=True)
class EmbodiedActionPayload:
    command: str
    arguments: JsonObject = field(default_factory=dict)
    expected_state: JsonObject = field(default_factory=dict)
    idempotency_key: str = ""

class EmbodiedVerifier(Protocol):
    def verify(self, *, action, execution_result, observed_state) -> VerificationResult: ...
```

Two deliberate additions to the brief's sketch, both load-bearing:

- **`expected_state` on the action.** Verification is meaningless without a
  machine-checkable statement of intent. Making the LLM declare it is the point.
- **`reason_code`.** Lets policy branch without parsing prose. `STATE_MISMATCH`
  (robot lied) and `SENSOR_TIMEOUT` (outcome unknown) demand different responses.

A verifier must not actuate, must not retry, and must not call an LLM. It is a pure
judgement.

---

## 5. Current loop vs. embodied loop

### Current

```
Agent.step()
  └─ LLM → tool_call
       └─ tool(action) ──────────────► sandbox executes
                        ◄────────────── Observation (exit code, stdout)
       └─ ObservationEvent → state.view → next step's LLM messages
  loop continues
```

The observation is **the command's own report of itself**. For code, that is usually
adequate. For a robot it is exactly the failure mode: `accepted: true` proves the
controller received the command, not that the object moved.

### Embodied

```
Agent.step()
  └─ LLM → tool_call(command, expected_state)   ← intent is explicit and checkable
       └─ tool(action)  ═══ ONE ATOMIC TRANSACTION, NOTHING EMITTED INSIDE ═══
            ├─ robot.execute(...)          → execution_result   (untrusted claim)
            ├─ world.observe()             → observed_state     (ground truth)
            └─ verifier.verify(expected, observed) → VerificationResult
          ◄─ returns ONE terminal Observation {verified, expected, observed, reason}
       └─ ObservationEvent → next step's LLM messages
  ── loop physically cannot advance before the above returns ──
  on finish:
       └─ WorldStateCritic.evaluate() → score
            score < threshold → finish VETOED, follow-up injected, agent replans
```

The two differences that matter:

1. **Nothing is emitted between actuation and verification.** No "command accepted"
   observation exists for the model to mistake for success.
2. **The model's next context contains reality, not the robot's claim** — and when they
   disagree, the disagreement is stated explicitly.

---

## 6. Fork evaluation — ranked

| # | Option | Core changes | Verdict |
|---|---|---|---|
| **1** | **Custom `ToolExecutor` + typed Action/Observation** | **none** | ✅ **Best.** Sits exactly on the execution boundary. Robot credentials stay out of the agent process. Maintenance surface is `ToolExecutor.__call__`, `Action`, `Observation`, `register_tool` — the SDK's most stable public API (it is the documented extension path, `examples/01_standalone_sdk/02_custom_tools.py`). **Proven.** |
| **2** | **`CriticBase` subclass for task completion** | **none** | ✅ **Use alongside #1.** Purpose-built for veto-and-retry, bounded by `max_iterations`. **Proven.** |
| **3** | **`PreToolUse` hook for interlocks** | none | ✅ Good supplement — enforce "no second embodied action while one is pending", "no `finish` while unverified". Rejections reach the LLM. |
| **4** | **Custom `Agent` subclass** | none, but couples to internals | ⚠️ Only for prompt discipline (teaching the model to emit good `expected_state`). Prefer tool descriptions + `system_prompt_suffix`. **Never rely on the agent to enforce its own gate — it is the thing being gated.** |
| **5** | **Custom `Workspace` / `openhands-agent-server` deployment** | none | ⚪ Orthogonal. Solves *where* the loop runs (e.g. on the robot's edge machine), not gating. Adopt if the robot is remote. |
| **6** | **Thin wrapper driving `Conversation` externally** | none | ⚠️ Tempting and wrong. You'd re-implement stepping, lose causal linkage, and race the loop. Only if you refuse to register a tool. |
| **7** | **Fork the loop (`LocalConversation.run`)** | large | ❌ **Unnecessary.** Continuous merge cost against a fast-moving 3k-line file, for a barrier the executor already provides. |

**Maintenance summary.** Options 1–3 are out-of-tree: your code depends on
`openhands-sdk` as a pinned dependency and you upgrade on your own schedule. Nothing
in `poc/` touches SDK internals, so the upgrade surface is a handful of public symbols.

**If you later want a hard, controller-level invariant** ("no step may proceed while an
embodied action is unverified") — enforced against buggy plugins, replay, and
reconnection, not merely by convention — that is a ~40–100 line change in
`LocalConversation.run()`. Propose it upstream as a **generic pending-action gate**, not
a robotics fork. It is not needed for the prototype, and it is not needed for a
single-robot single-conversation product. It becomes relevant for safety certification.

---

## 7. Licensing

**Verified at the pinned SHA.** Both repositories are **MIT**:

- `OpenHands/software-agent-sdk` — MIT, "Copyright (c) 2026 OpenHands contributors"
- `OpenHands/OpenHands` (Agent Canvas) — MIT, "Copyright © 2025 OpenHands contributors"

| Question | Answer |
|---|---|
| Modify the core agent loop | ✅ Permitted |
| Build & distribute a commercial robotics product on top | ✅ Permitted |
| Maintain a private fork | ✅ Permitted — no obligation to publish changes |
| Redistribute modified components | ✅ Permitted, retaining the notice |

The only condition: **include the MIT copyright and permission notice** in copies or
substantial portions. In a binary/firmware product, ship a third-party notices file.

### Dependency findings (this is where the real constraints are)

I scanned the resolved dependency set:

- **`openhands-sdk` runtime dependencies contain no copyleft licenses.** Clean.
- ⚠️ **`openhands-tools` pulls `func-timeout` (LGPL-2.1) as a *runtime* dependency.**
  Not a blocker for proprietary distribution (pure-Python LGPL is generally satisfiable
  by keeping it a separable, replaceable module and giving notice), but it needs a
  deliberate decision — especially if you statically bundle for an embedded target.
  **The PoC imports only `openhands-sdk` and therefore avoids this entirely.** Prefer
  that if you don't need the shipped terminal/file-editor tools.
- `pyinstaller` (GPL-2.0) is **dev-group only** — a build tool, not distributed.
- `litellm` is pinned to `==1.93.0` at the workspace level; hosted-model *terms of
  service* (separate from license) apply to whatever model you route to.

MIT provides **no warranty and no liability** and certainly no robotics safety
certification. This is an engineering assessment, not legal advice — have counsel review
before product release.

---

## 8. Proof of concept — built and passing

The brief asked for a *plan*. Since the architecture turned out to be simpler than
expected, I built it instead. **11/11 tests pass against the real agent loop.**

```
poc/
├── embodied_openhands/
│   ├── verifier.py   145 LOC  VerificationResult, EmbodiedVerifier, StateMatchVerifier
│   ├── world.py      118 LOC  MockWorld + MockRobot (modes: works | fails | lies)
│   ├── tool.py       243 LOC  MoveObjectAction/Observation + the gating executor
│   ├── critic.py      94 LOC  WorldStateCritic — task-completion gate
│   └── __init__.py    30 LOC
├── tests/            464 LOC  11 tests
└── demo.py           127 LOC  runnable transcript, no API key needed
```

**Total: 630 LOC implementation + 464 LOC tests.** SDK files modified: **zero**.

### The scenario

The interesting failure mode is a robot that **reports success without moving anything** —
the case an exit-code-only loop cannot detect.

```
$ python demo.py

[ACTION]      move_object {'object': 'A', 'destination': 'B'}
[VERIFY FAIL]  STATE_MISMATCH
              VERIFICATION FAILED for move_object. The world did not reach the
              expected state. A: expected 'B', observed 'table'.
              expected world state: {'A': 'B'}
              observed world state: {'A': 'table'}
              robot reported: {'accepted': True, 'detail': 'moved A to B'}   ← the lie
              The requested state change did NOT occur. Do not assume it did.

[ACTION]      finish {'message': 'Moved A to B.'}                    ← premature
[FEEDBACK]    You attempted to finish, but external world-state verification
              failed (attempt 1).                                    ← finish VETOED

[ACTION]      move_object {'object': 'A', 'destination': 'B'}
[VERIFY PASS]  OK

[ACTION]      finish {'message': 'Verified: A is on B.'}             ← accepted

final world state:   {'A': 'B'}
robot actuations:    2
LLM turns consumed:  4
execution status:    finished
```

### What the tests establish

**The gate holds** (`tests/test_embodied_gate.py`):

1. `test_loop_blocks_until_verification_returns` — **the decisive test.** A
   `threading.Event` blocks the verifier mid-transaction. While blocked: actuation has
   happened (`robot.attempts == 1`), no observation exists, and **`llm._call_count == 1`** —
   the agent has not taken another step. Release the event and the loop resumes.
2. `test_timeout_fails_closed_without_claiming_success` — verifier never answers →
   `SENSOR_TIMEOUT`, `verified=False`, no re-actuation, "physical outcome is unknown".
3. `test_silent_physical_failure_is_caught_and_surfaced` — robot lies; the model's context
   contains expected state, observed state, and an explicit "did NOT occur".
4. `test_agent_repairs_after_failed_verification` — the full cycle: act → verify fails →
   replan → verify passes.
5. `test_explicit_execution_failure_reports_real_state` — an admitted failure still gets
   its world state checked.
6. `test_exactly_one_terminal_observation_per_action` — exactly one observation per
   action, correctly `action_id`-linked, strictly ordered.
7. `test_low_confidence_blocks_even_when_state_matches` — matching state under
   untrustworthy perception is **not** a pass.

**Termination is gated too** (`tests/test_finish_gate.py`):

8. `test_finish_is_refused_while_world_state_is_wrong` — premature `finish` is vetoed and
   the agent is sent back to work.
9. `test_finish_succeeds_immediately_when_world_is_correct` — no spurious veto.
10. `test_refinement_is_bounded` — a permanently broken robot terminates after
    `max_iterations` rather than looping forever, and the transcript records failure
    rather than false success.
11. `test_gate_and_finish_gate_compose` — per-action and task-level gates are
    independent and both hold (every action verified, yet the task goal unmet → veto).

### Reproducing

```bash
git clone https://github.com/OpenHands/software-agent-sdk
cd software-agent-sdk && git checkout c7e270aae43a6e9bcc8723d27b85c680ab38e156
uv sync --group dev

cd /path/to/poc
PYTHONPATH=. /path/to/software-agent-sdk/.venv/bin/python -m pytest tests/ -q
PYTHONPATH=. /path/to/software-agent-sdk/.venv/bin/python demo.py
```

No API key, no network, no robot: a scripted `TestLLM`
(`openhands.sdk.testing.TestLLM`) drives the real loop.

### Two integration constraints discovered while building

1. **`Tool.params` is JSON-serialized** (`tool/spec.py`) when the agent spec is persisted
   or shipped to an agent-server. A live robot bridge cannot travel through it. Register
   a **tool instance** (`register_tool(name, instance)`) rather than the class.
2. **Tool names are derived from the class name**, camel→snake with `_tool` stripped
   (`tool/tool.py:391`): `MoveObjectTool` → `move_object`. That is what the LLM sees.

### Next steps toward real hardware

- Replace `MockRobot` with a ROS 2 / robot-SDK bridge; keep the executor unchanged.
- Replace `MockWorld.observe()` with the perception source; keep `EmbodiedVerifier`.
- Add a PreToolUse hook enforcing "no embodied action while one is outstanding."
- Add an **independent** safety supervisor (§9).

---

## 9. Risks and blockers

Ordered by how much they should worry you.

1. **The LLM is not a safety controller.** Nothing here bounds forces, velocities,
   workspace limits, or collisions. Actuation limits, e-stop, watchdogs, and rate limits
   must live in a deterministic layer *below* the agent that cannot be reasoned around.
   The gate ensures honest feedback; it does not ensure safe motion.
2. **The gate is a convention, not an enforced invariant.** It holds because the executor
   blocks. A second embodied tool registered by someone who didn't read this document
   would not be gated. Mitigate with a PreToolUse interlock; upstream a generic
   pending-action gate if you need it enforced.
3. **Parallel tool calls.** `tool_concurrency_limit` defaults to `1`, so you are safe
   today — but a model can emit multiple tool calls per response, and raising that limit
   would run embodied actions concurrently. Keep it at 1, or declare a robot resource key
   via `DeclaredResources` so they serialize.
4. **Timeouts are yours to impose.** The SDK applies no timeout to a tool call. A verifier
   that hangs hangs the conversation. The PoC's `timeout_s` + fail-closed path is the
   minimum; production needs heartbeats so a long legitimate motion is distinguishable
   from a wedged one.
5. **Timeout ≠ rollback.** `SENSOR_TIMEOUT` means the physical outcome is *unknown*. The
   PoC is explicit about this. Never let unknown collapse into either success or
   "nothing happened."
6. **Replay and restart.** Conversations persist and resume. Never re-actuate a
   non-idempotent motion because an event was replayed — hence `idempotency_key` in the
   robot bridge, not in the agent.
7. **World-state races.** `observe()` is instantaneous in the mock. Real perception needs
   settling time and causal association with the action, or you verify a stale snapshot.
8. **Uncertainty is not boolean.** Low-confidence perception must fail closed or request
   another observation — never be coerced to `success=True`.
9. **API churn — already demonstrated.** The prior research document was invalidated
   between one revision and the next by a repo split and an architecture rewrite. Pin the
   SHA. Keep the integration inside `ToolExecutor` / `Action` / `Observation` / `CriticBase`,
   the most stable public surface, and add characterization tests (as in `poc/tests`) that
   fail loudly on upgrade.
10. **Session/transport timeouts.** A multi-minute physical action can exceed HTTP or UI
    timeouts in `openhands-agent-server` / Agent Canvas. Emit progress out-of-band without
    releasing the logical gate.

---

## 10. Conclusion

```
Can OpenHands realistically serve as the foundation
for an Embodied Coding Agent Harness?

YES
```

Not "yes with significant modifications" — **yes, with zero core modifications**, which
I verified by building it rather than by reading.

The decisive fact is that current OpenHands executes tools through a **synchronous
blocking call** inside `Agent.step()` (`agent/agent.py:1373`), and constructs the model's
next context **solely** from what that call returns. An executor that performs
`actuate → observe → verify` before returning is therefore not a bolt-on gate; it *is*
the loop's completion condition. The agent cannot advance past unverified physical state
because there is no code path by which it could.

Two further pieces of luck: the SDK already ships a **task-completion veto** (`CriticBase`
+ `IterativeRefinementConfig`) that maps cleanly onto final world-state validation, and
tool execution is **sequential by default**, so the concurrency hazard is opt-in rather
than opt-out.

The honest caveats: the gate is a convention enforced by the executor rather than an
invariant enforced by the loop, and none of this is a safety system. A shipping robot
needs an independent deterministic supervisor beneath the agent, and probably a small
upstreamed pending-action gate. Neither affects the research question.

Robot policy generation as `code → physical execution → verification → code revision` is
not merely possible on OpenHands. It is 630 lines, no fork, and it runs today.
