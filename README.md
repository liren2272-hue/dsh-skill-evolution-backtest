# dsh-skill-evolution-backtest

把 **Mnemon 技能进化流水线的确定性一半**打包成 4 个 agent 工具。创造性的一半（真正把 SKILL.md 改好）仍由 agent 负责；这个插件负责它周围那圈纯机械、每次会话都在手搓的脚手架。

## 为什么存在

Mnemon 记忆插件会进化技能：后台 review 产出 `suggestions`（「这个技能可以学 X」），然后由 agent 把建议落成改进版 SKILL.md、回测、再以 `ready` 草稿停在面板等人批准。这套流程里：

- **创造性的一半** —— 把技能真的改好 —— 属于 agent（LLM）。
- **确定性的一半** —— 扫描建议、逐 check 部分分回测、带备份+并发守卫地原子写账本、再独立复核 —— 是纯管道（plumbing），过去每个会话都在现搓一次性 python/cjs 脚本。

本插件把那圈管道变成可调用工具，agent 驱动流水线用工具而不是每次重写脚本。

## 四个工具

| 工具 | 读写 | 作用 |
| --- | --- | --- |
| `skill_evolution_scan` | 只读 | 列出 pending/review/expired 建议 + baseHash 新鲜度（FRESH/STALE/MISSING 对照活文件）+ 已有 draftId / lastError |
| `skill_evolution_backtest` | 只读 | 候选草案 vs 当前 SKILL.md 做**逐 check 部分分**回测（锚点法，score=通过 check/总 check，对齐宿主 runScore），返回 before/after/Δ 与逐 check 明细（含缺失锚点） |
| `skill_evolution_write` | **写** | 把一次回测落成 `status='ready'` 草案 + before/after run 对；**写盘前先做 frontmatter 加载门校验**（用与 DSH 完全相同的 yaml@2.9.1 解析器复刻 `parseSkillFile`：首行 `---`、闭合 `---`、YAML 映射、name+description 必填、kebab-case 技能名、legacy invocation key 拒写、invocation 布尔型校验、metadata 必须是映射），任一不过直接抛错、绝不写盘；随后时间戳备份两本账本、守卫（建议已采纳/已挂 draftId 拒写、baseHash 按活文件现算）后原子写（generation+1），建议翻成 review+draftId |
| `skill_evolution_verify` | 只读 | 独立回读 write 落地结果，复查每条不变量（建议 review+draftId / baseHash 匹配 / before-after run 成对 / after hash=草案 / casesHash 成对 / 分数自洽） |

**这些工具从不采纳、从不安装、从不覆盖正式 SKILL.md** —— 草案停在 `ready` 等人批准，跟它所打包的流水线一模一样。`write` 受 `allowWrite` 开关控制，且每次写前必备份。

## 逐 check 部分分（锚点法）

一个改进只有当**具体知识点真的落进正文**才算数。锚点是一条正则，是那段知识**必须**命中的；一个 check 通过=它的**全部**锚点都命中正文；case 分数=通过 check/总 check。所以修好 3 个 check 里 2 个的草案得 0.667，而不是非 0 即 1。

**锚点校准教训**：锚点必须锚「技能级知识点」，绝不能锚某个案例专属串（如某个示例才用的 `/go` 路由、`sandbox_permissions` token）。锚了案例专属串会让 `before` 假红（假阴性）或 `after` 假绿（假阳性），整个回测就在撒谎。看到 `before=0` 先回头重读锚点，确认每条都是真缺的知识点。

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

「进化所选」拉起的主代理在提示里带两条韧性约束，让它在不理想环境下也不空转：

- **无子代理则自己干（B 模式降级）**：若主代理发现自己**无法派发子代理**（没有 subagent 工具、或 spawn 被拒/不可用），**不许卡住或报失败**——降级为**自己逐个技能**跑进化流水线（scan → 读 live SKILL.md → 起草 → backtest → write），再 verify 落地草案。即便单干也**绝不采纳/安装/覆盖正式 SKILL.md**，成稿仍只以 `ready` 草案停在面板等人批准。这与「技能进化编排：无法派发 subagent 时默认 B 模式自己干」的既定授权一致。
- **体积守卫（SIZE GUARD）**：写完草案后估算体积，超过安全线就**收紧**——合并重复章节、删冗余散文与过期/重叠的 Pitfalls、把冗长示例压到承重的命令/路径/API 行——但**保留全部可执行细节**（命令、路径、API 名、代码围栏）与仍有效内容。口径取自项目实测：`draftMaxTokens`=32768 输出 token 硬顶、中文密集文本 ≈2 字节/token，故**字节安全线 <50KB（≈<25K token），不是 30KB**；草案**本就 <50KB 就别再压**——再压只会删掉可用细节，违背保真要求。

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
- **最大并发数**（1–16，默认 3）：同时进化的技能上限。它作为**软上限**写进主代理的提示——「进化所选」拉起**一个真实 `standard` 主代理**，主代理按此上限分批开子代理（每技能一个）进化、**自行审核**落地草案（verify 全不变量 + after 分数 ≥ before 分数）、**不通过则重试一次**。上限由 LLM 主代理遵守（非代码硬卡）；若干个一起跑也不互相踩账本（子代理经真 `skill_evolution_write`，写入自带 frontmatter 加载门 + 并发守卫）；
- 顶部徽章显示待批准草案数与有建议的技能数；
- **「进化所选」按钮**：把勾选的技能交给宿主，`agents.create()` 拉起**一个真实 `standard` 主代理**会话，主代理用 subagent 工具按并发上限开子代理跑进化流水线（scan → 起草改进版 SKILL.md → backtest 逐 check 部分分 → write 落 `ready` 草案），并逐草案审核、失败重试一次；创造性改写由主代理开的子代理完成，子代理在代理树可见；
- **「进化任务进度」块**：按钮触发后轮询实时显示主代理编排任务的技能数 / 类型 / 阶段（进行中 → 已完成 / 失败）；它是主代理的单条任务（不是每技能一条），子代理进度在代理树里看。进化要几分钟，跑完面板会停在原地。

