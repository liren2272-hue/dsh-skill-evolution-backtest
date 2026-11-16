# dsh-skill-evolution-backtest

把 **Mnemon 技能进化流水线的确定性一半**打包成 5 个 agent 工具（见下）。1.16.0 起 `new` 模式更把这些工具串成一条由插件代码驱动的全自动状态机（见「代码状态机」一章）。创造性的一半（真正把 SKILL.md 改好）仍由 agent 负责；这个插件负责它周围那圈纯机械、每次会话都在手搓的脚手架。

## 为什么存在

Mnemon 记忆插件会进化技能：后台 review 产出 `suggestions`（「这个技能可以学 X」），然后由 agent 把建议落成改进版 SKILL.md、回测、再以 `ready` 草稿停在面板等人批准。这套流程里：

- **创造性的一半** —— 把技能真的改好 —— 属于 agent（LLM）。
- **确定性的一半** —— 扫描建议、逐 check 部分分回测、带备份+并发守卫地原子写账本、再独立复核 —— 是纯管道（plumbing），过去每个会话都在现搓一次性 python/cjs 脚本。

本插件把那圈管道变成可调用工具，agent 驱动流水线用工具而不是每次重写脚本。

## 代码状态机：new 模式（1.16.0）

> 背景：1.15.0 及以前的 `new` 模式把编排全交给一个 LLM 主代理，靠软提示词约束「并发 ≤ N」「先派发再评分」「子代理只写草案」等。实测（会话 928f11，7 个技能一起进化）证明 LLM 会忽略这些软约束：自行造出第二波 7 个落地子代理（共 14 个）、Write 波与落地波脱节空转约 24 分钟、总耗时 92 分钟，并在收尾报告里把 A 形态说成 C 形态（名实不符）。1.16.0 把**编排本身**从 LLM 提示词里拿走，改成插件代码里的确定性状态机。

**`new`（默认）= 全自动代码状态机**：`POST /evolve` 不再拉起任何 LLM 主代理。宿主 `llm` 服务只为每个技能跑**两次小调用**（1.18.0）：call1 产出 `{"cases":[...]}`（评测 rubric），call2 产出改进版完整 SKILL.md 正文。拆成两次短流是因为部分上游模型会把「一整份 rubric + 全文」的单次大 JSON 用 `aborted` 截断，其余全部由代码按固定顺序执行：

1. **一技能一 worker**：N 个技能 = N 个逻辑 worker（不是 2N）。草案生成失败最多在**落地前**修复 2 次，绝不带着坏草案落账本。
2. **并发硬上限**：代码信号量（`stats.active < maxConcurrency`），不是写进提示词的软上限；任一 worker 完成 `.finally` 先补位再干别的（PROCESS AS IT ARRIVES）。
3. **before 一次冻结、全程复用**：`scoreImpl` 每个 `skillName+casesHash` 只算一次并缓存，write/backtest 原样复用冻结的 `before`，杜绝重复冻结。
4. **确定性落地管道**：每个草案固定走 `writeImpl`（带冻结 `before`）→ 逐 `draftId` `verifyImpl` 自审 → `backtestImpl`（带冻结 `before`）算 after；共享账本写入加互斥锁，防并发丢更新。
5. **收口复核 + 代码生成报告**：全部完成后代码再逐 `draftId` 跑一次 `verifyImpl`，并生成 `report`（`orchestrator:'code-state-machine'`、`agentCreates=0`、`workerCount`、`peakConcurrency`、各类调用计数、`nameMatchesReality`），名实相符、不依赖 LLM 自述。

依赖宿主 `llm` 服务（`llm.stream`）；缺失时 `/evolve` 返回 503。新增配置 `draftTimeoutMs`（默认 300000）控制**每次** cases/草案生成的 LLM 超时（两次调用各享一个超时），与判分用的 `judgeTimeoutMs` 分开。

**`legacy`（保留）= 旧 LLM 主代理编排**：仍拉起一个 `standard` 主代理、按软上限开子代理、逐草案审核/重试一次，行为与改造前一致；并发数很大、主代理判分成为瓶颈时可选它。下文「主代理降级与体积守卫」「子代理工具挂载」等历史章节**只适用于 legacy**。

两种模式落地的草稿都停在 `status='ready'` 等人批准，**绝不采纳 / 安装 / 覆盖正式 SKILL.md**。

## 五个工具

| 工具 | 读写 | 作用 |
| --- | --- | --- |
| `skill_evolution_scan` | 只读 | 列出 pending/review/expired 建议 + baseHash 新鲜度（FRESH/STALE/MISSING 对照活文件）+ 已有 draftId / lastError |
| `skill_evolution_score` | 只读 | **评测标准冻结器（公平闸门）**：用已经定死的 `cases` 对**当前 live SKILL.md** 评一次，返回自包含 baseline（`baseHash` + `casesHash` + score/passRate/caseRows/engine）。它必须在写草案**之前**调用，把这套 rubric 锁死，之后 backtest/write 原样复用，避免「先写新 skill 再评分」导致的失真 |
| `skill_evolution_backtest` | 只读 | 候选草案 vs 当前 SKILL.md 做**语义回测**（模型逐 check 判定正文是否真正满足该改进点，锚点仅作离线回退；case 分按 must 加权、run 分取 case 级均值，对齐宿主 runScore），返回 before/after/Δ、passRate、评分引擎与逐 check 明细（含缺失锚点/判定理由）。支持可选 `before` 入参：传入 `skill_evolution_score` 的 baseline 时**原样复用冻结的 before 分**（校验 casesHash + baseHash，漂移即报错、绝不静默重算） |
| `skill_evolution_write` | **写** | 把一次回测落成 `status='ready'` 草案 + before/after run 对；**写盘前先做 frontmatter 加载门校验**（用与 DSH 完全相同的 yaml@2.9.1 解析器复刻 `parseSkillFile`：首行 `---`、闭合 `---`、YAML 映射、name+description 必填、kebab-case 技能名、legacy invocation key 拒写、invocation 布尔型校验、metadata 必须是映射），任一不过直接抛错、绝不写盘；随后时间戳备份两本账本、守卫（建议已采纳/已挂 draftId 拒写、baseHash 按活文件现算）后原子写（generation+1），建议翻成 review+draftId。支持可选 `before` 入参，复用冻结的 before 分（用**调用方原始 cases** 校验哈希，避免富化后的哈希误拒） |
| `skill_evolution_verify` | 只读 | 独立回读 write 落地结果，复查每条不变量（建议 review+draftId / baseHash 匹配 / before-after run 成对 / after hash=草案 / casesHash 成对 / 分数自洽） |

