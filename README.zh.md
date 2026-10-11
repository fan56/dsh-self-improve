# dsh-self-improve

dsh 的自我改进回路插件（`@aiwayds/dsh-self-improve`）：把会话信号变成**教训（lessons）**与**技能草稿（skill drafts）**——低风险教训自动生效，技能草稿必须人工审批才装机。

## 定位

- 设计契约：wayfinder 图 `~/repo/wayfinder/self-improve/`（spec 卷二，oldfox 双审 GO）
- 数据上游：[@aiwayds/dsh-topics-memory](https://github.com/fan56/dsh-topics-memory)（optional peer，`>=0.24.0`）——经其 `TopicsService.feedObservations` 写缝投喂 + lesson 数据存其 bundle；本仓**禁直写 bundle**
- 分级门控：本仓 `improveLoop`（off|shadow|on，默认 off）管回路；原仓 `lessonInject` 管注入——两仓各一闸

## 模块图（N1 地基波 + N3 审批/skills 波）

```
settings 命名空间 dsh-self-improve（三键，全 volatile 热更）
  └─ improveLoop: off | shadow | on          ← 回路总闸
src/
  config.ts       三键 schema（schemastery）+ 快照/归一化（非法值→off，只收窄不放宽）
  signals.ts      信号采集器：旁听 session firehose，turn/end 批量冲刷
  feed.ts         写缝接线：动态 import 可选 peer → BundleStore+TopicsService 直构
                  （同一 bundle root，$DSH_TOPICS_HOME → $DSH_HOME/topics → ~/.dsh/topics）
                  写缝方法① feedObservations + 方法② setLessonStatus + usage 聚合读
  skill-draft.ts  skills 草稿生成器：证据摘要（计数）→ LLM → 影子自验门 → 草稿区
                  （secret gate / 每日 ≤1 / source: auto-generated 机器钉）
  review.ts       /improve-review 审批命令：队列 / show / approve / reject / draft
  ledger.ts       行动账 meta/improve-actions.jsonl（白名单 / 512KB 紧缩 / 写失败静默）
  index.ts        门控接线：off=零 firehose 监听器（命令仍注册）；shadow=只落账+可起稿；on=全通
```

## 审批流（`/improve-review`，N3）

```
/improve-review                队列列表（skill 草稿 + lesson hint）
/improve-review show <id>      全文 + 证据摘要（机器拼：信号计数+来源；LLM 正反方摘要是 N4）
/improve-review approve <id>   skill → 装机 ~/.dsh/skills/<name>/；lesson → hint→established
/improve-review reject <id>    skill → 草稿归档 .archived/；lesson → removed（原仓归档后移出 roster）
/improve-review draft          手动起稿：行动账近 7 天信号 → SKILL.md 草稿（N2 前的真机验证口）
```

- **队列来源**：skill 草稿 = `~/.dsh/skills-drafts/<name>/SKILL.md`（`source: auto-generated` 才入队）；lesson hint = peer bundle `topics/*.md` 的文件级直读（`type: lesson ∧ confidence: hint`，peer 只导出 established，hint 仅供审批展示，永不注入）。
- **自动触发接口桩**：`SkillTriggerInput`（同类失败聚类 + lesson 盲区分支）是 N2 波的填充位，桩恒拒；手动 `draft` 不经触发桩（人发起，门照过）。
- **门控三态**：`off`=命令注册但队列恒空、生成拒绝（落账）、处置拒绝；`shadow`=读面 + 草稿生成与影子自验可跑，生效动作（装机/lesson 状态变更）拒绝；`on`=全通。**skill 装机恒人审，无自动路径**（B4 决议 1）。
- **手写保护**（B3 决议 4）：装机绝不覆盖已存在目录——同名冲突强制 `-auto` 后缀（frontmatter name 同步改写）；`-auto` 也存在则拒绝并提示合并；缺 `source: auto-generated` 标记的草稿拒绝装机。装机=复制+草稿移入 `.installed/<name>-<戳>/` 作写前备份（回滚指针落账）。
- **影子自验门**（B3 决议 2）：frontmatter 可解析 / name 合法（宿主 kebab-case 语法）/ description·whenToUse·正文必填 / 证据指针存在——不过不进队列。
- **红线**：LLM 出网 body 全文扫描（本机 credentials refs + 通用 token 形状），命中即断不发送，响应再扫一道才落盘；证据=计数摘要（白名单特征字段），对话原文不出进程；`source: auto-generated` 由本插件机器钉，绝不采信模型输出。
- **每日草稿 ≤1**（B4 决议 2，常量）：按行动账 `draft-created` 当日计数 + 草稿区扫描取大者，超限落账拒绝。
- **lessons 写缝**（§6.2 方法②）：`setLessonStatus(slug, to, { actor: 'dsh-self-improve:<sessionId>' })`，peer 落锁+git 提交，可 revert；peer 缺失时动作降级落账（§6.3）。

## 门控语义（`improveLoop`，firehose 面）

| 档位 | 监听器 | 行动账 | 投喂 |
|---|---|---|---|
| `off`（默认） | **不注册**（宿主行为逐字节不变，守卫测试钉死；改档需重载） | — | — |
| `shadow` | 注册 | 每条信号一行 | **从不** |
| `on` | 注册 | 每条信号一行 + 每次投喂的 accepted/duplicates/rejected 一行 | `feedObservations(obs, { actor: 'dsh-self-improve' })`，每 turn/end 一批（不逐事件） |

- shadow↔on 热切换（volatile 引用逐事件重读）；会话中途切到 off=监听器保留但全惰性。
- **peer 缺失降级**（optional peer，spec §6.3）：采集照跑、投喂跳过、`feed-degraded` 事件按 lane 节流落账、不补投。
- fail-open 硬编码（无键）：回路 lane 全异步+吞错，炸了不影响正常会话。
- `/improve-review` 在**所有档位注册**（人发起面，不属回路 lane）：它只在被调用时行动，off 档下队列恒空+生成拒绝（落账），不破坏 off 的零监听器守卫；审批动作只读 peer/写自己的目录，不碰注入。

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

行动账 `meta/improve-actions.jsonl` 恒随 `improveLoop` 开（无独立键），条目=信号行 / 投喂结果行 / 降级行 / **审批行**（N3：`kind: 'review'`，action 为封闭枚举——draft-created、各拒绝码、approved、rejected 及其拒绝/降级码；object=`skill:<名>`/`lesson:<slug>`；approve/reject 带回滚指针：装机路径+备份路径或写缝引用）。审批拒绝码即使 `improveLoop=off` 也落账（人发起的拒绝会计入，读面不计）。

## 状态（0.1.0）

N1 地基波 + N3 审批/skills 波已落地：配置三键 + 五信号采集 + 写缝投喂（①②）+ 行动账；`/improve-review` 审批命令（队列/show/approve/reject/draft）+ skills 草稿生成器（手动触发 + 触发接口桩、影子自验门、secret gate、每日 ≤1、装机不覆盖手写/-auto 后缀）。off 守卫 / 三态门控 / 装机保护 / 红线⑤ 全有测试（58 绿），真宿主 boot-smoke 绿。后续波：N2 触发引擎（填 `SkillTriggerInput` 聚类桩）、N4 jev 决策门（用 `improveJevBackend/Model` 两键）+ 审批证据 LLM 正反方摘要。
