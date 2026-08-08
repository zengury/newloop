# OpenHands as an embodied coding-agent harness

> ## ⚠️ SUPERSEDED — retained for history only
>
> Superseded by **[`openhands-embodied-harness.md`](./openhands-embodied-harness.md)**,
> which is based on an actual checkout and a working proof-of-concept.
>
> This document was written without access to the OpenHands source (see its own
> "Research limitation" note below) and describes the **legacy v0 architecture**.
> Three of its load-bearing premises are wrong for current OpenHands:
>
> 1. **Wrong repository.** `All-Hands-AI/OpenHands` now redirects to
>    `OpenHands/OpenHands`, which is *Agent Canvas*, a TypeScript UI. The Python
>    agent loop moved to `OpenHands/software-agent-sdk`.
> 2. **`AgentController` and `EventStream` no longer exist.** Every
>    `openhands/controller/...`, `openhands/events/...` and `openhands/runtime/...`
>    path cited below is gone from the mainline.
> 3. **The recommended integration point is not implementable.** "A custom Runtime
>    that withholds a terminal observation from the EventStream" has no analogue:
>    there is no Runtime abstraction and no EventStream. Tools are executed inline
>    inside `Agent.step()`.
>
> Its *conclusion* (YES) and much of its risk analysis happen to be correct, and
> the correct integration point turns out to be simpler than the one proposed here.
> Ironically, its own final risk — "API churn: pin versions" — is exactly what
> invalidated it.

**Research date:** 2026-08-08  
**Upstream examined:** the public `All-Hands-AI/OpenHands` architecture and its
documented event model. Upstream source links below deliberately target `main`;
an implementation should pin a commit before coding because OpenHands is moving
functionality into separately versioned SDK/runtime packages.

> **Research limitation.** This workspace contains no OpenHands checkout and its
> network proxy rejected GitHub access. Consequently this is an architecture and
> integration recommendation, not a claim that the paths below were compiled at
> one immutable upstream SHA. The first proof-of-concept task is therefore to pin
> an upstream revision and turn the path/method inventory into executable
> characterization tests.

## Executive answer

**YES.** OpenHands can realistically be the orchestration foundation for an
embodied coding-agent harness. Its action/observation `EventStream` already puts
an asynchronous boundary between agent reasoning and runtime execution. The
least invasive prototype is a custom embodied `Action`/`Observation` pair plus a
runtime executor that does not publish the terminal observation until external
world verification finishes. Because the controller advances in response to
events, withholding that terminal observation closes the loop without changing
the reasoning algorithm.

This answer has an important scope qualifier: an EventStream convention is not
the same as a safety interlock. For a safety-critical robot, an independent robot
supervisor must enforce actuation limits and the no-progress invariant. A small
controller change may ultimately be warranted to make “one outstanding embodied
action” a checked invariant across cancellation, reconnection, replay, and buggy
runtimes. It is not necessary to prove the concept.

## 1. Current architecture and call flow

The useful upstream source entry points are:

| Concern | Primary location | Relevant responsibility |
|---|---|---|
| Orchestration | [`openhands/controller/agent_controller.py`](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/controller/agent_controller.py) | `AgentController` owns `State`, subscribes to events, runs the step loop, calls the agent, publishes actions, applies observations, handles stop/pause/error/finish state. |
| Agent contract | [`openhands/controller/agent.py`](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/controller/agent.py) | `Agent.step(state) -> Action` is the reasoning/action-generation boundary. |
| Default reasoning agent | [`openhands/agenthub/codeact_agent/codeact_agent.py`](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/agenthub/codeact_agent/codeact_agent.py) | `CodeActAgent.step` constructs model input from state/history, calls the LLM, and converts the response to one or more actions. |
| Conversation projection | [`openhands/memory/conversation_memory.py`](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/memory/conversation_memory.py) | Projects EventStream history into messages/tool results visible to the LLM. This is how observations become subsequent model context. |
| State/history | [`openhands/controller/state/state.py`](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/controller/state/state.py) | Stores iteration counters, agent state, history and limits used by the controller/agent. |
| Event transport | [`openhands/events/stream.py`](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/events/stream.py) | `EventStream.add`, subscriber registration and ordered action/observation delivery. Event `cause` links an observation to its action. |
| Event base types | [`openhands/events/action/action.py`](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/events/action/action.py), [`openhands/events/observation/observation.py`](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/events/observation/observation.py) | Serializable `Action` and `Observation` contracts. |
| Finish/reject | [`openhands/events/action/agent.py`](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/events/action/agent.py) | Agent-control actions such as finish/reject/state change. |
| Runtime boundary | [`openhands/runtime/base.py`](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/runtime/base.py) | Runtime subscribes to executable actions, dispatches execution, and publishes the resulting observation. |
| Concrete runtime | [`openhands/runtime/impl/docker/docker_runtime.py`](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/runtime/impl/docker/docker_runtime.py) | Example environment implementation for sandbox execution and lifecycle. |
| Action confirmation | [`openhands/security/action_confirmation.py`](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/security/action_confirmation.py) | Confirmation status/mode used to pause an action for user approval; useful precedent, but not world verification. |

