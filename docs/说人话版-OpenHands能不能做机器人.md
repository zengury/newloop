# OpenHands 能不能拿来做机器人的"具身智能体"?

**结论:能。而且比想象中简单——一行核心代码都不用改。**

我没有只是读代码猜结论,我把它**真的写出来跑通了**:11 个测试全过,OpenHands 源码一个文件都没改。
代码在 [`poc/`](../poc) 目录,不用 API key、不用联网、不用真机器人,直接就能跑。

> 英文详细版在 [`openhands-embodied-harness.md`](./openhands-embodied-harness.md),
> 这份是给人看的白话版。

---

## 一、先说个坏消息:之前那份调研报告作废了

仓库里原来有一份调研 [`openhands-embodied-verification.md`](./openhands-embodied-verification.md)。
它的结论(能做)是对的,但**它说的那套代码结构已经不存在了**。

那份报告开头自己就写了:"当前环境没有 OpenHands 代码,网络也访问不了 GitHub"。
所以它是靠记忆和文档推测写的。现在我拉到了真代码,发现三件事:

1. **仓库搬家了。** `All-Hands-AI/OpenHands` 现在跳转到 `OpenHands/OpenHands`,
   而这个仓库已经**不是 Python 智能体了**,它变成了 **Agent Canvas**——一个 TypeScript 写的前端控制台。
   整个仓库里只有 4 个 Python 文件,没有一个是智能体循环。
   真正的智能体代码搬到了另一个仓库:`OpenHands/software-agent-sdk`。

2. **`AgentController` 和 `EventStream` 这两个类,现在压根不存在了。**
   老报告里引用的每一个路径(`openhands/controller/...`、`openhands/events/...`、
   `openhands/runtime/...`)在新代码里都找不到。

3. **它推荐的方案没法实现。** 老方案是"写一个自定义 Runtime,让它先别把执行结果发到 EventStream 上"。
   问题是:现在既没有 Runtime 这个概念,也没有 EventStream。工具是**直接在 `Agent.step()` 里同步执行的**。

有点讽刺的是,那份报告自己列的最后一条风险就是"OpenHands 接口变动快,记得锁版本"——
结果就是这条把它自己干掉了。

我没有删除它,只是在开头加了"已作废"的说明,保留下来当历史记录。

---

## 二、现在的循环长什么样

### 一句话版本

老架构:智能体把动作**扔进一个消息流**,另一个进程订阅、执行、再把结果**扔回消息流**。
新架构:智能体**直接调用一个函数**,等它返回。

对我们来说,**新架构反而好办太多了**。老架构要卡住循环,你得在跨进程的异步协议里做文章;
新架构只要让一个普通函数**先别返回**就行了。

### 关键的那一行

```python
# openhands/sdk/agent/agent.py:1373
observation = tool(action_event.action, conversation)
```

这行代码干了三件事,每一件都对我们有利:

1. 它是**同步阻塞**的。这个函数不返回,`Agent.step()` 就没法结束,外层的 `while` 循环就进不了下一轮。
2. 大模型下一轮能看到的内容,**完全**由这个函数的返回值决定。
3. 它是公开的扩展接口——OpenHands 官方文档就是教你这么加自定义工具的。

**所以:只要你写的工具执行器,在"发指令 → 看世界 → 验证"这三步都做完之前不返回,
它本身就是那道物理验证的闸门。** 这就是整个结论。

不是"我们想办法卡一下",而是**智能体压根没有别的路可走**。

### 完整调用链(想细看的话)

