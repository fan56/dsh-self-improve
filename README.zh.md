# dsh-self-improve

dsh 的自我改进回路插件（`@aiwayds/dsh-self-improve`）：把会话信号变成**教训（lessons）**与**技能草稿（skill drafts）**——低风险教训自动生效，技能草稿必须人工审批才装机。

## 定位

- 设计契约：wayfinder 图 `~/repo/wayfinder/self-improve/`（spec 卷二，oldfox 双审 GO）
- 数据上游：[@aiwayds/dsh-topics-memory](https://github.com/fan56/dsh-topics-memory)（optional peer）——观察写缝投喂 + lesson 数据存其 bundle
- 分级门控：本仓 `improveLoop`（off|shadow|on，默认 off）管回路；原仓 `lessonInject` 管注入——两仓各一闸

## 红线（五条）

快道零远程 / fail-open 硬编码 / secret gate 硬性（沿 System One）+ **自动写资产必须可回滚可识别**（source 标记+归档+卸载回收）+ **对话原文不出账本**（字段白名单，只特征不正文）。

## 状态

骨架仓（0.1.0）：插件可挂载、boot-smoke 通过，回路实现随 wave-2 提交，全部 default off。