**这些工具从不采纳、从不安装、从不覆盖正式 SKILL.md** —— 草案停在 `ready` 等人批准，跟它所打包的流水线一模一样。`write` 受 `allowWrite` 开关控制，且每次写前必备份。

## 公平闸门：先冻结评测标准，再进化（1.13.0）

用户核心诉求：**评测标准（cases）必须在进化新 skill 之前定死，before/after 用同一套，否则评分会因为「先写出新 skill 再评分」而失真。** 实现方式是轻量改法，不拆子代理：

1. **冻结**：设计并定稿 `cases` 之后，立即调 `skill_evolution_score`（skillName + cases）对**当前 live SKILL.md** 评一次，拿到 baseline（`baseHash` + `casesHash` + 分数）。这是本次进化**唯一**允许使用的 before 值。
2. **复用**：把 baseline 原样作为 `before` 传入 `skill_evolution_backtest`（第 5 步）与 `skill_evolution_write`（第 6 步）。插件校验 `casesHash` 与 `baseHash`，通过就**逐字复用**冻结的 before 分、绝不重算；`beforeReused` 字段会标明是否复用。
3. **漂移即拒绝**：cases 在冻结后被改动（`casesHash` 不匹配）或 live SKILL.md 被改动（`baseHash` 不匹配）时直接抛错，强制重跑 `skill_evolution_score`——**绝不静默用新 rubric 重算**，那正是要防的失真。
4. **只改草案不改 rubric**：回测后若 after 明显低于 before，只改进 draft，不改已冻结的 cases。

`skill_evolution_score` 是**只读**工具，不会写任何账本；它与 backtest/write 共用同一套评测引擎（LLM 语义评测，锚点仅作离线回退），因此 before/after 口径天然一致。

## 评分（与宿主 runScore 全量对齐）

评分口径与记忆插件（`dsh-mnemon-source-skills`）的宿主实现一致：

- **LLM 语义判定**：模型逐 check 判断正文是否**真正满足**该改进点（不是字面出现就算）。为减少小/快判题模型漏判导致的锚点回退，判题做了**补判 + 重试**：每个 case 首次调用若漏掉部分 check，**只针对缺失的 check 再问一次**并合并判定；首次输出不可解析时**重试一次**；只有补判/重试后仍缺、或模型不可达/报错，该 check/case 才回退锚点正则。评分引擎字段记录 provenance（`llm` / `anchor` / `llm+anchor`）。
- **must 加权**：`must:true` 的 check 权重 2，普通 check 权重 1；**case 的 verdict 仅当所有 must check 通过才为 pass**（must 未过即 fail，普通 check 未过只拉低 case 分、不 gate）。
- **case 级平均**：case 分 = 加权通过 / 总权重；run 分 = 各 case 分的均值（macro-average，非 check 级 micro-average）；run 的 `passRate` = 通过 case / 有分 case，与宿主 `runScore` 一致。

**粒度**：score 是 case 级加权平均，case 的 check 太少会让分数坍成粗台阶（如 1/5=0.2、4/5=0.8），掩盖部分回退。每个 case 请拆成至少 6–8 个独立 check（一个断言一个 check），分数才能真正区分强草案与弱草案。

**锚点校准教训**：锚点（回退用）必须锚「技能级知识点」，绝不能锚某个案例专属串（如某个示例才用的 `/go` 路由、`sandbox_permissions` token）。锚了案例专属串会让 `before` 假红（假阴性）或 `after` 假绿（假阳性），整个回测就在撒谎。看到 `before=0` 先回头重读锚点，确认每条都是真缺的知识点。

**对齐边界**：本插件的「对齐宿主 runScore」指**分数形式**（0~1 通过率、逐 check 部分分、case 级平均、must 加权）与宿主 `runScore`/`compareAutomaticSkillRuns` 一致；判定主体由本插件的模型判断代替宿主评估 agent，锚点仅为本插件新增的离线回退层（宿主无锚点）。

## frontmatter 加载门（m01144）

`skill_evolution_write` 在写盘前会复刻 **DSH 加载 SKILL.md 的同一道门**（来自 `@deepseek-ai/dsh-skill-filesystem` 的 `parseSkillFile`），用**与 DSH 完全相同的 yaml@2.9.1 解析器**（`lib/vendor/yaml`，已 vendored 进插件本体、源码自包含、不依赖插件目录外的文件夹）。它逐条对齐：

1. 首行必须是 `---`；必须找到闭合的 `---`；
2. 中间 YAML 必须能被解析成一个**映射**（数组/标量/空都拒绝）；
3. `name` 与 `description` 必填且非空字符串；
4. `name` 必须 kebab-case（`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`）；
5. 拒绝三个 legacy invocation key（`disableModelInvocation` / `modelInvocable` / `userInvocable`），报错文案带「use …」；
6. `disable-model-invocation` / `user-invocable` 必须是布尔（接受 `true/false/1/0/"true"/"yes"/"on"/"false"/"no"/"off"`）；
7. 若存在 `metadata`，必须是映射（不能是数组）。

任何一条不过，工具直接抛错（报错文案与 DSH 一致，例如未闭合引号是 `invalid YAML frontmatter: YAMLParseError: Missing closing "quote at line N, column M`），**绝不写盘**。这堵住了「草案一路过关变 `ready`、等到 Mnemon 落成、DSH 重新加载才炸」的低级漏洞——「最后给 skill 时再验证一次」就是这道门。离线回归 `selftest.mjs` 第 [8] 段覆盖全部 7 类拒绝 + 3 类合法 + 真实写工具拒绝坏草案/放行好草案。

## baseHash 用原始字节（m01752，修「草案已过期」误报）

进化刚落地的草案曾被面板判成「原技能已变更，此草案已过期」，但技能文件根本没动过。根因是**哈希口径不一致**：

- Mnemon 记忆插件算技能文件哈希用的是**原始字节**（`sha256(rawBuffer)`，不归一化换行）；
- 本插件之前算 `baseHash` 时把活文件做了 **CRLF→LF 归一化**再哈希。

