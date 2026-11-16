/**
 * 设置卡片：技能进化面板。
 *
 * 绑定在 `plugins.bundle.config` 槽位，出现在「设置 → 插件」里。
 * 让人能勾选要进化的 skill、设置流水线用的模型，并看到每个 skill 当前
 * 有多少 pending/review/expired 建议 + baseHash 新鲜度。
 *
 * 边界（重要）：这个面板**只做配置与状态展示**。它经 fetch 调宿主的
 * `/api/skill-evolution/state`（读）与 `/api/skill-evolution/config`（写模型+勾选）。
 * 真正的「进化一个 skill」由插件驱动：`new` 模式是代码状态机（LLM 只交
 * cases + 草案，代码按 score→write→verify→backtest 落地），`legacy` 模式仍
 * 由 LLM 主代理开子代理；本面板不采纳、不安装、不覆盖正式 SKILL.md。
 *
 * 实现要点（全部经 dsh-api-rules + app.asar 取证，勿改）：
 *  - `t` 是函数 `t(key, vars)`，绝不可 `t.xxx`（会白屏）。
 *  - 字典必须是扁平的「点号字面量 key」：宿主 lookup 只做 `locales.get(locale)[key]`，
 *    `localeSeat()` 只是 `face.bind(ns)` 的薄包装，不展平嵌套对象。
 *  - 纯 React DOM + 组件级 `<style>`；CSS 变量只用 app.asar 里真实存在的
 *    `--dsw-alias-*` / `--dsw-radius-*` token，且一律带兜底色。本文件绝不写死颜色；
 *    主按钮 = button-primary-fill 底 + label-primary-foreground 字（随主题反转）。
 *  - React 在 factory 顶层取一次；组件渲染期 require('react') 会抛错。
 *
 * @module dsh-skill-evolution-backtest/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-skill-evolution-backtest',
  factory(require) {
    const name = 'dsh-skill-evolution-backtest-client'
    const inject = ['slots', 'locale']
    // React 在 factory 顶层取一次：组件渲染期 require('react') 会抛错。
    const ReactTop = require('react')

    // ── 文案（扁平点号 key，中文优先；en 在下方，两份 key 必须对齐） ───────────
    const zh = {
      'card.title': '技能进化',
      'card.subtitle': '勾选要进化的技能、设置流水线用的模型。new 模式由代码状态机驱动（LLM 只交评测标准与草案），legacy 模式由主代理编排子代理；成果一律以「待批准」草案停在面板。',
      'card.chip': '{ready} 个待批准草案',
      'card.chipAll': '共 {n} 个技能有建议',

      'status.loading': '读取中…',
      'status.empty': '还没有技能有待处理建议。',
      'status.error': '加载失败：{message}',

      'col.skill': '技能',
      'col.kind': '类型',
      'col.pending': '待处理',
      'col.review': '待批准',
      'col.expired': '一次性',
      'col.freshness': '基线',
      'col.draft': '草案',
      'col.progress': '进度',
      'action.cancel': '取消',
      'action.cancelN': '取消 · {n} 个技能',
      'action.cancelRequested': '已请求取消，任务将在当前步骤后停止',
      'action.cancelFail': '取消失败：{message}',
      'kind.update': '进化',
      'kind.create': '新建',
      'kind.both': '进化+新建',
      'kind.desc': '进化＝改进已有技能；新建＝从零建一个新技能。',
      'select.all': '全选',
      'select.none': '清空',
      'selected.count': '已选 {n} 个',

      'freshness.FRESH': '最新',
      'freshness.STALE': '已漂移',
      'freshness.MISSING': '缺文件',

      'draft.ready': '有待批准草案',
      'draft.none': '—',

      'model.title': '流水线模型',
      'model.desc': '回测 run 记录用这个模型戳记，便于区分工具跑的和手跑的。选项来自历史 run 用过的模型。',
      'model.select': '选择模型',
      'model.save': '保存设置',
      'model.saving': '保存中…',
      'model.saved': '已保存',
      'model.failed': '保存失败：{message}',

      'action.refresh': '刷新',
      'action.refreshing': '刷新中…',
      'footer.note': '草稿只停在「待批准」，需在记忆插件面板里人工批准；本面板不采纳、不安装。',
      'evolve.run': '进化所选',
      'evolve.running': '进化中…',
      'evolve.needSelect': '请先勾选要进化的技能',
      'evolve.started': '已启动进化（{n} 个技能，跳过 {skipped} 个；new＝代码状态机 / legacy＝主代理编排），点击技能名展开逐步进度',
      'evolve.failed': '拉起进化失败：{message}',
      'concurrency.title': '最大并发数',
      'concurrency.desc': '同时进化的技能上限（1–16，默认 3；1 为串行，>1 为并发）。new 模式下是代码硬上限（同时运行的处理单元数，由代码信号量硬卡），legacy 模式下是写进主代理提示的软上限。',
      'concurrency.invalid': '并发数需为 1–16 的整数',
      'evolutionMode.title': '进化模式',
      'evolutionMode.desc': '代码状态机（默认 `new`）＝插件代码全自动驱动：LLM 只交评测标准与草案，落地/自审/打分/比较/收口全由代码执行，N 个技能=N 个处理单元，并发上限由代码硬卡，before 基线一次冻结复用，收尾逐个草案复核；`legacy`＝LLM 主代理编排子代理（原样保留）。并发数很大时可切 legacy 对比速度。',
      'evolutionMode.new': '代码状态机（推荐）',
      'evolutionMode.legacy': '主代理编排（legacy）',
      'jobs.title': '进化任务进度',
      'jobs.running': '进行中',
      'jobs.queued': '排队中',
      'jobs.review': '审核中',
      'jobs.retrying': '重试中',
      'jobs.done': '已完成',
      'jobs.failed': '失败',
      'jobs.attempt': '第 {n} 次',
      'jobs.orchestrator': '编排方式（code-state-machine＝代码状态机 / main-agent-spawns-subagents＝主代理编排；{n} 个技能）',
      'progress.queued': '排队中',
      'progress.running': '进行中',
      'progress.pending': '等待',
      'progress.done': '完成',
      'progress.failed': '失败',
      'progress.skipped': '跳过',
      'progress.dispatch': '调度排队（等 worker）',
      'progress.rubric': '造评分标准（cases）',
      'progress.score': '冻结 before 评分',
      'progress.draft': '撰写 + 审查草案',
      'progress.landing': '落地草案（write）',
      'progress.backtest': '草案回测打分',
      'progress.verify': '最后自审（verify）',
      'progress.empty': '该技能暂无进化任务；勾选后点「进化所选」即可在此看到逐步进度。',
      'progress.stepStatus.pending': '等待',
      'progress.stepStatus.active': '进行中',
      'progress.stepStatus.done': '已完成',
      'evolve.missingWarn': '⚠ {missing} 个所选技能没有 live SKILL.md，将按「新建」处理（跳过，避免 update 门报错）。',
      'skill.missing': '无 live 文件',
      'skill.doneAt': '完成时间',
      'skill.newUpdate': '又有新的更新任务',
      'progress.stepStatus.failed': '失败',
      'overview.title': '本次任务概览',
      'overview.model': '本次模型',
      'overview.mode': '进化模式',
      'overview.concurrency': '并发数',
      'overview.progress': '技能进度',
      'overview.totalTime': '总用时',
      'overview.health': '回测健康',
      'overview.scored': '{a}/{b} 有评分',
      'overview.missing': '{n} 缺失 ⚠',
      'overview.none': '暂无任务',
      'legend.gray': '灰＝未完成',
      'legend.color': '彩＝已完成（每段不同色）',
      'legend.time': '段下文字＋用时',
      'legend.red': '红＝失败段 / 无回测告警',
      'mini.chain': '七段彩色进度链（折叠态迷你版）',
      'para.title': '▸ 多技能并行：同一时刻，多个进度条一起亮',
      'para.sub': '代码硬并发（同时最多 {n} 个 worker）；下面是进行中的技能，各跑各的、亮在不同阶段。',
      'card.done': '已完成',
      'card.stageDone': '✓ 阶段完成',
      'card.running': '● 进行中',
      'card.failed': '✕ 失败',
      'card.ready': 'ready 草案',
      'card.noScore': '⚠ 无回测评分',
      'card.viewDraft': '查看草案 ↗',
      'card.rescore': '重新生成评分',
      'card.rebacktest': '↻ 重新回测',
      'card.retry': '↻ 再次修复',
      'card.retryFail': '⟳ 从失败处重试',
      'card.viewLog': '查看日志',
      'card.failHere': '▼ 失败于此',
      'meta.pending': '待处理',
      'meta.review': '待审',
      'meta.oneShot': '一次性',
      'meta.baseline': '基线',
      'meta.kind': '类型',
      'meta.model': '本次模型',
      'meta.attempt': '第 {n} 次',
      'meta.totalTime': '总用时',
      'meta.elapsed': '已用时',
      'score.title': '回测评分对比',
      'score.before': 'before（冻结）',
      'score.after': 'after（草案）',
      'score.pending': '待回测',
      'score.missing': '回测评分缺失（afterScore = 空）',
      'score.missingWhy': 'baseline 校验未通过或回测阶段未产出评分 —— 建议「重新生成」补算评分。',
      'score.failedNo': '本技能无回测评分',
      'score.failedWhy': '失败发生在回测阶段，after 未产出；修复后应从失败段继续。',
      'hint.done': '{a}/{b} 阶段完成，草案已就绪（ready）。',
      'hint.noScore': '草案已生成但缺回测评分 —— 这里显式告警并提供「重新生成评分」，不用整批重跑。',
      'hint.running': '正在进化中，完成后评分对比会自动刷新。',
      'hint.failed': '在「{stage}」阶段失败 —— 点「从失败处重试」只补这一段。',
      'stepShort.dispatch': '调度',
      'stepShort.0': '造标准', 'stepShort.1': '冻结评分', 'stepShort.2': '撰写草案',
      'stepShort.3': '落地', 'stepShort.4': '回测', 'stepShort.5': '自审',
      'modal.title': '草案内容',
      'modal.draftId': '草案 ID',
      'modal.status': '状态',
      'modal.close': '关闭',
      'modal.loading': '读取中…',
      'modal.error': '读取失败：{message}',
      'modal.noBody': '（草案正文为空）',
      'action.rescoring': '重算中…',
      'action.rescoreDone': '评分已重新生成（{n} 个任务已刷新）',
      'action.rescoreFail': '重算失败：{message}',
      'action.retryStarted': '已发起再次修复（单技能重跑）',
      'action.retryFail': '发起修复失败：{message}',
    }
    const en = {
      'card.title': 'Skill Evolution',
      'card.subtitle': 'Pick which skills to evolve and set the pipeline model. In new mode a code state machine drives the pipeline (the LLM only supplies grading cases and the draft); in legacy mode an LLM main agent orchestrates subagents. Results land as ready drafts awaiting approval.',
      'card.chip': '{ready} ready drafts',
      'card.chipAll': '{n} skills with suggestions',

      'status.loading': 'Loading…',
      'status.empty': 'No skills have open suggestions yet.',
      'status.error': 'Load failed: {message}',

      'col.skill': 'Skill',
      'col.kind': 'Kind',
      'col.pending': 'Pending',
      'col.review': 'Review',
      'col.expired': 'One-shot',
      'col.freshness': 'Baseline',
      'col.draft': 'Draft',
      'col.progress': 'Progress',
      'action.cancel': 'Cancel',
      'action.cancelN': 'Cancel · {n} skill(s)',
      'action.cancelRequested': 'Cancel requested; the job stops after the current step',
      'action.cancelFail': 'Cancel failed: {message}',
      'kind.update': 'Evolve',
      'kind.create': 'New',
      'kind.both': 'Evolve+New',
      'kind.desc': 'Evolve improves an existing skill; New creates a brand-new one.',
      'select.all': 'Select all',
      'select.none': 'Clear',
      'selected.count': '{n} selected',

      'freshness.FRESH': 'fresh',
      'freshness.STALE': 'drifted',
      'freshness.MISSING': 'missing',

      'draft.ready': 'ready draft',
      'draft.none': '—',

      'model.title': 'Pipeline model',
      'model.desc': 'Backtest runs are stamped with this model so tool-driven runs are distinguishable from hand runs. Options come from models past runs have used.',
      'model.select': 'Select model',
      'model.save': 'Save settings',
      'model.saving': 'Saving…',
      'model.saved': 'Saved',
      'model.failed': 'Save failed: {message}',

      'action.refresh': 'Refresh',
      'action.refreshing': 'Refreshing…',
      'footer.note': 'Drafts stop at "ready" and must be approved by hand in the Mnemon panel; this panel never adopts or installs.',
      'evolve.run': 'Evolve selected',
      'evolve.running': 'Evolving…',
      'evolve.needSelect': 'Select at least one skill to evolve first',
      'evolve.started': 'Evolution started ({n} job(s), {skipped} skipped; new = code state machine / legacy = LLM main-agent orchestration) — click a skill name to expand step progress',
      'evolve.failed': 'Failed to start evolution: {message}',
      'concurrency.title': 'Max concurrency',
      'concurrency.desc': 'Cap on skills being evolved at once (1–16, default 3; 1 = serial, >1 = concurrent). In `new` mode this is a hard code-level cap (simultaneous workers, enforced by a code semaphore); in `legacy` mode it is a soft cap written into the main-agent prompt.',
      'concurrency.invalid': 'Concurrency must be an integer from 1 to 16',
      'evolutionMode.title': 'Evolution mode',
      'evolutionMode.new': 'Code state machine (recommended)',
      'evolutionMode.legacy': 'LLM main-agent orchestration (legacy)',
      'evolutionMode.desc': 'Code state machine (default `new`) = plugin code drives the whole pipeline automatically: the LLM supplies only the cases[] grading standard and the draft body, while landing/self-review/scoring/comparison/finalization are all executed by code; N skills = N workers, a hard concurrency cap is enforced in code, the frozen before baseline is reused once, and every draft gets per-draftId verification at wrap-up; `legacy` keeps the LLM main agent orchestrating subagents (unchanged). Switch to legacy to compare speed when concurrency is very high.',
      'jobs.title': 'Evolution job progress',
      'jobs.running': 'Running',
      'jobs.queued': 'Queued',
      'jobs.review': 'Reviewing',
      'jobs.retrying': 'Retrying',
      'jobs.done': 'Done',
      'jobs.failed': 'Failed',
      'jobs.attempt': 'attempt {n}',
      'jobs.orchestrator': 'Orchestration (code-state-machine = code state machine / main-agent-spawns-subagents = LLM main-agent orchestration; {n} skill(s))',
      'progress.queued': 'Queued',
      'progress.running': 'Running',
      'progress.pending': 'Waiting',
      'progress.done': 'Done',
      'progress.failed': 'Failed',
      'progress.skipped': 'Skipped',
      'progress.dispatch': 'Dispatch / queue wait',
      'progress.rubric': 'Author grading rubric (cases)',
      'progress.score': 'Freezing before score',
      'progress.draft': 'Author + review draft',
      'progress.landing': 'Landing drafts (write)',
      'progress.backtest': 'Backtesting after score',
      'progress.verify': 'Final self-audit (verify)',
      'progress.empty': 'No evolution job for this skill yet; select it and press "Evolve selected" to see step progress here.',
      'progress.stepStatus.pending': 'waiting',
      'progress.stepStatus.active': 'running',
      'progress.stepStatus.done': 'done',
      'evolve.missingWarn': '⚠ {missing} selected skill(s) have no live SKILL.md and will be treated as create (skipped to avoid the update gate).',
      'skill.missing': 'no live file',
      'skill.doneAt': 'finished',
      'skill.newUpdate': 'new update available',
      'progress.stepStatus.failed': 'failed',
      'overview.title': 'This run',
      'overview.model': 'Model',
      'overview.mode': 'Mode',
      'overview.concurrency': 'Concurrency',
      'overview.progress': 'Skills',
      'overview.totalTime': 'Elapsed',
      'overview.health': 'Backtest health',
      'overview.scored': '{a}/{b} scored',
      'overview.missing': '{n} missing ⚠',
      'overview.none': 'no jobs yet',
      'legend.gray': 'gray = pending',
      'legend.color': 'color = done (each segment its own color)',
      'legend.time': 'label + time under each segment',
      'legend.red': 'red = failed segment / no-backtest warning',
      'mini.chain': 'seven-segment colored progress chain (collapsed mini)',
      'para.title': '▸ Parallel skills: several bars lighting up at once',
      'para.sub': 'Hard concurrency (up to {n} workers). Snapshot of skills still running, each at a different stage.',
      'card.done': 'done',
      'card.stageDone': '✓ stages done',
      'card.running': '● running',
      'card.failed': '✕ failed',
      'card.ready': 'ready draft',
      'card.noScore': '⚠ no backtest',
      'card.viewDraft': 'View draft ↗',
      'card.rescore': 'Rescore',
      'card.rebacktest': '\u21bb Re-backtest',
      'card.retry': '↻ Retry',
      'card.retryFail': '⟳ Retry from failure',
      'card.viewLog': 'View log',
      'card.failHere': '▼ failed here',
      'meta.pending': 'pending',
      'meta.review': 'review',
      'meta.oneShot': 'one-shot',
      'meta.baseline': 'baseline',
      'meta.kind': 'kind',
      'meta.model': 'model',
      'meta.attempt': 'attempt {n}',
      'meta.totalTime': 'elapsed',
      'meta.elapsed': 'elapsed',
      'score.title': 'Backtest score',
      'score.before': 'before (frozen)',
      'score.after': 'after (draft)',
      'score.pending': 'pending',
      'score.missing': 'Backtest score missing (afterScore = empty)',
      'score.missingWhy': 'Baseline check failed or backtest produced no score — use Rescore to recompute.',
      'score.failedNo': 'No backtest score for this skill',
      'score.failedWhy': 'Failure happened in backtest; after was not produced. Retry resumes from that segment.',
      'hint.done': '{a}/{b} stages done, draft is ready.',
      'hint.noScore': 'Draft exists but its backtest score is missing — warned here with a Rescore button, no full rerun.',
      'hint.running': 'Evolving; the score comparison refreshes automatically when done.',
      'hint.failed': 'Failed at "{stage}" — Retry from failure only replays that segment.',
      'stepShort.dispatch': 'Dispatch',
      'stepShort.0': 'Rubric', 'stepShort.1': 'Freeze', 'stepShort.2': 'Draft',
      'stepShort.3': 'Land', 'stepShort.4': 'Backtest', 'stepShort.5': 'Verify',
      'modal.title': 'Draft content',
      'modal.draftId': 'Draft ID',
      'modal.status': 'Status',
      'modal.close': 'Close',
      'modal.loading': 'Loading…',
      'modal.error': 'Load failed: {message}',
      'modal.noBody': '(empty draft body)',
      'action.rescoring': 'Rescoring…',
      'action.rescoreDone': 'Score regenerated ({n} job(s) refreshed)',
      'action.rescoreFail': 'Rescore failed: {message}',
      'action.retryStarted': 'Retry started (single-skill rerun)',
      'action.retryFail': 'Failed to start retry: {message}',
    }

    // ── 样式：纯真实 token + 兜底色；类名统一 seb- 前缀，随组件卸载移除 ─────────
    const CSS = [
      '.seb-card{display:flex;flex-direction:column;gap:16px;padding:16px;border:1px solid var(--dsw-alias-border-l2,#e1e5ee);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b1b1c);font-family:inherit;}',
      '.seb-head{display:flex;flex-direction:column;gap:6px;}',
      '.seb-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,#1b1b1c);}',
      '.seb-subtitle{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary,#5b616e);}',
      '.seb-chip{align-self:flex-start;padding:2px 10px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,#f2f4f8);font-size:12px;color:var(--dsw-alias-label-secondary,#5b616e);}',
      '.seb-table{width:100%;border-collapse:collapse;font-size:13px;}',
      '.seb-table th{text-align:left;padding:6px 8px;color:var(--dsw-alias-label-tertiary,#8a909c);font-weight:500;border-bottom:1px solid var(--dsw-alias-border-l2,#e1e5ee);}',
      '.seb-table td{padding:8px;border-bottom:1px solid var(--dsw-alias-border-l2,#e1e5ee);vertical-align:middle;}',
      '.seb-table tr:hover td{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.03));}',
      '.seb-skillname{font-family:var(--dsw-font,inherit);color:var(--dsw-alias-label-primary,#1b1b1c);word-break:break-all;}',
      '.seb-badge{display:inline-block;padding:1px 8px;border-radius:var(--dsw-radius-md,8px);font-size:11px;border:1px solid var(--dsw-alias-border-l2,#e1e5ee);color:var(--dsw-alias-label-secondary,#5b616e);}',
      '.seb-badge.fresh{color:var(--dsw-alias-label-primary,#1b1b1c);}',
      '.seb-badge.drifted{color:var(--dsw-alias-state-error-primary,#c62828);border-color:var(--dsw-alias-state-error-primary,#c62828);}',
      '.seb-badge.kind-update{color:var(--dsw-alias-label-secondary,#5b616e);}',
      '.seb-badge.kind-create{color:var(--dsw-alias-brand-primary,#4475e6);border-color:var(--dsw-alias-brand-primary,#4475e6);}',
      '.seb-cb{width:15px;height:15px;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#4475e6);}',
      '.seb-actions{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.seb-actions-right{display:flex;gap:8px;align-items:center;}',
      '.seb-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 14px;border-radius:var(--dsw-radius-md,8px);border:.5px solid transparent;font-family:inherit;font-size:13px;line-height:1;font-weight:600;cursor:pointer;}',
      '.seb-btn.primary{background:var(--dsw-alias-button-primary-fill,#1b1b1c);color:var(--dsw-alias-label-primary-foreground,#fff);}',
      '.seb-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#3a3d44);}',
      '.seb-btn.ghost{background:transparent;color:var(--dsw-alias-label-primary,#1b1b1c);border-color:var(--dsw-alias-border-l2,#e1e5ee);}',
      '.seb-btn.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.03));}',
      '.seb-btn:disabled{opacity:.5;cursor:not-allowed;}',
      '.seb-model{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l2,#e1e5ee);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2,#f7f8fa);}',
      '.seb-model-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1b1b1c);}',
      '.seb-model-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#5b616e);}',
      '.seb-fields{display:flex;gap:10px;flex-wrap:wrap;}',
      '.seb-field{display:flex;flex-direction:column;gap:4px;flex:1;min-width:140px;}',
      '.seb-label{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a909c);}',
      '.seb-input{height:30px;padding:0 10px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2,#e1e5ee);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b1b1c);font-family:inherit;font-size:13px;}',
      '.seb-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4475e6);}',
      '.seb-select{height:30px;padding:0 28px 0 10px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2,#e1e5ee);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b1b1c);font-family:inherit;font-size:13px;cursor:pointer;appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-tertiary,#8a909c) 50%),linear-gradient(135deg,var(--dsw-alias-label-tertiary,#8a909c) 50%,transparent 50%);background-position:calc(100% - 16px) 13px,calc(100% - 11px) 13px;background-size:5px 5px,5px 5px;background-repeat:no-repeat;}',
      '.seb-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4475e6);}',
      '.seb-select:disabled{opacity:.5;cursor:not-allowed;}',
      '.seb-flash{font-size:12px;color:var(--dsw-alias-label-secondary,#5b616e);}',
      '.seb-flash.err{color:var(--dsw-alias-state-error-primary,#c62828);}',
      '.seb-alert{padding:12px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-state-error-primary,rgba(198,40,40,0.08));color:var(--dsw-alias-label-primary,#1b1b1c);font-size:13px;}',
      '.seb-empty{padding:16px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a909c);font-size:13px;}',
      '.seb-footer{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a909c);line-height:1.5;}',
      '.seb-jobs{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid var(--dsw-alias-border-l2,#e1e5ee);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2,#f7f8fa);}',
      '.seb-jobs-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1b1b1c);}',
      '.seb-job{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#5b616e);}',
      '.seb-job-skill{font-weight:600;color:var(--dsw-alias-label-primary,#1b1b1c);}',
      '.seb-job-action{color:var(--dsw-alias-label-tertiary,#8a909c);}',
      '.seb-job-err{color:var(--dsw-alias-state-error-primary,#c62828);}',
      '.seb-skillbtn{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;}',
      '.seb-skillbtn:hover{color:var(--dsw-alias-brand-primary,#4475e6);}',
      '.seb-caret{display:inline-block;width:12px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a909c);}',
      '.seb-prog-row td{background:var(--dsw-alias-bg-layer-2,#f7f8fa);padding:10px 12px;}',
      '.seb-prog{display:flex;flex-direction:column;gap:6px;}',
      '.seb-prog-head{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1b1b1c);}',
      '.seb-step{display:grid;grid-template-columns:150px 1fr 56px;gap:8px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary,#5b616e);}',
      '.seb-step-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.seb-bar{display:block;height:8px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e1e5ee);overflow:hidden;}',
      '.seb-bar-fill{display:block;height:100%;background:var(--dsw-alias-brand-primary,#4475e6);}',
      '.seb-step-status{text-align:right;font-size:11px;}',
      '.seb-prog-err{color:var(--dsw-alias-state-error-primary,#c62828);font-size:12px;}',
      '.seb2-doneat{margin-left:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a909c);font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.seb2-newupd{margin-left:6px;font-size:11px;font-weight:600;color:var(--dsw-alias-state-error-primary,#d64545);white-space:nowrap;}',
      '.seb-skillrow-missing td{opacity:0.6;}',
      '.seb2-overview{display:flex;flex-wrap:nowrap;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e1e5ee);border-radius:var(--dsw-radius-lg,12px);padding:12px 16px;gap:0 18px;}',
      '.seb2-ov{flex:1 1 0;min-width:0;padding:0 10px;}',
      '.seb2-ov:first-child{padding-left:0;}',
      '.seb2-ov:last-child{border-right:0;}',
      '.seb2-ovmodel{flex:0 1 auto;min-width:0;}',
      '.seb2-ovmodel .seb2-v{overflow:hidden;text-overflow:ellipsis;}',
      '.seb2-k{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a909c);margin-bottom:4px;}',
      '.seb2-v{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1b1b1c);font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.seb2-vmono{font-family:var(--dsw-font-monospace,Consolas,monospace);font-size:12px;}',
      '.seb2-warn{color:var(--dsw-alias-state-error-primary,#c62828);}',
      '.seb2-ok{color:var(--dsw-alias-state-success-primary,#12805c);}',
      '.seb2-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#5b616e);}',
      '.seb2-legend span{display:inline-flex;align-items:center;gap:5px;}',
      '.seb2-dot{width:9px;height:9px;border-radius:3px;display:inline-block;background:var(--dsw-alias-brand-primary,#4475e6);}',
      '.seb2-dot.g{background:var(--dsw-alias-bg-layer-2,#dde2eb);}',
      '.seb2-dot.ok{background:var(--dsw-alias-state-success-primary,#12805c);}',
      '.seb2-dot.r{background:var(--dsw-alias-state-error-primary,#d92d20);}',
      '.seb2-para{background:var(--dsw-alias-bg-layer-2,#eef1fb);border:1px solid var(--dsw-alias-border-l2,#d3daf5);border-radius:var(--dsw-radius-lg,12px);padding:12px 16px 14px;}',
      '.seb2-ptitle{font-size:13px;font-weight:600;color:var(--dsw-alias-brand-primary,#3451d6);}',
      '.seb2-psub{font-size:11.5px;color:var(--dsw-alias-label-secondary,#57619b);margin:3px 0 11px;line-height:1.5;}',
      '.seb2-plines{display:flex;flex-direction:column;gap:8px;}',
      '.seb2-pline{display:grid;grid-template-columns:minmax(120px,200px) 1fr 88px;gap:10px;align-items:center;}',
      '.seb2-pname{font-family:var(--dsw-font-monospace,Consolas,monospace);font-size:11px;color:var(--dsw-alias-label-secondary,#313a63);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.seb2-pmbar{display:flex;gap:3px;}',
      '.seb2-segmini{height:10px;flex:1;border-radius:3px;background:var(--dsw-alias-bg-layer-2,#c9cfe0);}',
      '.seb2-segmini.done{background:var(--c);}',
      '.seb2-segmini.active{background:var(--c);animation:seb2pulse 1.3s ease-in-out infinite;}',
      '.seb2-segmini.fail{background:var(--dsw-alias-state-error-primary,#d92d20);}',
      '.seb2-minichain{display:flex;gap:2px;margin-top:5px;width:100%;max-width:132px;}',
      '.seb2-minichain .seb2-segmini{height:6px;flex:1;min-width:5px;}',
      '@keyframes seb2pulse{0%,100%{opacity:1;}50%{opacity:.42;}}',
      '.seb2-pstage{font-size:11px;font-weight:600;color:var(--dsw-alias-brand-primary,#3b4584);text-align:right;}',
      '.seb2-card{display:flex;flex-direction:column;gap:10px;}',
      '.seb2-chead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.seb2-sname{font-family:var(--dsw-font-monospace,Consolas,monospace);font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1b1b1c);word-break:break-all;}',
      '.seb2-badge{font-size:11px;padding:2px 8px;border-radius:20px;font-weight:600;white-space:nowrap;background:var(--dsw-alias-bg-layer-2,#eef0f4);color:var(--dsw-alias-label-secondary,#565d6b);}',
      '.seb2-badge.done{background:var(--dsw-alias-state-success-bg,#e6f5ee);color:var(--dsw-alias-state-success-primary,#12805c);}',
      '.seb2-badge.run{background:var(--dsw-alias-interactive-bg-hover,#e9eeff);color:var(--dsw-alias-brand-primary,#3451d6);}',
      '.seb2-badge.fail{background:var(--dsw-alias-state-error-bg,#fde9e7);color:var(--dsw-alias-state-error-primary,#d92d20);}',
      '.seb2-badge.neu{background:var(--dsw-alias-bg-layer-2,#eef0f4);color:var(--dsw-alias-label-secondary,#565d6b);}',
      '.seb2-meta{display:flex;gap:0;flex-wrap:nowrap;padding:0;background:var(--dsw-alias-bg-layer-2,#f7f8fb);border:1px solid var(--dsw-alias-border-l2,#edf0f5);border-radius:var(--dsw-radius-md,8px);font-size:11px;color:var(--dsw-alias-label-secondary,#565d6b);overflow:hidden;}',
      '.seb2-meta b{color:var(--dsw-alias-label-primary,#1b1b1c);font-weight:600;}',
      '.seb2-score:last-child{border-right:0;}',
      '.seb2-score{display:flex;align-items:center;gap:6px;flex:1 1 0;min-width:0;padding:8px 10px;background:transparent;border:0;border-right:1px solid var(--dsw-alias-border-l2,#e1e5ee);flex-wrap:nowrap;white-space:nowrap;}',
      '.seb2-score.fail{background:var(--dsw-alias-state-error-bg,#fff5f4);border-color:var(--dsw-alias-state-error-primary,#f6c9c4);}',
      '.seb2-sctitle{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a909c);min-width:0;flex:0 0 auto;}',
      '.seb2-sc{display:flex;flex-direction:column;gap:2px;min-width:0;flex:0 0 auto;}',
      '.seb2-sck{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a909c);}',
      '.seb2-scn{font-size:16px;font-weight:700;color:var(--dsw-alias-label-primary,#1b1b1c);line-height:1.1;}',
      '.seb2-scn.good{color:var(--dsw-alias-state-success-primary,#12805c);}',
      '.seb2-scarrow{font-size:14px;color:var(--dsw-alias-label-tertiary,#8a909c);margin:0 5px 0 1px;flex:0 0 auto;}',
      '.seb2-scdelta{margin-left:auto;flex:0 0 auto;font-size:12px;font-weight:600;padding:3px 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#eef0f4);color:var(--dsw-alias-label-secondary,#565d6b);white-space:nowrap;}',
      '.seb2-scdelta.good{background:var(--dsw-alias-state-success-bg,#e6f5ee);color:var(--dsw-alias-state-success-primary,#12805c);}',
      '.seb2-scdelta.bad{background:var(--dsw-alias-state-error-bg,#fde9e7);color:var(--dsw-alias-state-error-primary,#d92d20);}',
      '.seb2-noscore{display:flex;align-items:flex-start;gap:9px;font-size:12px;color:var(--dsw-alias-state-error-primary,#d92d20);font-weight:600;}',
      '.seb2-noscore-x{width:20px;height:20px;border-radius:6px;background:var(--dsw-alias-state-error-primary,#d92d20);color:var(--dsw-alias-label-primary-foreground,#fff);display:inline-grid;place-items:center;font-size:12px;flex:none;}',
      '.seb2-noscore small{display:block;font-weight:400;color:var(--dsw-alias-label-secondary,#a33);margin-top:2px;font-size:11px;}',
      '.seb2-track{display:flex;gap:5px;margin-top:4px;}',
      '.seb2-segwrap{flex:1;min-width:0;position:relative;}',
      '.seb2-segwrap>.seb2-tick{position:absolute;left:0;right:0;top:0;height:15px;display:grid;place-items:center;color:var(--dsw-alias-label-primary-foreground,#fff);font-size:10px;font-weight:700;pointer-events:none;}',
      '.seb2-seg{height:15px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,#dde2eb);position:relative;overflow:hidden;}',
      '.seb2-seg.done{background:var(--c);}',
      '.seb2-seg.done::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,.3),transparent 60%);}',
      '.seb2-seg.active{background:var(--dsw-alias-bg-layer-2,#e7ebf3);}',
      '.seb2-flow{position:absolute;top:0;left:0;height:100%;width:58%;border-radius:5px;background:var(--c);animation:seb2flow 2.2s ease-in-out infinite;}',
      '@keyframes seb2flow{0%{left:-30%;}100%{left:110%;}}',
      '.seb2-seg.fail{background:var(--dsw-alias-state-error-primary,#d92d20);}',
      '.seb2-seg.fail::after{content:"✕";position:absolute;inset:0;display:grid;place-items:center;color:var(--dsw-alias-label-primary-foreground,#fff);font-size:11px;font-weight:700;}',
      '.seb2-tick{position:absolute;inset:0;display:grid;place-items:center;color:var(--dsw-alias-label-primary-foreground,#fff);font-size:10px;font-weight:700;}',
      '.seb2-pct{position:absolute;top:-16px;left:50%;transform:translateX(-50%);font-size:10px;color:var(--dsw-alias-label-secondary,#5b616e);font-weight:700;}',
      '.seb2-failflag{position:absolute;bottom:22px;left:50%;transform:translateX(-50%);background:var(--dsw-alias-state-error-primary,#d92d20);color:var(--dsw-alias-label-primary-foreground,#fff);font-size:10px;font-weight:600;padding:2px 7px;border-radius:6px;white-space:nowrap;z-index:1;}',
      '.seb2-labels{display:flex;gap:5px;}',
      '.seb2-lab{flex:1;min-width:0;text-align:center;}',
      '.seb2-labn{display:block;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#565d6b);line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.seb2-labs{display:block;font-size:10px;color:var(--dsw-alias-label-tertiary,#8b93a1);margin-top:2px;}',
      '.seb2-labt{display:block;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a909c);margin-top:1px;font-variant-numeric:tabular-nums;}',
      '.seb2-lab.done .seb2-labs{color:var(--dsw-alias-state-success-primary,#12805c);}',
      '.seb2-lab.active .seb2-labn,.seb2-lab.active .seb2-labs{color:var(--dsw-alias-brand-primary,#5b61d6);}',
      '.seb2-lab.fail .seb2-labn,.seb2-lab.fail .seb2-labs{color:var(--dsw-alias-state-error-primary,#d92d20);}',
      '.seb2-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px dashed var(--dsw-alias-border-l2,#e1e5ee);padding-top:10px;margin-top:2px;}',
      '.seb2-hint{display:flex;align-items:center;gap:7px;font-size:11.5px;padding:7px 10px;border-radius:8px;flex:1;line-height:1.5;min-width:200px;background:var(--dsw-alias-bg-layer-2,#eef0f4);color:var(--dsw-alias-label-secondary,#565d6b);}',
      '.seb2-hint.ok{background:var(--dsw-alias-state-success-bg,#eef8f1);color:var(--dsw-alias-state-success-primary,#1a7a3c);}',
      '.seb2-hint.run{background:var(--dsw-alias-interactive-bg-hover,#f0f4ff);color:var(--dsw-alias-brand-primary,#3a4ec0);}',
      '.seb2-hint.fail{background:var(--dsw-alias-state-error-bg,#fdeeee);color:var(--dsw-alias-state-error-primary,#a82a22);}',
      '.seb2-ic{font-weight:700;flex:none;}',
      '.seb2-btn{font-size:11.5px;font-weight:600;padding:6px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d7dbe4);cursor:pointer;white-space:nowrap;font-family:inherit;background:var(--dsw-alias-bg-layer-2,#eef0f4);color:var(--dsw-alias-label-primary,#1b1b1c);}',
      '.seb2-btn.ghost{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b1b1c);border-color:var(--dsw-alias-border-l2,#d7dbe4);}',
      '.seb2-btn.primary{background:var(--dsw-alias-brand-primary,#3451d6);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent;}',
      '.seb2-btn.danger{background:var(--dsw-alias-state-error-primary,#d92d20);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent;}',
      '.seb2-btn:hover{filter:brightness(.96);}',
      'body[data-ds-dark-theme] .seb2-btn{background:var(--dsw-alias-bg-layer-2,#23262b);color:var(--dsw-alias-label-primary,#f2f4f7);border-color:var(--dsw-alias-border-l2,#3a3f47);}',
      'body[data-ds-dark-theme] .seb2-btn.ghost{background:var(--dsw-alias-bg-layer-2,#23262b);color:var(--dsw-alias-label-primary,#f2f4f7);border-color:var(--dsw-alias-border-l2,#4a5058);}',
      'body[data-ds-dark-theme] .seb2-btn.primary{background:#3b5bdb;color:#fff;border-color:transparent;}',
      'body[data-ds-dark-theme] .seb2-btn.danger{background:#e03131;color:#fff;border-color:transparent;}',
      'body[data-ds-dark-theme] .seb2-btn:hover{filter:brightness(1.12);}',
      'body[data-ds-dark-theme] .seb2-hint.ok{background:rgba(18,128,92,.16);color:#8ee6bd;border:1px solid rgba(18,128,92,.35);}',
      'body[data-ds-dark-theme] .seb2-hint.run{background:rgba(59,91,219,.16);color:#a5b4fc;border:1px solid rgba(59,91,219,.35);}',
      'body[data-ds-dark-theme] .seb2-hint.fail{background:rgba(224,49,49,.14);color:#ffa8a8;border:1px solid rgba(224,49,49,.35);}',
      'body[data-ds-dark-theme] .seb2-badge.done{background:rgba(18,128,92,.18);color:#8ee6bd;}',
      'body[data-ds-dark-theme] .seb2-badge.run{background:rgba(59,91,219,.18);color:#a5b4fc;}',
      'body[data-ds-dark-theme] .seb2-badge.fail{background:rgba(224,49,49,.18);color:#ffa8a8;}',
      'body[data-ds-dark-theme] .seb2-meta{background:var(--dsw-alias-bg-layer-2,#1f2125);border-color:var(--dsw-alias-border-l2,#33363b);}',
      'body[data-ds-dark-theme] .seb2-score{border-right-color:#33363b;}',
      'body[data-ds-dark-theme] .seb2-score{background:var(--dsw-alias-bg-layer-2,#1f2125);border-color:var(--dsw-alias-border-l2,#33363b);}',
      'body[data-ds-dark-theme] .seb2-pct{color:#c8cdd6;}',
      '.seb2-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.42);display:grid;place-items:center;z-index:50;padding:24px;}',
      '.seb2-modal{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e1e5ee);border-radius:var(--dsw-radius-lg,12px);width:min(860px,94vw);max-height:86vh;display:flex;flex-direction:column;overflow:hidden;}',
      '.seb2-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#e1e5ee);}',
      '.seb2-modal-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1b1b1c);}',
      '.seb2-modal-body{padding:14px 16px;overflow:auto;font-size:12px;color:var(--dsw-alias-label-primary,#1b1b1c);}',
      '.seb2-modal-pre{margin:10px 0 0;padding:12px;background:var(--dsw-alias-bg-layer-2,#f7f8fb);border:1px solid var(--dsw-alias-border-l2,#e1e5ee);border-radius:var(--dsw-radius-md,8px);font-family:var(--dsw-font-monospace,Consolas,monospace);font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;}',
    ].join('')

    // ── 组件 ────────────────────────────────────────────────────────────────
    function EvolutionCard({ React, t }) {
      const { useState, useEffect, useRef, useCallback } = React
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState('')            // '' | 'refresh' | 'save' | 'evolve'
      const [selected, setSelected] = useState({})    // skillName -> bool
      const [model, setModel] = useState({ provider: '', model: '' })
      const [maxConcurrency, setMaxConcurrency] = useState(3)
      const [evolutionMode, setEvolutionMode] = useState('new')
      const [flash, setFlash] = useState(null)        // { ok, text }
      const [jobs, setJobs] = useState([])            // live evolve jobs
      const [expanded, setExpanded] = useState({})   // skillName -> bool (inline per-skill progress)
      const [draftView, setDraftView] = useState(null) // null | {loading,id,skillName} | {draft} | {error,...}
      const [now, setNow] = useState(() => Date.now())
      // Live clock: re-render every second while any job is running so the
      // overview elapsed time and in-progress segment timers tick in real time
      // instead of only updating on the 3s job poll.
      useEffect(() => {
        const running = (jobs || []).some((j) => j.status === 'running' || ['queued', 'running', 'review', 'retrying'].includes(j.phase))
        if (!running) return
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
      }, [jobs])
      const alive = useRef(true)
      const safeSet = (fn) => { if (alive.current) fn() }

      useEffect(() => () => { alive.current = false }, [])

      const load = useCallback(async () => {
        try {
          const res = await fetch('/api/skill-evolution/state', { cache: 'no-store' })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const data = await res.json()
          safeSet(() => {
            setState(data)
            setError(null)
            setModel({ provider: data.model?.provider || '', model: data.model?.model || '' })
            setMaxConcurrency(Number.isFinite(data.maxConcurrency) ? data.maxConcurrency : 3)
            setEvolutionMode(data.evolutionMode === 'legacy' ? 'legacy' : 'new')
            // Always open with nothing selected — the user picks skills explicitly
            // rather than inheriting whatever was persisted from a previous run.
            setSelected({})
          })
        } catch (e) {
          safeSet(() => setError(String(e && e.message || e)))
        } finally {
          safeSet(() => setLoading(false))
        }
      }, [])

      useEffect(() => { load() }, [load])

      const toggle = (skillName) => setSelected((prev) => ({ ...prev, [skillName]: !prev[skillName] }))
      // Count/collect only selections that map to a currently-listed skill, so a
      // stale persisted key can never inflate "已选 x 个" or reach save/evolve.
      const selectedNames = () => {
        const listed = new Set(skills.map((s) => s.skillName))
        return Object.keys(selected).filter((k) => selected[k] && listed.has(k))
      }

      const save = useCallback(async () => {
        setBusy('save'); setFlash(null)
        const n = Number(maxConcurrency)
        if (!Number.isInteger(n) || n < 1 || n > 16) {
          safeSet(() => setFlash({ ok: false, text: t('concurrency.invalid') }))
          return
        }
        try {
          const res = await fetch('/api/skill-evolution/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, selectedSkills: selectedNames(), maxConcurrency: n, evolutionMode }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body.ok === false) throw new Error(body.error || 'HTTP ' + res.status)
          safeSet(() => { setFlash({ ok: true, text: t('model.saved') }); setState(body) })
        } catch (e) {
          safeSet(() => setFlash({ ok: false, text: t('model.failed', { message: String(e && e.message || e) }) }))
        } finally {
          safeSet(() => setBusy(''))
        }
      }, [model, maxConcurrency, selected, t])

      // Trigger a real evolution run for the selected skills. Spawns one agent per
      // open skill; the run takes minutes, so the panel polls GET /jobs for progress.
      const evolve = useCallback(async () => {
        const names = selectedNames()
        if (names.length === 0) {
          safeSet(() => setFlash({ ok: false, text: t('evolve.needSelect') }))
          return
        }
        setBusy('evolve'); setFlash(null)
        try {
          const res = await fetch('/api/skill-evolution/evolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skills: names, model }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body.ok === false) throw new Error(body.error || 'HTTP ' + res.status)
          const queuedCount = Array.isArray(body.queued) ? body.queued.length : 0
          const skippedCount = Array.isArray(body.skipped) ? body.skipped.length : 0
          const missingNames = names.filter((n) => { const s = skills.find((x) => x.skillName === n); return s && s.skillFileExists === false })
          const missingWarn = missingNames.length > 0 ? t('evolve.missingWarn', { missing: missingNames.length }) : ''
          safeSet(() => setFlash({
            ok: true,
            text: [t('evolve.started', { n: queuedCount, skipped: skippedCount }), missingWarn].filter(Boolean).join(' '),
          }))
          // Pick up the new jobs promptly.
          safeSet(() => pollJobs())
        } catch (e) {
          safeSet(() => setFlash({ ok: false, text: t('evolve.failed', { message: String(e && e.message || e) }) }))
        } finally {
          safeSet(() => setBusy(''))
        }
      }, [selected, model, t])

      const pollJobs = useCallback(async () => {
        try {
          const res = await fetch('/api/skill-evolution/jobs', { cache: 'no-store' })
          if (!res.ok) return
          const data = await res.json().catch(() => ({}))
          safeSet(() => setJobs(Array.isArray(data.jobs) ? data.jobs : []))
        } catch { /* transient — next tick retries */ }
      }, [])

      const refresh = useCallback(async () => {
        setBusy('refresh')
        await load()
        await pollJobs()
        safeSet(() => setBusy(''))
      }, [load, pollJobs])

      useEffect(() => { load() }, [load])
      // Poll job progress only while something is still running; stop when idle.
      useEffect(() => {
        let timer = null
        const tick = async () => {
          await pollJobs()
          if (!alive.current) return
          const stillRunning = jobsRef.current.some(
            (j) => j.status === 'running' || ['queued', 'running', 'review', 'retrying'].includes(j.phase),
          )
          if (stillRunning) timer = setTimeout(tick, 3000)
        }
        timer = setTimeout(tick, 3000)
        return () => { if (timer) clearTimeout(timer) }
      }, [pollJobs])
      const jobsRef = useRef([])
      useEffect(() => { jobsRef.current = jobs }, [jobs])
      useEffect(() => { pollJobs() }, [pollJobs])

      // v2 card actions — all mapped to real backend routes (no dead buttons).
      const doViewDraft = async (id, skillName) => {
        safeSet(() => setDraftView({ loading: true, skillName, id }))
        try {
          const res = await fetch('/api/skill-evolution/draft?id=' + encodeURIComponent(id), { cache: 'no-store' })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + res.status)
          safeSet(() => setDraftView({ draft: data.draft }))
        } catch (e) {
          safeSet(() => setDraftView({ error: String(e && e.message || e), skillName, id }))
        }
      }
      const doRescore = async (skillName, draftId) => {
        safeSet(() => setFlash({ ok: true, text: t('action.rescoring') }))
        try {
          const payload = { skillName }
          if (draftId) payload.draftId = draftId
          const res = await fetch('/api/skill-evolution/rescore', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + res.status)
          safeSet(() => setFlash({ ok: true, text: t('action.rescoreDone', { n: (data.result && data.result.mirrored) || 0 }) }))
          safeSet(() => pollJobs())
        } catch (e) {
          safeSet(() => setFlash({ ok: false, text: t('action.rescoreFail', { message: String(e && e.message || e) }) }))
        }
      }
      const doRetry = async (skillName) => {
        setBusy('evolve'); setFlash(null)
        try {
          const res = await fetch('/api/skill-evolution/evolve', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skills: [skillName], model }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + res.status)
          safeSet(() => setFlash({ ok: true, text: t('action.retryStarted') }))
          safeSet(() => pollJobs())
        } catch (e) {
          safeSet(() => setFlash({ ok: false, text: t('action.retryFail', { message: String(e && e.message || e) }) }))
        } finally { safeSet(() => setBusy('')) }
      }
      const doCancel = async (jobId) => {
        try {
          const res = await fetch('/api/skill-evolution/cancel', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + res.status)
          safeSet(() => setFlash({ ok: true, text: t('action.cancelRequested') }))
          safeSet(() => pollJobs())
        } catch (e) {
          safeSet(() => setFlash({ ok: false, text: t('action.cancelFail', { message: String(e && e.message || e) }) }))
        }
      }
      const doViewLog = (skillName) => {
        const jb = latestJobFor(skillName), pp = jb && jb.progress && jb.progress[skillName]
        safeSet(() => setFlash({ ok: false, text: String((pp && pp.error) || t('progress.failed')) }))
      }

      const skills = (state && Array.isArray(state.skills)) ? state.skills : []
      const modelOptions = (state && Array.isArray(state.modelOptions)) ? state.modelOptions : []
      const selectedCount = selectedNames().length
      const allChecked = skills.length > 0 && skills.every((s) => selected[s.skillName])

      const toggleExpand = (skillName) => setExpanded((prev) => ({ ...prev, [skillName]: !prev[skillName] }))
      const STEP_KEYS = ['dispatch', 'rubric', 'score', 'draft', 'landing', 'backtest', 'verify']
      const latestJobFor = (skillName) => {
        let best = null
        for (const j of jobs) {
          const p = j && j.progress && j.progress[skillName]
          if (p && (!best || String(j.startedAt || '') > String(best.startedAt || ''))) best = j
        }
        return best
      }
      const STEP_SHORT = ['stepShort.dispatch','stepShort.0','stepShort.1','stepShort.2','stepShort.3','stepShort.4','stepShort.5']
      const SEG_COLORS = ['#64748b','#5b61d6','#0891b2','#0d9e6a','#65a30d','#d97706','#ea580c']
      const fmtTime = (a, b) => {
        const x = Date.parse(a), y = Date.parse(b)
        return (Number.isFinite(x) && Number.isFinite(y) && y >= x) ? ((y - x) / 1000).toFixed(1) + 's' : '—'
      }
      const segTime = (steps, i) => {
        const cur = steps && steps[STEP_KEYS[i]]
        if (!cur) return '—'
        if (cur.status === 'active') {
          if (cur.startAt) {
            const el = Math.max(0, Math.floor((now - Date.parse(cur.startAt)) / 1000))
            return el + 's'
          }
          return '·'
        }
        if (cur.startAt && cur.at) return fmtTime(cur.startAt, cur.at)
        if (cur.status === 'active' || cur.status === 'done') return '·'
        return '—'
      }
      const fmtDur = (ms) => {
        if (!Number.isFinite(ms) || ms < 0) return '—'
        const s = Math.floor(ms / 1000)
        return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
      }
      const jobDuration = (j) => {
        if (!j || !j.startedAt) return '—'
        return fmtDur(Date.parse(j.finishedAt || new Date().toISOString()) - Date.parse(j.startedAt))
      }
      // v2.0.2 per-skill timer (m07140 Q1): the card's "total time" must belong to
      // THIS skill and freeze the moment the skill finishes -- NOT keep counting
      // until the whole job ends (jobDuration used the job clock, which still ran
      // while this skill sat done waiting for other skills). Runs from this skill's
      // dispatch startAt to its own last terminal step; while it is still running it
      // ticks against now, and once terminal it is frozen.
      const skillDuration = (j, skillName) => {
        const p = j && j.progress && j.progress[skillName]
        const steps = (p && p.steps) || {}
        const times = STEP_KEYS.map((k) => steps[k]).filter(Boolean)
        const starts = times.map((s) => s.startAt).filter(Boolean).map((x) => Date.parse(x)).filter((n) => !Number.isNaN(n))
        const ends = times.filter((s) => s.status === 'done' || s.status === 'failed').map((s) => Date.parse(s.at)).filter((n) => !Number.isNaN(n))
        if (!starts.length) return jobDuration(j)
        const start = Math.min.apply(null, starts)
        const skillRunning = !!(j && (j.status === 'running' || ['queued', 'running', 'review', 'retrying'].includes(j.phase))) && (p ? (p.status === 'running' || p.status === 'queued') : true)
        const end = skillRunning || !ends.length ? Date.now() : Math.max.apply(null, ends)
        return fmtDur(Math.max(0, end - start))
      }
      // Clock stamp for the moment this skill's latest job stopped running.
      const finishedClockFor = (skillName) => {
        const j = latestJobFor(skillName)
        if (!j || !j.finishedAt) return null
        const d = new Date(j.finishedAt)
        if (Number.isNaN(d.getTime())) return null
        const p2 = (n) => String(n).padStart(2, '0')
        return p2(d.getMonth() + 1) + '/' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
      }
      const resultFor = (j, skillName) => {
        // Search every job's report, not just the latest job's: a newer retry job may
        // have progress but no result yet, while an earlier completed job already holds
        // the afterScore. Prefer the most recent job that actually has a result.
        let best = null, bestJob = null
        for (const jb of jobs) {
          const results = jb && jb.report && Array.isArray(jb.report.results) ? jb.report.results : []
          const r = results.find((x) => x && x.skill === skillName)
          if (r && (!bestJob || String(jb.startedAt || '') > String(bestJob.startedAt || ''))) { best = r; bestJob = jb }
        }
        return best
      }
      const draftIdFor = (r) => (r && Array.isArray(r.draftIds) && r.draftIds[0]) || null
      const fmtScore = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(2) : '—'
      const fmtDelta = (v) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
        return (v > 0 ? '▲ +' : v < 0 ? '▼ ' : '± ') + v.toFixed(2)
      }
      const buildProgressRow = (skillName) => {
        const j = latestJobFor(skillName)
        const p = j && j.progress && j.progress[skillName]
        const r = resultFor(j, skillName)
        const draftId = draftIdFor(r)
        const skillInfo = skills.find((x) => x.skillName === skillName) || {}
        const mLbl = (j && j.model) ? (String(j.model.provider || '') + '/' + String(j.model.model || ''))
          : (model.provider ? model.provider + '/' + model.model : '—')
        const cells = []
        if (!p) {
          cells.push(React.createElement('div', { className: 'seb-prog-err', key: 'empty' }, t('progress.empty')))
        } else {
          const steps = p.steps || {}
          const stObjs = STEP_KEYS.map((k) => steps[k] || { status: 'pending' })
          const raw = stObjs.map((s) => s.status || 'pending')
          const failIdx = raw.indexOf('failed')
          const activeIdx = raw.indexOf('active')
          const isFailed = failIdx >= 0 || p.status === 'failed' || (j && j.status === 'failed') || Boolean(p.error)
          const isRunning = !isFailed && (activeIdx >= 0 || p.status === 'running' || (j && (j.status === 'running' || ['queued','running','review','retrying'].includes(j.phase))))
          const liveBefore = (p && Number.isFinite(p.beforeScore)) ? p.beforeScore : undefined
          const liveAfter = (p && Number.isFinite(p.afterScore)) ? p.afterScore : undefined
          const after = (r && Number.isFinite(r.afterScore)) ? r.afterScore : liveAfter
          const hasScore = typeof after === 'number' && Number.isFinite(after)
          const hasLiveBefore = typeof liveBefore === 'number' && Number.isFinite(liveBefore)
          // liveAfter is written to progress the moment backtesting completes for
          // THIS skill (index.js pNow2.afterScore). Surfaces the real result
          // immediately, without waiting for the whole batch to wrap up (m06404).
          const hasLiveAfter = typeof liveAfter === 'number' && Number.isFinite(liveAfter)
          const liveDelta = (hasLiveBefore && hasLiveAfter) ? (liveAfter - liveBefore) : undefined
          const doneCount = raw.filter((s) => s === 'done').length
          // header badges
          cells.push(React.createElement('div', { className: 'seb2-chead', key: 'chead' },
            React.createElement('span', { className: 'seb2-sname' }, skillName),
            React.createElement('span', { className: 'seb2-badge ' + (isFailed ? 'fail' : isRunning ? 'run' : 'done') },
              isFailed ? t('card.failed') : isRunning ? t('card.running') : t('card.stageDone')),
            isRunning ? null : (skillInfo.pending > 0
              ? React.createElement('span', { className: 'seb2-newupd', title: t('skill.newUpdate') }, t('skill.newUpdate'))
              : (finishedClockFor(skillName) ? React.createElement('span', { className: 'seb2-doneat', title: t('skill.doneAt') }, finishedClockFor(skillName)) : null)),
            r && r.action ? React.createElement('span', { className: 'seb2-badge neu' }, String(r.action)) : null,
            draftId ? React.createElement('span', { className: 'seb2-badge done' }, t('card.ready')) : null,
            isFailed ? React.createElement('span', { className: 'seb2-badge fail' }, t('card.noScore')) : null,
          ))
          // management-panel-style metadata
          // Score comparison inline (moved here from its own block). Reuses the
          // same three states: running -> pending, scored -> before/after/delta,
          // else -> missing/failed marker (rescore button lives in the foot).
          const scoreKids = []
          if (isRunning && hasLiveAfter) {
            // Backtest finished for this skill even though the job is still
            // wrapping up other skills — show the real result now (m06404).
            scoreKids.push(React.createElement('span', { className: 'seb2-sc', key: 'b' }, React.createElement('span', { className: 'seb2-sck' }, t('score.before')), React.createElement('span', { className: 'seb2-scn' }, fmtScore(liveBefore))))
            scoreKids.push(React.createElement('span', { className: 'seb2-scarrow', key: 'ar' }, '→'))
            scoreKids.push(React.createElement('span', { className: 'seb2-sc', key: 'a' }, React.createElement('span', { className: 'seb2-sck' }, t('score.after')), React.createElement('span', { className: 'seb2-scn good' }, fmtScore(liveAfter))))
            scoreKids.push(React.createElement('span', { className: 'seb2-scdelta ' + ((liveDelta || 0) >= 0 ? 'good' : 'bad'), key: 'd' }, fmtDelta(liveDelta)))
          } else if (isRunning) {
            if (hasLiveBefore) {
              scoreKids.push(React.createElement('span', { className: 'seb2-sc', key: 'b' }, React.createElement('span', { className: 'seb2-sck' }, t('score.before')), React.createElement('span', { className: 'seb2-scn' }, fmtScore(liveBefore))))
              scoreKids.push(React.createElement('span', { className: 'seb2-scarrow', key: 'ar' }, '→'))
              scoreKids.push(React.createElement('span', { className: 'seb2-scdelta', key: 'pending' }, t('score.pending')))
            } else {
              scoreKids.push(React.createElement('span', { className: 'seb2-scdelta', key: 'pending' }, t('score.pending')))
            }
          } else if (hasScore) {
            scoreKids.push(React.createElement('span', { className: 'seb2-sc', key: 'b' }, React.createElement('span', { className: 'seb2-sck' }, t('score.before')), React.createElement('span', { className: 'seb2-scn' }, fmtScore(r ? r.beforeScore : undefined))))
            scoreKids.push(React.createElement('span', { className: 'seb2-scarrow', key: 'ar' }, '→'))
            scoreKids.push(React.createElement('span', { className: 'seb2-sc', key: 'a' }, React.createElement('span', { className: 'seb2-sck' }, t('score.after')), React.createElement('span', { className: 'seb2-scn good' }, fmtScore(after))))
            scoreKids.push(React.createElement('span', { className: 'seb2-scdelta ' + (((r ? r.delta : 0) || 0) >= 0 ? 'good' : 'bad'), key: 'd' }, fmtDelta(r ? r.delta : undefined)))
          } else {
            scoreKids.push(React.createElement('span', { className: 'seb2-noscore-x' + (isFailed ? ' fail' : ''), key: 'x' }, isFailed ? '✕' : '!'))
            scoreKids.push(React.createElement('span', { key: 't' }, isFailed ? t('score.failedNo') : t('score.missing')))
          }
          cells.push(React.createElement('div', { className: 'seb2-meta', key: 'meta' },
            React.createElement('span', { className: 'seb2-score' }, React.createElement('span', { className: 'seb2-sctitle' }, t('meta.model')), React.createElement('b', null, mLbl)),
            React.createElement('span', { className: 'seb2-score' }, React.createElement('span', { className: 'seb2-sctitle' }, t('meta.totalTime')), React.createElement('b', null, skillDuration(j, skillName))),
            React.createElement('span', { className: 'seb2-score' }, React.createElement('span', { className: 'seb2-sctitle' }, t('score.title')), scoreKids),
          ))
          // (score comparison now renders inline in the meta row above)
          // segmented progress track
          const segs = []
          for (let i = 0; i < STEP_KEYS.length; i++) {
            const st = raw[i]
            const segCls = 'seb2-seg' + (st === 'done' ? ' done' : st === 'active' ? ' active' : st === 'failed' ? ' fail' : '')
            const inner = []
            if (st === 'active') inner.push(React.createElement('span', { className: 'seb2-flow', key: 'f', style: { backgroundColor: SEG_COLORS[i], opacity: 0.85 } }))
            const kids = []
            if (i === failIdx) kids.push(React.createElement('span', { className: 'seb2-failflag', key: 'flag' }, t('card.failHere')))
            // tick is a DIRECT child of .seb2-segwrap (sibling of .seb2-seg) so its
            // absolute centering anchors to the stable segwrap cell, not .seb2-seg's
            // state-dependent position:relative (which let ticks drift to the card edge).
            if (st === 'done') kids.push(React.createElement('span', { className: 'seb2-tick', key: 'k' }, '✓'))
            kids.push(React.createElement('span', { className: segCls, key: 'seg', style: (st === 'done' || st === 'active') ? { backgroundColor: SEG_COLORS[i] } : undefined }, inner.length ? inner : null))
            segs.push(React.createElement('span', { className: 'seb2-segwrap', key: i }, kids))
          }
          cells.push(React.createElement('div', { className: 'seb2-track', key: 'track' }, segs))
          // labels: name + status + per-segment time
          const labs = STEP_KEYS.map((k, i) => {
            const st = raw[i]
            const cls = 'seb2-lab' + (st === 'done' ? ' done' : st === 'active' ? ' active' : st === 'failed' ? ' fail' : '')
            const stTxt = st === 'done' ? t('progress.stepStatus.done') : st === 'active' ? t('progress.stepStatus.active') : st === 'failed' ? t('progress.stepStatus.failed') : t('progress.stepStatus.pending')
            return React.createElement('span', { className: cls, key: k },
              React.createElement('span', { className: 'seb2-labn', title: String((stObjs[i] && stObjs[i].detail) || '') }, t(STEP_SHORT[i])),
              React.createElement('span', { className: 'seb2-labs' }, stTxt),
              React.createElement('span', { className: 'seb2-labt' }, segTime(steps, i)),
            )
          })
          cells.push(React.createElement('div', { className: 'seb2-labels', key: 'labels' }, labs))
          // foot: hint + real action buttons
          const hintCls = isFailed ? 'seb2-hint fail' : isRunning ? 'seb2-hint run' : hasScore ? 'seb2-hint ok' : 'seb2-hint fail'
          const hintTxt = isFailed ? t('hint.failed', { stage: failIdx >= 0 ? t(STEP_SHORT[failIdx]) : '—' })
            : isRunning ? t('hint.running')
            : hasScore ? t('hint.done', { a: doneCount, b: STEP_KEYS.length })
            : t('hint.noScore')
          const btns = []
          if (draftId) btns.push(React.createElement('button', { className: 'seb2-btn ghost', key: 'view', onClick: () => doViewDraft(draftId, skillName) }, t('card.viewDraft')))
          // v2.0.2 (m07155 Q2): when the ONLY failed segment is backtest (the draft
          // landed and verified fine), the meaningful action is to RE-RUN THE BACKTEST
          // (a real re-score), not a full-skill /evolve retry that would redo everything.
          // Detect that narrow case and surface a dedicated re-backtest button wired to
          // /rescore; a genuine pipeline failure (rubric/score/draft/landing/verify)
          // still gets the full "retry from failure".
          const btStep = (p.steps && p.steps.backtest) || {}
          const btFailedOnly = isFailed && btStep.status === 'failed' && !STEP_KEYS.slice(0, STEP_KEYS.indexOf('backtest')).some((k) => (p.steps[k] || {}).status === 'failed')
          if (btFailedOnly) {
            btns.push(React.createElement('button', { className: 'seb2-btn ghost', key: 'log', onClick: () => doViewLog(skillName) }, t('card.viewLog')))
            btns.push(React.createElement('button', { className: 'seb2-btn danger', key: 'rescore', onClick: () => doRescore(skillName, draftId) }, t('card.rebacktest')))
          } else if (isFailed) {
            btns.push(React.createElement('button', { className: 'seb2-btn ghost', key: 'log', onClick: () => doViewLog(skillName) }, t('card.viewLog')))
            btns.push(React.createElement('button', { className: 'seb2-btn danger', key: 'retry', onClick: () => doRetry(skillName) }, t('card.retryFail')))
          } else {
            if (!isRunning && !hasScore) btns.push(React.createElement('button', { className: 'seb2-btn danger', key: 'rescore', onClick: () => doRescore(skillName, draftId) }, t('card.rescore')))
            btns.push(React.createElement('button', { className: 'seb2-btn primary', key: 'retry', onClick: () => doRetry(skillName) }, t('card.retry')))
          }
          cells.push(React.createElement('div', { className: 'seb2-foot', key: 'foot' },
            React.createElement('div', { className: hintCls }, React.createElement('span', { className: 'seb2-ic' }, isFailed ? '✕' : isRunning ? '◐' : hasScore ? '✓' : '⚠'), hintTxt),
            btns,
          ))
          if (p.error) cells.push(React.createElement('div', { className: 'seb-prog-err', key: 'err' }, String(p.error)))
        }
        return React.createElement('tr', { className: 'seb-prog-row', key: 'prog-' + skillName },
          React.createElement('td', { colSpan: STEP_KEYS.length }, React.createElement('div', { className: 'seb2-card', 'data-skill': skillName }, cells)),
        )
      }

      // 折叠态小面板里的彩色迷你链：复用 SEG_COLORS，7 段一一对应。
      const buildMiniChain = (skillName) => {
        const j = latestJobFor(skillName)
        const jRunning = !!(j && (j.status === 'running' || ['queued', 'running', 'review', 'retrying'].includes(j.phase)))
        if (!jRunning) return null
        const p = j && j.progress && j.progress[skillName]
        if (!p) return null
        const steps = (p && p.steps) || {}
        return React.createElement('span', { className: 'seb2-minichain', title: t('mini.chain') },
          STEP_KEYS.map((k, i) => {
            const st = (steps[k] && steps[k].status) || 'pending'
            return React.createElement('i', {
              className: 'seb2-segmini' + (st === 'done' ? ' done' : st === 'active' ? ' active' : st === 'failed' ? ' fail' : ''),
              key: k, style: (st === 'done' || st === 'active') ? { backgroundColor: SEG_COLORS[i] } : undefined,
            })
          }),
        )
      }

      const toggleAll = () => {
        const next = {}
        if (!allChecked) for (const s of skills) next[s.skillName] = true
        setSelected(next)
      }

      const header = React.createElement('div', { className: 'seb-head' },
        React.createElement('div', { className: 'seb-title' }, t('card.title')),
        React.createElement('div', { className: 'seb-subtitle' }, t('card.subtitle')),
        React.createElement('div', { className: 'seb-chip' },
          t('card.chip', { ready: state ? state.ready : 0 }) + ' · ' +
          t('card.chipAll', { n: skills.length }),
        ),
      )

      const runningJobs = jobs.filter((j) => j && (j.status === 'running' || ['queued','running','review','retrying'].includes(j.phase)))
      const allProg = []
      for (const jb of jobs) {
        for (const k of Object.keys((jb && jb.progress) || {})) allProg.push({ j: jb, p: jb.progress[k] })
      }
      const nDone = allProg.filter((x) => x.p && (x.p.status === 'done' || (x.j && x.j.status === 'completed'))).length
      const nRun = allProg.filter((x) => x.p && (x.p.status === 'running' || x.p.status === 'active')).length
      const nFail = allProg.filter((x) => x.p && (x.p.status === 'failed' || (x.j && x.j.status === 'failed'))).length
      const nTotal = allProg.length || skills.length
      let nScored = 0
      for (const jb of jobs) for (const rr of ((jb && jb.report && jb.report.results) || [])) {
        if (rr && typeof rr.afterScore === 'number' && Number.isFinite(rr.afterScore)) nScored++
      }
      const nMissing = Math.max(0, nTotal - nScored)
      const modelLabel = model.provider ? (model.provider + '/' + model.model)
        : ((state && state.model) ? (state.model.provider + '/' + state.model.model) : '—')
      // Shrink the model-name font as it gets longer so the overview strip
      // stays on one line instead of wrapping (m06476).
      const modelFontSize = modelLabel.length > 40 ? 10 : (modelLabel.length > 24 ? 11 : 12)
      const latestStart = jobs.length ? jobs.map((x) => x.startedAt).filter(Boolean).sort().pop() : null
      const totalTime = latestStart ? fmtDur(now - Date.parse(latestStart)) : '—'
      const overview = React.createElement('div', { className: 'seb2-overview' },
        React.createElement('div', { className: 'seb2-ov seb2-ovmodel' }, React.createElement('div', { className: 'seb2-k' }, t('overview.model')), React.createElement('div', { className: 'seb2-v seb2-vmono', style: { fontSize: modelFontSize + 'px' } }, modelLabel)),
        React.createElement('div', { className: 'seb2-ov' }, React.createElement('div', { className: 'seb2-k' }, t('overview.mode')), React.createElement('div', { className: 'seb2-v' }, evolutionMode === 'legacy' ? t('evolutionMode.legacy') : t('evolutionMode.new'))),
        React.createElement('div', { className: 'seb2-ov' }, React.createElement('div', { className: 'seb2-k' }, t('overview.concurrency')), React.createElement('div', { className: 'seb2-v' }, String(maxConcurrency))),
        React.createElement('div', { className: 'seb2-ov' }, React.createElement('div', { className: 'seb2-k' }, t('overview.progress')), React.createElement('div', { className: 'seb2-v' }, nDone + ' ' + t('card.done') + ' · ' + nRun + ' ' + t('card.running') + ' · ' + nFail + ' ' + t('card.failed'))),
        React.createElement('div', { className: 'seb2-ov' }, React.createElement('div', { className: 'seb2-k' }, t('overview.totalTime')), React.createElement('div', { className: 'seb2-v' }, totalTime)),
      )
      const legend = React.createElement('div', { className: 'seb2-legend' },
        React.createElement('span', null, React.createElement('i', { className: 'seb2-dot g' }), t('legend.gray')),
        React.createElement('span', null, React.createElement('i', { className: 'seb2-dot' }), t('legend.color')),
        React.createElement('span', null, React.createElement('i', { className: 'seb2-dot ok' }), t('legend.time')),
        React.createElement('span', null, React.createElement('i', { className: 'seb2-dot r' }), t('legend.red')),
      )
      const plines = []
      for (const jb of runningJobs) {
        for (const k of Object.keys((jb && jb.progress) || {})) {
          const pp = jb.progress[k]
          const sts = STEP_KEYS.map((sk) => (pp && pp.steps && pp.steps[sk] && pp.steps[sk].status) || 'pending')
          const act = sts.indexOf('active')
          const mini = sts.map((st, i) => React.createElement('i', {
            className: 'seb2-segmini' + (st === 'done' ? ' done' : st === 'active' ? ' active' : ''), key: i, style: { '--c': SEG_COLORS[i] },
          }))
          plines.push(React.createElement('div', { className: 'seb2-pline', key: String(jb.jobId || jb.startedAt) + '-' + k },
            React.createElement('span', { className: 'seb2-pname', title: k }, k),
            React.createElement('span', { className: 'seb2-pmbar' }, mini),
            React.createElement('span', { className: 'seb2-pstage' }, act >= 0 ? (t(STEP_SHORT[act]) + ' ↗') : '—'),
          ))
        }
      }
      const parallel = runningJobs.length
        ? React.createElement('div', { className: 'seb2-para' },
            React.createElement('div', { className: 'seb2-ptitle' }, t('para.title')),
            React.createElement('div', { className: 'seb2-psub' }, t('para.sub', { n: String(maxConcurrency) })),
            React.createElement('div', { className: 'seb2-pcancel' }, runningJobs.map((jb) =>
              React.createElement('button', {
                className: 'seb-btn ghost seb2-cancelbtn', key: String(jb.jobId || jb.startedAt),
                onClick: () => doCancel(String(jb.jobId || '')),
              }, t('action.cancelN', { n: String(jb.skillCount || ((jb.skill || '').split(',').filter(Boolean).length)) })),
            )),
            React.createElement('div', { className: 'seb2-plines' }, plines),
          )
        : null

      let body
      if (loading) {
        body = React.createElement('div', { className: 'seb-empty' }, t('status.loading'))
      } else if (error) {
        body = React.createElement('div', { className: 'seb-alert' }, t('status.error', { message: error }))
      } else if (!skills.length) {
        body = React.createElement('div', { className: 'seb-empty' }, t('status.empty'))
      } else {
        const rows = skills.flatMap((s) => {
          // 类型：进化（改进已有技能）／新建（从零建新技能）／混合
          const isUpdate = (s.update || 0) > 0
          const isCreate = (s.create || 0) > 0
          const kindKey = isUpdate && isCreate ? 'kind.both' : (isCreate ? 'kind.create' : 'kind.update')
          const kindCls = 'seb-badge ' + (isCreate && !isUpdate ? 'kind-create' : 'kind-update')
          const mainRow = React.createElement('tr', { key: s.skillName },
            React.createElement('td', null,
              React.createElement('input', {
                type: 'checkbox', className: 'seb-cb', checked: Boolean(selected[s.skillName]),
                onChange: () => toggle(s.skillName),
              }),
            ),
            React.createElement('td', { className: 'seb-skillname' },
              React.createElement('span', { className: 'seb-skillbtn', onClick: () => toggleExpand(s.skillName) },
                React.createElement('span', { className: 'seb-caret' }, expanded[s.skillName] ? '▾' : '▸'),
                s.skillName,
              ),
            ),
            React.createElement('td', null,
              React.createElement('span', { className: kindCls, title: t('kind.desc') },
                typeof t(kindKey) === 'string' && t(kindKey) !== kindKey ? t(kindKey) : kindKey,
              ),
            ),
            React.createElement('td', null, String(s.pending)),
            React.createElement('td', null, String(s.review)),
            React.createElement('td', { className: 'seb2-progcell' }, buildMiniChain(s.skillName)),
            React.createElement('td', null, s.hasReadyDraft ? t('draft.ready') : t('draft.none')),
          )
          const prog = expanded[s.skillName] ? buildProgressRow(s.skillName) : null
          return prog ? [mainRow, prog] : [mainRow]
        })
        body = React.createElement('div', { className: 'seb-actions' },
          React.createElement('span', { className: 'seb-flash' }, t('selected.count', { n: selectedCount })),
          React.createElement('div', { className: 'seb-actions-right' },
            React.createElement('button', { className: 'seb-btn ghost', onClick: toggleAll },
              allChecked ? t('select.none') : t('select.all')),
            React.createElement('button', {
              className: 'seb-btn ghost', onClick: refresh, disabled: busy === 'refresh',
            }, busy === 'refresh' ? t('action.refreshing') : t('action.refresh')),
            React.createElement('button', {
              className: 'seb-btn primary', onClick: evolve, disabled: busy === 'evolve',
            }, busy === 'evolve' ? t('evolve.running') : t('evolve.run')),
          ),
          React.createElement('table', { className: 'seb-table' },
            React.createElement('thead', null,
              React.createElement('tr', null,
                React.createElement('th', null, ''),
                React.createElement('th', null, t('col.skill')),
                React.createElement('th', null, t('col.kind')),
                React.createElement('th', null, t('col.pending')),
                React.createElement('th', null, t('col.review')),
                React.createElement('th', null, t('col.progress')),
                React.createElement('th', null, t('col.draft')),
              ),
            ),
            React.createElement('tbody', null, rows),
          ),
        )
      }

      const modelBlock = React.createElement('div', { className: 'seb-model' },
        React.createElement('div', { className: 'seb-model-title' }, t('model.title')),
        React.createElement('div', { className: 'seb-model-desc' }, t('model.desc')),
        React.createElement('div', { className: 'seb-model-desc' }, t('concurrency.desc')),
        React.createElement('div', { className: 'seb-fields' },
          React.createElement('div', { className: 'seb-field' },
            React.createElement('label', { className: 'seb-label' }, t('model.select')),
            React.createElement('select', {
              className: 'seb-select',
              value: model.provider ? (model.provider + '/' + model.model) : '',
              onChange: (e) => {
                const val = String(e.target.value || '')
                const idx = val.indexOf('/')
                const provider = idx >= 0 ? val.slice(0, idx) : val
                const modelName = idx >= 0 ? val.slice(idx + 1) : ''
                setModel({ provider, model: modelName })
              },
              disabled: busy === 'save',
            },
              !(modelOptions.some((o) => o.provider === model.provider && o.model === model.model)) && model.provider
                ? React.createElement('option', { value: model.provider + '/' + model.model },
                    model.provider + '/' + model.model)
                : null,
              modelOptions.map((o) => React.createElement('option', {
                key: o.provider + '/' + o.model, value: o.provider + '/' + o.model,
              }, o.provider + '/' + o.model)),
            ),
          ),
          React.createElement('div', { className: 'seb-field' },
            React.createElement('label', { className: 'seb-label' }, t('concurrency.title')),
            React.createElement('input', {
              className: 'seb-input', type: 'number', min: 1, max: 16, step: 1,
              value: maxConcurrency === '' ? '' : (Number.isFinite(maxConcurrency) ? maxConcurrency : 3),
              onChange: (e) => {
                const raw = e.target.value
                setMaxConcurrency(raw === '' ? '' : Number(raw))
              },
              disabled: busy === 'save',
            }),
          ),
          React.createElement('div', { className: 'seb-field' },
            React.createElement('label', { className: 'seb-label' }, t('evolutionMode.title')),
            React.createElement('select', {
              className: 'seb-input', value: evolutionMode, disabled: busy === 'save',
              onChange: (e) => setEvolutionMode(e.target.value),
            },
              React.createElement('option', { value: 'new' }, t('evolutionMode.new')),
              React.createElement('option', { value: 'legacy' }, t('evolutionMode.legacy')),
            ),
          ),
          React.createElement('div', { className: 'seb-field' },
            React.createElement('label', { className: 'seb-label' }, ''),
            React.createElement('button', {
              className: 'seb-btn primary', onClick: save, disabled: busy === 'save',
            }, busy === 'save' ? t('model.saving') : t('model.save')),
          ),
        ),
        flash ? React.createElement('div', { className: 'seb-flash' + (flash.ok ? '' : ' err') }, flash.text) : null,
      )

      const draftModal = !draftView ? null : React.createElement('div', { className: 'seb2-modal-overlay', onClick: () => setDraftView(null) },
        React.createElement('div', { className: 'seb2-modal', onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation() } },
          React.createElement('div', { className: 'seb2-modal-head' },
            React.createElement('span', { className: 'seb2-modal-title' }, t('modal.title') + (draftView.skillName ? ' · ' + draftView.skillName : '')),
            React.createElement('button', { className: 'seb2-btn ghost', onClick: () => setDraftView(null) }, t('modal.close')),
          ),
          React.createElement('div', { className: 'seb2-modal-body' },
            draftView.loading ? t('modal.loading')
              : draftView.error ? React.createElement('span', { className: 'seb-prog-err' }, t('modal.error', { message: draftView.error }))
              : draftView.draft ? React.createElement('div', null,
                  React.createElement('div', { className: 'seb2-meta' },
                    React.createElement('span', null, t('modal.draftId'), ' ', React.createElement('b', null, String(draftView.draft.id || '—'))),
                    React.createElement('span', null, t('modal.status'), ' ', React.createElement('b', null, String(draftView.draft.status || '—'))),
                    React.createElement('span', null, t('meta.baseline'), ' ', React.createElement('b', null, String(draftView.draft.baseHash || '—'))),
                  ),
                  React.createElement('pre', { className: 'seb2-modal-pre' }, String(draftView.draft.content || t('modal.noBody'))),
                )
              : null,
          ),
        ),
      )

      return React.createElement('div', { className: 'seb-card' },
        React.createElement('style', null, CSS),
        header,
        overview,
        legend,
        parallel,
        body,
        modelBlock,
        React.createElement('div', { className: 'seb-footer' }, t('footer.note')),
        draftModal,
      )
    }

    function apply(ctx) {
      try {
        const namespace = 'settings.skill-evolution-backtest'
        ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'skill-evolution-backtest: panel copy')
        const t = ctx.locale.bind(namespace)
        const React = require('react')
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: '@local/dsh-skill-evolution-backtest', locale: namespace },
            () => React.createElement(EvolutionCard, { React, t }),
          ),
        )
      } catch (e) {
        console.error('[skill-evolution-backtest] client apply failed:', e)
      }
    }

    return { apply, inject, name }
  },
})