Names and package boundaries have changed between OpenHands releases. In newer
distributions, equivalent event, agent, tool, conversation, and workspace
contracts may live in `openhands-sdk`, while execution/server concerns may live
in `openhands-agent-server`. The architectural seam remains agent -> event ->
runtime -> event -> conversation.

### Concrete normal-path sequence

1. A session constructs an `EventStream`, `Runtime`, `Agent`, and
   `AgentController`; controller and runtime subscribe to the stream.
2. A user `MessageAction` enters the stream. The controller records the event in
   `State` and schedules/permits a step when the agent is `RUNNING`.
3. `AgentController` calls `await agent.step(state)`. For CodeAct, `step`
   projects relevant history through conversation memory, invokes the configured
   LLM, parses its response, and returns an `Action`.
4. The controller increments/checks iteration and budget limits, establishes the
   action's causal link, and appends it to the EventStream as an agent event.
5. The runtime receives executable actions (shell, file, browser, etc.), executes
   them in its environment, converts output/error into an `Observation`, sets the
   observation's `cause` to the action event, and appends it to the EventStream as
   an environment event.
6. The controller receives the observation and updates state. On the next step,
   conversation memory renders that observation as model-visible input. The LLM
   can repair or produce the next action.
7. `AgentFinishAction` is the normal model-selected termination. Reject, fatal
   error, iteration/budget exhaustion, user stop, cancellation, and controller
   state transitions are alternate terminal paths.

The critical property is that **the runtime, not the agent, supplies execution
truth**. A robot verifier belongs on that side of the boundary.

## 2. Best interception point

### Recommendation: a typed action/observation pair executed by a runtime extension

Use:

* `EmbodiedAction`: a model/tool-call-visible request containing the robot command
  and an explicit, machine-checkable expected state;
* `EmbodiedObservation`: the *single terminal result* containing command outcome,
  observed world state, verification outcome, confidence, and diagnostics; and
* `EmbodiedRuntime` (or an action executor registered with the current runtime):
  dispatch to robot/simulator, await world observation, invoke the verifier, then
  publish the `EmbodiedObservation`.

Do not publish an ordinary successful execution observation between actuation and
verification. The controller could interpret it as completion and take another
step. Telemetry/progress may be stored out of band, or emitted only through an
event type that is explicitly non-terminal and cannot schedule agent progress.

An Observation alone is insufficient: it represents feedback well but does not
define dispatch or carry `expected_state`. Middleware around execution is a good
internal implementation detail but a poor public contract. An Environment-only
extension hides semantics from history. An EventStream hook is too generic and
risks ordering/replay bugs. A controller modification provides the strongest
global enforcement, but is unnecessary for the minimum experiment.

### The gate's contract

An embodied action has exactly one outstanding lifecycle:

```text
REQUESTED -> EXECUTING -> OBSERVING -> VERIFYING -> VERIFIED | FAILED | CANCELLED
```

Only `VERIFIED`, `FAILED`, or `CANCELLED` produces the terminal observation that
releases the controller. Failure is still an observation: it must return actual
state to the LLM so it can replan. “Failed verification” means “do not assume the
requested state transition happened,” not “silently retry” and not “deadlock.”

The prototype should also reject a second embodied action while one is pending,
deduplicate action IDs, apply timeouts, and fail closed on verifier exceptions.

## 3. Existing mechanisms and robotics reuse

