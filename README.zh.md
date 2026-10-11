# dsh-self-improve

dsh 的自我改进回路插件（`@aiwayds/dsh-self-improve`）：把会话信号变成**教训（lessons）**与**技能草稿（skill drafts）**——低风险教训自动生效，技能草稿必须人工审批才装机。

## 定位

- 设计契约：wayfinder 图 `~/repo/wayfinder/self-improve/`（spec 卷二，oldfox 双审 GO）
- 数据上游：[@aiwayds/dsh-topics-memory](https://github.com/fan56/dsh-topics-memory)（optional peer，`>=0.24.0`）——经其 `TopicsService.feedObservations` 写缝投喂 + lesson 数据存其 bundle；本仓**禁直写 bundle**。触发引擎/快速通道另读 `lessonsSync` roster、写 `saveTopic` lesson 分支（0.25.0 成员；运行时 peer 更旧则结构探测降级——roster 视为空、快速通道记 seam-unavailable，其余 lane 不受影响）
- 分级门控：本仓 `improveLoop`（off|shadow|on，默认 off）管回路；原仓 `lessonInject` 管注入——两仓各一闸

## 模块图（N1 地基波 + N3 审批/skills 波 + N2 触发波 + N4 jev 决策波）

```
settings 命名空间 dsh-self-improve（三键，全 volatile 热更）
  └─ improveLoop: off | shadow | on          ← 回路总闸
  └─ improveJevBackend: '' | zen             ← jev 增强层总闸（N4）
  └─ improveJevModel: ''（哨兵→jev-1.13-free）
src/
  config.ts       三键 schema（schemastery）+ 快照/归一化（非法值→off，只收窄不放宽）
  signals.ts      信号采集器：旁听 session firehose，turn/end 批量冲刷
  feed.ts         写缝接线：动态 import 可选 peer → BundleStore+TopicsService 直构
                  （同一 bundle root，$DSH_TOPICS_HOME → $DSH_HOME/topics → ~/.dsh/topics）
                  写缝方法① feedObservations + 方法② setLessonStatus + usage 聚合读
                  + established lesson roster 读（lessonsSync）+ lesson 数据面落库（saveTopic kind:lesson）
  triggers.ts     触发引擎（N2）：tool-error 聚类（7 天窗 ≥3）→ BL-3 合取 → fire/不 fire 落账
                  + 打断对快速通道（占位 hint，每 session ≤3）
                  + 门① 触发聚类判定 / 门④ 90 天退役复审扫描（N4）
  skill-draft.ts  skills 草稿生成器：证据摘要（计数）→ LLM → 影子自验门 → 门③ jev 质量门 → 草稿区
                  （secret gate / 每日 ≤1 / source: auto-generated 机器钉）
                  + 审批证据 LLM 正反方摘要 + 摘要缓存（N4，蒸馏路由）
  review.ts       /improve-review 审批命令：队列 / show / approve / reject / draft / triggers
                  + 门② lesson 固化前矛盾检测（N4）+ 队列退役建议渲染 + reject 退役卸装
  ledger.ts       行动账 meta/improve-actions.jsonl（白名单 / 512KB 紧缩 / 写失败静默）
  jev-gate.ts     jev 决策层客户端（N4）：@aiwayds/dsh-jev-core 封装 + 判定账
                  meta/improve-decisions.jsonl（fail-open / 15s 超时 / 键=keychain-first）
  index.ts        门控接线：off=零 firehose 监听器（命令仍注册）；shadow=只落账+可起稿；on=全通
```

## 审批流（`/improve-review`，N3 + N2）

```
/improve-review                队列列表（skill 草稿 + lesson hint + jev 退役复审建议，如有）
/improve-review show <id>      全文 + 证据摘要（机器拼恒在；LLM 正反方一句正一句反，失败/无凭据回退机器拼，
                               摘要按 id+digest 缓存于 meta/improve-summaries.jsonl 防重复调用）
/improve-review approve <id>   skill → 装机 ~/.dsh/skills/<name>/；lesson → hint→established
                               （lesson 固化前过 jev 矛盾检测：adopt 静默放行，record/fallback 带警示行，人审优先不拦截）
/improve-review reject <id>    skill → 草稿归档 .archived/；lesson → removed（原仓归档后移出 roster）；
                               若为已装机的 auto skill（无草稿）→ 退役卸装（归档备份，可回滚，手写永不碰）
/improve-review draft          手动起稿：行动账近 7 天信号 → SKILL.md 草稿（自验门后过 jev 质量门）
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
| `improveJevBackend` | `''` | jev 决策层后端：`''`=增强层关（纯码路径，N2/N3 行为逐字节不变）；`zen`=opencode-zen。N1 落键，N4 接线 |
| `improveJevModel` | `''` | 钉死模型 id；`''`=哨兵，调用时解析后端默认（zen→`jev-1.13-free`）。N4 接线 |

## jev 增强层（N4：四门 + 判定账 + 证据摘要）

依赖 `@aiwayds/dsh-jev-core@^0.1.4`（keychain-first、typed fail-open），后端钉 opencode-zen 免费档（endpoint `https://opencode.ai/zen/v1/systemone`，model `jev-1.13-free`）。**`improveJevBackend=''`（默认）时四门整体跳过：零远程调用、零判定账行、纯码路径与 N2/N3 逐字节一致（守卫测试钉死）。**

**键/凭据**：key 解析梯子 = `JEV_ZEN_API_KEY` env → macOS 钥匙串服务 `opencode-zen-inference`（jev-core 非抛查找；值只进 Authorization 头，绝不打印/落盘/落账）。超时 15s/次；任何失败（无 key/超时/http/坏响应）= 该次判定 band=fallback + 机器 outcome 码，**绝不抛、绝不阻塞回路**（红线②）。

**判定账** `meta/improve-decisions.jsonl`（jev-log 纪律：白名单字面量 / 512KB 紧缩 / 写失败静默）：

```
{ at, gate: trigger-cluster|lesson-contradiction|draft-quality|retire-review,
  ref: "tool/code|skill:<名>|lesson:<slug>",   ← 有界语法 id，绝不存判定原文（红线⑤）
  digest: sha256(state) 前 16 位,               ← 内容身份不存内容
  probability?: 0..1（仅 outcome=ok 时有）,
  band: adopt|record|fallback,                  ← adopt ≥0.60 / record ≥0.10 / fallback 其余或调用失败
  outcome: ok|no-key|timeout|http|invalid-response|error, latencyMs? }
```

**四门**（全异步批 lane、全 fail-open、同一次判定带 24h 复查窗——不被每分钟扫描重复问询，veto 在窗内粘滞）：

| 门 | 挂点 | 问什么 | adopt（≥0.60） | record（0.10–0.60） | fallback（<0.10 应答或调用失败） |
|---|---|---|---|---|---|
| ① 触发聚类判定 | N2 引擎 fire 前（gate=on 且今日未花）| 「这 N 次失败是同一个问题吗」（batch noul，state=聚类键/计数/窗口特征）| 放行 fire | 只记仍 fire | **不 fire** 落账（防噪音优先；仅此门把调用失败也归入不 fire） |
| ② 矛盾检测 | `/improve-review approve lesson:` 固化前 | 「与现有 established lessons 矛盾吗」（候选 title/description/conclusion + roster 前 8 条 title/triggers）| 静默放行 | **警示行 + 放行**（人审优先） | **警示行 + 放行**（应答为矛盾/调用不可用措辞分档） |
| ③ 草稿质量门 | N3 影子自验门之后、入队之前 | 「质量够格进审批队列吗」（name/description/whenToUse/正文统计+头 400 字）| 进队列 | 进队列（判定留账） | 应答 <0.10 → **不进队列**（归档 `.archived/`+落账 `draft-quality-gate`）；调用失败 → 结构自验结果即终局（进队列，jev 不阻回路） |
| ④ 90 天退役复审 | 周期槽（随 unused-injection 的每 session 一次位）| 对已装机 auto skill（frontmatter created ≥90 天，最老优先 ≤10 条/批，30 天注入 hits/opens 作特征）batch 问「仍有存在价值吗」 | 保留（留账） | 保留（留账） | 应答 <0.10 → 进 `/improve-review` 队列标注「退役复审建议」（**不自动删**）；调用失败 → 不建议、留账 |

- **人为裁决**（门④）：队列列出建议后由人处置——`reject skill:<名>`（无草稿时）= 退役卸装：装机目录整体移入 `.archived/<名>-<戳>-uninstalled/`（可回滚），仅限 `source: auto-generated`，手写技能永不碰；处置后建议自清（卸装/新 adopt 行任一即出队）。
- **状态语义**：门①只在 fire 将真发生时问（shadow 的 would-fire 行保持纯 N2、零调用）；门②③④在 shadow 也照常工作（判定/留账均无生效动作）；`improveLoop=off` 时四门随回路一起不存在（零监听器）。
- **与原仓 jev 的关系**：独立依赖 dsh-jev-core，不经 topics-memory 的 src/jev 五键（那套 default off 依旧沉睡）；两套判定账本互不混写。

**审批证据摘要**（第五增强，蒸馏路由**不占 jev**）：`/improve-review show skill:<名>` 在机器拼证据行之上追加 LLM 正反方各一句（bigmodel glm-5.3-flash，沿 N3 的 `ZAI_CODING_CN_API_KEY` 取证路径；15s 超时；pro/con 各截 200 字）。缓存 `meta/improve-summaries.jsonl`（{at,id,digest,pro,con} 白名单行，id+正文 digest 键）防重复调用；任何失败回退机器拼原文（N3 输出逐字节不变）。

**成本口径**：zen 免费档（`jev-1.13-free`），每次判定 ~350 tok（实测 381in/21out）；四门均有节流（①每日实质 ≤1 次 fire 问询 + 24h 复查窗，④每 skill 每日 ≤1 次，③随每日草稿 ≤1，②随人审批）。

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

N1 地基波 + N3 审批/skills 波 + N2 触发引擎波 + N4 jev 决策波已落地：配置三键 + 五信号采集 + 写缝投喂（①②）+ 行动账；`/improve-review` 审批命令（队列/show/approve/reject/draft/triggers）+ skills 草稿生成器（手动 + 引擎清关触发、影子自验门、secret gate、每日 ≤1、装机不覆盖手写/-auto 后缀）；N2 触发引擎（tool-error 聚类 7 天 ≥3 ∧ BL-3 lesson 合取、turn/end 每分钟 ≤1 节流扫描、每日 fire ≤1、would-fire 影子带）+ 打断对快速通道（peer lesson 数据面直构落库、占位 hint pending-refine、每 session ≤3）；N4 jev 增强层（四门：触发聚类判定/矛盾检测/草稿质量门/90 天退役复审，判定账 improve-decisions.jsonl，fail-open 全硬编码，off=零调用零账行纯码逐字节）+ 审批证据 LLM 正反方摘要（蒸馏路由+缓存）+ reject 退役卸装。off 守卫 / 三态门控 / 装机保护 / 红线⑤ / 四门三 band+fail-open 全有测试（110 绿），真宿主 boot-smoke 绿。后续波：占位 hint 冷读提炼（打断对升格）。

## 纯本地模式（不需要 GitHub）

回路的每一环都**不依赖 GitHub**——信号采集在本机 firehose、观察/教训/技能落在本地 bundle 与本地目录、判定账在本地 meta。GitHub 只出现在 topics-memory 的**可选**同步功能里，与回路无关；不配同步（或 onboard 选 local-only）就是彻底的纯本地。回归测试 `test/pure-local.test.mjs` 钉死：无 remote、无 sync 配置的 bundle 上「观察投喂→hint lesson 落库→established」三环全通。

另一台电脑的纯本地装机清单：

1. profile 装 `@aiwayds/dsh-topics-memory`（≥0.24.0）+ `@aiwayds/dsh-self-improve`（均 npm latest）；
2. profile `cordis.patch.yml` 加挂载条目（`improveLoop: 'on'`；`improveJevBackend` 可留空=纯码判定）；
3. topics-memory 配好蒸馏模型路由（教训提炼用）；**不配 GitHub 同步**；
4. zen 钥匙串凭据可选——没有则 jev 门自动 fail-open 退纯码，回路照跑。

注意：本机 bundle 若**已**配 GitHub 同步，回路产出会随包一起同步（私有仓）——要「这份不上去」，就把那台 bundle 用 `/topics onboard` 的 local-only 模式重置。