凡 `SKILL.md` 里含 CRLF 换行（Windows 上很常见），两条哈希必不相等 → 面板 `base.hash !== draft.baseHash` → 误报「已过期」。LF 文件两条相等，所以这个 bug 之前一直没暴露。

**修法**：本插件新增 `liveFileHash(file)`（`fs.readFileSync(file)` 直接读原始 Buffer 再 sha256，不归一化），把 scan / write / verify / panel 里所有哈希点全部改为原始字节，与 Mnemon 对齐。`gradeBody` 的 CRLF→LF 归一化**保留**——那只用于逐 check 打分，与哈希无关。修复后，本插件写入的 `baseHash` 与 Mnemon 面板口径一致，进化草案不再被误判过期。

> 数据说明：修复只保证**之后**写入的草案口径正确；已经躺在账本里的旧草案（若是 CRLF 文件生成、baseHash 为归一化值）仍会报过期，需要重新生成一次，或等它被采纳/丢弃后自然消失。

## 交付前自我审查（validateDraftSchema，m02989 修「采纳报错 / 黑屏」全链）

`status='ready'` 的草案不只是本插件自己的数据——**Mnemon 面板和 host 的 `draft()` / `adoptDraft()` 服务对它有一组硬字段要求**。缺任何一个，本插件这边写进去看着没问题，但人一点开/一采纳就崩：

| 缺的字段 | 人的动作 | 后果 |
| --- | --- | --- |
| `changes` / `notes` / `updatedAt` | 打开审查页 | `DraftReview` 读 `draft.changes.length` → TypeError → **整页黑屏** |
| `runIds` | 打开审查页 | host `draft()` 读 `draft.runIds.flatMap` → TypeError |
| `baseKey` + `origin`（update） | 采纳 | host `requireOriginal` 解析不到原技能 → 报「旧记录未可靠保存原工作区」(origin-unavailable) |
| `baseHash`（update） | 采纳 | host `requireHash(..., draft.baseHash)` 在 `undefined` 时必抛 → 报「changed since it was read」 |

`skill_evolution_write` 现在在**原子写盘之前**调 `validateDraftSchema(draft)`（`lib/ledger.mjs`）做一次**交付前自我审查**：逐项核对上述全部字段（update 类型额外要求 `baseKey`/`origin.path`/`baseHash`），任一缺失或类型不对就**当场抛错、绝不写盘**。这样把「人点开才崩」的静默晚期失败，提前变成「写盘时就报错」的响亮早期失败——报错信息直接点名缺哪个字段，照着补即可，不用再等到面板上盲猜。

> 由来：2026-11-13 那批草案因为缺 `baseHash`（外加早期缺 `changes`/`runIds`/`origin`），采纳时逐个报错。这套自我审查把这些硬字段固化成 write 的出门口，之后无论谁调用都不会再漏。离线自测 `[4b]` 段就是这道门的回归（12 条负向 + 2 条正向）。

## 主代理降级与体积守卫（m03118，1.6.0）

> 本章与下一章「子代理工具挂载」描述的都是 `legacy` 模式（LLM 主代理 + 子代理）的行为；`new`（默认，1.16.0）为代码状态机，不拉起主代理、不发生子代理挂载与 B 模式降级。

「进化所选」拉起的主代理在提示里带两条韧性约束，让它在不理想环境下也不空转：

- **无子代理则自己干（B 模式降级）**：若主代理发现自己**无法派发子代理**（没有 subagent 工具、或 spawn 被拒/不可用），**不许卡住或报失败**——降级为**自己逐个技能**跑进化流水线（scan → 读 live SKILL.md → 起草 → backtest → write），再 verify 落地草案。即便单干也**绝不采纳/安装/覆盖正式 SKILL.md**，成稿仍只以 `ready` 草案停在面板等人批准。这与「技能进化编排：无法派发 subagent 时默认 B 模式自己干」的既定授权一致。
- **体积守卫（SIZE GUARD）**：写完草案后估算体积，超过安全线就**收紧**——合并重复章节、删冗余散文与过期/重叠的 Pitfalls、把冗长示例压到承重的命令/路径/API 行——但**保留全部可执行细节**（命令、路径、API 名、代码围栏）与仍有效内容。口径取自项目实测：`draftMaxTokens`=32768 输出 token 硬顶、中文密集文本 ≈2 字节/token，故**字节安全线 <50KB（≈<25K token），不是 30KB**；草案**本就 <50KB 就别再压**——再压只会删掉可用细节，违背保真要求。

## 子代理工具挂载（m03118，1.11.0）

**问题**：1.10.0 之前「进化所选」拉起的编排主代理，**全部没有 `subagent` 工具**——真实会话日志里 11 个编排主代理会话工具目录里均无 `subagent`，实际派发次数为 0，全部走 B 模式自干。模型说「无法开子代理」是**如实**，不是偷懒。

**根因**：出货的 `standard` 预设里委派工具所在的 delegation 组声明带 **`isolate: { workflowEngine: true }`**——该组（`tool-subagent` / `tool-subagent-fork` / `tool-subagent-control` / `workflow-ptc`）**仅在 workflow 引擎激活时才挂载**。插件原先只给 `agents.create` 传 `meta.agentPreset: 'standard'`，而 `agentPreset` **只写进会话 header、不触发组合挂载**，且插件未激活 workflow 引擎、未传 `setup` → 隔离的委派组从不进入主代理工具目录。对照：普通会话工具目录里有 `subagent` 的 2117 个，全是 workflow 引擎激活的会话；同一份 standard 预设，引擎激活才有这个工具。

**修复**：`spawnMainAgent` 给 `agents.create` 补 `setup` 回调，复刻宿主 `composeAgent` 的做法——从 `agentCtx` 取 `agentPresets` 服务，调 `presets.mount(agentCtx, 'standard')` 把预设组合（含隔离委派组）挂进 agent 的 scoped world，`subagent` / `subagent_fork` / `send_message` / `list_agents` 才随组合进入工具目录：

```js
setup: async (agentCtx) => {
  const presets = agentCtx.get('agentPresets')
  if (presets && typeof presets.mount === 'function') {
    await presets.mount(agentCtx, 'standard')
  }
},
```