```
LocalConversation.run()                    conversation/impl/local_conversation.py:1850
└─ while True:                                                                    :1878
   ├─ agent.step()                                                                :1938
   │  └─ Agent.step()                              agent/agent.py:637
   │     ├─ 组装历史消息 → 调大模型                        :675      ← 推理
   │     └─ _handle_tool_calls()                   response_dispatch.py:143
   │        ├─ _get_action_event()                 agent/agent.py:1189  ← 生成动作
   │        ├─ _requires_user_confirmation()       agent/agent.py:1015  ← 人工确认(可选)
   │        └─ _execute_actions()                  agent/agent.py:571
   │           ├─ tool(action, conversation)       agent/agent.py:1373
   │           │   ★★★ 闸门在这里 ★★★
   │           ├─ batch.emit() → ObservationEvent  agent/agent.py:312   ← 收集观测
   │           └─ batch.finalize()                 agent/agent.py:341
   │              └─ 评审员可以否决"完成"            critic_mixin.py:76
   └─ 检查:预算 / 最大轮数(默认 500) / 暂停 / 卡死
```

对照你问的几项:

| 你要找的 | 在哪 |
|---|---|
| 大模型推理 | `Agent.step()` — `agent/agent.py:637` |
| 生成动作 | `_get_action_event` — `agent/agent.py:1189` |
| 执行动作 | `tool(action, conversation)` — `agent/agent.py:1373` |
| 收集观测 | `_ActionBatch.emit` — `agent/agent.py:312` |
| 观测喂回模型 | `Observation.to_llm_content` → 下一轮的消息 |
| 决定要不要再来一轮 | `while True` — `local_conversation.py:1878`。**注意:没有"要不要继续"的判断,继续是默认行为**,靠 break 退出 |
| 结束任务 | `FinishTool` → `mark_finished()` — `agent/agent.py:341` |

---

## 三、该在哪插入验证?

### 答案:写一个 `ToolExecutor`。就这样。核心代码零改动。

你在需求里列了一堆候选(新 Observation 类型、Action/Observation 对、执行中间件、
Environment 扩展、Runtime 扩展、EventStream 钩子、改 AgentController)。

**正确答案不在这个列表里**,因为这个列表是照着老架构列的。

| 候选方案 | 结论 |
|---|---|
| **自定义 `ToolExecutor`** | ✅ **就用这个。** 零核心改动,天然阻塞,返回内容完全你说了算。已跑通。 |
| **`CriticBase`(评审员)做任务级验证** | ✅ **配合上面一起用。** 现成的,见下一节。已跑通。 |
| 只加一个 Observation 类型 | 不够。Observation 只是返回值,它没法承载"预期状态"、也决定不了怎么执行。要和执行器一起用。 |
| 执行中间件 | **没有这个缝。** `_execute_action_event` 直接调工具。想插只能继承 `Agent`,不如直接写执行器。 |
| Environment 扩展 | **没这个概念。** `Workspace` 管的是"文件放哪",不管动作分发。 |
| Runtime 扩展 | **Runtime 类不存在了。** 远程执行的做法是把整个会话跑在 `openhands-agent-server` 上,那不是执行拦截点。 |
| EventStream 钩子 | **EventStream 不存在了。** 最接近的是 `callbacks`,但它是**纯观察性的**——触发时观测已经生成并记录完了,来不及改模型看到什么。 |
| 改 `AgentController` | **这个类不存在。** 对应的是 `LocalConversation.run()`,但没必要动它。 |
| **`PostToolUse` 钩子** | ❌ **这是个坑**,见下。 |

### ⚠️ 一个看起来很对、实际没用的坑

"动作执行完之后检查一下世界状态"——听起来 `PostToolUse` 钩子就是干这个的对吧?

**它不行。** 看 `hooks/conversation_hooks.py:220-241`:

```python
results = self.hook_manager.run_post_tool_use(...)
for hook, result in zip(hooks, results, strict=False):
    self._emit_hook_execution_event(...)
    if result.error:
        logger.warning(f"PostToolUse hook error: {result.error}")
```

**钩子返回的判断结果被直接丢掉了。** 只用来发个日志事件。

对比一下 `PreToolUse`(`:162-176`),它是会调 `state.block_action(...)` 真的拦截的。
但 `PostToolUse` 没有任何途径去阻断、重试、或者往模型的上下文里塞反馈。**它就是个埋点。**

