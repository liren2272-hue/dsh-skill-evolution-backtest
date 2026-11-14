// dsh-skill-evolution-backtest — host entry.
//
// Registers four agent tools that package the DETERMINISTIC half of the Mnemon
// skill-evolution pipeline (the creative half — writing the improved SKILL.md —
// stays with the agent):
//
//   skill_evolution_scan      read-only  list suggestions + baseHash freshness
//   skill_evolution_backtest  read-only  per-check partial-score draft vs current
//   skill_evolution_write     MUTATING   ready draft + before/after runs → ledger
//   skill_evolution_verify    read-only  independent re-read of what write landed
//
// The tools never adopt, install, or overwrite the live SKILL.md; a draft stops
// at status 'ready' for the human to approve in the Mnemon panel. `write` is
// gated by config.allowWrite and always backs up both ledgers first.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolvePaths } from './lib/paths.mjs'
import { sha256Hex, EMPTY_SHA, casesHash } from './lib/hash.mjs'
import { gradeBody } from './lib/grade.mjs'
import { judgeBody, GRADE_ENGINE } from './lib/llm-judge.mjs'
import { readJson, writeJsonAtomic, backupLedgers, buildRun, newDraft, pruneDrafts, validateDraftSchema } from './lib/ledger.mjs'
// Vendored yaml@2.9.1 — the SAME parser DSH uses to load SKILL.md frontmatter
// (verified byte-for-byte against the desktop profile's yaml, and against the
// error text DSH emits). We vendor it rather than hand-roll a parser so the
// frontmatter gate below mirrors DSH's load check exactly, instead of becoming
// a new "low-level error" of its own.
import { parse as parseYaml } from './lib/vendor/yaml/index.js'

export const name = 'skill-evolution-backtest'
export const inject = ['tools']

// ---- config ----
let CFG = {}
function configure(cfg = {}) {
  CFG = {
    ...resolvePaths(cfg),
    stateDir: cfg.stateDir || path.join(process.cwd(), 'state'),
    allowWrite: cfg.allowWrite !== false,
    backupKeep: Number.isFinite(cfg.backupKeep) ? cfg.backupKeep : 20,
    model: cfg.model || { provider: 'workbuddy', model: 'hy4free' },
    // Concurrency cap for the evolution coordinator (m00648): how many worker
    // agents may run at once. Clamped 1..16; default 3.
    maxConcurrency: Math.min(16, Math.max(1, Number.isFinite(cfg.maxConcurrency) ? (cfg.maxConcurrency | 0) : 3)),
    // Grading engine. 'auto' = LLM semantic judge when a model is reachable,
    // anchors as the safe fallback; 'llm' forces the model judge; 'anchor'
    // forces the deterministic regex grader.
    gradeEngine: cfg.gradeEngine === 'llm' || cfg.gradeEngine === 'anchor' ? cfg.gradeEngine : 'auto',
    judgeTimeoutMs: Number.isFinite(cfg.judgeTimeoutMs) ? cfg.judgeTimeoutMs : 120000,
    gradeNote:
      cfg.gradeNote ||
      'LLM 语义评分：模型逐 check 判定正文是否真正满足该改进点，锚点正则仅在模型不可用时回退；score=case 级加权平均（must=2，普通=1），对齐宿主 runScore。',
  }
  // Persist state (backups) next to the plugin, not the cwd, when possible.
  // NB: on Windows `new URL(...).pathname` yields "/C:/Users/..." (leading slash),
  // and path.join treats "/C:" as a relative segment → "C:\C:\...". fileURLToPath
  // converts correctly to "C:\Users\...".
  if (!cfg.stateDir) CFG.stateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'state')
  return CFG
}

const j = (v) => JSON.stringify(v, null, 2)
const readBody = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)

// Hash a live skill file EXACTLY the way Mnemon's catalog does: sha256 over the
// raw file bytes, with NO line-ending normalization. Mnemon records
// skill.hash = sha256(rawBuffer) (host index.js:406), and its draft panel flags
// base-changed whenever base.hash !== draft.baseHash (lib/index.js:3441). Any
// normalization here (e.g. CRLF→LF) desynchronizes the two hashes for every file
// that contains CRLF, making freshly-written drafts show as "已过期".
const liveFileHash = (file) => (fs.existsSync(file) ? sha256Hex(fs.readFileSync(file)) : null)

// Grade one skill body. `auto`/`llm` use the model judge (SVC.llm + CFG.model)
// with the deterministic anchor grader as the safe fallback; `anchor` forces the
// offline regex grader. Returns the host-aligned aggregate (case-level score +
// must-weighted verdicts).
async function gradeFor(body, cases) {
  const engine = CFG.gradeEngine === 'anchor' ? GRADE_ENGINE.ANCHOR : CFG.gradeEngine
  const signal = engine === GRADE_ENGINE.ANCHOR ? undefined : AbortSignal.timeout(CFG.judgeTimeoutMs)
  return judgeBody(body, cases, { llm: SVC.llm, model: CFG.model, signal, engine })
}

// ---- tool: scan ----
function scanImpl(args) {
  const ledger = readJson(CFG.ledgerPath)
  const want = args?.status ? String(args.status) : null
  const statuses = ['pending', 'review', 'expired', 'adopted', 'dismissed']
  const counts = {}
  for (const s of ledger.suggestions || []) counts[s.status] = (counts[s.status] || 0) + 1
  const rows = []
  for (const s of ledger.suggestions || []) {
    if (want && s.status !== want) continue
    if (!want && !['pending', 'review', 'expired'].includes(s.status)) continue
    const skillFile = CFG.skillFile(s.skillName)
    const curHash = liveFileHash(skillFile)
    const live = curHash === null ? 'MISSING' : curHash === s.skillFileHash ? 'FRESH' : 'STALE'
    rows.push({
      id: s.id,
      skillName: s.skillName,
      action: s.action,
      status: s.status,
      confidence: s.confidence,
      baseHashFresh: live,
      hasDraftId: Boolean(s.draftId),
      draftId: s.draftId || null,
      lastError: s.lastError || null,
      summary: String(s.summary || '').slice(0, 280),
      skillFile,
    })
  }
  return {
    generation: ledger.generation,
    counts,
    drafts: (ledger.drafts || []).length,
    ready: (ledger.drafts || []).filter((d) => d.status === 'ready').length,
    listing: rows,
  }
}

