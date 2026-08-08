# `robot` — Pi 的第五个 tool(骨架)

把 `robot` 做成和 `read / write / edit / bash` 同级的 tool,让 Pi 的 agent loop
在**物理世界验证返回之前无法前进**。

**12/12 测试通过**,跑的是**真实的** `agentLoop`(`@earendil-works/pi-agent-core@0.84.1`),
Pi 一个文件都没改、没 patch、没继承。不需要 API key、不需要联网、不需要机器人。

```bash
npm install
npm test        # 12 passed
npm run demo    # 打印完整 transcript
npm run typecheck
```

---

## 为什么这样能成

Pi 的循环(`agent-loop.ts:170-214`)是:

```
while (true) { 流式调模型 → await executeToolCalls(...) → 下一轮 }
```

`await` 就是闸门。tool 不 resolve,agent 就拿不到下一轮。
所以一个「执行 → 观测 → 验证」做完才返回的 tool,**本身就是那道闸门**——
不是外挂上去的,是循环的完成条件。

---

## 三个必须知道的点

### 1. `executionMode: "sequential"` 是必需的,不是装饰

Pi **默认并行**执行 tool call(`executeToolCallsParallel`)。不声明的话,模型可以在
一个 batch 里同时发 `robot run` + `bash`,甚至两个 `robot run`。

测试 `Pi honours it: nothing else runs while a policy is executing` 直接证明了
这个 flag 有牙齿:一条 assistant 消息同时发 `robot` 和 `probe`,`robot` 卡在事务中间时
`probe` 不会溜过去。

### 2. `run` 是阻塞的,所以 agent **不能**中途调 `status` / `stop`

阻塞正是闸门的来源。代价是 policy 执行期间 agent 被卡住,那些生命周期动词对它不可达。

- 进度用 `onUpdate` 流出去 → **可见性**(测试 `streams per-step updates without releasing the gate`)
- 停机归人和安全层 → **能动性**

不要为了让 agent 能干预就把 `run` 改成非阻塞,那就是把闸门拆了。

### 3. `policy_outcome` 和 `verdict` 是两个字段

`bash` 的 exit code 是**自证**的:程序的输出**就是**关于程序做了什么的真相。
`robot` 没有这个性质——policy 跑完了不代表世界变了。

所以 `completed + state_mismatch`(**机器人撒谎**)必须能被表达出来。这是 demo 的第一段。

---

## ToolResult schema

```ts
{
  policy_outcome: "completed" | "failed" | "aborted" | "unknown",  // 程序跑完了吗
  verdict:        "verified" | "state_mismatch" | "unknown",        // 世界真的变了吗
  reason_code:    "OK" | "STATE_MISMATCH" | "LOW_CONFIDENCE"
                | "SENSOR_TIMEOUT" | "VERIFIER_ERROR"
                | "CAPABILITY_FAILED" | "ABORTED",
  failed_at?:     "s2_pick_bottle",
  resumable_from?:"s2_pick_bottle",   // 见下面「修复粒度」
  entry_state:    {...},              // 跑之前世界什么样
  observed_state: {...},              // 独立观测源给的
  steps: [ { stepId, capability, verdict, expected, observed, capabilityResult } ]
}
```

`verdict: "unknown"` 是三值而不是布尔——急停或传感器超时之后,世界处于**没人观测过**的状态。
把它塌缩成「成功」或「什么都没发生」,就是机器人重跑一个已经做了一半的动作的原因。

---

## 修复粒度:`resume_from`

`robot run policy` 是**一次** tool call,所以反馈粒度天然是一整个 policy。
七步的 policy 第四步挂了,重跑整个 policy 意味着**重复前三步已经在物理世界发生过的动作**。

所以验证是**逐步**做的,结果带 `failed_at` + `resumable_from`,agent 用 `resume_from` 续跑。

demo 的输出直接证明了这点:

```
capability calls:   ["navigate:works","manipulate:lies","manipulate:works"]
                      ↑ 只跑了一次        ↑ 撒谎        ↑ 修复
```

**这给 RoboOnto 提了一个硬需求:policy 必须把「检查点 / 可恢复」做成语言的一等特性。**
否则只有两个坏结局——危险地重复执行,或者 agent 学会把所有东西拆成单步 policy
(那就退化回 `robot("grasp cup")`)。

---

## 两层分离

`src/world.ts` 里的 capability 绑定表就是这个分离的落点:

```
policy 里写的:   navigate / manipulate / perceive / dialogue    ← 语义
runtime 绑定的:  Nav2     / VLA        / 感知栈   / TTS+ASR      ← 实现
```

policy **从不**提 Nav2 或某个 VLA。换实现是改 `world.ts`,不是改 policy、更不是改 agent。
`robot` 之后是整个机器人世界,但 Pi 只看见一个 tool。

---

## RoboOnto 和 observation 分不开

`src/policy.ts` 里,**没有 `expect` 的 step 会被直接拒绝**:

```
Policy step 's1' declares no 'expect'. A step with no postcondition cannot be
verified — declare {} to opt out explicitly.
```

验证的本质是「预期 vs 实际」。**如果 policy 不声明预期,验证器就没有 spec 可对照**,
只能退回去问 runtime「你成功了吗」——又回到自证陷阱。

所以边界是:

```
RoboOnto      → 声明「应该变成什么样」(postcondition)
observation 层 → 回答「实际变成了什么样」(VDM / world model / 传感器融合)
verifier      → 比对两者,且独立于 policy runtime
```

可以分开**实现**,不能分开**设计**。

---

## 文件

| 文件 | 行数 | 作用 |
|---|---|---|
| `src/verifier.ts` | 114 | `VerificationResult` / `RobotVerifier` / `StateMatchVerifier`。**不 import 任何 Pi 代码。** |
| `src/policy.ts` | 64 | policy artifact(RoboOnto 编译产物的占位),强制 `expect` |
| `src/world.ts` | 106 | 假世界 + capability 绑定表,模式:`works` / `fails` / **`lies`** |
| `src/robot-tool.ts` | 351 | `robot` tool 本体 |
| `test/harness.ts` | 170 | 用 mock streamFn 驱动真实 agentLoop |
| `test/robot-gate.test.ts` | 296 | 12 个测试 |
| `demo.ts` | 108 | 可跑的 transcript |

**总计 635 行实现 + 466 行测试。改动的 Pi 文件数:0。**

---

## 这不是安全系统

闸门保证的是**反馈诚实**,不是**运动安全**。
力/速度限位、工作空间边界、碰撞规避、急停、看门狗必须放在 agent **下面**一层
确定性系统里,而且要让它绕不过去。`robot stop` 不等于回滚——它把世界留在未知状态。