这个坑值得单独说,因为它是最容易踩的那个选择。

---

## 四、OpenHands 现成有哪些东西能复用?

| 能力 | 有吗 | 机器人场景能用吗 |
|---|---|---|
| 异步动作 | 有(`arun`/`astep`) | ✅ 能用。等传感器 I/O 时不占线程,闸门照样关着。 |
| 长时间动作 | 有,而且**不设超时** | ✅ 能用,但**超时得你自己加**。`ToolExecutor.interrupt()` 会被跨线程调用,正好拿来做急停。 |
| 外部工具执行 | 有(`ToolExecutor`、MCP) | ✅ 完全对口。机器人桥接就是个执行器。机器人栈不是 Python 的话,走 MCP。 |
| 执行回调 | 有,但只读 | ⚠️ **只能做监控,不能当闸门。** 触发时已经晚了。 |
| 人工确认 | 有 | ⚠️ **回答的是另一个问题。** 它问"这个动作能不能开始",我们要问"实际发生了什么"。但它证明了**循环是可以被卡住的**,是个好先例。两个都要。 |
| 动作拒绝 | 有(PreToolUse → `UserRejectObservation`) | ✅ **拿来做互锁。** 比如"上一个机器人动作还没验证完,不许发第二个",拒绝理由会传给模型。 |
| 自动重试 | 没有(靠模型自己重新规划) | ✅ **这样才对。** 千万别给物理动作加盲目重试。幂等键要放在机器人桥接层。 |
| 错误观测 | 有 | ✅ 能用,但**验证失败应该是"正常观测"而不是"错误"**——模型要看到结构化的世界状态,不是异常堆栈。 |
| 环境状态 | 半有 | ⚠️ `Workspace` 是文件系统,`ConversationState` 是对话状态,**都不是物理世界状态**。世界状态放你自己的观测里,别硬塞进去。 |
| **任务完成验证** | ✅ **有,而且正是你要的** | ✅ **直接用。**`CriticBase` + `IterativeRefinementConfig`:模型调 `finish` 时评审员打分,低于阈值就**拒绝结束**,并自动塞一条追问消息让它接着干,还有最大次数兜底。把它指向"观测到的世界状态"就变成了物理任务验证器。已跑通。 |
| 自定义 Runtime | ❌ 没了 | 不需要。 |
| 自定义观测源 | 有 | ✅ 这就是真值送进模型的通道。 |
| **并发控制** | 有,**默认串行** | ✅ **意外之喜。** `tool_concurrency_limit` 默认是 1。万一以后调大了,用 `DeclaredResources` 声明个 `"robot:arm0"` 资源键,机器人动作就会自动串行。 |

---

## 五、最小接口设计

就这么点东西(`poc/embodied_openhands/verifier.py`,145 行,**不 import 任何 OpenHands 的东西**):

```python
@dataclass(frozen=True)
class VerificationResult:
    success: bool                                # 唯一用来卡循环的字段
    observation: str                             # 给模型读的话
    structured_state: JsonObject | None = None   # 真实世界状态,供重新规划
    confidence: float | None = None
    reason_code: str = REASON_OK                 # STATE_MISMATCH / SENSOR_TIMEOUT / ...

@dataclass(frozen=True)
class EmbodiedActionPayload:
    command: str
    arguments: JsonObject = ...
    expected_state: JsonObject = ...             # 关键:必须说清楚"预期变成什么样"
    idempotency_key: str = ""

class EmbodiedVerifier(Protocol):
    def verify(self, *, action, execution_result, observed_state) -> VerificationResult: ...
```

比你给的草稿多了两个字段,都是必要的:

- **`expected_state`(预期状态)**:不写清楚"预期是什么",验证就没有意义。
  **逼着大模型把意图写成可机检的形式,这本身就是价值。**