| Mechanism | What OpenHands provides | Robotics verdict |
|---|---|---|
| Asynchronous actions | EventStream decouples controller and runtime; execution handlers are asynchronous. | **Reuse.** Keep an embodied action pending while actuation/verification awaits I/O. Confirm with a pinned-version concurrency test. |
| Long-running actions | Shell/browser/runtime operations can run for extended periods and support timeout/cancellation patterns. | **Reuse with extension.** Add robot timeout, heartbeat and emergency-stop semantics; never equate timeout with physical rollback. |
| External tool execution | Runtime/tool abstractions execute outside the LLM and return typed results. | **Direct fit.** A simulator or robot bridge is an external tool/executor. |
| Execution callbacks | Runtime action subscription and EventStream publication are the effective callbacks. | **Reuse internally.** There is no reason to expose arbitrary callbacks as the embodied API; publish one causal observation. |
| Human confirmation | Action confirmation can pause risky actions pending approval. | **Pre-action only.** Useful for authorization, but approval does not prove a post-action world state. Keep both gates separate. |
| Action rejection | Agent reject/control actions and rejected confirmation paths exist. | **Partial reuse.** Authorization rejection differs from verifier failure; retain distinct structured status. |
| Retry | The agent can observe errors and emit a revised/repeated action; some infrastructure operations retry. | **Do not automatically reuse for motion.** Retry must be idempotency-aware and model/world-state-informed. |
| Error observations | Typed error/command observations enter history and become model context. | **Reuse.** Verifier exceptions/timeouts become explicit embodied failure observations containing last known state. |
| Environment state | Runtime owns workspace/sandbox state; `State` owns conversation/control state. | **Extend, do not overload.** World state belongs in the embodied observation/world-state store, not controller `State` as mutable truth. |
| Task completion verification | The agent normally chooses finish; evaluation harnesses may score a completed task. | **Insufficient.** Inter-action physical verification must precede every dependent step; add a final task validator too. |
| Custom runtimes | Runtime implementations provide alternate execution backends. | **Best integration seam.** A composite runtime can delegate coding actions to the sandbox and embodied actions to the robot bridge. |
| Custom observation sources | Environment-originated observations are first-class EventStream events. | **Reuse carefully.** Correlate by action ID and distinguish progress/telemetry from the one terminal gate event. |

Two existing features must not be mistaken for the requirement. User
confirmation answers “may this action start?”; world verification answers “what
actually happened?” Likewise an exit code proves only that a robot command was
accepted, not that the physical state changed.

## 4. Minimum interface

The verifier should be domain-independent, asynchronous (sensors may take time),
and serializable at its boundary. It need not know about the LLM or EventStream.

```python
from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol

JsonObject = Mapping[str, Any]

@dataclass(frozen=True)
class VerificationResult:
    success: bool
    observation: str
    structured_state: JsonObject | None = None
    confidence: float | None = None
    reason_code: str | None = None

@dataclass(frozen=True)
class EmbodiedActionPayload:
    command: str
    arguments: JsonObject = field(default_factory=dict)
    expected_state: JsonObject = field(default_factory=dict)
    idempotency_key: str = ""

class EmbodiedVerifier(Protocol):
    async def verify(
        self,
        *,
        action: EmbodiedActionPayload,
        execution_result: JsonObject,
        observed_state: JsonObject,
    ) -> VerificationResult: ...
```

`reason_code` is the only addition to the prompt's example: a stable code such as
`STATE_MISMATCH`, `LOW_CONFIDENCE`, or `SENSOR_TIMEOUT` lets policy logic avoid
parsing prose. Do not put retry policy, actuation, perception, or LLM calls in the
verifier. Validate `0 <= confidence <= 1` when present. Production schemas should
use JSON-safe immutable snapshots and schema/version identifiers.

The terminal `EmbodiedObservation` should expose at least:

```python
EmbodiedObservation(
    action_id=action.id,
    execution_result=execution_result,
    expected_state=action.expected_state,
    observed_state=observed_state,
    verification=verification_result,
    cause=action_event_id,
)
```

## 5. Current loop versus embodied loop

### Current OpenHands loop

```text
AgentController._step
  -> Agent.step(State)
       -> history -> LLM -> Action
  -> EventStream.add(Action, source=AGENT)
  -> Runtime receives Action
       -> execute in sandbox
       -> EventStream.add(Observation, source=ENVIRONMENT, cause=Action)
  -> AgentController receives Observation and schedules/allows next step
  -> conversation memory includes Observation on the next Agent.step
  -> repeat, or AgentFinishAction / limit / stop terminates
```

### Proposed embodied loop