`agentPreset` 仍照常传 `meta.agentPreset: 'standard'`（写 header，供会话首回合预设选定），**但真正让工具进目录的是这条 `setup`**。自测 `[7]` 新增三项断言：`meta.agentPreset=standard`、`setup` 是函数、调用 `setup` 时 `agentPresets.mount(agentCtx, 'standard')` 被真实触发。即便该挂载在某些环境失败，`agentPreset` 与 setup 都做空值/能力守卫，**不会**让编排崩掉——回退到 B 模式自干的保护不变。

## 评分粒度（GRANULARITY，m03216，1.7.0）

分数 = 通过的 check 数 / 总 check 数。若一个 case 只拆了少数几个 check，分数只能落在几个粗大的台阶上（如 1/5=0.2、4/5=0.8），看不出局部回退。本版本把「多拆 check」从 SKILL.md 的 Pitfall **提升进插件的进化提示与验证门**，让 evolve 代理真正产出细粒度分数：

- **生成侧（evolve 提示第 4b 步 GRANULARITY）**：要求**每个 case 拆出至少 6–8 个独立、可分别锚定的 check**（密集改动更多），一个 check 对应一条改进应保证的断言（守住的契约、记录的 Pitfall、禁止的错误模式、在场的示例、正确的交叉引用……），**绝不把多条断言塞进一个宽 check**。并明确提示：分数接近扁平（各 case ≈0.2/0.8）就是拆分不足的信号，应继续拆细再回测。
- **验证侧（verify 的 `granularityOk` 门）**：`skill_evolution_verify` 新增 `granularityOk` 检查——after run 的 check 总数 **≥6** 才算过；拆分不足会在验证报告里标红。
- **审核侧（主代理 review）**：主代理复核子代理产出时，除 `allOk` / 分数回退外，**`granularityOk=false` 也作为重试一次的理由**，并在重试提示里要求按 ≥6–8 check/case 重新拆分。

## 面板计数与记忆插件对齐（m03351，1.8.0）

修两个面板显示 bug：

- **「已选 x 个」数字不对**：`selected` 选择状态会从持久化的 `selectedSkills` 配置播种，里面可能残留**已不在列表里的陈旧 skillName**（已被采纳/驳回/过期出列表的），而 `selectedCount` 数的是所有 truthy key，导致数字比可见勾选框多。修法：载入时只播种仍在本轮 `skills` 列表里的名字，且 `selectedNames()` 只统计**当前列表内**的勾选，`save`/`evolve` 也只发列表内技能——陈旧 key 既不虚增计数也不会被送进进化。
- **面板技能数与记忆插件不一致**：本插件原先把 `pending/review/expired` 任一状态的技能都列进面板，而记忆插件的 `OPEN_STATUSES = {pending, drafting, review}`（且 pending 过了 `expiresAt` 会被 `expireSuggestions` 降级为 expired，不算 open）。差异案例：`dsh-present-card-render-diagnosis` 只有一条 expired 建议，本插件列了（4 个技能）、记忆插件没列（3 个）。修法：`panelStateImpl` 用 `effectiveStatus()` 套用同一条过期规则（pending 过 `expiresAt` → expired），且**只列有 ≥1 条 open 建议的技能**（expired-only 技能不再上榜，其 expired 计数仍显示在有 open 建议的技能行上）。两个面板技能数自此一致。

## 设置面板（客户端卡片）

插件还带一个**设置面板卡片**，出现在「设置 → 插件」里，让人不进记忆插件面板也能看到要进化的技能并做配置：

- **勾选要进化的技能**（checkbox，全选/清空/已选计数）；
- 每个技能一行：**类型**（进化=update 建议已存在 / 新建=create 建议新技能 / 进化+新建=两者都有）+ 待处理 / 待批准 / 一次性建议数 + **基线新鲜度**（FRESH=最新 / STALE=已漂移 / MISSING=缺文件）+ 是否已有待批准草案；
- **流水线模型**用下拉选择（不是自由输入），选项**数据驱动**：主源走宿主 `llm` 服务的 `listProviders()` + `listModels(provider)`，与模型选择器同一份目录，列出全部可用 provider/model；每个 provider 探测单独容错（一个挂不拖垮整个下拉），整次枚举带 8 秒超时（防慢/挂起 provider 拖死 state 端点）。`llm` 服务不可用或枚举无产出时降级回 `evals.json` 历史回测 run 里出现过的 provider/model 组合 + `workbuddy/hy4free` 默认；回测 run 会戳这个 model；
- **最大并发数**（1–16，默认 3，**运行时可再覆盖**）：同时进化的技能数上限。`new` 模式下是**代码信号量硬上限**（同时运行的逻辑 worker 数，由代码硬卡，不再依赖 LLM 自觉）；`legacy` 模式下仍是写进主代理提示的软上限。**=1 即串行，>1 即并发**；面板保存的是默认值，触发 `/evolve` 时还可在请求体用 `maxConcurrency`（或 `concurrency`）临时覆盖，越界（非 1–16）返回 400。
- 顶部徽章显示待批准草案数与有建议的技能数；
- **「进化所选」按钮**：把勾选的技能交给宿主 `POST /api/skill-evolution/evolve`。`new`（默认）模式由插件**代码状态机**驱动：宿主 `llm` 只产出 cases + 草案正文，代码按固定顺序 score→write→verify→backtest 落地，并发受信号量硬卡，收尾逐 draftId 复核并生成代码报告（`orchestrator:'code-state-machine'`，**不拉起 LLM 主代理、代理树里看不到子代理**）。`legacy` 模式才用 `agents.create()` 拉起一个 `standard` 主代理开子代理；两种模式都只落 `ready` 草案、绝不采纳/安装/覆盖正式 SKILL.md；
- **进化模式**（`evolutionMode`，默认 `new`，可选 `legacy`，**运行时可覆盖**）：决定编排由谁驱动。`new`（默认，1.16.0）＝**代码状态机全自动**（见上节：LLM 只交 cases+草案，代码管派发/并发硬卡/before 去重/落地/自审/复核/报告）；`legacy`＝拉起一个 LLM 主代理开子代理跑完整流水线（含判分），与改造前行为一致。运行时可在 `/evolve` 请求体用 `evolutionMode` 临时覆盖，非法值 400。
- **逐技能逐步进度（点击技能名内联展开，1.17.0）**：基础表格布局完全不变；点某个技能名即在该行下方内联展开该技能的逐步进度条（`new` 模式）：起草 cases+草案 → 修复无效草案 → 冻结 before 评分 → 落地草案(write) → 自审(verify) → 回测 after 打分 → 收尾逐草案复核；每步显示状态（等待 / 进行中 / 已完成 / 失败）与进度条，结束后展示代码生成的 report 摘要。数据来自 `GET /jobs` 的 `job.progress[skill]`（代码状态机在各阶段 `setStep` 上报，面板每 3 秒轮询刷新，跑完停在终态）。`legacy` 模式无逐步数据，子代理进度仍在代理树里看。