- **`reason_code`(原因码)**:让代码能判断,不用去解析自然语言。
  "机器人撒谎了"(`STATE_MISMATCH`)和"不知道发生了啥"(`SENSOR_TIMEOUT`)
  是完全不同的两种情况,处理方式也不一样。

验证器有三条纪律:**不许发指令、不许重试、不许调大模型。** 它只负责下判断。

---

## 六、两个循环对比

### 现在(写代码的智能体)

```
Agent.step()
  └─ 大模型 → 工具调用
       └─ tool(action) ──────► 沙箱执行
                    ◄────────── Observation(退出码、stdout)
       └─ 进入下一轮的上下文
```

问题:**观测是"命令对自己的汇报"**。写代码没啥问题,机器人就要命了——
`accepted: true` 只证明控制器**收到了**指令,不证明物体真的动了。

### 改成(具身智能体)

```
Agent.step()
  └─ 大模型 → 工具调用(指令 + 预期状态)      ← 意图显式、可机检
       └─ tool(action)  ═══ 一个原子事务,中间什么都不往外发 ═══
            ├─ robot.execute(...)   → 执行结果      (不可信的自述)
            ├─ world.observe()      → 观测状态      (真值)
            └─ verifier.verify(预期, 实际) → 验证结论
          ◄─ 只返回一个终态观测 {是否通过, 预期, 实际, 原因}
       └─ 进入下一轮的上下文
  ── 上面这一坨不返回,循环物理上就走不下去 ──

  模型想 finish 时:
       └─ WorldStateCritic 打分
            分数不够 → 拒绝结束,自动追问,模型重新规划
```

两个关键差别:

1. **发指令和验证之间,什么都不往外发。** 不存在一个"命令已接受"的观测让模型误以为成功了。
2. **模型下一轮看到的是现实,不是机器人的自述**——两者不一致时,把不一致明明白白写出来。

---

## 七、要不要 fork?——排序

| 排名 | 方案 | 要改核心吗 | 结论 |
|---|---|---|---|
| **1** | **自定义 `ToolExecutor` + 类型化的 Action/Observation** | **不用** | ✅ **最佳。** 正好卡在执行边界上,机器人的凭证不进智能体进程。要维护的接口是 OpenHands 最稳定的公开 API(官方示例就是这么写的)。**已验证。** |
| **2** | **`CriticBase` 子类做任务完成验证** | **不用** | ✅ **和 1 一起用。** 天生就是干"否决+重来"的,还自带次数上限。**已验证。** |
| **3** | **`PreToolUse` 钩子做互锁** | 不用 | ✅ 好补充。强制"上一个动作没验证完不许发下一个"。 |
| **4** | 自定义 `Agent` 子类 | 不用但耦合内部 | ⚠️ 只用来调教提示词(教模型写好 `expected_state`)。**永远别让智能体自己守自己的门——它就是被守的那个。** |
| **5** | 自定义 `Workspace` / 部署 agent-server | 不用 | ⚪ 正交问题。解决"循环跑在哪"(比如跑在机器人边缘机上),不解决卡门。 |
| **6** | 在外面包一层驱动 `Conversation` | 不用 | ⚠️ 看着诱人其实是错的。你会重新实现一遍步进逻辑、丢掉因果关联、还跟内部循环抢时序。 |
| **7** | fork 核心循环 | 大改 | ❌ **没必要。** 为了一个执行器就能提供的屏障,去背一个 3000 行高频变动文件的合并成本。 |

**维护成本总结:** 方案 1–3 全部在树外,你的代码只是把 `openhands-sdk` 当依赖锁死,升级节奏自己定。
`poc/` 里没有一处碰 SDK 内部实现,所以升级面就是几个公开符号。

