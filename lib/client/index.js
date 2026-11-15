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
      'progress.drafting': '起草 cases + 草案',
      'progress.repairing': '修复无效草案',
      'progress.scoring': '冻结 before 评分',
      'progress.landing': '落地草案（write）',
      'progress.verifying': '自审（verify）',
      'progress.backtesting': '回测 after 打分',
      'progress.auditing': '收尾逐草案复核',
      'progress.empty': '该技能暂无进化任务；勾选后点「进化所选」即可在此看到逐步进度。',
      'progress.stepStatus.pending': '等待',
      'progress.stepStatus.active': '进行中',
      'progress.stepStatus.done': '已完成',
      'progress.stepStatus.failed': '失败',
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
      'progress.drafting': 'Authoring cases + draft',
      'progress.repairing': 'Repairing invalid draft',
      'progress.scoring': 'Freezing before score',
      'progress.landing': 'Landing drafts (write)',
      'progress.verifying': 'Self-audit (verify)',
      'progress.backtesting': 'Backtesting after score',
      'progress.auditing': 'Final per-draft audit',
      'progress.empty': 'No evolution job for this skill yet; select it and press "Evolve selected" to see step progress here.',
      'progress.stepStatus.pending': 'waiting',
      'progress.stepStatus.active': 'running',
      'progress.stepStatus.done': 'done',
      'progress.stepStatus.failed': 'failed',
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
            const sel = {}
            // Only seed selections for skills still present in the list — stale
            // names persisted in panel config (already adopted/dismissed/expired
            // out) must not inflate the "已选 x 个" count nor be sent to /evolve.
            const listed = new Set((data.skills || []).map((x) => x.skillName))
            for (const s of data.selectedSkills || []) if (listed.has(s)) sel[s] = true
            setSelected(sel)
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

      const refresh = useCallback(async () => {
        setBusy('refresh')
        await load()
        safeSet(() => setBusy(''))
      }, [load])

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
          safeSet(() => setFlash({
            ok: true,
            text: t('evolve.started', { n: queuedCount, skipped: skippedCount }),
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

      const skills = (state && Array.isArray(state.skills)) ? state.skills : []
      const modelOptions = (state && Array.isArray(state.modelOptions)) ? state.modelOptions : []
      const selectedCount = selectedNames().length
      const allChecked = skills.length > 0 && skills.every((s) => selected[s.skillName])

      const toggleExpand = (skillName) => setExpanded((prev) => ({ ...prev, [skillName]: !prev[skillName] }))
      const STEP_KEYS = ['drafting', 'repairing', 'scoring', 'landing', 'verifying', 'backtesting', 'auditing']
      const latestJobFor = (skillName) => {
        let best = null
        for (const j of jobs) {
          const p = j && j.progress && j.progress[skillName]
          if (p && (!best || String(j.startedAt || '') > String(best.startedAt || ''))) best = j
        }
        return best
      }
      const stepPercent = (st) => (st === 'done' ? 100 : st === 'failed' ? 100 : st === 'active' ? 60 : 8)
      const buildProgressRow = (skillName) => {
        const j = latestJobFor(skillName)
        const p = j && j.progress && j.progress[skillName]
        const cells = []
        if (!p) {
          cells.push(React.createElement('div', { className: 'seb-prog-err', key: 'empty' }, t('progress.empty')))
        } else {
          cells.push(React.createElement('div', { className: 'seb-prog-head', key: 'head' },
            skillName + ' · ' + t('progress.' + (p.status || 'queued')) +
            (j && j.orchestrator ? ' · ' + j.orchestrator : ''),
          ))
          for (const k of STEP_KEYS) {
            const s = (p.steps && p.steps[k]) || { status: 'pending' }
            cells.push(React.createElement('div', { className: 'seb-step', key: k },
              React.createElement('span', { className: 'seb-step-label', title: String(s.detail || '') }, t('progress.' + k)),
              React.createElement('span', { className: 'seb-bar' },
                React.createElement('span', { className: 'seb-bar-fill', style: { width: stepPercent(s.status) + '%' } }),
              ),
              React.createElement('span', { className: 'seb-step-status' }, t('progress.stepStatus.' + (s.status || 'pending'))),
            ))
          }
          if (p.error) cells.push(React.createElement('div', { className: 'seb-prog-err', key: 'err' }, String(p.error)))
        }
        return React.createElement('tr', { className: 'seb-prog-row', key: 'prog-' + skillName },
          React.createElement('td', { colSpan: 8 }, React.createElement('div', { className: 'seb-prog' }, cells)),
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

      let body
      if (loading) {
        body = React.createElement('div', { className: 'seb-empty' }, t('status.loading'))
      } else if (error) {
        body = React.createElement('div', { className: 'seb-alert' }, t('status.error', { message: error }))
      } else if (!skills.length) {
        body = React.createElement('div', { className: 'seb-empty' }, t('status.empty'))
      } else {
        const rows = skills.flatMap((s) => {
          const freshKey = 'freshness.' + s.newestFreshness
          const freshLabel = t(freshKey)
          const freshCls = 'seb-badge ' + (s.newestFreshness === 'FRESH'
            ? 'fresh'
            : (s.newestFreshness === 'STALE' ? 'drifted' : ''))
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
            React.createElement('td', null, String(s.expired)),
            React.createElement('td', null,
              React.createElement('span', { className: freshCls },
                typeof freshLabel === 'string' && freshLabel !== freshKey ? freshLabel : s.newestFreshness,
              ),
            ),
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
                React.createElement('th', null, t('col.expired')),
                React.createElement('th', null, t('col.freshness')),
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

      return React.createElement('div', { className: 'seb-card' },
        React.createElement('style', null, CSS),
        header,
        body,
        modelBlock,
        React.createElement('div', { className: 'seb-footer' }, t('footer.note')),
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