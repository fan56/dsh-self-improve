# dsh-self-improve

dsh 的自我改进回路插件（`@aiwayds/dsh-self-improve`）：把会话信号变成**教训（lessons）**与**技能草稿（skill drafts）**——低风险教训自动生效，技能草稿必须人工审批才装机。

## 定位

- 设计契约：wayfinder 图 `~/repo/wayfinder/self-improve/`（spec 卷二，oldfox 双审 GO）
- 数据上游：[@aiwayds/dsh-topics-memory](https://github.com/fan56/dsh-topics-memory)（optional peer，`>=0.24.0`）——经其 `TopicsService.feedObservations` 写缝投喂 + lesson 数据存其 bundle；本仓**禁直写 bundle**
- 分级门控：本仓 `improveLoop`（off|shadow|on，默认 off）管回路；原仓 `lessonInject` 管注入——两仓各一闸

## 模块图（N1 地基波）

```
settings 命名空间 dsh-self-improve（三键，全 volatile 热更）
  └─ improveLoop: off | shadow | on          ← 回路总闸
src/
  config.ts   三键 schema（schemastery）+ 快照/归一化（非法值→off，只收窄不放宽）
  signals.ts  信号采集器：旁听 session firehose，turn/end 批量冲刷
  feed.ts     写缝接线：动态 import 可选 peer → BundleStore+TopicsService 直构
              （同一 bundle root，$DSH_TOPICS_HOME → $DSH_HOME/topics → ~/.dsh/topics）
  ledger.ts   行动账 meta/improve-actions.jsonl（白名单 / 512KB 紧缩 / 写失败静默）
  index.ts    门控接线：off=零监听器；shadow=只落账；on=落账+投喂
```

## 门控语义（`improveLoop`）

| 档位 | 监听器 | 行动账 | 投喂 |
|---|---|---|---|
| `off`（默认） | **不注册**（宿主行为逐字节不变，守卫测试钉死；改档需重载） | — | — |
| `shadow` | 注册 | 每条信号一行 | **从不** |
| `on` | 注册 | 每条信号一行 + 每次投喂的 accepted/duplicates/rejected 一行 | `feedObservations(obs, { actor: 'dsh-self-improve' })`，每 turn/end 一批（不逐事件） |

- shadow↔on 热切换（volatile 引用逐事件重读）；会话中途切到 off=监听器保留但全惰性。
- **peer 缺失降级**（optional peer，spec §6.3）：采集照跑、投喂跳过、`feed-degraded` 事件按 lane 节流落账、不补投。
- fail-open 硬编码（无键）：回路 lane 全异步+吞错，炸了不影响正常会话。

## 键表

| 键 | 默认 | 语义 |
|---|---|---|
| `improveLoop` | `off` | 回路总闸，三态，volatile（spec §7 MJ-A） |
| `improveJevBackend` | `''` | jev 决策层后端：`''`=增强层关；`zen`=opencode-zen。N1 落键，N4 接线 |
| `improveJevModel` | `''` | 钉死模型 id；`''`=哨兵，调用时解析后端默认（zen→`jev-1.13-free`）。N4 前不读 |

## 信号（B1 v1 短清单，N1 活跃五条）

| # | 信号 | 缝 | 落盘特征（白名单，只特征不原文） |
|---|---|---|---|
| 1 | `tool-error` | firehose `tool/call`（callId→名）+ `tool/result` isError | toolName / errorName / errorCode / turn；`error.reason` 不落 |
| 2 | `turn-end-negative` | firehose `turn/end` reason ∈ {error, max-tokens, aborted} | reason / errorCode（LlmFailure.code）/ cancelKind / turn；message 不落 |
| 3 | `repeat-call` | 旁听宿主 dsh-repeat-tool-reminder 注入的 `repeat-tool-reminder` source 消息 | 从其有界 summary 元数据解析 toolName × count；解析不了只计一次 |
| 4 | `interruption-pair` | aborted turn/end（或 assistant interrupted:true）+ 下一条人类消息 | 只记发生+turn 位置+触发标记 |
| 5 | `unused-injection` | **周期型**（每 session 至多一次，首 turn/end 触发；dsh-cron 友好） | peer 的 usageSignals 聚合（30 天窗）里 hits≥1 且 opens=0 的 slug 快照，按 hits 降序 ≤20 条 |

第 6 条 `jev-calibration`（spec §2.1）随 N4 决策层接线，本波不采。

## 红线（五条）

快道零远程 / fail-open 硬编码 / secret gate 硬性（沿 System One）+ **自动写资产必须可回滚可识别**（source 标记+归档+卸载回收）+ **对话原文不出账本**（字段白名单，只特征不正文——tool/call arguments、user/assistant 正文、error.reason、reminder content 一律不过进程外；守卫测试用含原文的 mock 事件钉死）。

行动账 `meta/improve-actions.jsonl` 恒随 `improveLoop` 开（无独立键），条目=信号行 / 投喂结果行 / 降级行三类，全部白名单字面量。

## 状态（0.1.0）

N1 地基波已落地：配置三键 + 五信号采集 + 写缝投喂 + 行动账；off 守卫 / shadow/on 投喂差异 / peer 降级 / 512KB 紧缩 / 红线⑤ 全有测试，真宿主 boot-smoke 绿。后续波：触发引擎（B 线）、审批队列 `/improve-review`、skills 回路、jev 决策门（用 `improveJevBackend/Model` 两键）。