```text
AgentController._step
  -> Agent.step(State)
       -> LLM -> EmbodiedAction(command, expected_state)
  -> EventStream.add(EmbodiedAction, source=AGENT)
  -> EmbodiedRuntime receives action
       -> robot_bridge.execute(command)             [no terminal event yet]
       -> world_source.observe()                    [no terminal event yet]
       -> verifier.verify(expected, actual)         [gate]
       -> EventStream.add(
            EmbodiedObservation(actual, verification),
            source=ENVIRONMENT,
            cause=EmbodiedAction,
          )
  -> only now may AgentController schedule/allow the next step
       -> success: model may continue from verified state
       -> failure: model sees actual state/reason and revises policy
  -> final task verifier must pass before finish is accepted
```

For a strict prototype, also wrap/guard `AgentFinishAction`: a robot task cannot
terminate successfully unless the latest task-level verification passes. This is
distinct from per-action gating.

## 6. Integration choices, ranked

1. **Custom/composite Runtime plus typed events — best.** Small, aligned with the
   execution boundary, keeps robot credentials and I/O out of the agent, and
   preserves normal observation feedback. Maintenance is mostly adapting to the
   runtime/event API. Deploy the verifier beside the robot bridge, not in the LLM
   process.
2. **OpenHands extension/tool/plugin — good if the pinned release exposes a stable
   registration API.** Lowest distribution friction and can package schemas,
   prompt/tool description and executor together. Its weakness is enforcement:
   a generic plugin may not prevent unrelated actions or premature finish. Pair
   it with runtime-level gating.
3. **Custom Agent — useful companion, not the gate.** It can reliably generate
   structured expected states and understand failure observations. It cannot be
   trusted to enforce physical sequencing because it is the component being
   gated. It increases prompt/parser maintenance.
4. **Thin wrapper around an OpenHands session — acceptable spike.** Fast to mock,
   but risks racing the internal controller, losing causal/replay semantics, and
   confusing UI state. Use only if the public runtime extension surface cannot
   load custom events.
5. **Core `AgentController` fork — worst initially, possibly appropriate for a
   hardened product.** It gives a formal pending-action barrier and finish guard,
   but touches rapidly changing orchestration code and creates the largest merge,
   test and security burden. Prefer an upstreamable generic “completion gate”
   hook over a robotics-specific fork.

An Environment extension alone ranks below a runtime because environment state
does not own the controller's action-completion protocol. An EventStream hook
alone ranks last: it is cross-cutting, easy to bypass, and hard to make correct
under replay.

## 7. Licensing