// ---- tool: backtest (read-only) ----
async function backtestImpl(args) {
  const skillName = String(args?.skillName || '')
  const draftContent = String(args?.draftContent ?? '')
  const cases = Array.isArray(args?.cases) ? args.cases : []
  if (!skillName) throw new Error('skillName is required')
  if (!cases.length) throw new Error('cases must be a non-empty array of {id,title,checks:[{id,text,must?,anchors?}]}')
  const skillFile = CFG.skillFile(skillName)
  const current = readBody(skillFile)
  const currentNorm = current === null ? '' : current.replace(/\r\n/g, '\n')
  const before = await gradeFor(currentNorm, cases)
  const after = await gradeFor(draftContent.replace(/\r\n/g, '\n'), cases)
  return {
    skillName,
    skillFileExists: current !== null,
    before: { score: before.score, passRate: before.passRate, totalChecks: before.totalChecks, passedChecks: before.passedChecks, caseRows: before.caseRows },
    after: { score: after.score, passRate: after.passRate, totalChecks: after.totalChecks, passedChecks: after.passedChecks, caseRows: after.caseRows },
    delta: Number((after.score - before.score).toFixed(4)),
    engine: { before: before.engine, after: after.engine },
    note: 'score = case 级加权平均（must=2，普通=1），对齐宿主 runScore；由模型逐 check 语义判定，模型不可用时回退锚点正则。',
  }
}