**如果以后需要"硬保证"**(不是靠约定,而是循环层面强制"有未验证的物理动作时任何一步都不许走",
能防住写错的插件、事件重放、断线重连)——那是 `LocalConversation.run()` 里大约 40–100 行的改动。
建议**作为通用的"待完成动作闸门"提给上游**,而不是自己维护一个机器人专用 fork。
原型阶段不需要,单机器人单会话的产品也不需要。要做安全认证时才有意义。

---

## 八、许可证:能商用,但有个小雷

**两个仓库都是 MIT**(我在锁定的那个 commit 上确认过):

- `OpenHands/software-agent-sdk` — MIT, "Copyright (c) 2026 OpenHands contributors"
- `OpenHands/OpenHands`(Agent Canvas)— MIT, "Copyright © 2025 OpenHands contributors"

| 你问的 | 答案 |
|---|---|
| 改核心循环 | ✅ 可以 |
| 基于它做商业机器人产品并分发 | ✅ 可以 |
| 维护私有 fork | ✅ 可以,**没有开源义务** |
| 再分发修改过的组件 | ✅ 可以,保留声明即可 |

唯一义务:**在副本或实质性部分中附上 MIT 版权声明和许可声明**。
做成固件/二进制产品的话,带一个第三方声明文件。

### 依赖扫描(真正的限制在这里)

我扫了实际解析出来的依赖树:

- ✅ **`openhands-sdk` 的运行时依赖里没有任何 copyleft 许可证。** 干净。
- ⚠️ **`openhands-tools` 引入了 `func-timeout`(LGPL-2.1),而且是运行时依赖。**
  这对闭源分发不是硬伤(纯 Python 的 LGPL 一般保持可替换模块 + 给出声明就能满足),
  但需要有意识地决策,尤其是要静态打包到嵌入式设备上的话。
  **PoC 只 import `openhands-sdk`,完全绕开了这个问题。** 如果你不需要它自带的终端/文件编辑工具,建议就这么干。
- `pyinstaller`(GPL-2.0)只在 **dev 组**,是构建工具,不参与分发。
- `litellm` 在工作区层面被锁死在 `==1.93.0`;另外你接哪家托管模型,**那家的服务条款**是另一回事(和许可证无关)。

MIT 不提供任何担保和责任承诺,更不提供机器人安全认证。
**这是工程判断,不是法律意见**,产品发布前请让法务过一遍。

---

## 九、概念验证:已经建好并跑通了

你要的是一份"计划"。但因为架构比预想的简单,我**直接把它写出来了**。

```
poc/
├── embodied_openhands/
│   ├── verifier.py   145 行   验证结果 / 验证器协议 / 参考实现
│   ├── world.py      118 行   假世界 + 假机器人(三种模式:正常 / 失败 / 撒谎)
│   ├── tool.py       243 行   闸门执行器 + 类型化的动作/观测
│   ├── critic.py      94 行   世界状态评审员——任务级闸门
│   └── __init__.py    30 行
├── tests/            464 行   11 个测试
└── demo.py           127 行   可直接跑的演示
```

**总计 630 行实现 + 464 行测试。改动的 SDK 文件数:0。**

### 最关键的场景:机器人撒谎

真正要命的失败模式是:**机器人回报成功,但东西根本没动**。
只看退出码的智能体循环**永远发现不了这种情况**。

```
$ python demo.py

[ACTION]      move_object {'object': 'A', 'destination': 'B'}
[VERIFY FAIL]  STATE_MISMATCH
              验证失败:世界没有到达预期状态。A: 预期 'B',实际 'table'。
              预期世界状态: {'A': 'B'}
              观测世界状态: {'A': 'table'}
              机器人回报: {'accepted': True, 'detail': 'moved A to B'}   ← 这就是那句谎话
              该状态变化并未发生。不要假设它发生了。

[ACTION]      finish {'message': 'Moved A to B.'}              ← 想提前收工
[FEEDBACK]    你试图结束,但外部世界状态验证失败(第 1 次)。   ← 收工被否决

[ACTION]      move_object {'object': 'A', 'destination': 'B'}
[VERIFY PASS]  OK

[ACTION]      finish {'message': 'Verified: A is on B.'}       ← 这次放行

最终世界状态:      {'A': 'B'}
机器人实际执行次数:  2
大模型消耗轮数:      4
执行状态:           finished
```

