# dsh-skill-evolution-backtest

把 **Mnemon 技能进化流水线的确定性一半**打包成 5 个 agent 工具（见下）。1.16.0 起 `new` 模式更把这些工具串成一条由插件代码驱动的全自动状态机（见「代码状态机」一章）。创造性的一半（真正把 SKILL.md 改好）仍由 agent 负责；这个插件负责它周围那圈纯机械、每次会话都在手搓的脚手架。

## 为什么存在

Mnemon 记忆插件会进化技能：后台 review 产出 `suggestions`（「这个技能可以学 X」），然后由 agent 把建议落成改进版 SKILL.md、回测、再以 `ready` 草稿停在面板等人批准。这套流程里：

- **创造性的一半** —— 把技能真的改好 —— 属于 agent（LLM）。
- **确定性的一半** —— 扫描建议、逐 check 部分分回测、带备份+并发守卫地原子写账本、再独立复核 —— 是纯管道（plumbing），过去每个会话都在现搓一次性 python/cjs 脚本。

本插件把那圈管道变成可调用工具，agent 驱动流水线用工具而不是每次重写脚本。

## 代码状态机：new 模式（1.16.0）

> 背景：1.15.0 及以前的 `new` 模式把编排全交给一个 LLM 主代理，靠软提示词约束「并发 ≤ N」「先派发再评分」「子代理只写草案」等。实测（会话 928f11，7 个技能一起进化）证明 LLM 会忽略这些软约束：自行造出第二波 7 个落地子代理（共 14 个）、Write 波与落地波脱节空转约 24 分钟、总耗时 92 分钟，并在收尾报告里把 A 形态说成 C 形态（名实不符）。1.16.0 把**编排本身**从 LLM 提示词里拿走，改成插件代码里的确定性状态机。

**`new`（默认）= 全自动代码状态机**：`POST /evolve` 不再拉起任何 LLM 主代理。宿主 `llm` 服务只为每个技能产出一份 `{"cases":[...],"draftContent":"..."}`（评测 rubric + 改进版完整 SKILL.md 正文），其余全部由代码按固定顺序执行：

1. **一技能一 worker**：N 个技能 = N 个逻辑 worker（不是 2N）。草案生成失败最多在**落地前**修复 2 次，绝不带着坏草案落账本。
2. **并发硬上限**：代码信号量（`stats.active < maxConcurrency`），不是写进提示词的软上限；任一 worker 完成 `.finally` 先补位再干别的（PROCESS AS IT ARRIVES）。
3. **before 一次冻结、全程复用**：`scoreImpl` 每个 `skillName+casesHash` 只算一次并缓存，write/backtest 原样复用冻结的 `before`，杜绝重复冻结。
4. **确定性落地管道**：每个草案固定走 `writeImpl`（带冻结 `before`）→ 逐 `draftId` `verifyImpl` 自审 → `backtestImpl`（带冻结 `before`）算 after；共享账本写入加互斥锁，防并发丢更新。
5. **收口复核 + 代码生成报告**：全部完成后代码再逐 `draftId` 跑一次 `verifyImpl`，并生成 `report`（`orchestrator:'code-state-machine'`、`agentCreates=0`、`workerCount`、`peakConcurrency`、各类调用计数、`nameMatchesReality`），名实相符、不依赖 LLM 自述。

依赖宿主 `llm` 服务（`llm.stream`）；缺失时 `/evolve` 返回 503。新增配置 `draftTimeoutMs`（默认 300000）控制单次 cases/草案生成的 LLM 超时，与判分用的 `judgeTimeoutMs` 分开。

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

`[9]` 专门验证**服务端桥接路由** `/api/skill-evolution/run`：注入假 `llm.stream`，确认 `op:'backtest'` 真的走到 LLM 语义判定（`result.after.engine === 'llm'`，而非锚点回退），`op:'write'` 落 draft、`op:'verify'` 全不变量通过、未知 op 返 400——即 harness 脚本经 HTTP 调用时，评分链路与 agent 工具完全同源。`[10]` 验证**公平闸门**：`skill_evolution_score` 冻结 baseline（带 `baseHash`+`casesHash`+caseRows）、backtest/write 原样复用 `before`（`beforeReused=true`、分数逐字相等）、casesHash 漂移与 baseHash 漂移两种负向对照均被拒绝、`op:'score'` 经路由可达。`[12]` 验证 `/evolve` 按 `evolutionMode` 分叉（`new` 缺宿主 `llm` → 503、`legacy` → 拉起主代理 `main-agent-spawns-subagents`、非法 mode → 400）；`[13]` 用假 `llm.stream` 跑通 `new` 代码状态机的 I1–I10 不变量（worker 数=技能数、agentCreates=0、并发 ≤ 上限、score 一次冻结复用、write/verify/backtest 固定顺序、收尾逐 draftId 复核、代码生成 report 名实相符、全部落 `ready` 草案、as-it-arrives 补位、I10 逐技能逐步 progress 全 done）。

客户端面板另有离线验收（会话内脚本，不进插件目录）：假 React 渲染冒烟测试（无宿主验证无运行时错误 + 统计 checkbox/table/select/style/button + i18n zh/en key 对齐全扁平 + 可见文案无 raw key，含「进化所选」按钮与类型徽章）；宿主四个 HTTP 端点离线干跑（假 webServer 直调 handler：GET state 对真实账本只读返回、POST config 落盘模型+勾选、POST evolve 假 agents 服务拉起任务+模型优先级+无勾选 400/无服务 503、GET jobs 列任务，负向 400/405、disposer 数组已收集）。样式令牌全部对 app.asar 抽出的 475 个真实 `--dsw-*` token 做差集清零（防深色崩）。

## 边界

- 不采纳（adopt）、不安装（install）、不覆盖正式 SKILL.md。
- 成果以 `status='ready'` 草案停在面板待批准。
- 破坏性写有备份可回滚（`<stateDir>/backups/<时间戳>/`）。
- 设置面板在 GUI 里**展示状态 + 配置 + 触发**：勾选技能、选模型，点「进化所选」触发 `new` 代码状态机（LLM 只产出 cases+草案）或 `legacy` 拉起 agent 会话跑进化（创造性改写仍归 LLM/agent）。面板本身不写账本、不采纳；两种模式都只把成果落成 `ready` 草案，绝不采纳/安装/覆盖正式 SKILL.md。
- 「进化所选」`new` 模式依赖宿主 `llm` 服务、`legacy` 模式依赖 `agents`/`agentDefaultModel`/`sessions` 服务，缺失时该端点返回 503 而非误动作；任务跑在本进程内存里，宿主重启会丢进度记录（成稿已落账本的 `ready` 草案不受影响）。