// ---------------------------------------------------------------------------
// Frontmatter load gate (m01144).
//
// `skill_evolution_write` used to stop at anchor-hit / score / ledger-invariant
// checks, so a draft whose SKILL.md frontmatter DSH itself cannot parse would
// sail through to a 'ready' draft, then explode later when Mnemon lands it and
// DSH re-reads SKILL.md. This mirrors the EXACT load gate in DSH's
// @deepseek-ai/dsh-skill-filesystem `parseSkillFile` (verified against the
// desktop profile's source): first line `---`, a closing `---`, a YAML mapping
// parsed by the same yaml@2.9.1 parser, mandatory name+description, kebab-case
// skill name, legacy-invocation-key rejection, and boolean typing of the
// invocation policy. Throws the same wording DSH would emit.
// ---------------------------------------------------------------------------
export function validateSkillFrontmatter(content) {
  const raw = String(content ?? '')
  const nl = raw.indexOf('\n')
  const firstLine = (nl === -1 ? raw : raw.slice(0, nl)).replace(/\r$/, '')
  if (firstLine !== '---') {
    throw new Error('missing YAML frontmatter (first line must be "---")')
  }
  const rest = nl === -1 ? '' : raw.slice(nl + 1)
  const lines = rest.split('\n')
  let closeIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '') === '---') { closeIdx = i; break }
  }
  if (closeIdx === -1) {
    throw new Error('missing closing "---" for YAML frontmatter')
  }
  const yamlText = lines.slice(0, closeIdx).join('\n')
  let data
  try {
    data = parseYaml(yamlText)
  } catch (e) {
    // Same wording DSH logs for a YAML syntax error (e.g. the unclosed-quote
    // "Missing closing 'quote at line N, column M" the user actually hit).
    throw new Error(`invalid YAML frontmatter: ${String(e)}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('missing YAML frontmatter (frontmatter did not parse to a mapping)')
  }
  const name = typeof data.name === 'string' && data.name.length > 0 ? data.name : undefined
  const description = typeof data.description === 'string' && data.description.length > 0 ? data.description : undefined
  if (!name || !description) {
    throw new Error('frontmatter requires name and description')
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`invalid skill name "${name}"`)
  }
  // parseInvocationPolicy: reject the three legacy keys, then type-check the
  // two canonical boolean fields exactly like DSH.
  const legacy = [
    ['disableModelInvocation', 'disable-model-invocation'],
    ['modelInvocable', 'disable-model-invocation'],
    ['userInvocable', 'user-invocable'],
  ]
  for (const [oldKey, canonical] of legacy) {
    if (oldKey in data) {
      throw new Error(`frontmatter field "${oldKey}" is unsupported; use "${canonical}"`)
    }
  }
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (key in data) {
      const v = data[key]
      const okBool =
        v === true || v === false || v === 1 || v === 0 ||
        v === 'true' || v === 'yes' || v === 'on' ||
        v === 'false' || v === 'no' || v === 'off'
      if (!okBool) {
        throw new TypeError(`frontmatter field "${key}" must be a boolean`)
      }
    }
  }
  if ('metadata' in data) {
    const m = data.metadata
    if (m === null || Array.isArray(m) || typeof m !== 'object') {
      throw new Error('frontmatter field "metadata" must be a mapping')
    }
  }
}

// ---- tool: write (mutating) ----
async function writeImpl(args) {
  if (!CFG.allowWrite) {
    return { dryRun: true, would: 'build a ready draft + before/after runs and atomic-write both ledgers (config.allowWrite=false → nothing touched)' }
  }
  const skillName = String(args?.skillName || '')
  const suggestionId = String(args?.suggestionId || '')
  const action = args?.action === 'create' ? 'create' : 'update'
  const draftContent = String(args?.draftContent ?? '')
  const notes = String(args?.notes || '')
  const rawCases = Array.isArray(args?.cases) ? args.cases : []
  if (!skillName || !suggestionId || !rawCases.length) {
    throw new Error('skillName, suggestionId and a non-empty cases[] are required')
  }

  // Frontmatter load gate (m01144): the draft content must parse under the same
  // YAML frontmatter rules DSH uses to load SKILL.md. Fail fast — before any
  // backup/write — so a bad draft never reaches a 'ready' state and blows up
  // later when Mnemon lands it.
  validateSkillFrontmatter(draftContent)

  // The host hands us `args` (and nested cases[]/checks[] objects) FROZEN /
  // non-extensible. writeImpl annotates each case (id/skillName/origin/…), so
  // mutating them in place throws "Cannot add property skillName, object is not
  // extensible". Rebuild every case and check into a FRESH plain object first —
  // identical shape, but extensible — and mutate only those copies.
  const cases = rawCases.map((c) => ({
    ...(c && typeof c === 'object' ? c : {}),
    checks: Array.isArray(c?.checks)
      ? c.checks.map((k) => ({ ...(k && typeof k === 'object' ? k : {}) }))
      : [],
  }))

  const ledger = readJson(CFG.ledgerPath)
  const sug = (ledger.suggestions || []).find((s) => s.id === suggestionId)
  if (!sug) throw new Error(`suggestion ${suggestionId} not found`)
  if (sug.status === 'adopted' || sug.status === 'dismissed') {
    throw new Error(`suggestion already ${sug.status}; refusing to write (concurrency guard)`)
  }
  if (sug.draftId) throw new Error(`suggestion already has draftId ${sug.draftId}; refusing to overwrite`)

  const skillFile = CFG.skillFile(skillName)
  const current = readBody(skillFile)
  const baseHash = liveFileHash(skillFile) ?? EMPTY_SHA
  if (action === 'update' && current === null) throw new Error(`update action but ${skillFile} does not exist`)
  if (action === 'create' && current !== null) throw new Error(`create action but ${skillFile} already exists`)

  // Backup FIRST, so a guard failure later still leaves a restorable pair.
  const backup = backupLedgers(CFG, CFG.stateDir, CFG.backupKeep)

  const evals = readJson(CFG.evalsPath)
  const evalCases = evals.cases || (evals.cases = [])
  const now = new Date().toISOString()
  // Attach real caseIds / checkIds: reuse any the caller supplied, else mint.
  for (const c of cases) {
    if (!c.id) c.id = randomUUID()
    c.skillName = skillName
    if (c.context === undefined) c.context = ''
    if (c.enabled === undefined) c.enabled = true
    if (c.requiresVision === undefined) c.requiresVision = false
    c.origin = c.origin || `skill-suggestion:${suggestionId}`
    c.createdAt = c.createdAt || now
    c.updatedAt = now
    for (const k of c.checks || []) {
      if (!k.id) k.id = randomUUID()
      // Host-aligned: a check gates its case only when explicitly marked must.
      if (k.must === undefined) k.must = false
    }
    if (!evalCases.some((x) => x.id === c.id)) evalCases.push(c)
  }
  const chash = casesHash(cases)

  const draftId = randomUUID()
  const draftHash = sha256Hex(Buffer.from(draftContent, 'utf8'))
  const beforeGraded = await gradeFor(current === null ? '' : current.replace(/\r\n/g, '\n'), cases)
  const afterGraded = await gradeFor(draftContent.replace(/\r\n/g, '\n'), cases)

  const beforeRun = buildRun({
    id: randomUUID(), skillName, kind: 'current', hash: baseHash, draftId: null,
    cases, graded: beforeGraded, model: CFG.model, gradeNote: CFG.gradeNote, now,
  })
  const afterRun = buildRun({
    id: randomUUID(), skillName, kind: 'draft', hash: draftHash, draftId,
    cases, graded: afterGraded, model: CFG.model, gradeNote: CFG.gradeNote, now,
  })
  beforeRun.casesHash = chash
  afterRun.casesHash = chash

  const draft = newDraft({
    id: draftId, suggestionId, skillName, action, baseHash, content: draftContent, notes,
    runIds: [beforeRun.id, afterRun.id], now,
  })
  draft.origin = { path: skillFile }

  evals.runs = evals.runs || []
  evals.runs.push(beforeRun, afterRun)

  ledger.drafts = ledger.drafts || []
  ledger.drafts.push(draft)
  ledger.drafts = pruneDrafts(ledger.drafts)
  sug.status = 'review'
  sug.draftId = draft.id
  delete sug.lastError
  ledger.generation = (ledger.generation || 0) + 1

  // Delivery self-audit (交付前自我审查): a 'ready' draft is read by the Mnemon
  // panel + host adoptDraft with HARD field requirements (changes/notes/
  // updatedAt for rendering, runIds for flatMap, baseKey/origin/baseHash for
  // update-adopt). A draft missing any of these writes fine but crashes the
  // panel the moment a human opens or adopts it — a failure we can't see from
  // here. So re-check the FULL native schema RIGHT BEFORE committing, and fail
  // loud at write time instead of silent-late at a human's click.
  validateDraftSchema(draft)

  writeJsonAtomic(CFG.evalsPath, evals)
  writeJsonAtomic(CFG.ledgerPath, ledger)

  return {
    dryRun: false,
    draftId: draft.id,
    beforeRunId: beforeRun.id,
    afterRunId: afterRun.id,
    baseHash,
    draftHash,
    beforeScore: beforeGraded.score,
    afterScore: afterGraded.score,
    beforePassRate: beforeGraded.passRate,
    afterPassRate: afterGraded.passRate,
    engine: { before: beforeGraded.engine, after: afterGraded.engine },
    generation: ledger.generation,
    ready: ledger.drafts.filter((d) => d.status === 'ready').length,
    runs: evals.runs.length,
    cases: evalCases.length,
    backupDir: backup.dir,
    status: `suggestion ${suggestionId} → review，draft ${draft.id} 停在面板待批准（未采纳/未安装）`,
  }
}

// ---- tool: verify (read-only) ----
function verifyImpl(args) {
  const draftId = String(args?.draftId || '')
  const ledger = readJson(CFG.ledgerPath)
  const evals = readJson(CFG.evalsPath)
  const drafts = (ledger.drafts || []).filter((d) => d.status === 'ready' && (!draftId || d.id === draftId))
  if (!drafts.length) throw new Error(draftId ? `ready draft ${draftId} not found` : 'no ready drafts to verify')
  const results = []
  let allOk = true
  for (const d of drafts) {
    const skillFile = CFG.skillFile(d.skillName)
    const liveHash = liveFileHash(skillFile)
    const checks = {
      suggestionReview: (() => {
        const s = (ledger.suggestions || []).find((x) => x.id === d.suggestionId)
        return Boolean(s && s.status === 'review' && s.draftId === d.id)
      })(),
      baseHashMatchesLiveFile: d.baseHash === (liveHash ?? EMPTY_SHA),
      contentIntact: Boolean(d.content && d.content.length > 0),
      runPairPresent: Array.isArray(d.runIds) && d.runIds.length === 2,
    }
    const [beforeId, afterId] = d.runIds || []
    const b = (evals.runs || []).find((r) => r.id === beforeId)
    const a = (evals.runs || []).find((r) => r.id === afterId)
    if (b && a) {
      checks.beforeTargetCurrent = b.target?.kind === 'current'
      checks.afterTargetDraft = a.target?.kind === 'draft' && a.target?.draftId === d.id
      checks.afterHashMatchesDraft = a.target?.hash === sha256Hex(Buffer.from(d.content, 'utf8'))
      checks.beforeHashMatchesLive = b.target?.hash === (liveHash ?? EMPTY_SHA)
      checks.casesHashPaired = b.casesHash === a.casesHash
      checks.singleCaseFocused = b.caseIds?.length === 1 && a.caseIds?.length === 1
      // Host-aligned self-consistency: recompute the run aggregate from the
      // stored per-case rows (score = mean of case scores, passRate = pass /
      // graded) and require the stored run score/passRate to match exactly.
      const gradedRows = (a.results || []).filter((r) => r.verdict !== 'error')
      const recomputedScore = gradedRows.length
        ? gradedRows.reduce((s, r) => s + (Number(r.score) || 0), 0) / gradedRows.length
        : 0
      const recomputedPassRate = gradedRows.length
        ? gradedRows.filter((r) => r.verdict === 'pass').length / gradedRows.length
        : 0
      const passRateOk =
        typeof a.passRate === 'number' ? Math.abs(a.passRate - recomputedPassRate) < 1e-9 : true
      checks.afterScoreSelfConsistent =
        gradedRows.length > 0 && Math.abs(a.score - recomputedScore) < 1e-9 && passRateOk
      // m03216 granularity gate: a coarse check count collapses the score into a few
      // big steps (1/5=0.2, 4/5=0.8). Require enough checks across all cases so the
      // score is actually fine-grained; an under-decomposed case set is a defect.
      const totalChecksAllCases = (a.results || []).reduce((n, r) => n + (r.checks?.length || 0), 0)
      checks.granularityOk = totalChecksAllCases >= 6
    } else {
      checks.runsFound = false
    }
    const ok = Object.values(checks).every((v) => v === true)
    if (!ok) allOk = false
    results.push({ draftId: d.id, skillName: d.skillName, ok, checks })
  }
  return { allOk, results, generation: ledger.generation }
}

// ---- panel config (persisted next to the plugin, survives reloads) ----
// The client panel edits two things: which skills are "in scope" to evolve
// (checkboxes) and which model the pipeline stamps on its runs. Both persist to
// <stateDir>/panel-config.json so a reload keeps the user's selections.
function panelConfigFile() { return path.join(CFG.stateDir, 'panel-config.json') }
function loadPanelConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(panelConfigFile(), 'utf8'))
    return {
      selectedSkills: Array.isArray(raw.selectedSkills) ? raw.selectedSkills : [],
      model: (raw.model && typeof raw.model === 'object') ? raw.model : { ...CFG.model },
      maxConcurrency: Number.isFinite(raw.maxConcurrency) ? Math.min(16, Math.max(1, raw.maxConcurrency | 0)) : CFG.maxConcurrency,
    }
  } catch {
    return { selectedSkills: [], model: { ...CFG.model }, maxConcurrency: CFG.maxConcurrency }
  }
}
function savePanelConfig(next) {
  fs.mkdirSync(CFG.stateDir, { recursive: true })
  const tmp = panelConfigFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, panelConfigFile())
  return next
}

// Models offered in the panel dropdown. Primary source is the host `llm`
// service — `listProviders()` + `listModels(provider)` — which is the same
// catalog the model selector shows. The historical backtest runs and the
// configured default are kept as fallbacks so the dropdown is never empty if
// the llm service is unavailable or a provider probe fails.
function collectModelOptionsSync(currentModel) {
  const seen = new Map()
  const add = (p, m) => {
    p = String(p || '').trim(); m = String(m || '').trim()
    if (!p || !m) return
    const k = p + '/' + m
    if (!seen.has(k)) seen.set(k, { provider: p, model: m })
  }
  try {
    const evals = readJson(CFG.evalsPath)
    for (const r of evals.runs || []) if (r.model) add(r.model.provider, r.model.model)
  } catch { /* evals unreadable → fall through to default + current */ }
  add('workbuddy', 'hy4free')                       // the configured default
  if (currentModel) add(currentModel.provider, currentModel.model)
  return [...seen.values()].sort((a, b) => (a.provider + '/' + a.model).localeCompare(b.provider + '/' + b.model))
}

// Async model catalog from the host llm service. Each provider probe is
// best-effort (one failure must not sink the whole dropdown), and the whole
// enumeration is raced against a timeout so a hung provider cannot stall the
// panel's state endpoint. On any shortfall we merge whatever the llm service
// returned with the synchronous fallback list.
async function collectModelOptions(currentModel) {
  const llm = SVC.llm
  const canList = llm && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function'
  if (!canList) return collectModelOptionsSync(currentModel)

  const seen = new Map()
  const add = (p, m) => {
    p = String(p || '').trim(); m = String(m || '').trim()
    if (!p || !m) return
    const k = p + '/' + m
    if (!seen.has(k)) seen.set(k, { provider: p, model: m })
  }
  let gotAny = false
  const enumerate = (async () => {
    let providers = []
    try { providers = await llm.listProviders() } catch { providers = [] }
    for (const prov of providers || []) {
      const pid = prov && (prov.id ?? prov.provider)
      if (!pid) continue
      try {
        const models = await llm.listModels(pid)
        for (const m of models || []) { add(pid, m && (m.id ?? m.model)); if (m && (m.id ?? m.model)) gotAny = true }
      } catch { /* one provider failing must not sink the dropdown */ }
    }
  })()
  // Bound the enumeration so a slow/hung provider can't stall the state route.
  await Promise.race([
    enumerate,
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ])
  if (gotAny) {
    add('workbuddy', 'hy4free')                     // keep the configured default selectable
    if (currentModel) add(currentModel.provider, currentModel.model)
    return [...seen.values()].sort((a, b) => (a.provider + '/' + a.model).localeCompare(b.provider + '/' + b.model))
  }
  // llm service yielded nothing usable → historical runs + default + current.
  return collectModelOptionsSync(currentModel)
}

// Aggregate the ledger into a per-skill view for the panel: how many
// suggestions each skill has in each open status, baseHash freshness of the
// newest suggestion, and whether a ready draft already exists.
async function panelStateImpl() {
  const ledger = readJson(CFG.ledgerPath)
  const drafts = ledger.drafts || []
  const readyDraftSkills = new Set(drafts.filter((d) => d.status === 'ready').map((d) => d.skillName))
  const bySkill = new Map()
  // Skills that have >=1 OPEN suggestion (pending-not-yet-expired / drafting /
  // review). Mirrors the memory plugin's OPEN_STATUSES = {pending, drafting,
  // review} so both panels report the SAME skill count. An expired-only skill is
  // not actionable, so it is NOT listed (though its expired tally is still shown
  // on any skill that also has an open suggestion).
  const openSkills = new Set()
  const nowMs = Date.now()
  // Effective status: a pending suggestion past its expiresAt has lapsed, exactly
  // as the memory plugin's expireSuggestions() demotes pending -> expired.
  const effectiveStatus = (s) => {
    if (s.status === 'pending' && s.expiresAt && Date.parse(s.expiresAt) < nowMs) return 'expired'
    return s.status
  }
  for (const s of ledger.suggestions || []) {
    const st = effectiveStatus(s)
    // Aggregate the displayed tallies (pending / review / expired); ignore
    // terminal statuses (adopted / dismissed) and non-actionable drafting.
    if (!['pending', 'review', 'expired'].includes(st)) continue
    if (st === 'pending' || st === 'review') openSkills.add(s.skillName)
    let row = bySkill.get(s.skillName)
    if (!row) {
      const skillFile = CFG.skillFile(s.skillName)
      const curHash = liveFileHash(skillFile)
      row = {
        skillName: s.skillName,
        skillFileExists: curHash !== null,
        pending: 0, review: 0, expired: 0,
        update: 0, create: 0,
        newestFreshness: 'MISSING',
        hasReadyDraft: readyDraftSkills.has(s.skillName),
      }
      if (row[st] !== undefined) row[st] += 1
      if (s.action === 'create') row.create += 1; else row.update += 1
      bySkill.set(s.skillName, row)
    } else {
      if (row[st] !== undefined) row[st] += 1
      if (s.action === 'create') row.create += 1; else row.update += 1
    }
  }
  // Drop rows whose skill has no open suggestion (e.g. expired-only) so the panel
  // lists the same set of skills as the memory plugin's attention view.
  for (const [name, row] of [...bySkill]) if (!openSkills.has(name)) bySkill.delete(name)
  const counts = {}
  for (const s of ledger.suggestions || []) counts[s.status] = (counts[s.status] || 0) + 1
  const pc = loadPanelConfig()
  const running = [...RUNNING.values()]
  const phaseSummary = {}
  for (const j of running) { const p = j.phase || j.status || 'unknown'; phaseSummary[p] = (phaseSummary[p] || 0) + 1 }
  return {
    generation: ledger.generation,
    counts,
    drafts: drafts.length,
    ready: drafts.filter((d) => d.status === 'ready').length,
    model: pc.model,
    modelOptions: await collectModelOptions(pc.model),
    allowWrite: CFG.allowWrite,
    backupKeep: CFG.backupKeep,
    maxConcurrency: CFG.maxConcurrency,
    phaseSummary,
    coordinator: {
      maxConcurrency: CFG.maxConcurrency,
      active: running.filter((j) => ['queued', 'running', 'review', 'retrying'].includes(j.phase)).length,
      jobs: running.length,
    },
    selectedSkills: pc.selectedSkills,
    skills: [...bySkill.values()].sort((a, b) => a.skillName.localeCompare(b.skillName)),
  }
}

// ---- host HTTP endpoints (the client panel talks to these over fetch) ----
function writeJson(response, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  response.statusCode = code
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', String(body.length))
  response.end(body)
}
function readReqBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    request.on('data', (c) => chunks.push(c))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', () => resolve(Buffer.alloc(0)))
  })
}

// ---- evolution orchestrator: one real MAIN agent spawns subagents (m01472) ----
// The panel's "进化所选" button → POST /api/skill-evolution/evolve. It spawns a
// single real 'standard' MAIN agent through the host `agents` service. The main
// agent drives evolution by opening up to maxConcurrency subagents (soft cap
// passed in its prompt), each of which drives skill_evolution_* tools (scan →
// draft → backtest → write); the main agent reviews the landed drafts (verify +
// score) and retries once on failure. Subagents appear in the agent tree.
// Pattern proven by @weibaohui/dsh-plugin-kit: agents.create({sessionId,
// meta:{cwd, agentPreset:'standard'}, agentOptions:{provider,model}}) then
// agent.followup({content:[{type:'text',text}], source:{kind:'user'}}) and
// agent.whenIdle(); agentPreset:'standard' is REQUIRED (inherit-the-user-default
// can neither read files nor call host tools).
// m03118: agentPreset alone only writes the session header — the standard
// preset's delegation group is `isolate: { workflowEngine: true }`, so a
// `setup` callback that calls agentPresets.mount(agentCtx, 'standard') is ALSO
// required to mount the composition (and thus the `subagent` tool) into the
// spawned agent. Without it the orchestrator never sees `subagent` and falls
// back to B-mode solo work.
const RUNNING = new Map() // jobId → job record the panel polls via GET /jobs
const SVC = {} // resolved host services: agents / agentDefaultModel / sessions

function openSuggestionsForSkill(skillName) {
  const ledger = readJson(CFG.ledgerPath)
  return (ledger.suggestions || []).filter(
    (s) => s.skillName === skillName && (s.status === 'pending' || s.status === 'expired') && !s.draftId
  )
}

function buildEvolvePrompt(skillName, suggestions, action) {
  const lines = []
  lines.push('You are evolving a DSH skill using the skill_evolution_* host tools.')
  lines.push(`Skill: ${skillName}`)
  lines.push(
    `Action: ${action} (update = a live SKILL.md exists at ${CFG.skillsRoot}\\${skillName}\\SKILL.md; create = brand-new skill, no live file yet)`
  )
  lines.push('')
  lines.push('Open suggestions this draft must satisfy (integrate ALL of them into one coherent draft):')
  for (const s of suggestions) {
    lines.push(`- suggestionId=${s.id} status=${s.status}${s.confidence != null ? ` confidence=${s.confidence}` : ''}`)
    if (s.title) lines.push(`  title: ${s.title}`)
    if (s.summary) lines.push(`  summary: ${s.summary}`)
    if (s.rationale) lines.push(`  rationale: ${s.rationale}`)
    if (s.guidance) lines.push(`  guidance: ${s.guidance}`)
    if (Array.isArray(s.evidence) && s.evidence.length) lines.push(`  evidence: ${JSON.stringify(s.evidence)}`)
  }
  lines.push('')
  lines.push('Work in this order:')
  lines.push('1. Call skill_evolution_scan to confirm these suggestions are still open and check baseHash freshness.')
  lines.push(
    '2. Read the current live SKILL.md (for create it may not exist) plus any references/ files, so you preserve still-valid content, frontmatter and section structure.'
  )
  lines.push(
    '3. Write the FULL improved SKILL.md (draftContent) integrating the improvement points above while keeping all still-valid content.'
  )
  // m03118 size guard: compress an oversized SKILL.md at the end of evolution.
  // Authoritative budget (project memory dsh-skill-md-12-token-2ddc6548):
  // dsh-mnemon draftMaxTokens = 32768 output-token hard cap; Chinese-dense text
  // ≈ 2 bytes/token → byte safety line <50–55KB (NOT 30KB). Skills already under
  // that line must NOT be over-compressed (that would strip executable detail).
  lines.push(
    '3b. SIZE GUARD — keep the draft under the output-token budget. dsh-mnemon draftMaxTokens = 32768 tokens; Chinese-dense text ≈ 2 bytes/token, so the byte safety line is <50KB (≈<25K tokens). After writing the draft, estimate its size: if it would exceed ~50KB, TIGHTEN IT — merge duplicate sections, drop redundant prose and stale/overlapping Pitfalls, compress verbose examples to their load-bearing command/path/API lines — while preserving every executable detail (commands, paths, API names, code fences) and all still-valid content. If the draft is already under ~50KB, leave it alone: do NOT over-compress, that only deletes usable detail.'
  )
  lines.push(
    '4. Build improvement-point cases[] = [{id?, title, checks:[{id?, text, must?, anchors?}]}]. A model judges each check against the body (does the skill genuinely satisfy the improvement?), so write the check text as the INTENT of the improvement, not a literal string to match. Mark load-bearing checks must:true (the case only passes when they do); use anchors only as an optional offline fallback. Judge intent, never a case-specific string or an over-strict anchor you invented, or the score lies.',
    '4b. GRANULARITY (IMPORTANT — this decides score granularity). The score is the case-level mean of must-weighted check scores, so a case with only a handful of checks can only ever produce coarse steps (e.g. 1/5 = 0.2, 4/5 = 0.8) and hides partial regressions. For EVERY case, decompose the improvement into at least 6–8 independent, individually-judged checks (target ~6 per case, more for a dense change) — one check per distinct assertion the improvement should guarantee (a contract honored, a pitfall recorded, a wrong pattern forbidden, a worked example present, a cross-reference correct, ...). NEVER lump several assertions into one broad check. More fine-grained checks = a score that actually distinguishes a strong draft from a weak one; a near-flat score (e.g. all cases ≈0.2/0.8) is a signal you under-decomposed, so split the checks further and re-backtest.'
  )
  lines.push(
    '5. Call skill_evolution_backtest with skillName + draftContent + cases[] to get before/after case-level scores and pass rates. If after is not clearly >= before, refine the draft or the checks.'
  )
  lines.push(
    '6. Call skill_evolution_write once per open suggestion (they may share the same draftContent): pass skillName, suggestionId, action, draftContent, notes (≤2000 chars on what changed), cases[]. Skip any suggestion that already has a draftId — the tool refuses those. This lands a status=ready draft + a before/after run pair.'
  )
  lines.push(
    '7. HARD CONSTRAINTS: never adopt, never install, never overwrite the live SKILL.md, never edit files under the skills root directly. The draft stops at status=ready for a human to approve in the Mnemon panel.'
  )
  lines.push('8. Finish with a short report: skill, suggestionId(s), before→after scores, draftId(s).')
  return lines.join('\n')
}

// ---- evolution orchestrator: one real MAIN agent spawns ≤maxConcurrency
// SUBAGENTS (m00648 / m01472). The panel "进化所选" → POST /evolve spawns a
// single real 'standard' MAIN agent. The main agent opens up to maxConcurrency
// subagents (via the subagent tool) to evolve skills in parallel, reviews each
// landed draft via skill_evolution_verify and retries once on failure. The
// subagents appear in the agent tree (list_agents). Concurrency is a SOFT cap
// the LLM honours (maxConcurrency is passed in the main-agent prompt); the host
// standard preset's own subagent cap is the only hard bound.

// Main-agent prompt: it orchestrates subagents and reviews/retries. The per-skill
// subagent prompt is produced by buildEvolvePrompt (kept above) so each subagent
// gets the full scan→draft→backtest→write procedure with its suggestion details.
function buildMainAgentPrompt(skills, maxConcurrency) {
  const parts = []
  parts.push('You are the ORCHESTRATOR for evolving DSH skills. You drive evolution by spawning SUBAGENTS — you never edit skill files yourself.')
  parts.push('CONCURRENCY: keep at most ' + maxConcurrency + ' subagents running at the same time; batch the rest. NEVER exceed ' + maxConcurrency + ' concurrent subagents.')
  parts.push('')
  parts.push('For EACH skill listed below, spawn a subagent (subagent tool) and give it EXACTLY that skill\'s subagent prompt. The subagent does the actual evolution (it calls skill_evolution_scan → draft → backtest → write) and returns after landing a status=ready draft (it reports draftId(s)).')
  parts.push('After a subagent finishes, REVIEW: call skill_evolution_verify with the draftId it landed (or skill_evolution_scan to find the latest ready draft for that skill). If not allOk, after-score < before-score, OR the verify report shows granularityOk=false (too few checks — the score collapsed into coarse ~0.2/0.8 steps, which means the subagent under-decomposed the case), spawn ONE retry subagent for that skill using the same subagent prompt and tell it to decompose into at least 6–8 checks per case. Retry at most once.')
  // m03118 fallback: if subagents can't be dispatched (no subagent tool, or
  // spawning is refused/unavailable in this environment), the main agent must
  // NOT stall — it does the work itself, one skill at a time. This is the B-mode
  // fallback the user authorized (MEMORY.md "无法派发 subagent → B 模式自己干").
  parts.push('')
  parts.push('FALLBACK (IMPORTANT): if you find you CANNOT spawn subagents in this environment — the subagent tool is absent, or a spawn call is refused/unavailable — DO NOT stall or report failure. Fall back to doing the evolution YOURSELF, one skill at a time, in this session: for each skill below, follow that skill\'s prompt directly (skill_evolution_scan → read live SKILL.md → draft → skill_evolution_backtest → skill_evolution_write), then skill_evolution_verify the landed draft. Never adopt, install, or overwrite the live SKILL.md even when working solo.')
  parts.push('Constraints: you orchestrate only; never call skill_evolution_write yourself. Drafts stop at status=ready for human approval in the Mnemon panel.')
  parts.push('Finish with a concise per-skill report: skill, draftId(s), before→after score, verify ok / retried.')
  parts.push('')
  for (const skill of skills) {
    const suggestions = openSuggestionsForSkill(skill)
    const action = suggestions.some((s) => s.action === 'create') ? 'create' : 'update'
    parts.push('=== SUBAGENT PROMPT FOR SKILL: ' + skill + ' ===')
    parts.push(buildEvolvePrompt(skill, suggestions, action))
    parts.push('=== END SUBAGENT PROMPT ===')
    parts.push('')
  }
  return parts.join('\n')
}

// Spawn the single real main agent for one /evolve request (m01472).
async function spawnMainAgent(skills, model, maxConcurrency) {
  const sessionId = 'session-' + randomUUID()
  const handle = await SVC.agents.create({
    sessionId,
    meta: { cwd: CFG.skillsRoot, agentPreset: 'standard' },
    agentOptions: model ? { provider: model.provider, model: model.model } : undefined,
    // m03118: meta.agentPreset only writes the session header. The standard
    // preset's delegation group (tool-subagent / tool-subagent-fork) is declared
    // with `isolate: { workflowEngine: true }`, so its tools are NOT mounted
    // unless the preset composition itself is mounted into the agent. Replicate
    // the host's composeAgent() setup here: mount the 'standard' composition via
    // agentPresets. Without this the orchestrator's tool list lacks `subagent`
    // and the model correctly falls back to B-mode solo work.
    setup: async (agentCtx) => {
      const presets = agentCtx.get('agentPresets')
      if (presets && typeof presets.mount === 'function') {
        await presets.mount(agentCtx, 'standard')
      }
    },
  })
  const agent = handle.agent
  const job = {
    jobId: randomUUID(),
    skill: skills.join(', '),
    skillCount: skills.length,
    sessionId,
    model: model || null,
    maxConcurrency,
    startedAt: new Date().toISOString(),
    phase: 'running',
    status: 'running',
    attempts: 1,
    reviewed: false,
    error: null,
  }
  job.agent = agent
  RUNNING.set(job.jobId, job)
  job.done = (async () => {
    try {
      const prompt = buildMainAgentPrompt(skills, maxConcurrency)
      await agent.followup({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
      await agent.whenIdle()
      job.status = 'completed'
      job.phase = 'done'
      job.finishedAt = new Date().toISOString()
    } catch (e) {
      job.status = 'failed'
      job.phase = 'failed'
      job.error = String((e && e.message) || e)
    } finally {
      try { SVC.sessions?.flush?.(agent.session) } catch {}
    }
  })()
  return job
}

// Strip internal fields (agent handle, done promise, full review) before handing
// a job to the panel; keep a small reviewSummary.
function publicJob(job) {
  const { agent, done, review, firstAttemptReview, ...rest } = job
  rest.reviewSummary = review
    ? { ok: review.ok, allOk: review.allOk, scoreOk: review.scoreOk, reason: review.reason || undefined }
    : undefined
  return rest
}

function registerPanelRoutes(ctx) {
  if (typeof ctx.inject !== 'function') return
  // Resolve the host services the evolve spawner needs. If any is missing the
  // evolve route answers 503 with a clear error rather than misbehaving.
  ctx.inject(['agents', 'agentDefaultModel', 'sessions', 'llm'], (sctx) => {
    SVC.agents = sctx.agents
    SVC.agentDefaultModel = sctx.agentDefaultModel
    SVC.sessions = sctx.sessions
    SVC.llm = sctx.llm
  })
  ctx.inject(['webServer'], (webCtx) => {
    // Collect and return every disposer: on HMR reload a stale closure that kept
    // its route would collide with the new one ("duplicate exact route").
    const disposers = []
    const register = (p, handler) => disposers.push(webCtx.webServer.register({ kind: 'exact', path: p, handler }))

    // GET → current panel state (per-skill suggestion counts, freshness, model, selection).
    register('/api/skill-evolution/state', async (_request, response) => {
      try { writeJson(response, 200, await panelStateImpl()) }
      catch (e) { writeJson(response, 500, { error: String(e && e.message || e) }) }
    })

    // POST { model?: {provider, model}, selectedSkills?: string[],
    //        maxConcurrency?: number } → persist. Only model + selection +
    // maxConcurrency live here; evolving/backtesting stays with the agent tools
    // (the panel configures, it does not run the pipeline).
    register('/api/skill-evolution/config', async (request, response) => {
      if (request.method !== 'POST') { writeJson(response, 405, { error: 'method not allowed' }); return }
      try {
        const body = JSON.parse((await readReqBody(request)).toString('utf8') || '{}')
        const pc = loadPanelConfig()
        if (body.model && typeof body.model === 'object') {
          const provider = String(body.model.provider ?? '').trim()
          const model = String(body.model.model ?? '').trim()
          if (!provider || !model) { writeJson(response, 400, { error: 'model.provider and model.model are required' }); return }
          pc.model = { provider, model }
          CFG.model = { provider, model }
        }
        if (Array.isArray(body.selectedSkills)) {
          pc.selectedSkills = body.selectedSkills.map((s) => String(s)).filter(Boolean)
        }
        if (body.maxConcurrency !== undefined) {
          const n = Number(body.maxConcurrency)
          if (!Number.isFinite(n) || n < 1 || n > 16) { writeJson(response, 400, { error: 'maxConcurrency must be an integer between 1 and 16' }); return }
          pc.maxConcurrency = n | 0
          CFG.maxConcurrency = n | 0
        }
        savePanelConfig(pc)
        writeJson(response, 200, { ok: true, ...(await panelStateImpl()) })
      } catch (e) { writeJson(response, 500, { error: String(e && e.message || e) }) }
    })

    // POST { skills?: string[], model?: {provider, model} } → spawn ONE real
    // 'standard' main agent for one evolution request. Defaults to the panel
    // selection + panel model when omitted. The main agent opens up to
    // maxConcurrency subagents (soft cap), reviews each landed draft (verify +
    // score) and retries once on failure. Each subagent drives
    // skill_evolution_scan→draft→backtest→write; the ready draft it lands stops
    // in the panel for human approval. Fire-and-forget: the pipeline takes
    // minutes, so we return the job id and let the panel poll /jobs.
    register('/api/skill-evolution/evolve', async (request, response) => {
      if (request.method !== 'POST') { writeJson(response, 405, { error: 'method not allowed' }); return }
      if (!SVC.agents) {
        writeJson(response, 503, { error: 'evolution coordinator unavailable: host agents service not injected' })
        return
      }
      try {
        const body = JSON.parse((await readReqBody(request)).toString('utf8') || '{}')
        const pc = loadPanelConfig()
        const skills = (Array.isArray(body.skills) && body.skills.length ? body.skills : pc.selectedSkills)
          .map((s) => String(s).trim())
          .filter(Boolean)
        if (!skills.length) { writeJson(response, 400, { error: 'no skills selected to evolve' }); return }
        // model precedence: request body > panel config > host default selection.
        let model = pc.model || null
        if (body.model && typeof body.model === 'object') {
          const provider = String(body.model.provider ?? '').trim()
          const mdl = String(body.model.model ?? '').trim()
          if (!provider || !mdl) { writeJson(response, 400, { error: 'model.provider and model.model are required' }); return }
          model = { provider, model: mdl }
        }
        if ((!model || !model.provider || !model.model) && typeof SVC.agentDefaultModel?.currentSelection === 'function') {
          const sel = SVC.agentDefaultModel.currentSelection()
          if (sel && sel.provider && sel.model) model = { provider: sel.provider, model: sel.model }
        }
        const queue = []
        const skipped = []
        for (const skill of skills) {
          const suggestions = openSuggestionsForSkill(skill)
          if (!suggestions.length) { skipped.push({ skill, reason: 'no open (pending/expired) suggestion without a draftId' }); continue }
          queue.push(skill)
        }
        writeJson(response, 200, {
          ok: true,
          maxConcurrency: CFG.maxConcurrency,
          queued: queue,
          skipped,
          model,
          orchestrator: 'main-agent-spawns-subagents',
        })
        // Spawn ONE real main agent; it opens ≤maxConcurrency subagents (soft cap
        // passed in its prompt), reviews each landed draft, retries once. The
        // pipeline takes minutes → fire-and-forget, panel polls /jobs.
        spawnMainAgent(queue, model, CFG.maxConcurrency).catch((e) => {
          ctx?.logger?.error?.(`skill-evolution-backtest: main-agent orchestrator crashed: ${String(e && e.stack || e)}`)
        })
      } catch (e) { writeJson(response, 500, { error: String(e && e.message || e) }) }
    })

    // POST { op: 'backtest'|'write'|'verify', ...args } → run the matching
    // pipeline step IN-PROCESS, using the exact same gradeFor()/SVC.llm path the
    // agent tools use. This is the server-side bridge for session harness scripts
    // that cannot call the cordis tools directly: a hand-rolled harness that
    // imports lib/grade.mjs's anchor-only gradeBody() would silently grade with
    // regexes and never reach the LLM semantic judge. Routing through here
    // guarantees the LLM judge (with anchor fallback) is used.
    register('/api/skill-evolution/run', async (request, response) => {
      if (request.method !== 'POST') { writeJson(response, 405, { error: 'method not allowed' }); return }
      try {
        const body = JSON.parse((await readReqBody(request)).toString('utf8') || '{}')
        const op = String(body.op || '').trim()
        if (op === 'backtest') {
          writeJson(response, 200, { ok: true, result: await backtestImpl(body) })
        } else if (op === 'write') {
          writeJson(response, 200, { ok: true, result: await writeImpl(body) })
        } else if (op === 'verify') {
          writeJson(response, 200, { ok: true, result: verifyImpl(body) })
        } else {
          writeJson(response, 400, { error: "op must be 'backtest', 'write' or 'verify'" })
        }
      } catch (e) {
        writeJson(response, 500, { error: String(e && e.message || e) })
      }
    })

    // GET → spawn jobs the panel polls to show live evolution progress.
    register('/api/skill-evolution/jobs', async (_request, response) => {
      const jobs = [...RUNNING.values()]
        .map(publicJob)
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      writeJson(response, 200, { jobs })
    })

    return disposers
  })
}

// ---- registration ----
export function apply(ctx, config = {}) {
  const cfg = configure(config)
  ctx.logger?.info?.(`skill-evolution-backtest: ledger=${cfg.ledgerPath} skillsRoot=${cfg.skillsRoot} allowWrite=${cfg.allowWrite}`)
  if (typeof ctx.inject !== 'function') return

  registerPanelRoutes(ctx)

  ctx.inject(['tools'], (sctx) => {
    return sctx.effect(() => {
      sctx.tools.register({
        name: 'skill_evolution_scan',
        description:
          'List Mnemon skill-evolution suggestions (pending/review/expired by default) with baseHash freshness (FRESH/STALE/MISSING vs the live SKILL.md), existing draftId and lastError. Read-only; use it to decide what to evolve next. Returns generation, status counts and a per-suggestion listing.',
        parameters: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['pending', 'review', 'expired', 'adopted', 'dismissed'],
              description: 'Filter to one status. Omit to list all not-yet-settled (pending/review/expired).',
            },
          },
        },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: (args) => j(scanImpl(args)),
      })

      sctx.tools.register({
        name: 'skill_evolution_backtest',
        description:
          'Per-check semantic backtest of a candidate improved SKILL.md against the current live one, graded the way the Mnemon host does. You supply skillName, the full draftContent, and cases[] = [{id?,title,checks:[{id?,text,must?,anchors?}]}]. A model judges each check against the body (does the skill actually satisfy the improvement?), anchors are only the offline fallback, case score is must-weighted (must=2, optional=1), and the run score is the case-level mean (passRate = pass cases / graded cases). Returns before/after scores + pass rates, delta, the grading engine, and the per-check breakdown. Read-only — nothing is written. Mark load-bearing checks must:true so a case only passes when they do.',
        parameters: {
          type: 'object',
          properties: {
            skillName: { type: 'string', description: 'Skill to backtest, e.g. dsh-plugin-edit-verify.' },
            draftContent: { type: 'string', description: 'Full improved SKILL.md text (the after side).' },
            cases: {
              type: 'array',
              description: 'Improvement-point cases with anchor-checked items.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  checks: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        text: { type: 'string' },
                        must: { type: 'boolean', description: 'Load-bearing check: the case only passes when this check does.' },
                        anchors: { type: 'array', items: { type: 'string' }, description: 'Optional fallback regexes; used only if the model judge is unavailable.' },
                      },
                      required: ['text'],
                    },
                  },
                },
                required: ['title', 'checks'],
              },
            },
          },
          required: ['skillName', 'draftContent', 'cases'],
        },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async (args) => j(await backtestImpl(args)),
      })

      sctx.tools.register({
        name: 'skill_evolution_write',
        description:
          'MUTATING: turn a graded improvement into a status=ready Mnemon draft + a before/after run pair, atomic-write both ledgers (generation+1) after timestamped backups, and flip the suggestion to review with draftId set. Grading is host-aligned: a model judges each check semantically (anchors only as fallback), case score is must-weighted (must=2, optional=1), run score is the case-level mean. Guards: refuses if the suggestion is adopted/dismissed or already has a draftId; baseHash is recomputed from the live file. The draft stops at ready for human approval — it does NOT adopt, install, or overwrite the live SKILL.md. Provide skillName, suggestionId, action(update|create), draftContent, notes, cases[] (same shape as backtest).',
        parameters: {
          type: 'object',
          properties: {
            skillName: { type: 'string' },
            suggestionId: { type: 'string', description: 'The pending suggestion this draft answers.' },
            action: { type: 'string', enum: ['update', 'create'], description: 'update = live SKILL.md exists; create = brand-new skill.' },
            draftContent: { type: 'string', description: 'Full improved SKILL.md text.' },
            notes: { type: 'string', description: 'What this draft changes (≤2000 chars).' },
            cases: {
              type: 'array',
              description: 'Improvement-point cases (same shape as skill_evolution_backtest).',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  origin: { type: 'string' },
                  checks: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        text: { type: 'string' },
                        must: { type: 'boolean' },
                        anchors: { type: 'array', items: { type: 'string' } },
                      },
                      required: ['text'],
                    },
                  },
                },
                required: ['title', 'checks'],
              },
            },
          },
          required: ['skillName', 'suggestionId', 'action', 'draftContent', 'cases'],
        },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async (args) => j(await writeImpl(args)),
      })

      sctx.tools.register({
        name: 'skill_evolution_verify',
        description:
          'Independently re-read a ready draft (or all ready drafts) and recheck every invariant the write should have satisfied: suggestion flipped to review+draftId, baseHash matches the live file, content intact, before/after run pair present with correct current/draft targets, after hash matches the draft, casesHash paired, single focused case, after score/passRate self-consistent with the per-case rows (host-aligned case-level aggregate), and granularityOk (the after run carries enough checks (>=6 total) that the score is actually fine-grained rather than collapsed into coarse ~0.2/0.8 steps). Read-only; returns allOk plus a per-draft check table.',
        parameters: {
          type: 'object',
          properties: { draftId: { type: 'string', description: 'Verify one ready draft. Omit to verify all ready drafts.' } },
        },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: (args) => j(verifyImpl(args)),
      })
    })
  })

  ctx.on('dispose', () => {
    ctx.logger?.info?.('skill-evolution-backtest: disposed')
  })
}