面板的勾选/模型/最大并发数/「进化所选」都只是**配置 + 触发**：它经 `fetch('/api/skill-evolution/state')`（读）、`fetch('/api/skill-evolution/config')`（写模型+勾选+最大并发数）、`fetch('/api/skill-evolution/evolve')`（拉起进化任务）、`fetch('/api/skill-evolution/jobs')`（轮询进度）打宿主的四个 HTTP 端点。勾选、模型与最大并发数持久化在插件的 `<stateDir>/panel-config.json`，重载不丢。**无论 `new`（代码状态机）还是 `legacy`（LLM 主代理），「进化所选」都绝不采纳、绝不安装、绝不覆盖正式 SKILL.md —— 成稿只以 `ready` 草案停在记忆插件面板等人批准。**

宿主端点（`ctx.inject(['webServer'], …)` + `webServer.register({kind:'exact',path,handler})`，**收集并返回 disposer** 防 HMR 撞 duplicate route）：

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/api/skill-evolution/state` | GET | 当前面板状态（每技能建议计数、类型、新鲜度、模型、勾选、**最大并发数**、阶段汇总、编排状态） |
| `/api/skill-evolution/config` | POST | 持久化 `{ model?: {provider, model}, selectedSkills?: string[], maxConcurrency?: number, evolutionMode?: 'new'|'legacy' }`；maxConcurrency 非 1–16 整数返回 400，evolutionMode 非 new/legacy 返回 400，GET 误用返回 405 |
| `/api/skill-evolution/evolve` | POST | 按 `evolutionMode` 分叉：`new` → 由插件代码状态机驱动（不拉起 LLM 主代理，宿主 `llm` 只交 cases+草案，并发为代码硬上限），`legacy` → 拉起**一个**真实 `standard` 主代理按软上限开子代理；`{ skills?, model?, maxConcurrency?, evolutionMode? }`，model 优先级 body > 面板 > 宿主默认，**maxConcurrency 运行时覆盖**，**evolutionMode 运行时覆盖**（默认 new），回传 `mode: 'serial'|'concurrent'`（=1 串行、>1 并发）与 `evolutionMode`；先返回 `{ ok, orchestrator, maxConcurrency, mode, evolutionMode, queued[], skipped[], model }` 再 fire-and-forget，`orchestrator` 按 mode 取 `code-state-machine` / `main-agent-spawns-subagents`；无勾选 400、maxConcurrency 非 1–16 返回 400、evolutionMode 非 new/legacy 返回 400、GET 误用 405、`new` 缺宿主 `llm` 服务 / `legacy` 缺 `agents` 服务返回 503 |
| `/api/skill-evolution/run` | POST | **服务端桥接路由**：`{ op: 'score'|'backtest'|'write'|'verify', ...args }` 直接在进程内调用与 agent 工具**同一条** `gradeFor→judgeBody` 路径（LLM 语义判定 + must 加权 + case 级均值，锚点仅回退）。`op:'score'` 冻结 baseline、`op:'backtest'` 支持复用 `before`。供无法直调 cordis 工具的会话 harness 脚本 POST 调用，避免它 import 锚点版 `gradeBody` 绕过 LLM 判定；未知 op 400、非 POST 405、异常 500 |
| `/api/skill-evolution/jobs` | GET | 返回本进程拉起的进化任务列表（jobId/技能数/类型/阶段/错误），供面板轮询进度；一次进化是单条任务，`new` 模式含代码生成的 report（worker/并发/调用计数）与 `progress`（逐技能逐步状态：`progress[skill]={status,current,steps:{drafting,repairing,scoring,landing,verifying,backtesting,auditing},error}`，供点击技能名内联展开） |

## 安装

本地自写插件（**宿主侧工具 + 客户端设置卡片**，经 `dsh.client` + `exports["./client"]` 进客户端）。装进桌面 profile 走「三处注册 + 软链」：

```
~/.dsh/profiles/desktop/node_modules/@local/dsh-skill-evolution-backtest  → 软链回本目录
package.json  dependencies["@local/dsh-skill-evolution-backtest"]="*"
package.json  dsh.profile.bundles 追加 "@local/dsh-skill-evolution-backtest"（末位）
pnpm-lock.yaml importers.'.'.dependencies 补 specifier/version 两条 link:
```

cordis 补丁只在启动时读取，装完需**完全退出并重开桌面端**才生效（由用户决定何时重启）。

## 配置（cordis.patch.yml）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `ledgerPath` | `~/.mnemon/skills/ledger.json` | 建议+草案账本 |
| `evalsPath` | `~/.mnemon/skills/evals.json` | 回测 case+run 账本 |
| `skillsRoot` | `~/.dsh/skills` | 活技能根（baseHash 对照这里） |
| `allowWrite` | `true` | `write` 总开关；`false` 时只报「将会做什么」不动手（干跑） |
| `backupKeep` | `20` | 两本账本的时间戳备份保留份数（写前必备份） |
| `model` | `workbuddy/hy4free` | 写入 run 的 model 戳 |
| `maxConcurrency` | `3` | 同时进化的技能数上限（1–16）。`new` 模式为**代码信号量硬上限**，`legacy` 模式为写进主代理提示的软上限。**=1 即串行，>1 即并发**；面板保存默认值，`/evolve` 请求体可用 `maxConcurrency`（或 `concurrency`）临时覆盖，越界（非 1–16）返回 400 |
| `evolutionMode` | `new` | 编排驱动方式。`new`（默认，1.16.0）＝代码状态机全自动（LLM 只交 cases+草案，代码管派发/并发硬卡/before 去重/落地/自审/复核/报告）；`legacy`＝拉起一个 LLM 主代理开子代理跑完整流水线（含判分）。运行时可在 `/evolve` 请求体用 `evolutionMode` 临时覆盖，非法值 400 |
| `gradeNote` | LLM 语义评分说明 | 戳在每个 check 行上，让评分语义可审计 |
| `gradeEngine` | `auto` | 评分引擎：`auto`=模型可达走 LLM 语义判定、不可达回退锚点；`llm` 强制模型判定；`anchor` 强制确定性锚点正则 |
| `judgeTimeoutMs` | `120000` | 单次 LLM 判定的超时（毫秒）；超时该 case 回退锚点 |
| `draftTimeoutMs` | `300000` | `new` 模式下单次 cases/草案生成的 LLM 超时（毫秒）；与判分用的 `judgeTimeoutMs` 分开 |

## 自测

```
node selftest.mjs
```

离线跑，不碰真实 `~/.mnemon` 存储：在临时目录造假账本，验证部分分数学、casesHash 签名、run/draft 记录形状、pruneDrafts（ready 恒保留）、原子写+generation+1+建议翻 review、并发守卫、verify 全不变量。

`[9]` 专门验证**服务端桥接路由** `/api/skill-evolution/run`：注入假 `llm.stream`，确认 `op:'backtest'` 真的走到 LLM 语义判定（`result.after.engine === 'llm'`，而非锚点回退），`op:'write'` 落 draft、`op:'verify'` 全不变量通过、未知 op 返 400——即 harness 脚本经 HTTP 调用时，评分链路与 agent 工具完全同源。`[10]` 验证**公平闸门**：`skill_evolution_score` 冻结 baseline（带 `baseHash`+`casesHash`+caseRows）、backtest/write 原样复用 `before`（`beforeReused=true`、分数逐字相等）、casesHash 漂移与 baseHash 漂移两种负向对照均被拒绝、`op:'score'` 经路由可达。`[12]` 验证 `/evolve` 按 `evolutionMode` 分叉（`new` 缺宿主 `llm` → 503、`legacy` → 拉起主代理 `main-agent-spawns-subagents`、非法 mode → 400）；`[13]` 用假 `llm.stream` 跑通 `new` 代码状态机的 I1–I10 不变量（worker 数=技能数、agentCreates=0、并发 ≤ 上限、score 一次冻结复用、write/verify/backtest 固定顺序、收尾逐 draftId 复核、代码生成 report 名实相符、全部落 `ready` 草案、as-it-arrives 补位、I10 逐技能逐步 progress 全 done）、`[14]` J1–J10（v1.18.0：A1 rubric/draft 两次小调用各一次、B 无 live 文件技能按 create 落地并在面板标警示）、[15] K1–K6（v1.18.1：DRAFT frontmatter 由代码合成保证合法）。v1.18.2：诊断回测在 baseline 漂移（baseHash/casesHash）时不再静默吞错，回退用同一 rubric 重评当前正文、记录 `beforeFallback`，after 分照常返回（面板回测步骤可见分数，不再出现「无回测结果」）。`[10]` 的负向对照仍证明 **write 侧公平闸门**照常拒绝漂移 baseline。v1.19.0：**进化面板 v2 UI**——进度条重设计为分段彩色横条（未完成灰段、失败段红色标出，新增「从失败处重试」）、顶部概览条（模型/进化模式/并发/技能进度/总用时/回测健康）+并行多技能卡片；新增两个面板端点：`GET /api/skill-evolution/draft?id=` 只读取草案正文供「查看草案」弹窗（不采纳/不安装），`POST /api/skill-evolution/rescore` 用与流水线同源的 `scoreImpl`+`backtestImpl` 重算 before/after 并镜像回内存 job（「无回测」卡片一键重算评分）。`[16]` 验证两端点的注册、取草案、400/404/405 负向、重算数值与 rubric 解析。v1.19.1：**面板四连修复**——①回测状态：`resultFor` 改为跨全部 job 的 report 搜索结果，避免最新 retry job 尚未产出结果时丢分、导致「进化过的技能仍显示无回测」；②各段用时：后端 `setStep` 记录每步 `startAt`（active 打点、done/failed 保留），前端 `segTime` 改算单步 `startAt→at` 真实耗时，不再被收尾 finalize 统一覆写时间戳而显示每段不足 1 秒；③小面板彩色链条：折叠态主表格行内新增 7 段彩色迷你链（`seb2-minichain`，复用 SEG_COLORS）；④深色模式按钮：默认/ghost 按钮改用 `label-primary` 字色 + 可见边框并补 `body[data-ds-dark-theme]` 深色覆盖，解决深色下按钮看不清。v1.19.2：**评分回传技能管理面板 + 视觉三修**——①根因修复：Mnemon 的 `SkillsService.saveEvals` 按 skillName 只保留数组前 20 条 run，而插件 write 时 `push` 到数组尾，新 run 在 Mnemon 下次保存时被裁掉，导致 ledger 草案 `runIds` 悬空、技能管理面板「进化」tab 一直显示「还没有回测」；插件改为 `unshift(afterRun, beforeRun)`（candidate 在前，与 Mnemon `startRun` 同序），新 run 落在数组头部故不被裁剪。②前端分段条/迷你链改用内联 `backgroundColor` 直填（原先经 React style 注入的 `var(--c)` 未生效，深色下 7 段全灰），done/active 着色、pending 保持灰段。③彩色迷你链从技能名同行移到名称下方独立换行（`display:flex` + `margin-top`），不再压住名称。④深色模式对比度：`body[data-ds-dark-theme]` 下 hint.ok/run/fail、badge.done/run/fail、meta、score、primary/danger 按钮改为低饱和深底浅字，消除刺眼浅绿与看不清的按钮。v1.19.3：**面板精简 + 任务取消**——①删概览条的「回测健康」（信息量低、常态显示缺失）；②删主表格的「一次性」与「基线」两列，原位改放 7 段彩色进度颗粒（从技能名同行移到独立「进度」列，表格由 8 列缩为 7 列）；③新增任务取消：后端新路由 `POST /api/skill-evolution/cancel` 标记 `cancelRequested`，代码状态机在下一个调度周期不再派新 worker、已启动的 in-flight 任务跑完后才停（避免半写草案），未启动的技能标为 canceled；前端并行区每个运行中任务加「取消」按钮。`[17]` 验证 `/cancel` 路由注册与 405/400/404 负向。

客户端面板另有离线验收（会话内脚本，不进插件目录）：假 React 渲染冒烟测试（无宿主验证无运行时错误 + 统计 checkbox/table/select/style/button + i18n zh/en key 对齐全扁平 + 可见文案无 raw key，含「进化所选」按钮与类型徽章）；宿主四个 HTTP 端点离线干跑（假 webServer 直调 handler：GET state 对真实账本只读返回、POST config 落盘模型+勾选、POST evolve 假 agents 服务拉起任务+模型优先级+无勾选 400/无服务 503、GET jobs 列任务，负向 400/405、disposer 数组已收集）。样式令牌全部对 app.asar 抽出的 475 个真实 `--dsw-*` token 做差集清零（防深色崩）。

## 边界

- 不采纳（adopt）、不安装（install）、不覆盖正式 SKILL.md。
- 成果以 `status='ready'` 草案停在面板待批准。
- 破坏性写有备份可回滚（`<stateDir>/backups/<时间戳>/`）。
- 设置面板在 GUI 里**展示状态 + 配置 + 触发**：勾选技能、选模型，点「进化所选」触发 `new` 代码状态机（LLM 只产出 cases+草案）或 `legacy` 拉起 agent 会话跑进化（创造性改写仍归 LLM/agent）。面板本身不写账本、不采纳；两种模式都只把成果落成 `ready` 草案，绝不采纳/安装/覆盖正式 SKILL.md。
- 「进化所选」`new` 模式依赖宿主 `llm` 服务、`legacy` 模式依赖 `agents`/`agentDefaultModel`/`sessions` 服务，缺失时该端点返回 503 而非误动作；任务跑在本进程内存里，宿主重启会丢进度记录（成稿已落账本的 `ready` 草案不受影响）。

### v2.0.1 — 修「冻结评分 / 回测瞬发 0.0s」（评审用错模型）

- **根因**：`gradeFor` 硬编码用 config 默认模型（`CFG.model`，默认 `workbuddy/hy4free`）去做语义评审，而不是 job 实际选中的模型。当面板选的模型与默认模型不同、或默认模型不可达时，评审 LLM 调用秒败失败 → `judgeCase` 静默回退到 anchor 正则（毫秒级）→ score / backtest 两段就读成 0.0s。rubric / draft / review 没这问题，因为它们直接拿到了 job 选中的 `llmModel`。
- **修法**：把 job 选中的模型一路穿进 `gradeFor` → `scoreImpl` / `backtestImpl` / `writeImpl`，评审和起草 rubric / 写草案用**同一个可达模型**。现在 score / backtest 会真正调 LLM 逐 check 语义判定、耗时如实反映（段详情带 `[engine]` 后缀，区分 `llm` / `anchor` / 缓存命中）。

### v2.0.0 — 公平性重构：撰写与审查彻底分离 + 七段重命名

- **公平闸门闭环（修「让写草案 LLM 看检查项=作弊」）**：拆出三个独立环节——`authorRubric` 只产评测标准（cases）、`writeDraft` 只写改进草案（**绝不喂 cases/anchors**，照检查项凑的漏洞已堵）、`reviewDraftInMemory` 由独立审查员（可看 rubric=裁判，作者不可看）在**草案落定前**门控。撰写与审查彻底分离，写草案环节再也无法抄标准。
- **审查前置 + 打回重写**：草案在落地前先过独立审查（最多 3 次重写预算），审查员打回的 issues 作为修复提示回流，而不是把整份 rubric 裸塞给作者。审查在落地**之前**，不再是落地后的事后追认。
- **七段进度链重命名**：`dispatch → rubric → score → draft → landing → backtest → verify`。评分（冻结 before 基线）移到草案之前，明确「先定标准 → 冻结基线 → 写草案（含审查）→ 落地 → 回测 → 自审」。落地失败该技能链断在 landing 标红、job 整体不断、beforeCache 复用、账本原子写不坏。
- **每段重试预算显到面板**：每段最多 3 次重试，重试计数写进步骤详情（`· retried Nx`）供面板红字渲染。
- **自审加体积守卫**：`verifyImpl` 新增 `sizeOk`（草案 ≤65536 字节），并入历史 12 项检查一起判定。
- **A+ 落地失败自动重跑**：自审失败时（如 run 对在落地和 verify 之间被宿主 keep-20 剪掉）自动按预算重新落地——复用同一份已过审草案内容与冻结基线（**不重评分、不重审**），新 run 对 `unshift` 到队首活过剪枝，再重新 verify。确定性失败（体积/粒度/分数自洽）重跑同样失败、按预算收敛，如实标记。

### v2.0.2 — 修「评审遗漏体积门 + 面板五个体验问题」

- **审查前置体积门（m07170 + m07205）**：起草→审查→重写循环里，`reviewDraftInMemory` 现在会先测草案字节数，超 65536 字节就打回要求**就地压缩到 64KB 以下**（把压缩指令作为 repairHint 返回给起草方重写）。不再等到最后 verify 才报「体积过大」那时只能崩链。`DRAFT_REVIEW_SYSTEM` 也加了「超大就打回」一条。
- **单技能计时冻结（m07140 Q1）**：展开卡「总用时」不再用整个 job 的时钟（其他技能还在跑时会一直涨），改用本技能自己的 dispatch→末段时间，技能一完成就冻结。
- **回测失败不再显绿勾（m07140 Q3）**：回测段失败时该段直接标红✕（不翻转整个技能为失败，因 landing+verify 已成功）；finalize 不再把已 failed 的段洗成绿 done。
- **「重新回测」按钮（m07155 Q2）**：当唯一失败段是回测（草案已落地+自审过）时，显示「↻ 重新回测」按钮直达 `/rescore`（真重评 before+after），不再是没意义的整技能重跑；`/rescore` 也传 job 选中的模型保证同一可达评审。
- **落地/自审耗时说明（m07140 Q4/Q5）**：落地里的 `writeImpl` 会对评分算一次真 LLM 语义评审（v2.0.1 修前用错模型秒败→秒回，修后真评审所以变长）；verify 纯读账本+\u54c8\u5e0c比对无 LLM，本就该瞬发。

### v1.19.4 — 动态时钟 + 默认不勾选 + 活动色块

- 总用时与各段计时动态实时跳动：运行中每秒重渲染一次（`now` state），不再只靠 3s 轮询刷新
- 打开面板默认全不勾选：不再回填上次持久化的选中技能
- 展开窗口活动色块可见：修正 `.seb2-flow` 用 `var(--c)` 被宿主 sanitizer 剥掉导致不显色，改为内联真实段色

### v1.19.5 — 评分对比并入 meta 行 + 精简 meta 项

- 回测评分对比不再单开一块，并入上方 meta 行（本次模型 / 总用时）末尾
- 删除 meta 行的待处理 / 待审 / 一次性 / 基线 MISSING 四项
- 「重新评分」按钮移到卡片底部操作区（仅在有草案但缺评分时显示）

### v1.19.6 — meta 行统一边框 + 取消按钮显示技能数

### v1.19.7 — 概览条取消均分 + 进行中段计时每秒跳动

### v1.28.0

- Top rows made flexible on a single line: overview cells share the row (flex:1 1 0) and truncate with ellipsis; expanded meta row forced to nowrap with shrinkable cells and a tighter score number/arrow/delta so the before->after->delta chip no longer clips off the card edge.

### v1.27.0

- Overview header strip forced onto a single line: the model cell shrinks (font steps down 12/11/10px by name length) with ellipsis safety net, so long model names no longer wrap the strip to a second line.

### v1.26.0

- **调度段真实计时**：`dispatch` 段原先从状态机建 progress 行才开始计时，而进化路由在派发前已花时间加载配置、解析模型、逐技能扫描建议——`pump()` 又几乎立即拉起 worker，导致调度段恒显 0.0s。现于路由入口盖 `acceptedAt` 戳，经 `spawnStateMachine` 传入作为 `job.startedAt` 与 dispatch 段 `startAt`，调度段如实反映排队等待。
- **评分类 cell 不再换行**：`.seb2-score` 去掉 `flex-wrap:wrap`、`.seb2-sctitle`/`.seb2-sc` 收窄 `min-width`，before→after→delta 单行排布。
- **回测出分即显**：单技能回测一完成（`pNow2.afterScore` 落 progress）立即在面板渲染真实 before→after→delta，无需等整批收尾。
- `[17]` 每段耗时语义=该段自身 `startAt→at`（等宽分段不变），瞬发段如实显 0.0s。

### v1.25.0

- **七段进度链：新增「调度」段**。进化面板现在显示 `dispatch → drafting → repairing → scoring → landing → verifying → backtesting` 七段。新增的「调度」段 = 从 job 启动（技能入队）到它的 worker 真正开始跑的排队等待时间，补齐了之前藏进总用时里、不落任何段的“主代理分配任务”时间。收尾复核保持并入「自审」（verifying），不单独占格。
- **评分/回测标注评测引擎**。scoring / backtesting 的完成详情现在带 `[engine]` 后缀（如 `model` / `anchor` / 缓存复用），区分“真模型判定（较慢）”与“降级正则 / 缓存命中（瞬发）”，避免 0.0s 被误读成“没跑”。
- 面板等宽彩色链同步为 7 段；selftest I10 与 smoke 断言同步为 7 段。

### v1.24.0

- 修时间轴失效：`setStep` 不再把上一段的开始时间强行继给「从未 active 直接 done」的段（如「修复草案」未触发重生时），改为给它自己的时间戳→时长准确读作 0.0s，不再重复显示上一段时长、也不再「卡在第一段然后瞬间完成」。

### v1.23.0

- 回测 before 基线一冻结就实时上面板：评分阶段一完成，展开栏就显示「before → 待回测」，不再等整个任务跑完。
- 展开栏 meta 行去掉「框中套框」：三个信息单元合成一块面板，用分隔线分隔，评分数值放大提层级。

### v1.22.0

- 收尾复核（auditing）不再单独占一个彩色段：段数 7→6。
- 整批级 final 重读仍作为安全网保留，但其结果并进第 5 段「自校验 verifying」（不一致时 verifying 变红）。

### v1.21.0

- 完成时间戳移到展开栏第一行（技能名旁），不再放在折叠表行。
- 该技能已有更新的待处理建议时，用红色「又有新的更新任务」注明代替时间戳。

### v1.20.0

- 删掉技能名后的「无 live 文件」⚠ 徽标（用户不需要）。
- 技能名后改为显示完成时间戳：该技能最新一次进化作业结束后（完成/取消/失败），在名称末尾显示 月/日 时:分。

### v1.19.9

- 修复进化面板技能列表与记忆插件不对齐：前端之前会丢掉还没装到磁盘的「新建」类待进化技能，导致 16 个待进化技能只显示 9 个。现在列出后端返回的全部待进化技能（含尚未安装的新建类），无实体文件的技能仍以行内⚠ 标记提醒。

### v1.19.8 — 概览条去竖线 + 刷新重同步任务 + 清除陈旧七色链
- 概览条去掉四根竖向分隔线（`.seb2-ov` 去 `border-right`），项目仅靠间距区分。
- 「刷新」按钮现在同时重读技能库（`/state`）与任务列表（`/jobs`），不再只刷一半。
- 折叠行的七色迷你链只在该技能有进行中任务时才显示；已完成/已取消的旧任务不再留下陈旧链，新需求技能不会误显旧进度。
- 展开行进行中段计时改为整秒（不带小数），该段结束定格后才显示精确到 0.1s 的小数。
- 概览条五项不再等宽均分（`.seb2-ov` 由 `flex:1` 改按内容宽），项间加 gap 28px；技能进度值 `white-space:nowrap` 不再换行成两行。
- 展开行各段计时 active 优先级修正：`segTime` 先判进行中段，用 `now` 每秒重算 `startAt→now`，不再被进入时刻 `at` 走首分支冻结成 0.0s（起草等段现在真实跳动）。

- meta 行的本次模型 / 总用时 / 评分对比统一加边框，对齐整齐
- 删掉进展段上方无意义的「60%」标签
- 取消按钮改为显示技能个数（原本截断前 40 字符导致只显示 2/3 个技能名）