### 11 个测试证明了什么

**闸门确实关得住:**

1. `test_loop_blocks_until_verification_returns` — **最关键的一个**。
   用一个 `threading.Event` 把验证器卡在事务中间。卡住期间:动作已经执行了
   (`robot.attempts == 1`)、没有任何观测产生、而且 **`llm._call_count == 1`**
   ——智能体没有再走一步。放开后循环恢复。
2. `test_timeout_fails_closed_without_claiming_success` — 验证器一直不回 →
   `SENSOR_TIMEOUT`、判定不通过、**不自动重发指令**、明说"物理结果未知"。
3. `test_silent_physical_failure_is_caught_and_surfaced` — 机器人撒谎,
   模型的上下文里同时出现预期状态、实际状态和"并未发生"。
4. `test_agent_repairs_after_failed_verification` — 完整闭环:执行 → 验证失败 → 重新规划 → 验证通过。
5. `test_explicit_execution_failure_reports_real_state` — 就算机器人自己承认失败,也照样查世界状态
   (失败的动作也可能让世界变了一半)。
6. `test_exactly_one_terminal_observation_per_action` — 每个动作**恰好一个**观测,`action_id` 正确关联,顺序严格。
7. `test_low_confidence_blocks_even_when_state_matches` — **状态对上了但传感器置信度不够,一样不算通过。**

**结束任务也卡得住:**

8. `test_finish_is_refused_while_world_state_is_wrong` — 提前收工被否决,打回去继续干。
9. `test_finish_succeeds_immediately_when_world_is_correct` — 该放行时不会误伤。
10. `test_refinement_is_bounded` — 机器人永久坏掉时,到次数上限就停,**记录失败而不是假装成功**,不会死循环。
11. `test_gate_and_finish_gate_compose` — 两道闸门互相独立且都生效
    (每个动作都验证通过了,但任务目标没达成 → 照样否决收工)。

### 怎么跑

```bash
git clone https://github.com/OpenHands/software-agent-sdk
cd software-agent-sdk
git checkout c7e270aae43a6e9bcc8723d27b85c680ab38e156   # openhands-sdk v1.41.0
uv sync --group dev
SDK_PY="$PWD/.venv/bin/python"

cd /path/to/poc
PYTHONPATH=. "$SDK_PY" -m pytest tests/ -q     # 11 passed
PYTHONPATH=. "$SDK_PY" demo.py
```

不需要 API key、不需要联网、不需要机器人——用 `openhands.sdk.testing.TestLLM`
喂脚本化的回复来驱动**真实的**循环。

### 写的过程中踩到的两个坑

1. **`Tool.params` 会被 JSON 序列化**(智能体配置要持久化 / 发给 agent-server)。
   所以**活的机器人连接对象没法通过它传递**。要用
   `register_tool(名字, 工具实例)` 注册**实例**,而不是注册类。
2. **工具名是从类名推导的**(`tool/tool.py:391`),驼峰转下划线再去掉 `_tool` 后缀:
   `MoveObjectTool` → `move_object`。这才是大模型看到的名字。

### 下一步怎么接真机

- 把 `MockRobot` 换成 ROS 2 / 机器人 SDK 桥接,**执行器代码不用动**。
- 把 `MockWorld.observe()` 换成真实感知源,**`EmbodiedVerifier` 接口不用动**。
- 加一个 PreToolUse 钩子做互锁:"上一个物理动作没验证完,不许发下一个"。
- 加一个**独立的**安全监督层(见下一节)。

---

## 十、风险和坑(按该担心的程度排)