面板的勾选/模型/最大并发数/「进化所选」都只是**配置 + 触发**：它经 `fetch('/api/skill-evolution/state')`（读）、`fetch('/api/skill-evolution/config')`（写模型+勾选+最大并发数）、`fetch('/api/skill-evolution/evolve')`（拉起进化任务）、`fetch('/api/skill-evolution/jobs')`（轮询进度）打宿主的四个 HTTP 端点。勾选、模型与最大并发数持久化在插件的 `<stateDir>/panel-config.json`，重载不丢。**即便走「进化所选」，被拉起的 agent 也被硬约束绝不采纳、绝不安装、绝不覆盖正式 SKILL.md —— 成稿只以 `ready` 草案停在记忆插件面板等人批准。**

宿主端点（`ctx.inject(['webServer'], …)` + `webServer.register({kind:'exact',path,handler})`，**收集并返回 disposer** 防 HMR 撞 duplicate route）：

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/api/skill-evolution/state` | GET | 当前面板状态（每技能建议计数、类型、新鲜度、模型、勾选、**最大并发数**、阶段汇总、主代理编排状态） |
| `/api/skill-evolution/config` | POST | 持久化 `{ model?: {provider, model}, selectedSkills?: string[], maxConcurrency?: number }`；maxConcurrency 非 1–16 整数返回 400，缺 model 字段返回 400，GET 误用返回 405 |
| `/api/skill-evolution/evolve` | POST | 拉起**一个**真实 `standard` 主代理，按并发上限（软上限，写进主代理提示）开子代理跑进化流水线并逐草案审核+失败重试一次；`{ skills?, model? }`，model 优先级 body > 面板 > 宿主默认；先返回 `{ ok, orchestrator, maxConcurrency, queued[], skipped[], model }` 再 fire-and-forget；无勾选 400、GET 误用 405、宿主 agents 服务缺失 503 |
| `/api/skill-evolution/jobs` | GET | 返回本进程拉起的进化任务列表（jobId/技能数/类型/阶段/错误），供面板轮询进度；主代理编排是单条任务 |

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
| `maxConcurrency` | `3` | 「进化所选」拉起的主代理可同时开的子代理上限（1–16）；作为**软上限**写进主代理提示，由 LLM 遵守，非代码硬卡 |
| `gradeNote` | 锚点评分说明 | 戳在每个 check 行上，让评分语义可审计 |

## 自测

```
node selftest.mjs
```

离线跑，不碰真实 `~/.mnemon` 存储：在临时目录造假账本，验证部分分数学、casesHash 签名、run/draft 记录形状、pruneDrafts（ready 恒保留）、原子写+generation+1+建议翻 review、并发守卫、verify 全不变量。

客户端面板另有离线验收（会话内脚本，不进插件目录）：假 React 渲染冒烟测试（无宿主验证无运行时错误 + 统计 checkbox/table/select/style/button + i18n zh/en key 对齐全扁平 + 可见文案无 raw key，含「进化所选」按钮与类型徽章）；宿主四个 HTTP 端点离线干跑（假 webServer 直调 handler：GET state 对真实账本只读返回、POST config 落盘模型+勾选、POST evolve 假 agents 服务拉起任务+模型优先级+无勾选 400/无服务 503、GET jobs 列任务，负向 400/405、disposer 数组已收集）。样式令牌全部对 app.asar 抽出的 475 个真实 `--dsw-*` token 做差集清零（防深色崩）。

## 边界

- 不采纳（adopt）、不安装（install）、不覆盖正式 SKILL.md。
- 成果以 `status='ready'` 草案停在面板待批准。
- 破坏性写有备份可回滚（`<stateDir>/backups/<时间戳>/`）。
- 设置面板在 GUI 里**展示状态 + 配置 + 触发**：勾选技能、选模型，点「进化所选」由宿主拉起 agent 会话跑进化（创造性改写仍归 agent）。面板本身不写账本、不采纳；被拉起的 agent 也被硬约束只把成果落成 `ready` 草案，绝不采纳/安装/覆盖正式 SKILL.md。
- 「进化所选」依赖宿主 `agents`/`agentDefaultModel`/`sessions` 服务，缺失时该端点返回 503 而非误动作；拉起的任务跑在本进程内存里，宿主重启会丢进度记录（成稿已落账本的 `ready` 草案不受影响）。