The upstream repository publishes the [MIT License](https://github.com/All-Hands-AI/OpenHands/blob/main/LICENSE).
Subject to confirming the license at the exact pinned revision, MIT permits use,
copying, modification, private forks, sublicensing, sale, and redistribution,
including as part of a commercial robotics product. Source disclosure and
publication of private modifications are not required.

The operative condition is to include the upstream copyright notice and MIT
permission notice in copies or substantial portions of the software. Therefore:

* modifying the controller/runtime is allowed;
* distributing a proprietary product incorporating it is allowed;
* maintaining a private fork is allowed; and
* redistributing modified components is allowed with the notice/license retained.

This is not legal advice. Audit the dependency lockfiles and bundled assets
separately: dependencies, model weights, datasets, logos/trademarks, hosted model
terms, and robot SDKs can have different licenses. MIT contains an “as is”
warranty/liability disclaimer and provides no robotics safety certification.
Preserve attribution in binary distributions (for example, a third-party notices
file), document local modifications, and obtain counsel for product release.

## 8. Minimal proof of concept

### Scenario

Use a deterministic in-memory world:

```text
initial:  {"A": "table"}
action:   move_object(object="A", destination="B",
                      expected_state={"A": "B"})
executor: configured to move, fail, or acknowledge-without-moving
observe:  snapshot the in-memory world
verify:   observed["A"] == expected["A"]
```

On acknowledge-without-moving, the command result is “accepted” while world
state remains `{"A": "table"}`. The essential assertion is that no second
`Agent.step` occurs before the verifier releases a terminal observation. After
release, the next model input must contain both the mismatch and actual state.

### Suggested files after pinning OpenHands

Prefer an out-of-tree package where supported:

```text
embodied_openhands/events.py          # EmbodiedAction/Observation       ~50 LOC
embodied_openhands/verifier.py        # protocol and result              ~35 LOC
embodied_openhands/runtime.py         # dispatch/observe/gate            ~90 LOC
embodied_openhands/mock_world.py      # deterministic robot/world        ~45 LOC
tests/test_embodied_gate.py           # ordering, failure, timeout       ~120 LOC
```

Expected total: **220-340 lines** plus registration glue (roughly 20-60 lines,
version-dependent). If current runtime dispatch is a closed type switch, add a
small upstream registration branch or subclass override. No controller change is
expected for the spike. A hardened pending-action/finish guard would likely add
roughly 40-100 controller lines plus substantially more lifecycle tests.

### Characterization and acceptance tests

1. **Ordering:** block the verifier on an `asyncio.Event`; assert the runtime did
   not publish a terminal observation and `Agent.step` call count stays at one.
2. **Verified success:** release `success=True`; assert exactly one causal
   `EmbodiedObservation`, then allow the next step.
3. **Physical mismatch:** executor acknowledges but does not move; assert the next
   model context contains expected state, observed state, and `STATE_MISMATCH`.
4. **Timeout/exception:** assert fail-closed observation, no assumed state change,
   and no automatic physical retry.
5. **Duplicate/replay:** deliver the same action twice; assert one actuation via
   `idempotency_key` and one terminal lifecycle.
6. **Concurrent action:** inject a second embodied action while pending; assert it
   is rejected/queued and never executes concurrently.
7. **Premature finish:** emit finish while physical verification is pending or the
   final task validator fails; assert successful termination is refused.
8. **Cancellation:** stop during movement; assert controller state and actual
   last-known world state are reported without claiming rollback.

### Pseudocode executor

```python
async def run_embodied_action(action, event_stream):
    # No model-visible completion is published in this block.
    try:
        execution = await robot.execute(action.payload,
                                        key=action.idempotency_key)
        observed = await world.observe(after=execution)
        result = await verifier.verify(
            action=action.payload,
            execution_result=execution,
            observed_state=observed,
        )
    except Exception as exc:
        observed = await world.last_known_state()
        result = VerificationResult(
            success=False,
            observation=f"Verification failed closed: {type(exc).__name__}",
            structured_state=observed,
            reason_code="VERIFIER_ERROR",
        )

    await event_stream.add(
        EmbodiedObservation(
            action_id=action.id,
            execution_result=execution if "execution" in locals() else {},
            expected_state=action.expected_state,
            observed_state=observed,
            verification=result,
            cause=action.id,
        ),
        source=EventSource.ENVIRONMENT,
    )
```

## 9. Risks and architectural blockers

* **No absolute controller-level barrier:** the proposal relies on the runtime
  emitting no premature terminal observation. A buggy plugin can violate this.
* **Multiple actions per model response:** tool-call batching or parallel actions
  must be disabled or serialized for embodied commands unless independence is
  proven. Verify the pinned agent/controller behavior.
* **Unsolicited events:** user messages, telemetry, reconnections, or unrelated
  observations might trigger stepping depending on the release. Characterize and
  explicitly whitelist which event completes the pending action.
* **Finish semantics:** normal `AgentFinishAction` is a claim, not external task
  verification. Add a final-state gate.
* **Event durability/replay:** after restart, distinguish requested, executed, and
  verified states. Never repeat non-idempotent motion merely because an event is
  replayed.
* **World-state races:** a sensor snapshot must be causally associated with the
  action and sufficiently settled; timestamps/action IDs and stabilization rules
  are required.
* **Uncertainty:** low-confidence perception cannot be coerced into Boolean
  success. The simple result supports confidence, but policy must fail closed or
  request another observation.
* **LLM is not a safety controller:** authorization, collision avoidance,
  emergency stop, rate limits, workspace bounds, and watchdogs must remain in an
  independent deterministic layer.
* **Backpressure and timeout:** long physical actions can exceed web/session
  timeouts. The runtime needs heartbeat/progress visibility without releasing the
  logical gate.
* **API churn:** current OpenHands packaging is evolving. Pin versions, isolate an
  adapter, and test event scheduling rather than depending on private methods.

## Conclusion

```text
Can OpenHands realistically serve as the foundation
for an Embodied Coding Agent Harness?

YES
```

The decisive architectural fact is its typed, causal action/observation runtime
boundary. Treat “execute + observe + verify” as one asynchronous runtime
transaction and publish exactly one terminal `EmbodiedObservation`; the agent's
next turn then naturally receives physical ground truth instead of a mere command
acknowledgement. This proves the desired code -> physical execution -> world
verification -> code revision cycle with a few hundred lines and no initial core
fork. A production robot should add an independent safety supervisor and likely a
generic controller-level pending-action/final-completion gate, ideally upstreamed
rather than carried as a robotics-specific fork.