1. **⚠️ 大模型不是安全控制器。** 这套东西**完全不管**力、速度、工作空间边界、碰撞。
   限位、急停、看门狗、速率限制必须放在智能体**下面**一层确定性系统里,而且要让它绕不过去。
   **闸门保证的是"反馈诚实",不是"运动安全"。这两件事别混。**
2. **闸门是约定,不是强制不变量。** 它成立是因为执行器阻塞了。
   如果有人没读文档、又注册了一个物理工具,那个工具就不受管。
   缓解:PreToolUse 互锁;需要真正强制的话,把通用闸门提给上游。
3. **并发工具调用。** `tool_concurrency_limit` 默认是 1,所以现在是安全的——
   但模型一次可以吐多个工具调用,调大这个值就会让物理动作并发跑。
   保持 1,或者用 `DeclaredResources` 声明机器人资源键让它们串行。
4. **超时得你自己加。** SDK 对工具调用**不设任何超时**。验证器卡死 = 整个会话卡死。
   PoC 里的 `timeout_s` + 失败保护是最低配置;生产环境还需要心跳,
   好区分"一个合法的长动作"和"卡死了"。
5. **超时 ≠ 回滚。** `SENSOR_TIMEOUT` 的意思是"物理结果**未知**"。
   PoC 里对这点写得很明确。**绝对不能让"未知"塌缩成"成功"或"什么都没发生"。**
6. **重放和重启。** 会话是会持久化和恢复的。
   **绝不能因为事件被重放就重新执行一次非幂等的物理动作**——所以幂等键放在机器人桥接层,不放在智能体里。
7. **世界状态的时序竞争。** 假世界里 `observe()` 是瞬时的。
   真实感知需要稳定时间,还要和动作有因果关联,否则你验证的是一张过期快照。
8. **不确定性不是布尔值。** 低置信度的感知必须"失败保护"或者再观测一次,**不能被强行判成成功**。
9. **接口变动 —— 这个已经应验过一次了。** 上一份调研就是被一次仓库拆分 + 架构重写作废的。
   锁死 commit;把集成限制在 `ToolExecutor` / `Action` / `Observation` / `CriticBase`
   这些最稳定的公开接口上;写特征测试(像 `poc/tests` 那样),升级时能大声报错。
10. **会话/传输超时。** 一个几分钟的物理动作可能超过 `openhands-agent-server` 或
    Agent Canvas 的 HTTP / UI 超时。要在不释放逻辑闸门的前提下,把进度带外上报。

---

## 十一、最终结论

```
OpenHands 能不能作为具身编码智能体框架的基础?

能(YES)
```

不是"能但要大改",而是**能,而且核心代码零改动**——这个结论是我**写出来验证的**,不是读出来猜的。

决定性的事实是:现在的 OpenHands 通过 `Agent.step()` 里一个**同步阻塞调用**执行工具
(`agent/agent.py:1373`),并且**完全**依据这个调用的返回值来构建模型的下一轮上下文。
所以一个"执行 → 观测 → 验证"做完才返回的执行器,不是外挂上去的闸门,
**它本身就是这个循环的完成条件**。智能体越不过未验证的物理状态,
是因为**根本不存在一条能越过去的代码路径**。

另外还有两个运气不错的地方:SDK **已经自带任务完成否决机制**
(`CriticBase` + `IterativeRefinementConfig`),正好能映射到最终世界状态校验;
而且工具执行**默认串行**,并发风险是"要主动打开"而不是"要主动关掉"。

诚实的保留意见有两条:闸门是执行器保证的约定,不是循环强制的不变量;
以及**这套东西不是安全系统**。要出货的机器人需要在智能体下面加一层独立的确定性监督,
可能还需要往上游提一个小的"待完成动作闸门"。这两条都不影响这次调研的结论。

**把机器人策略生成做成「写代码 → 物理执行 → 验证 → 改代码」的迭代闭环,
在 OpenHands 上不只是"可行"——它是 630 行代码、不用 fork、今天就能跑。**
