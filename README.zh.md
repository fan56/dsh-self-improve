# dsh-self-improve

dsh 的自我改进回路插件（`@aiwayds/dsh-self-improve`）：把会话信号变成**教训（lessons）**与**技能草稿（skill drafts）**——低风险教训自动生效，技能草稿必须人工审批才装机。

## 定位

- 设计契约：wayfinder 图 `~/repo/wayfinder/self-improve/`（spec 卷二，oldfox 双审 GO）
- 数据上游：[@aiwayds/dsh-topics-memory](https://github.com/fan56/dsh-topics-memory)（optional peer，`>=0.24.0`）——经其 `TopicsService.feedObservations` 写缝投喂 + lesson 数据存其 bundle；本仓**禁直写 bundle**。触发引擎/快速通道另读 `lessonsSync` roster、写 `saveTopic` lesson 分支（0.25.0 成员；运行时 peer 更旧则结构探测降级——roster 视为空、快速通道记 seam-unavailable，其余 lane 不受影响）
- 分级门控：本仓 `improveLoop`（off|shadow|on，默认 off）管回路；原仓 `lessonInject` 管注入——两仓各一闸

## 模块图（N1 地基波 + N3 审批/skills 波 + N2 触发波）

```
settings 命名空间 dsh-self-improve（三键，全 volatile 热更）
  └─ improveLoop: off | shadow | on          ← 回路总闸
src/
  config.ts       三键 schema（schemastery）+ 快照/归一化（非法值→off，只收窄不放宽）
  signals.ts      信号采集器：旁听 session firehose，turn/end 批量冲刷
  feed.ts         写缝接线：动态 import 可选 peer → BundleStore+TopicsService 直构
                  （同一 bundle root，$DSH_TOPICS_HOME → $DSH_HOME/topics → ~/.dsh/topics）
                  写缝方法① feedObservations + 方法② setLessonStatus + usage 聚合读
                  + established lesson roster 读（lessonsSync）+ lesson 数据面落库（saveTopic kind:lesson）
  triggers.ts     触发引擎（N2）：tool-error 聚类（7 天窗 ≥3）→ BL-3 合取 → fire/不 fire 落账
                  + 打断对快速通道（占位 hint，每 session ≤3）
  skill-draft.ts  skills 草稿生成器：证据摘要（计数）→ LLM → 影子自验门 → 草稿区
                  （secret gate / 每日 ≤1 / source: auto-generated 机器钉）
  review.ts       /improve-review 审批命令：队列 / show / approve / reject / draft / triggers
  ledger.ts       行动账 meta/improve-actions.jsonl（白名单 / 512KB 紧缩 / 写失败静默）
  index.ts        门控接线：off=零 firehose 监听器（命令仍注册）；shadow=只落账+可起稿；on=全通
```

## 审批流（`/improve-review`，N3 + N2）

```
/improve-review                队列列表（skill 草稿 + lesson hint）
/improve-review show <id>      全文 + 证据摘要（机器拼：信号计数+来源；LLM 正反方摘要是 N4）
/improve-review approve <id>   skill → 装机 ~/.dsh/skills/<name>/；lesson → hint→established
/improve-review reject <id>    skill → 草稿归档 .archived/；lesson → removed（原仓归档后移出 roster）
/improve-review draft          手动起稿：行动账近 7 天信号 → SKILL.md 草稿
/improve-review triggers       触发引擎观察面：当前候选与判定依据（只读干跑，零落账）
```

- **队列来源**：skill 草稿 = `~/.dsh/skills-drafts/<name>/SKILL.md`（`source: auto-generated` 才入队）；lesson hint = peer bundle `topics/*.md` 的文件级直读（`type: lesson ∧ confidence: hint`，peer 只导出 established，hint 仅供审批展示，永不注入）。
- **自动触发**：cluster 草稿请求必须经触发引擎 BL-3 清关（`cluster.cleared` 只由 triggers.ts 钉入）——无清关的 cluster 请求一律拒绝（`cluster-not-cleared`），生成通道自身无自动起稿能力；手动 `draft` 不经触发引擎（人发起，门照过）。
- **门控三态**：`off`=命令注册但队列恒空、生成拒绝（落账）、处置拒绝；`shadow`=读面 + 草稿生成与影子自验可跑，生效动作（装机/lesson 状态变更）拒绝；`on`=全通。**skill 装机恒人审，无自动路径**（B4 决议 1）。
- **手写保护**（B3 决议 4）：装机绝不覆盖已存在目录——同名冲突强制 `-auto` 后缀（frontmatter name 同步改写）；`-auto` 也存在则拒绝并提示合并；缺 `source: auto-generated` 标记的草稿拒绝装机。装机=复制+草稿移入 `.installed/<name>-<戳>/` 作写前备份（回滚指针落账）。
- **影子自验门**（B3 决议 2）：frontmatter 可解析 / name 合法（宿主 kebab-case 语法）/ description·whenToUse·正文必填 / 证据指针存在——不过不进队列。
- **红线**：LLM 出网 body 全文扫描（本机 credentials refs + 通用 token 形状），命中即断不发送，响应再扫一道才落盘；证据=计数摘要（白名单特征字段），对话原文不出进程；`source: auto-generated` 由本插件机器钉，绝不采信模型输出。
- **每日草稿 ≤1**（B4 决议 2，常量）：按行动账 `draft-created` 当日计数 + 草稿区扫描取大者，超限落账拒绝。
- **lessons 写缝**（§6.2 方法②）：`setLessonStatus(slug, to, { actor: 'dsh-self-improve:<sessionId>' })`，peer 落锁+git 提交，可 revert；peer 缺失时动作降级落账（§6.3）。

## 触发引擎（N2：什么时候学）

「重复痛点→skill 草稿」的升级判定（spec §4.1 + BL-3 修订，稀疏触发原则——单次坏体验永不触发）：

```
行动账信号（7 天滑动窗）
  └─ tool-error 按 (toolName + errorCode) 聚类，errorName 兜底，≥3 = 同类失败候选
       └─ BL-3 合取：候选 ∧（无相关 established lesson ∨ established lesson 仍复发）
            ├─ 过 → fire：N3 草稿通道（cluster 输入引擎清关，每日 ≤1 沿用）
            └─ 不过 → no-fire；fire/no-fire 全落行动账 kind:'trigger'
```

- **数据源**（全文件级只读，沿 N1 直构读法）：本仓行动账 `meta/improve-actions.jsonl`（信号条目 + `review.approved object=lesson:<slug>` 行作 lesson 批准时间戳）+ peer bundle 的 established lesson roster（`lessonsSync`，MJ-3 语义——hint 永不入册）+ 其 30 天 ilog hits/opens（仅作展示注记）。**peer 缺失 → 空 roster → BL-3 盲区直通分支**（§6.3：skills 回路不依赖原仓）。
- **「无相关 lesson」判定**：established lessons 的 triggers/title 与聚类键（toolName/code）做**词面交集**（ASCII 词 run + CJK run，≥2 字符）；有交集即相关。
- **「仍复发」判定**：窗口内存在晚于该 lesson 账内批准时间的失败 → 仍复发（lesson 治不了才升级 skill）；账内无批准记录（他 actor 批的/账前批的）按「批准早于窗口」处理 → 窗口内失败即复发。
- **节奏**：扫描挂 turn/end，**每 session 每分钟 ≤1 次**（节流）；无候选的扫描零落账（不刷账本）。spec 的执行位写的是离线批处理（dsh-cron daily 保底），本波按任务契约落 turn/end 轻扫（每分钟至多一次账本读 + mtime 缓存 roster 读，非 LLM 热路径）；cron 批处理留待后续波接入同一 `scanTriggers`。
- **每日 fire ≤1**：引擎先自查当日已 fire（`trigger.fired` 或 `draft-created` 当日行）→ 已花则候选行记 `already-fired-today`，不再进草稿通道（避免每分钟拒绝刷账）。
- **影子档（would-fire 记录带）**：`improveLoop=shadow` 引擎照算，`kind:'trigger'` 行落 `wouldFire:true, fired:false`——不 fire、不产草稿、不调 LLM。
- **观察面**：`/improve-review triggers` 随时干跑同一判定（候选 ×N、BL-3 分支、相关 lesson 及其注入统计），只读不落账——用来看引擎在想什么。

### 打断对快速通道（B2 决议 3② + MJ-1）

`interruption-pair` 信号（用户打断助手后紧跟 steer）→ **立即**产 hint 级 lesson 草稿，不等批量蒸馏：

- **落库拍板**：peer `service.saveTopic` 的 lesson 数据面分支（0.25.0 公开：`kind:'lesson'`）经直构 handle 调用——spec 要求「立即」，不走 feedObservation+等蒸馏批量。`confidence:'hint' ∧ scope:'workspace' ∧ lessonSource:'correction'` 由 handle 钉死（调用方无法放宽）；`workspaceId` 沿 0.24.0 语义由 peer 写入时按 cwd hash 自盖（MJ-2）；走 peer store 锁 + git 提交，可 revert。
- **v1 最小实现 = 占位 hint**（`pending-refine` 标记）：打断对只有位置没有内容——condition=「用户在 turn N 打断了助手」，action=「待蒸馏批次补全」，原文不落任何账本（红线⑤）；LLM 冷读提炼补全排 N4 后的集成波。
- **上限**：每 session ≤3 条（B4 决议 2 + MJ-3：挡的是「生成草稿」不是「生效」）；hint 不参与注入（MJ-3），仅供 `/improve-review` 审批展示。peer 缺失/旧版（无 saveTopic lesson 分支）→ 降级落账 `seam-unavailable`，不影响其他 lane。
- 行动账新增 `kind:'hint'` 行（created / cap-refused / seam-unavailable / seam-failed）。

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

行动账 `meta/improve-actions.jsonl` 恒随 `improveLoop` 开（无独立键），条目=信号行 / 投喂结果行 / 降级行 / **审批行**（N3：`kind: 'review'`，action 为封闭枚举——draft-created、各拒绝码、approved、rejected 及其拒绝/降级码；object=`skill:<名>`/`lesson:<slug>`；approve/reject 带回滚指针：装机路径+备份路径或写缝引用）/ **触发行**（N2：`kind: 'trigger'`，fired/wouldFire/聚类键/计数/判定码）/ **快速通道行**（N2：`kind: 'hint'`）。审批拒绝码即使 `improveLoop=off` 也落账（人发起的拒绝会计入，读面不计）。

## 状态（0.1.0）

N1 地基波 + N3 审批/skills 波 + N2 触发引擎波已落地：配置三键 + 五信号采集 + 写缝投喂（①②）+ 行动账；`/improve-review` 审批命令（队列/show/approve/reject/draft/triggers）+ skills 草稿生成器（手动 + 引擎清关触发、影子自验门、secret gate、每日 ≤1、装机不覆盖手写/-auto 后缀）；N2 触发引擎（tool-error 聚类 7 天 ≥3 ∧ BL-3 lesson 合取、turn/end 每分钟 ≤1 节流扫描、每日 fire ≤1、would-fire 影子带）+ 打断对快速通道（peer lesson 数据面直构落库、占位 hint pending-refine、每 session ≤3）。off 守卫 / 三态门控 / 装机保护 / 红线⑤ 全有测试（78 绿），真宿主 boot-smoke 绿。后续波：N4 jev 决策门（用 `improveJevBackend/Model` 两键：触发聚类判定/矛盾检测/草稿质量门/90 天退役复审）+ 审批证据 LLM 正反方摘要 + 占位 hint 冷读提炼。
