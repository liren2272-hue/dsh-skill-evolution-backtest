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
import { gradeBody, normalizeCases } from './lib/grade.mjs'
import { judgeBody, GRADE_ENGINE, streamAssistantText } from './lib/llm-judge.mjs'
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
    // Concurrency the user can choose (m00533): how many worker subagents may
    // run at once. Clamped 1..16; default 3. 1 = OLD serial mode (one skill at a
    // time); >1 = NEW concurrent mode (several skills in parallel). The user picks
    // the value because a too-large concurrency can make it slower than serial.
    maxConcurrency: Math.min(16, Math.max(1, Number.isFinite(cfg.maxConcurrency) ? (cfg.maxConcurrency | 0) : 3)),
    // Evolution mode. 'new' (default) = deterministic CODE state machine
    // (no LLM orchestrator, hard concurrency bound, N skills = N workers).
    // 'legacy' = the original LLM main-agent orchestrator that spawns
    // subagents; kept verbatim for users who prefer it at high concurrency.
    evolutionMode: cfg.evolutionMode === 'legacy' ? 'legacy' : 'new',
    // Grading engine. 'auto' = LLM semantic judge when a model is reachable,
    // anchors as the safe fallback; 'llm' forces the model judge; 'anchor'
    // forces the deterministic regex grader.
    gradeEngine: cfg.gradeEngine === 'llm' || cfg.gradeEngine === 'anchor' ? cfg.gradeEngine : 'auto',
    judgeTimeoutMs: Number.isFinite(cfg.judgeTimeoutMs) ? cfg.judgeTimeoutMs : 120000,
    // Timeout for the ONE creative LLM call (cases[] + draftContent) per skill in
    // the 'new' code state machine. Separate from judgeTimeoutMs (per-check judge).
    draftTimeoutMs: Number.isFinite(cfg.draftTimeoutMs) ? cfg.draftTimeoutMs : 300000,
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
async function gradeFor(body, cases, modelOverride) {
  const engine = CFG.gradeEngine === 'anchor' ? GRADE_ENGINE.ANCHOR : CFG.gradeEngine
  const signal = engine === GRADE_ENGINE.ANCHOR ? undefined : AbortSignal.timeout(CFG.judgeTimeoutMs)
  // Judge with the model the calling job selected (same one that authored the
  // rubric/draft) so the semantic judge is actually reachable. Falling back to the
  // config default here made score/backtest fail fast to the anchor regex and read
  // 0.0s whenever the selected model differed from CFG.model (m07102).
  const judgeModel = modelOverride || CFG.model
  return judgeBody(body, cases, { llm: SVC.llm, model: judgeModel, signal, engine })
}

// Validate & normalize a PRE-COMPUTED baseline (the frozen "before"). This is the
// fairness gate the user required: the evaluation standard (cases) must be frozen
// BEFORE the draft is written, and before/after must be judged under the SAME
// rubric. A baseline that drifted — cases edited after it was computed, or the
// live SKILL.md changed (baseHash) — is REJECTED outright rather than silently
// recomputed. A silent recompute would let the very act of writing the new skill
// influence the rubric, which is exactly the scoring distortion to avoid.
//
// `before` is the object returned by skill_evolution_score. It must carry
// `baseHash`, `casesHash` and the graded baseline; pass the FULL result, not a
// trimmed copy. Returns a graded object shaped like judgeBody()'s output, or null
// when the caller did not supply a baseline (caller then grades normally).
function normalizeBefore(before, cases, baseHash) {
  if (before == null) return null
  if (typeof before !== 'object' || Array.isArray(before)) {
    throw new Error('before must be the baseline object returned by skill_evolution_score (or omitted)')
  }
  const src = before.baseline && typeof before.baseline === 'object' ? before.baseline : before
  if (typeof src.baseHash !== 'string' || typeof src.casesHash !== 'string') {
    throw new Error('before must carry baseHash and casesHash — pass the full result of skill_evolution_score, not a trimmed copy')
  }
  const wantCases = casesHash(cases)
  if (src.casesHash !== wantCases) {
    throw new Error(
      `before.casesHash (${src.casesHash}) does not match the frozen rubric casesHash (${wantCases}). ` +
        'The evaluation standard changed after the baseline was computed — re-run skill_evolution_score with the SAME cases before evolving, or pass the matching cases.'
    )
  }
  if (src.baseHash !== baseHash) {
    throw new Error(
      `before.baseHash (${src.baseHash}) does not match the current live file hash (${baseHash}). ` +
        'The live SKILL.md changed after the baseline was computed — re-run skill_evolution_score against the current file.'
    )
  }
  if (!Array.isArray(src.caseRows) || !src.caseRows.length) {
    throw new Error('before baseline is missing caseRows — pass the full result of skill_evolution_score')
  }
  return {
    score: src.score,
    passRate: src.passRate,
    totalChecks: src.totalChecks,
    passedChecks: src.passedChecks,
    engine: src.engine,
    caseRows: src.caseRows,
  }
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
  const baseHash = liveFileHash(skillFile) ?? EMPTY_SHA
  // v1.18.2: Reuse a frozen baseline when the caller supplied one (skill_evolution_score
  // output); otherwise grade the current body now. A baseline that drifted (the
  // live file or the rubric changed after it was frozen) is REJECTED by
  // normalizeBefore. For the DIAGNOSTIC backtest that rejection must not erase the
  // after score: fall back to grading the current body under the SAME rubric and
  // record why, so the panel still shows a result instead of silently dropping the
  // backtest (m02504: skills showed "no backtest result" because this throw was
  // swallowed upstream and afterScore came back undefined).
  let before = null
  let beforeFallback = null
  try {
    before = normalizeBefore(args?.before, cases, baseHash)
  } catch (e) {
    beforeFallback = String((e && e.message) || e)
    before = await gradeFor(currentNorm, cases, args?.model)
  }
  if (!before) before = await gradeFor(currentNorm, cases, args?.model)
  const after = await gradeFor(draftContent.replace(/\r\n/g, '\n'), cases, args?.model)
  return {
    skillName,
    skillFileExists: current !== null,
    baseHash,
    beforeReused: Boolean(args?.before) && !beforeFallback,
    beforeFallback,
    before: { score: before.score, passRate: before.passRate, totalChecks: before.totalChecks, passedChecks: before.passedChecks, caseRows: before.caseRows },
    after: { score: after.score, passRate: after.passRate, totalChecks: after.totalChecks, passedChecks: after.passedChecks, caseRows: after.caseRows },
    delta: Number((after.score - before.score).toFixed(4)),
    engine: { before: before.engine, after: after.engine },
    note: 'score = case 级加权平均（must=2，普通=1），对齐宿主 runScore；由模型逐 check 语义判定，模型不可用时回退锚点正则。',
  }
}

// ---- tool: score (read-only) — freeze the evaluation standard BEFORE evolving ----
// The user's core fairness requirement: the rubric (cases) and the "before"
// baseline must be fixed BEFORE the draft is written, so the score is not
// distorted by writing the new skill first and scoring after. This tool grades
// the CURRENT live SKILL.md against the frozen cases and returns a self-contained
// baseline object that backtest/write can consume via their `before` param — the
// exact same rubric, scored once, reused unchanged.
//
// Failure is deliberately loud: cases must be frozen first, and a baseline from a
// drifted live file is useless, so the caller must re-freeze.
async function scoreImpl(args) {
  const skillName = String(args?.skillName || '')
  const cases = Array.isArray(args?.cases) ? args.cases : []
  if (!skillName) throw new Error('skillName is required')
  if (!cases.length) throw new Error('cases must be a non-empty array of {id,title,checks:[{id,text,must?,anchors?}]}')
  const skillFile = CFG.skillFile(skillName)
  const current = readBody(skillFile)
  const baseHash = liveFileHash(skillFile) ?? EMPTY_SHA
  const currentNorm = current === null ? '' : current.replace(/\r\n/g, '\n')
  const graded = await gradeFor(currentNorm, cases, args?.model)
  const baseline = {
    skillName,
    baseHash,
    casesHash: casesHash(cases),
    score: graded.score,
    passRate: graded.passRate,
    totalChecks: graded.totalChecks,
    passedChecks: graded.passedChecks,
    engine: graded.engine,
    caseRows: graded.caseRows,
    note: '冻结基准：cases 先定，再对当前 live SKILL.md 评一次。把它原样传给 skill_evolution_backtest / skill_evolution_write 的 before 参数，before/after 即共用同一套评测标准。',
  }
  return {
    skillName,
    skillFileExists: current !== null,
    baseHash,
    casesHash: baseline.casesHash,
    baseline,
    // Convenience mirror of the baseline fields (also emitted top-level so a
    // caller that ignores `baseline` still gets the numbers).
    score: baseline.score,
    passRate: baseline.passRate,
    totalChecks: baseline.totalChecks,
    passedChecks: baseline.passedChecks,
    engine: baseline.engine,
    caseRows: baseline.caseRows,
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
  // Reuse a frozen baseline when the caller supplied one (skill_evolution_score
  // output). Validate it against the RAW cases as passed — the baseline's
  // casesHash was computed over the caller's rubric object, BEFORE this function
  // enriches the copies with skillName/id/etc. Enriching first would change the
  // hash and falsely reject an unchanged rubric.
  const beforeGraded = normalizeBefore(args?.before, rawCases, baseHash) ?? (await gradeFor(current === null ? '' : current.replace(/\r\n/g, '\n'), cases, args?.model))
  const afterGraded = await gradeFor(draftContent.replace(/\r\n/g, '\n'), cases, args?.model)

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
  evals.runs.unshift(afterRun, beforeRun)

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
      // m06571/m06761: a SKILL.md that DSH itself would reject for size must be a
      // hard verify defect. 65536 bytes is the host's documented max.
      sizeOk: Buffer.byteLength(String(d.content ?? ''), 'utf8') <= 65536,
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
    // singleCaseFocused is informational, not a defect gate. A multi-subpoint
    // improvement legitimately lands one case per subpoint (multi-case), which
    // sets singleCaseFocused=false by design. The real coarse-granularity guard
    // is granularityOk (total checks >= 6). Exclude singleCaseFocused from the
    // ok verdict so a benign multi-case draft is not blocked as 11/12, while the
    // flag stays in checks for the panel to surface honestly.
    const BENIGN_CHECKS = new Set(['singleCaseFocused'])
    const ok = Object.entries(checks)
      .filter(([k]) => !BENIGN_CHECKS.has(k))
      .every(([, v]) => v === true)
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
      evolutionMode: raw.evolutionMode === 'legacy' || raw.evolutionMode === 'new' ? raw.evolutionMode : CFG.evolutionMode,
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
      evolutionMode: CFG.evolutionMode,
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

// ---- evolution orchestrator: code state machine (new) + legacy LLM main agent ----
// The panel's "进化所选" button → POST /api/skill-evolution/evolve. Two modes:
//  'new' (default, v1.16.0): a deterministic CODE state machine drives the whole
//    pipeline — NO LLM main agent is spawned. The host `llm` authors only
//    cases[]/draftContent; code runs scoreImpl→writeImpl→verifyImpl→backtestImpl
//    per skill with a hard semaphore cap, before-baseline dedup, a code-generated
//    final report (orchestrator:'code-state-machine'). See runStateMachine below.
//  'legacy' (retained): ONE real 'standard' MAIN agent opens ≤maxConcurrency
//    subagents (soft cap in its prompt), each drives skill_evolution_* tools; the
//    main agent reviews/retries once. Subagents appear in the agent tree.
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
const SVC = {} // resolved host services: agents / agentDefaultModel / sessions / llm

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
    '4c. FREEZE THE RUBRIC BEFORE EVALUATING (fairness gate). Immediately after the cases are final, call skill_evolution_score with skillName + cases[] to grade the CURRENT live SKILL.md once and get the frozen baseline (baseHash + casesHash + score/caseRows). This is the ONLY before value you may use for this skill: before and after must share the exact same rubric, and the baseline must be computed before the draft exists, otherwise the score is distorted by writing the new skill first. Do NOT change cases after this call — any later edit changes casesHash and the frozen baseline is rejected.'
  )
  lines.push(
    '5. Call skill_evolution_backtest with skillName + draftContent + cases[] AND the `before` field set to the baseline object returned by step 4c. The tool reuses that frozen before score verbatim (it validates casesHash + baseHash and rejects a drifted baseline rather than silently re-grading). If after is not clearly >= before, refine the DRAFT (not the frozen checks).'
  )
  lines.push(
    '6. Call skill_evolution_write once per open suggestion (they may share the same draftContent): pass skillName, suggestionId, action, draftContent, notes (≤2000 chars on what changed), cases[], and the SAME `before` baseline from step 4c so the landed before run reuses the frozen score. Skip any suggestion that already has a draftId — the tool refuses those. This lands a status=ready draft + a before/after run pair.'
  )
  lines.push(
    '7. HARD CONSTRAINTS: never adopt, never install, never overwrite the live SKILL.md, never edit files under the skills root directly. The draft stops at status=ready for a human to approve in the Mnemon panel.'
  )
  lines.push('8. Finish with a short report: skill, suggestionId(s), before→after scores, draftId(s).')
  return lines.join('\n')
}

// =====================================================================
// evolution orchestration (v1.16.0)
//
// 'new' (default) = CODE-DRIVEN state machine. No LLM main-agent orchestrator
// is spawned. The plugin code owns the entire deterministic pipeline: it asks
// the host LLM only for the creative artifacts (evaluation cases[] + the
// improved SKILL.md draftContent), then itself calls, in a fixed order,
//   scoreImpl (freeze BEFORE once) -> writeImpl (land draft, reuse before)
//   -> verifyImpl (self-audit)    -> backtestImpl (after score, reuse before)
// with a HARD concurrency semaphore, ONE logical worker per skill
// (N skills = N workers, never 2N), a single code-level retry on invalid
// artifacts, and a final per-draftId verify. The report is generated by CODE,
// so the declared mode and the actual tool ownership can never diverge.
//
// 'legacy' = the original LLM main-agent orchestrator (spawnMainAgent below)
// is kept verbatim; it spawns one 'standard' main agent that opens subagents.
// =====================================================================

// Async mutex around the shared-ledger mutation (writeImpl). Several workers
// run concurrently; without this lock two writeImpl calls would both read the
// same ledger generation and the last atomic write would silently drop the
// other's draft. The lock serializes only the short commit; the expensive LLM
// artifact/score phases still run fully in parallel.
let _writeChain = Promise.resolve()
function withWriteLock(fn) {
  const result = _writeChain.then(fn, fn)
  _writeChain = result.then(() => {}, () => {})
  return result
}

// The host LLM is used ONLY for two SMALL creative artifacts (v1.18.0), fetched
// in TWO separate short streams. A single stream emitting the whole rubric +
// full SKILL.md in one JSON object was being cut off by some upstream models
// (finish reason 'aborted') — splitting keeps each response small.
const RUBRIC_SYSTEM = `You are the RUBRIC AUTHOR (call 1 of 2) for DSH skill evolution.
Return ONLY a single JSON object (no prose, no markdown fences) with this exact shape:
{"cases":[{"id":"case-1","title":"<improvement point>","checks":[{"id":"c1k1","text":"<what must be true in the improved skill>","must":true,"anchors":["<literal substring a good draft must contain>"]}]}]}
Rules:
- Produce 1-2 cases totalling AT LEAST 6 independent checks. Each check encodes one improvement intent from the suggestions; "must" marks load-bearing checks.
- "anchors" are literal substrings a correct draft must contain (used by the offline regex fallback). Give every check at least one short anchor.
- Do NOT adopt, install, or overwrite any file. Return only the rubric JSON object.`

const DRAFT_SYSTEM = `You are the DRAFT AUTHOR for DSH skill evolution.
You are given a set of improvement suggestions and the CURRENT live skill.
Return ONLY the full improved SKILL.md text — no JSON wrapper, no prose, no explanation.
Rules:
- Start with a valid YAML frontmatter block: first line "---", then "name: <kebab-case>", "description: <one line>", then "---", then the body.
- Keep every still-valid section of the CURRENT skill and integrate ALL listed suggestions into real, substantive improvements.
- Write the genuinely best improved skill you can. You are NOT shown any grading rubric, scoring checklist, or anchor list, and you must NOT invent or try to satisfy one — the evaluation is separate and hidden from you.
- Do NOT adopt, install, or overwrite any file. Return only the SKILL.md text.`

// Independent DRAFT REVIEWER. The reviewer MAY see the rubric (it is the judge),
// unlike the DRAFT AUTHOR above which must never see it. This keeps the draft
// honest (authored blind) while still letting a rubric-aware judge gate quality
// before the draft is landed (user m06631/m06634 fairness requirement).
const DRAFT_REVIEW_SYSTEM = `You are an independent DRAFT REVIEWER for DSH skill evolution.
You are given an improved SKILL.md draft, the improvement suggestions it must satisfy, and the grading rubric (cases).
Return ONLY a single JSON object (no prose, no markdown fences) with this exact shape:
{"ok":true,"issues":[]}  or  {"ok":false,"issues":["<specific, actionable fix>"]}
Flag a real defect ONLY when the draft:
- misses valid YAML frontmatter (first line ---, name + description, closing ---), or
- is oversized (the final SKILL.md file would exceed the host 65536-byte cap -- reject and tell the author to cut scope), or
- fails to genuinely and substantively integrate one or more listed suggestions, or
- has empty / truncated / placeholder content or broken sections, or
- would not actually work as a DSH skill.
Do NOT flag stylistic nitpicks or require rubric anchor strings to appear verbatim. Return only the JSON object.`


// Tolerant single-JSON-object extractor (mirrors extractChecksJson but for an
// object). Braces inside JSON strings are ignored via the in-string state.
function extractJsonObject(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  let s = text.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          const o = JSON.parse(s.slice(start, i + 1))
          if (o && typeof o === 'object' && !Array.isArray(o)) return o
        } catch { /* keep scanning */ }
      }
    }
  }
  return null
}

// Force a stable, fully-identified rubric in CODE (never trust raw LLM ids).
function normalizeArtifacts(raw) {
  const cases = (Array.isArray(raw?.cases) ? raw.cases : []).map((c, ci) => ({
    id: String((c && c.id) || `case-${ci + 1}`),
    title: String((c && c.title) || `improvement-${ci + 1}`),
    checks: (Array.isArray(c && c.checks) ? c.checks : []).map((k, ki) => ({
      id: String((k && k.id) || `c${ci + 1}k${ki + 1}`),
      text: String((k && k.text) || ''),
      must: !!(k && k.must === true),
      anchors: Array.isArray(k && k.anchors) ? k.anchors.map((a) => String(a)) : [],
    })),
  }))
  return { cases, draftContent: String(raw?.draftContent ?? '') }
}

function validateArtifacts(a) {
  if (!a.draftContent.trim()) return 'draftContent is empty'
  if (!a.cases.length) return 'cases[] is empty'
  const total = a.cases.reduce((n, c) => n + c.checks.length, 0)
  if (total < 6) return `only ${total} checks (need >= 6 for granularityOk)`
  try { validateSkillFrontmatter(a.draftContent) } catch (e) { return `invalid draft frontmatter: ${String(e && e.message || e)}` }
  return null
}

// v1.18.0 (A1): the single stream that emitted the whole rubric + full SKILL.md
// as one JSON object was being cut off by some upstream models (finish reason
// 'aborted'). Split it into TWO short streams, each with its own timeout:
//   call 1 -> small {"cases":[...]} rubric object
//   call 2 -> the improved SKILL.md text only (no JSON wrapper)
// Use String.fromCharCode(10) for newlines so this block is immune to the
// classic double-backslash escaping bug when spliced into index.js.
const NL = String.fromCharCode(10)
function stripDraftFence(text) {
  let s = String(text ?? '').trim()
  if (!s.startsWith('```')) return s
  const nl = s.indexOf(NL)
  if (nl < 0) return s
  let inner = s.slice(nl + 1)
  const close = inner.lastIndexOf('```')
  if (close >= 0) inner = inner.slice(0, close)
  return inner.trim()
}
// v1.18.1: real models often emit the improved SKILL.md with a frontmatter block
// that has NO closing delimiter (or is otherwise malformed). Instead of trusting
// the model's frontmatter, we keep only the BODY it wrote and re-synthesize a
// guaranteed-valid frontmatter in code.
export function parseFrontmatterLoose(text) {
  const s = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (!s) return { name: undefined, description: undefined, body: '', wellFormed: false }
  if (!s.startsWith('---')) return { name: undefined, description: undefined, body: s, wellFormed: false }
  const lines = s.split('\n')
  let closeIdx = -1
  for (let j = 1; j < lines.length; j++) {
    if (lines[j].replace(/\r$/, '') === '---') { closeIdx = j; break }
  }
  if (closeIdx !== -1) {
    let name, description
    for (let j = 1; j < closeIdx; j++) {
      const m = lines[j].match(/^(name|description)\s*:\s*(.*)$/)
      if (m) { if (m[1] === 'name') name = m[2].trim().replace(/^"'|"$/g, ''); else description = m[2].trim().replace(/^"'|"$/g, '') }
    }
    const body = lines.slice(closeIdx + 1).join('\n').trim()
    return { name, description, body, wellFormed: true }
  }
  // No closing delimiter: drop the opening one plus consecutive key:value lines.
  let i = 1
  while (i < lines.length) {
    const l = lines[i]
    if (l.trim() === '') { i++; continue }
    if (/^[A-Za-z0-9_-]+\s*:/.test(l)) { i++; continue }
    break
  }
  let name2, description2
  for (let j = 1; j < i; j++) {
    const m = lines[j].match(/^(name|description)\s*:\s*(.*)$/)
    if (m) { if (m[1] === 'name') name2 = m[2].trim().replace(/^"'|"$/g, ''); else description2 = m[2].trim().replace(/^"'|"$/g, '') }
  }
  return { name: name2, description: description2, body: lines.slice(i).join('\n').trim(), wellFormed: false }
}

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// YAML-safe double-quoted scalar: escape backslashes and double quotes so a
// description carrying colons / quotes can never break parseYaml.
function yamlSafe(v) {
  return '"' + String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ') + '"'
}
export function repairDraftFrontmatter(text, currentBody, skillName) {
  const parsed = parseFrontmatterLoose(text)
  const live = parseFrontmatterLoose(currentBody)
  const name = (skillName && KEBAB_RE.test(skillName)) ? skillName : (live.name && KEBAB_RE.test(live.name) ? live.name : (parsed.name && KEBAB_RE.test(parsed.name) ? parsed.name : 'improved-skill'))
  const description = parsed.description || live.description || 'Improved skill draft.'
  const body = parsed.body || '(No body produced by the model.)'
  return ['---', 'name: ' + yamlSafe(name), 'description: ' + yamlSafe(description), '---', '', body].join('\n') + '\n'
}

// Per-segment retry budget (v2.0.0): every LLM/landing segment gets up to this many
// attempts. A segment that exhausts its budget is marked failed; the whole skill
// chain stops there but the job continues for other skills (m06761).
const MAX_STEP_ATTEMPTS = 3

function buildSuggestionBlock(suggestions) {
  return JSON.stringify(
    suggestions.map((s) => ({ id: s.id, title: s.title, summary: s.summary, rationale: s.rationale, guidance: s.guidance })),
    null, 2,
  )
}

// RUBRIC AUTHOR (v2.0.0). Produces ONLY the hidden grading cases as a small
// {"cases":[...]} JSON object. It NEVER produces the improved body. This is the
// half of the old generateArtifacts call 1, kept on its own so it can run
// CONCURRENTLY with writeDraft and so neither side can see the other's output.
async function authorRubric(skill, suggestions, action, currentBody, model, repairHint) {
  const repair = repairHint ? `${NL}REPAIR: your previous rubric was rejected because: ${repairHint}. Return corrected rubric only.` : ''
  const user = [
    `Skill: ${skill}`,
    `Action: ${action}`,
    'Open suggestions to satisfy (integrate ALL of them):',
    buildSuggestionBlock(suggestions),
    '',
    'CURRENT live SKILL.md (preserve still-valid content):',
    '<<<SKILL', String(currentBody ?? ''), 'SKILL>>>',
    repair,
    '',
    'Return the rubric JSON object now.',
  ].join(NL)
  const signal = AbortSignal.timeout(CFG.draftTimeoutMs)
  const rubricText = await streamAssistantText(SVC.llm, model, { system: RUBRIC_SYSTEM, user, signal })
  const obj = extractJsonObject(rubricText)
  if (!obj || !Array.isArray(obj.cases)) {
    throw new Error('LLM (rubric call) did not return a parseable {"cases":[...]} object')
  }
  return normalizeArtifacts({ cases: obj.cases, draftContent: '' }).cases
}

// DRAFT AUTHOR (v2.0.0). Writes ONLY the improved SKILL.md text. CRITICAL
// FAIRNESS: this call NEVER receives the rubric cases/anchors -- the draft is
// authored blind to the grading checklist so it cannot pander to it (user
// m06631/m06634). The only cross-talk allowed is a repairHint carried over from
// the independent REVIEWER (not the rubric itself).
async function writeDraft(skill, suggestions, action, currentBody, model, repairHint) {
  const repair = repairHint ? `${NL}REPAIR: an independent reviewer rejected your previous draft because: ${repairHint}. Rewrite the full SKILL.md fixing exactly those points.` : ''
  const user = [
    `Skill: ${skill}`,
    `Action: ${action}`,
    'Open suggestions to satisfy (integrate ALL of them):',
    buildSuggestionBlock(suggestions),
    '',
    'CURRENT live SKILL.md (preserve still-valid content):',
    '<<<SKILL', String(currentBody ?? ''), 'SKILL>>>',
    repair,
    '',
    'Return ONLY the full improved SKILL.md text now.',
  ].join(NL)
  const signal = AbortSignal.timeout(CFG.draftTimeoutMs)
  const draftText = await streamAssistantText(SVC.llm, model, { system: DRAFT_SYSTEM, user, signal })
  const stripped = stripDraftFence(draftText)
  if (!stripped.trim()) throw new Error('LLM (draft call) returned empty SKILL.md text')
  // Never trust the model's frontmatter: re-synthesize a valid block in code.
  return repairDraftFrontmatter(stripped, currentBody, skill)
}

// INDEPENDENT DRAFT REVIEWER (v2.0.0). Unlike the DRAFT AUTHOR above, the
// reviewer MAY see the rubric -- it is the judge, and a judge that cannot see
// the rubric would be useless. It reviews the in-memory draft BEFORE landing and
// returns { ok, issues[] }. A failed parse or LLM error is treated as ok=true
// (a broken reviewer must never block landing) but the reason is surfaced in
// detail so the panel shows the review ran degraded.
async function reviewDraftInMemory(skill, draftContent, cases, suggestions, model) {
  // v2.0.2 SIZE GATE (m07170 + m07205): the reviewer never checked size, so an
  // oversized draft (e.g. 70860 B > the host 65536 B cap) sailed through landing
  // and only failed the post-landing verify -- too late, the chain could only
  // crash. The user is explicit: this must be caught DURING authoring, inside the
  // write -> review -> rewrite loop, and the fix is to COMPRESS (keep improving,
  // just shorter) -- NOT to crash the chain at verify. Reject it HERE so the loop
  // re-drafts with an explicit compress instruction. Checked before the LLM call:
  // a size failure is deterministic and needs no model. The returned issue becomes
  // the repairHint fed to the next writeDraft, so the author is told to shrink.
  const reviewBytes = Buffer.byteLength(String(draftContent ?? ''), 'utf8')
  if (reviewBytes > 65536) {
    return {
      ok: false,
      issues: ['OVERSIZE: the draft is ' + reviewBytes + ' bytes, over the host 65536-byte cap. COMPRESS the SKILL.md to under 64KB -- keep every real improvement but cut verbosity, drop repetition, tighten prose and long code blocks. Do not just trim a few lines; produce a substantially shorter, still-complete skill.'],
    }
  }
  const user = [
    `Skill: ${skill}`,
    'IMPROVEMENT SUGGESTIONS the draft must satisfy:',
    buildSuggestionBlock(suggestions),
    '',
    'GRADING RUBRIC (cases) the draft will be scored against:',
    JSON.stringify(cases, null, 2),
    '',
    'IMPROVED SKILL.md DRAFT to review:',
    '<<<DRAFT', String(draftContent ?? ''), 'DRAFT>>>',
    '',
    'Return the review JSON object now.',
  ].join(NL)
  try {
    const signal = AbortSignal.timeout(CFG.draftTimeoutMs)
    const reviewText = await streamAssistantText(SVC.llm, model, { system: DRAFT_REVIEW_SYSTEM, user, signal })
    const obj = extractJsonObject(reviewText)
    if (!obj || typeof obj.ok !== 'boolean') {
      return { ok: true, issues: [], degraded: 'reviewer returned unparseable JSON (treated as pass)' }
    }
    const issues = Array.isArray(obj.issues) ? obj.issues.map((i) => String(i)).slice(0, 5) : []
    return { ok: obj.ok || issues.length === 0, issues }
  } catch (e) {
    return { ok: true, issues: [], degraded: String((e && e.message) || e) }
  }
}


// ONE logical worker per skill. Frozen BEFORE is graded exactly once (scoreImpl)
// and passed unchanged to writeImpl AND backtestImpl (no re-freeze). Retry (once)
// only regenerates invalid artifacts, BEFORE any draft is committed, so the
// writeImpl "already has draftId" guard is never hit.

// Per-skill step progress, surfaced to the panel through GET /jobs. publicJob
// keeps `progress` in `...rest`, so no serialization change is needed.
// A step is { status:'pending'|'active'|'done'|'failed', at, detail }.
// v2.0.0 segment order. rubric (author the hidden grading cases) and draft
// (write the improved body) run CONCURRENTLY and neither sees the other's output
// (fairness). score freezes the before baseline from the rubric. The draft segment
// internally runs write -> review -> rewrite (max 3) fully BEFORE landing, so a
// reviewed, rubric-aware-judged draft is what gets landed. verify (incl. size + all
// historical checks) is the final self-audit AFTER landing.
const STEP_ORDER = ['dispatch', 'rubric', 'score', 'draft', 'landing', 'backtest', 'verify']
function setStep(job, skill, step, status, detail) {
  if (!job || !skill) return
  if (!job.progress) job.progress = {}
  const p = job.progress[skill] || (job.progress[skill] = { skill, status: 'queued', current: 'queued', steps: {}, error: null })
  p.current = step
  if (status === 'active') p.status = 'running'
  else if (status === 'failed') { p.status = 'failed'; p.error = String(detail || '') }
  const prev = p.steps[step] || {}
  // startAt: for 'active' it's now; for a terminal status inherit the step's own
  // startAt ONLY if it ever went active. A step that jumps straight to done/failed
  // (e.g. repairing "not needed", or a batch fallback) must NOT inherit the prior
  // step's startAt — that made the time axis show the previous stage's duration
  // again (m06022: "stuck on stage 1 then suddenly completes"). Give it its own
  // timestamp so its duration reads 0.0s (accurate for instant code steps).
  const nowIso = new Date().toISOString()
  p.steps[step] = { status, at: nowIso, startAt: status === 'active' ? nowIso : (prev.startAt || nowIso), detail: String(detail || '') }
}

// One logical worker per skill. It authors cases[] + draftContent via the host
// llm (the LLM's ONLY job), then the CODE executes the deterministic pipeline:
// scoreImpl (freeze before) -> writeImpl (land) -> verifyImpl (self-audit) ->
// backtestImpl (score after). The frozen `before` is cached by casesHash and
// passed unchanged to writeImpl AND backtestImpl (no re-freeze). Retry (once)
// only regenerates invalid artifacts, BEFORE any draft is committed.
// A+ (m07044): re-land a draft that failed its post-landing ledger self-audit.
// Re-running writeImpl verbatim is refused (writeImpl throws when the suggestion
// already has a draftId), so clear the stale draft + suggestion.draftId first, then
// write a FRESH draft with the SAME reviewed content, SAME cases and SAME frozen
// baseline (no re-score, no re-review). writeImpl unshifts the fresh before/after run
// pair to the FRONT of evals.runs, so it survives the host keep-20 prune that made the
// first landing's runs vanish between landing and verify. Deterministic failures
// (sizeOk / granularityOk / score self-consistency) re-fail identically -- that is
// honest; the caller's budget bounds the retries.
async function relandForVerify({ skill, suggestionId, action, draftContent, cases, frozen, model }) {
  const ledger = readJson(CFG.ledgerPath)
  const sug = (ledger.suggestions || []).find((s) => s.id === suggestionId)
  const staleIds = new Set()
  if (sug && sug.draftId) staleIds.add(sug.draftId)
  for (const d of ledger.drafts || []) if (d.suggestionId === suggestionId) staleIds.add(d.id)
  if (staleIds.size) {
    ledger.drafts = (ledger.drafts || []).filter((d) => !staleIds.has(d.id))
    if (sug) delete sug.draftId
    writeJsonAtomic(CFG.ledgerPath, ledger)
  }
  return writeImpl({ skillName: skill, suggestionId, action, draftContent, cases, before: frozen, model })
}

async function runSkillWorker(skill, llmModel, stats, beforeCache, job) {
  // worker picked this skill up -> close its dispatch (queue-wait) segment
  setStep(job, skill, 'dispatch', 'done', 'worker picked up')
  const suggestions = openSuggestionsForSkill(skill)
  if (!suggestions.length) {
    setStep(job, skill, 'rubric', 'done', 'no open suggestions — skipped')
    return { skill, status: 'skipped', reason: 'no open suggestions' }
  }
  const hasLive = fs.existsSync(CFG.skillFile(skill))
  const action = hasLive ? 'update' : 'create'
  const currentBody = readBody(CFG.skillFile(skill)) ?? ''

  // ---- RUBRIC + DRAFT-AUTHORING run CONCURRENTLY (fairness) ----
  // authorRubric produces ONLY the cases; the draft half starts from the SAME
  // suggestions but NEVER sees the cases. Neither call can influence the other,
  // so scoring the current live file against the rubric is not distorted by the
  // improved body (user m06631/m06634).
  let rubricCases = null, rubricErr = null, rubricAttempts = 0
  let draftContent = null, draftErr = null, draftAuthorAttempts = 0
  setStep(job, skill, 'rubric', 'active', 'LLM authors the hidden grading cases[]')
  setStep(job, skill, 'draft', 'active', 'LLM writes the improved SKILL.md')
  const rubricTask = (async () => {
    let last = null
    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
      rubricAttempts = attempt
      try { return await authorRubric(skill, suggestions, action, currentBody, llmModel, last) }
      catch (e) { last = String((e && e.message) || e) }
      setStep(job, skill, 'rubric', 'active', `rubric rejected, retrying (attempt ${attempt}/${MAX_STEP_ATTEMPTS}): ${last}`)
    }
    throw new Error(last || 'rubric generation failed')
  })()
  const draftTask = (async () => {
    let last = null
    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
      draftAuthorAttempts = attempt
      try { return await writeDraft(skill, suggestions, action, currentBody, llmModel, last) }
      catch (e) { last = String((e && e.message) || e) }
      setStep(job, skill, 'draft', 'active', `draft authoring failed, retrying (attempt ${attempt}/${MAX_STEP_ATTEMPTS}): ${last}`)
    }
    throw new Error(last || 'draft authoring failed')
  })()
  const settled = await Promise.allSettled([rubricTask, draftTask])
  if (settled[0].status === 'fulfilled') rubricCases = settled[0].value
  else rubricErr = String((settled[0].reason && settled[0].reason.message) || settled[0].reason)
  if (settled[1].status === 'fulfilled') draftContent = settled[1].value
  else draftErr = String((settled[1].reason && settled[1].reason.message) || settled[1].reason)
  if (rubricErr) {
    setStep(job, skill, 'rubric', 'failed', `rubric generation failed after ${rubricAttempts} attempts: ${rubricErr}`)
    return { skill, status: 'failed', reason: `rubric generation failed: ${rubricErr}`, attempts: rubricAttempts, suggestionIds: suggestions.map((s) => s.id) }
  }
  setStep(job, skill, 'rubric', 'done', `cases ready (${(rubricCases || []).length})${rubricAttempts > 1 ? ` · retried ${rubricAttempts - 1}x` : ''}`)
  if (draftErr) {
    // Rubric is still reusable, but without a body there is nothing to land. Report
    // failure honestly; beforeCache keeps the frozen baseline for a later retry.
    setStep(job, skill, 'draft', 'failed', `draft authoring failed after ${draftAuthorAttempts} attempts: ${draftErr}`)
    return { skill, status: 'failed', reason: `draft authoring failed: ${draftErr}`, attempts: draftAuthorAttempts, suggestionIds: suggestions.map((s) => s.id) }
  }

  // ---- SCORE: freeze the before baseline from the rubric (BEFORE any landing) ----
  const cases = rubricCases
  const key = skill + '|' + casesHash(cases)
  let frozen = beforeCache.get(key)
  const reuseHit = Boolean(frozen)
  setStep(job, skill, 'score', 'active', 'freezing before baseline (skill_evolution_score)')
  if (!frozen) {
    stats.scoreCalls++
    let scoreErr = null
    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
      try { frozen = await scoreImpl({ skillName: skill, cases, model: llmModel }); scoreErr = null; break }
      catch (e) { scoreErr = String((e && e.message) || e) }
    }
    if (!frozen) {
      setStep(job, skill, 'score', 'failed', `scoring failed after ${MAX_STEP_ATTEMPTS} attempts: ${scoreErr}`)
      return { skill, status: 'failed', reason: `scoring failed: ${scoreErr}`, attempts: MAX_STEP_ATTEMPTS, suggestionIds: suggestions.map((s) => s.id) }
    }
    beforeCache.set(key, frozen)
  } else stats.beforeCacheHits++
  setStep(job, skill, 'score', 'done', (reuseHit ? 'before cache hit / reused' : 'before frozen') + (frozen && frozen.baseline && frozen.baseline.engine ? ' [' + frozen.baseline.engine + ']' : ''))
  // Expose the frozen baseline score NOW so the panel shows "before -> (pending)".
  if (frozen && frozen.baseline && Number.isFinite(frozen.baseline.score)) {
    const pNow = job.progress && job.progress[skill]
    if (pNow) pNow.beforeScore = frozen.baseline.score
  }

  // ---- DRAFT: independent review -> rewrite loop, fully BEFORE landing ----
  // The reviewer (not the author) may see the rubric. Up to MAX_STEP_ATTEMPTS
  // total drafts; each rejected draft is rewritten with the reviewer's issues as
  // the repair hint (never the raw rubric). Exhausting the budget fails the skill.
  let review = await reviewDraftInMemory(skill, draftContent, cases, suggestions, llmModel)
  let draftTotalAttempts = draftAuthorAttempts
  if (!review.ok) setStep(job, skill, 'draft', 'active', `reviewer rejected draft (1/${MAX_STEP_ATTEMPTS}): ${(review.issues || []).slice(0, 2).join('; ')}`)
  while (!review.ok && draftTotalAttempts < MAX_STEP_ATTEMPTS) {
    draftTotalAttempts++
    try {
      draftContent = await writeDraft(skill, suggestions, action, currentBody, llmModel, (review.issues || []).join(' | '))
    } catch (e) {
      setStep(job, skill, 'draft', 'failed', `rewrite failed (attempt ${draftTotalAttempts}/${MAX_STEP_ATTEMPTS}): ${String((e && e.message) || e)}`)
      return { skill, status: 'failed', reason: `draft rewrite failed: ${String((e && e.message) || e)}`, attempts: draftTotalAttempts, suggestionIds: suggestions.map((s) => s.id) }
    }
    review = await reviewDraftInMemory(skill, draftContent, cases, suggestions, llmModel)
    if (!review.ok && draftTotalAttempts < MAX_STEP_ATTEMPTS) {
      setStep(job, skill, 'draft', 'active', `reviewer rejected rewrite ${draftTotalAttempts}/${MAX_STEP_ATTEMPTS}: ${(review.issues || []).slice(0, 2).join('; ')}`)
    }
  }
  if (!review.ok) {
    setStep(job, skill, 'draft', 'failed', `draft failed review after ${draftTotalAttempts}/${MAX_STEP_ATTEMPTS} attempts: ${(review.issues || []).slice(0, 2).join('; ')}`)
    return { skill, status: 'failed', reason: 'draft failed review', attempts: draftTotalAttempts, reviewIssues: review.issues, suggestionIds: suggestions.map((s) => s.id) }
  }
  setStep(job, skill, 'draft', 'done', `draft passed review (attempt ${draftTotalAttempts}/${MAX_STEP_ATTEMPTS})${draftTotalAttempts > 1 ? ` · retried ${draftTotalAttempts - 1}x` : ''}`)

  // ---- LANDING: one draft per open suggestion, retried, under the write lock ----
  const draftIds = []
  const draftSugMap = {}
  let lastError = null
  let landingAttempts = 0
  setStep(job, skill, 'landing', 'active', `writing ${suggestions.length} ready draft(s) (skill_evolution_write)`)
  for (const s of suggestions) {
    let landed = null
    let sErr = null
    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
      landingAttempts++
      try {
        landed = await withWriteLock(() => writeImpl({
          skillName: skill, suggestionId: s.id, action, draftContent, cases, before: frozen, model: llmModel,
          notes: `code-state-machine v2.0.0 (draft attempt ${draftTotalAttempts}, ${suggestions.length} suggestion(s))`,
        }))
        sErr = null
        break
      } catch (e) { sErr = String((e && e.message) || e) }
    }
    if (landed) { stats.writeCalls++; stats.beforeReused++; draftIds.push(landed.draftId); draftSugMap[landed.draftId] = s.id }
    else lastError = sErr
  }
  if (!draftIds.length) {
    setStep(job, skill, 'landing', 'failed', `landing failed after ${landingAttempts} attempt(s): ${lastError}`)
    return { skill, status: 'failed', reason: `landing failed: ${lastError}`, attempts: landingAttempts, suggestionIds: suggestions.map((s) => s.id) }
  }
  setStep(job, skill, 'landing', 'done', `${draftIds.length} draft(s) landed${landingAttempts > draftIds.length ? ` · retried ${landingAttempts - draftIds.length}x` : ''}`)

  // ---- BACKTEST: score the after result once per skill (diagnostic) ----
  let bt = null
  let btError = null
  setStep(job, skill, 'backtest', 'active', 'scoring the after result (skill_evolution_backtest)')
  try {
    bt = await backtestImpl({ skillName: skill, draftContent, cases, before: frozen, model: llmModel })
    stats.backtestCalls++; stats.beforeReused++
  } catch (e) {
    // backtest is diagnostic; record, do not fail the worker. Never swallow
    // silently — surface WHY there is no after score (m02504).
    btError = String((e && e.message) || e)
  }
  if (bt) {
    setStep(job, skill, 'backtest', 'done', `after=${bt.after?.score} delta=${bt.delta}${bt.beforeFallback ? ' ⚠before recomputed (baseline drifted)' : ''}${bt.after?.engine ? ' [' + bt.after.engine + ']' : ''}`)
  } else {
    // v2.0.2 (m07140 Q3): a failed backtest must NOT read as a green 'done'
    // segment. Mark THIS segment failed (red X) so the panel is honest, but do NOT
    // flip the whole skill to failed -- landing + verify already succeeded and
    // backtest is diagnostic. Write the step directly so setStep's 'failed' branch
    // (which sets p.status='failed') is bypassed.
    const nowIso = new Date().toISOString()
    const pB = job.progress && job.progress[skill]
    if (pB) pB.steps.backtest = { status: 'failed', at: nowIso, startAt: (pB.steps.backtest && pB.steps.backtest.startAt) || nowIso, detail: `backtest failed: ${btError}` }
  }
  if (bt && bt.after && Number.isFinite(bt.after.score)) {
    const pNow2 = job.progress && job.progress[skill]
    if (pNow2) { pNow2.afterScore = bt.after.score; pNow2.delta = bt.delta }
  }

  // ---- VERIFY: FINAL self-audit of every landed draft (size + all history) ----
  const verify = []
  let verifyRetries = 0
  setStep(job, skill, 'verify', 'active', `self-verifying ${draftIds.length} draft(s) (skill_evolution_verify)`)
  const verifyOne = (draftId) => {
    const v = verifyImpl({ draftId })
    stats.verifyCalls++
    const r = (v.results && v.results[0]) || {}
    return { draftId, allOk: v.allOk, granularityOk: !!(r.checks && r.checks.granularityOk), sizeOk: !!(r.checks && r.checks.sizeOk) }
  }
  for (const draftId of draftIds) verify.push(verifyOne(draftId))
  // A+ (m07044): a failed ledger self-audit (e.g. its run pair was pruned by the host
  // keep-20 between landing and verify) is re-landed with the SAME reviewed content +
  // frozen before (no re-score / no re-review) up to MAX_STEP_ATTEMPTS, then
  // re-verified. Deterministic content failures re-fail identically and stop at budget.
  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS && verify.some((v) => !v.allOk); attempt++) {
    const failed = verify.filter((v) => !v.allOk)
    let relanded = 0
    for (const f of failed) {
      const suggestionId = draftSugMap[f.draftId]
      if (!suggestionId) continue
      setStep(job, skill, 'verify', 'active', `verify failed, re-landing ${String(f.draftId).slice(0, 8)} (attempt ${attempt}/${MAX_STEP_ATTEMPTS})`)
      try {
        const again = await withWriteLock(() => relandForVerify({ skill, suggestionId, action, draftContent, cases, frozen, model: llmModel }))
        if (again && again.draftId) {
          draftSugMap[again.draftId] = suggestionId
          const res = verifyOne(again.draftId)
          const idx = verify.indexOf(f)
          if (idx >= 0) verify[idx] = res
          relanded++
        }
      } catch (e) { /* re-land refused; keep the original failure honestly */ }
    }
    verifyRetries += relanded
  }
  setStep(job, skill, 'verify', 'done', (verify.every((v) => v.allOk) ? 'allOk' : 'some verify checks failed') + (verifyRetries > 0 ? ` · re-landed ${verifyRetries}x` : ''))
  const beforeScore = frozen?.baseline?.score
  const afterScore = bt ? bt.after?.score : undefined
  return {
    skill, status: 'ok', action, attempts: draftTotalAttempts,
    suggestionIds: suggestions.map((s) => s.id),
    draftIds,
    beforeScore, afterScore, delta: bt ? bt.delta : undefined,
    beforeReused: bt ? bt.beforeReused : false,
    beforeFallback: bt ? bt.beforeFallback : null,
    backtestError: btError,
    verifyAllOk: verify.every((v) => v.allOk),
    verifyRetries,
    granularityOk: verify.every((v) => v.granularityOk),
    scoreOk: afterScore === undefined ? true : Number(afterScore) + 1e-9 >= Number(beforeScore),
    reviewOk: review.ok,
    verify,
  }
}

// Deterministic state machine: HARD-bounded worker pool, as-it-arrives refill,
// final independent per-draftId verify, and a CODE-generated report.
async function runStateMachine(queue, model, maxConcurrency, job) {
  const llmModel = model || CFG.model
  const stats = {
    workerCount: queue.length, agentCreates: 0, scoreCalls: 0, beforeCacheHits: 0,
    beforeReused: 0, writeCalls: 0, verifyCalls: 0, backtestCalls: 0,
    finalVerifyCalls: 0, active: 0, peak: 0,
  }
  const beforeCache = new Map()
  const results = []
  let cursor = 0
  job.phase = 'running'
  // Every queued skill gets a progress row immediately, even before its worker
  // starts (skipped skills still get a terminal row at wrap-up).
  if (!job.progress) job.progress = {}
  for (const s of queue) {
    if (!job.progress[s]) job.progress[s] = { skill: s, status: 'queued', current: 'queued', steps: {}, error: null }
    // dispatch segment = skill queued -> its worker picks it up. Start the
    // clock at job.startedAt (the evolve route's accept time), NOT now — the
    // route already spent real time building this queue before the state
    // machine began pumping, and that wait belongs to dispatch (m06336).
    setStep(job, s, 'dispatch', 'active', 'queued — waiting for a worker slot')
    if (job.startedAt) job.progress[s].steps.dispatch.startAt = job.startedAt
  }
  await new Promise((resolve) => {
    const pump = () => {
      if (job.cancelRequested) {
        // USER CANCEL: mark every skill that never started as canceled and stop
        // dispatching new workers. In-flight workers are allowed to finish so a
        // half-written draft is never left dangling.
        while (cursor < queue.length) {
          const skill = queue[cursor++]
          results.push({ skill, status: 'canceled', reason: 'canceled by user' })
        }
      }
      if (cursor >= queue.length && stats.active === 0) { resolve(); return }
      if (job.cancelRequested) return // do not dispatch new; drain active then resolve
      while (stats.active < maxConcurrency && cursor < queue.length) {
        const skill = queue[cursor++]
        stats.active++
        stats.peak = Math.max(stats.peak, stats.active)
        runSkillWorker(skill, llmModel, stats, beforeCache, job)
          .then((r) => { results.push(r) })
          .catch((e) => { results.push({ skill, status: 'failed', reason: String((e && e.message) || e) }) })
          .finally(() => { stats.active--; pump() }) // PROCESS AS IT ARRIVES: refill the freed slot FIRST
      }
    }
    pump()
  })
  // Final independent re-read across the whole batch, keyed by every draftId.
  // Kept as a safety net, but no longer a standalone `auditing` segment: a
  // batch-level discrepancy folds into the per-skill `verifying` step.
  job.phase = 'verifying'
  const finalAudit = []
  for (const r of results) {
    if (r.status !== 'ok' || !Array.isArray(r.draftIds)) continue
    for (const draftId of r.draftIds) {
      try {
        const v = verifyImpl({ draftId })
        stats.finalVerifyCalls++
        finalAudit.push({ draftId, skill: r.skill, allOk: v.allOk })
        if (!v.allOk) setStep(job, r.skill, 'verify', 'failed', `final audit mismatch: draft ${draftId}`)
      } catch (e) {
        finalAudit.push({ draftId, skill: r.skill, allOk: false, error: String((e && e.message) || e) })
        setStep(job, r.skill, 'verify', 'failed', `final audit error: ${draftId}`)
      }
    }
  }
  // Finalize per-skill progress so the panel's inline rows reach a terminal,
  // fully-populated state (every one of STEP_ORDER marked done/failed).
  for (const r of results) {
    const p = job.progress && job.progress[r.skill]
    if (!p) continue
    if (r.status === 'ok') {
      for (const k of STEP_ORDER) {
        if (!p.steps[k]) p.steps[k] = { status: 'done', at: new Date().toISOString(), startAt: undefined, detail: '' }
        else if (p.steps[k].status === 'failed') { /* v2.0.2 (m07140 Q3): keep the honest failure -- do NOT paint a green check over a failed segment (e.g. a diagnostic backtest that errored). */ }
        else if (p.steps[k].status !== 'done') p.steps[k] = { status: 'done', at: new Date().toISOString(), startAt: p.steps[k]?.startAt, detail: p.steps[k]?.detail || '' }
      }
      p.status = 'done'; p.current = 'done'
    } else {
      p.status = r.status === 'skipped' ? 'skipped' : r.status === 'canceled' ? 'canceled' : 'failed'
      p.current = r.status
      p.error = r.reason || null
      for (const k of STEP_ORDER) {
        if (!p.steps[k] || p.steps[k].status === 'active' || p.steps[k].status === 'pending') {
          p.steps[k] = { status: r.status === 'skipped' ? 'done' : 'failed', at: new Date().toISOString(), startAt: p.steps[k]?.startAt, detail: r.reason || '' }
        }
      }
    }
  }
  const okCount = results.filter((r) => r.status === 'ok').length
  const report = {
    orchestrator: 'code-state-machine',
    evolutionMode: 'new',
    maxConcurrency,
    workerCount: stats.workerCount,
    agentCreates: stats.agentCreates, // ALWAYS 0: this driver spawns no agents
    peakConcurrency: stats.peak,
    scoreCalls: stats.scoreCalls,
    beforeCacheHits: stats.beforeCacheHits,
    beforeReused: stats.beforeReused,
    writeCalls: stats.writeCalls,
    verifyCalls: stats.verifyCalls,
    backtestCalls: stats.backtestCalls,
    finalVerifyCalls: stats.finalVerifyCalls,
    landed: okCount,
    failed: results.length - okCount,
    nameMatchesReality: true, // the report is emitted by the code that made the calls
    results,
    finalAudit,
  }
  job.report = report
  job.review = {
    ok: okCount === queue.length,
    allOk: finalAudit.every((a) => a.allOk),
    scoreOk: results.every((r) => r.status !== 'ok' || r.scoreOk),
    reason: `${okCount}/${queue.length} landed`,
  }
  job.status = job.cancelRequested ? 'canceled' : 'completed'
  job.phase = job.cancelRequested ? 'canceled' : 'done'
  job.finishedAt = new Date().toISOString()
  return report
}

// Mirror spawnMainAgent's job bookkeeping, but for the code state machine.
function spawnStateMachine(queue, model, maxConcurrency, acceptedAt) {
  const job = {
    jobId: randomUUID(),
    skill: queue.join(', '),
    skillCount: queue.length,
    sessionId: null,
    model: model || null,
    maxConcurrency,
    // startedAt = the moment the evolve route accepted the request (NOT when
    // the state machine starts pumping workers). The route spends real time
    // building the queue before spawnStateMachine runs; attributing that to
    // the per-skill dispatch segment requires starting the clock at accept.
    startedAt: acceptedAt || new Date().toISOString(),
    phase: 'queued',
    status: 'running',
    attempts: 1,
    reviewed: false,
    error: null,
    orchestrator: 'code-state-machine',
    progress: {},
  }
  RUNNING.set(job.jobId, job)
  job.done = runStateMachine(queue, model, maxConcurrency, job).catch((e) => {
    job.status = 'failed'
    job.phase = 'failed'
    job.error = String((e && e.message) || e)
    for (const s of queue) {
      const p = job.progress && job.progress[s]
      if (p && p.status !== 'done') { p.status = 'failed'; p.error = job.error }
    }
  })
  return job
}

// LEGACY (v1.15 and earlier) LLM main-agent orchestrator prompt, kept for
// explicit evolutionMode='legacy'. One 'standard' main agent opens up to
// maxConcurrency subagents, each running buildEvolvePrompt's full pipeline.
function buildMainAgentPrompt(skills, maxConcurrency, _evolutionMode) {
  const parts = []
  parts.push('You are the ORCHESTRATOR for evolving DSH skills (LEGACY mode). You drive evolution by spawning SUBAGENTS — you never edit skill files yourself and you never grade yourself.')
  parts.push('CONCURRENCY: keep at most ' + maxConcurrency + ' subagents running at the same time; batch the rest. NEVER exceed ' + maxConcurrency + ' concurrent subagents.')
  parts.push('')
  parts.push('For EACH skill listed below, spawn a subagent (subagent tool) and give it EXACTLY that skill subagent prompt. Each subagent runs the FULL pipeline on its own (skill_evolution_scan → draft → backtest → write, including its own grading) and returns after landing a status=ready draft.')
  parts.push('After a subagent finishes, REVIEW: call skill_evolution_verify with the draftId it landed. If not allOk, or granularityOk=false, spawn ONE retry subagent for that skill. Retry at most once.')
  parts.push('')
  parts.push('FALLBACK (IMPORTANT): if you find you CANNOT spawn subagents in this environment, DO NOT stall or report failure. Fall back to doing the evolution YOURSELF, one skill at a time, following the per-skill procedure directly. Never adopt, install, or overwrite the live SKILL.md even when working solo.')
  parts.push('Constraints: you orchestrate only — never call skill_evolution_write yourself. Drafts stop at status=ready for human approval in the Mnemon panel.')
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
async function spawnMainAgent(skills, model, maxConcurrency, evolutionMode) {
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
      const prompt = buildMainAgentPrompt(skills, maxConcurrency, evolutionMode)
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

// Locate the rubric cases belonging to a draft (mirrors the v1.18.2 backfill
// script, read-only). Exact suggestionId match wins; otherwise the most
// recently updated rubric group for the same skill is used. Deterministic.
function rubricForDraft(draft, allCases) {
  const skillName = String((draft && draft.skillName) || '')
  const mine = (Array.isArray(allCases) ? allCases : []).filter((c) => c && c.skillName === skillName)
  const sid = draft && draft.suggestionId
  const exact = mine.filter((c) => c.origin && typeof c.origin === 'object' && c.origin.suggestionId === sid)
  if (exact.length) return exact
  const groups = new Map()
  for (const c of mine) {
    const o = c.origin
    const key = (o && typeof o === 'object')
      ? 'obj:' + (o.suggestionId || o.trajectoryId || 'none')
      : (typeof o === 'string' ? 'str:' + o : 'none')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(c)
  }
  let best = []
  let top = ''
  for (const g of groups.values()) {
    const t = g.map((c) => c.updatedAt || '').sort().pop() || ''
    if (t > top) { top = t; best = g }
  }
  return best.length ? best : mine
}
const safeReadJson = (f) => { try { return readJson(f) || {} } catch { return {} } }

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
        if (body.evolutionMode !== undefined) {
          if (body.evolutionMode !== 'new' && body.evolutionMode !== 'legacy') { writeJson(response, 400, { error: 'evolutionMode must be "new" or "legacy"' }); return }
          pc.evolutionMode = body.evolutionMode
          CFG.evolutionMode = body.evolutionMode
        }
        savePanelConfig(pc)
        writeJson(response, 200, { ok: true, ...(await panelStateImpl()) })
      } catch (e) { writeJson(response, 500, { error: String(e && e.message || e) }) }
    })

    // POST { skills?, model?, maxConcurrency?, evolutionMode?: 'new'|'legacy' }.
    // 'new' (default) drives the deterministic CODE state machine — no LLM main
    // agent is spawned; the host llm authors cases[]/draftContent only.
    // 'legacy' spawns ONE 'standard' main agent that opens ≤maxConcurrency
    // subagents (soft cap), reviews/retries once. Both land drafts that stop at
    // status=ready for human approval and are fire-and-forget (panel polls /jobs).
    register('/api/skill-evolution/evolve', async (request, response) => {
      if (request.method !== 'POST') { writeJson(response, 405, { error: 'method not allowed' }); return }
      // acceptedAt = wall clock at route entry. Queue building (config load,
      // model resolution, per-skill suggestion scan) happens below BEFORE the
      // state machine starts; the per-skill dispatch segment must include it.
      const acceptedAt = new Date().toISOString()
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
        // Runtime concurrency override (m00533): request body > panel config.
        // The user picks 1..16 at trigger time. 1 = OLD serial mode (one skill at
        // a time); >1 = NEW concurrent mode. A too-large value can be slower than
        // serial, which is exactly why the number is user-selectable. Out-of-range
        // values are rejected (matching the /config validator), never clamped.
        const requestedConcurrency = (body.maxConcurrency !== undefined) ? body.maxConcurrency : body.concurrency
        let resolvedConcurrency
        if (body.maxConcurrency !== undefined || body.concurrency !== undefined) {
          if (!Number.isFinite(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > 16) {
            writeJson(response, 400, { error: 'maxConcurrency must be a number between 1 and 16' }); return
          }
          resolvedConcurrency = requestedConcurrency | 0
        } else {
          resolvedConcurrency = CFG.maxConcurrency
        }
        // Runtime evolutionMode override: request body > panel config > CFG default.
        // 'new' (default, v1.16.0) = deterministic CODE state machine (host llm
        // authors cases[]/draftContent only; no LLM main agent is spawned).
        // 'legacy' = one 'standard' main agent opens subagents running the full
        // pipeline including their own grading; kept verbatim for environments that
        // prefer the original LLM-orchestrated behavior.
        const requestedMode = (body.evolutionMode !== undefined) ? body.evolutionMode : body.mode
        let resolvedMode
        if (body.evolutionMode !== undefined || body.mode !== undefined) {
          if (requestedMode !== 'new' && requestedMode !== 'legacy') {
            writeJson(response, 400, { error: 'evolutionMode must be "new" or "legacy"' }); return
          }
          resolvedMode = requestedMode
        } else {
          resolvedMode = pc.evolutionMode || CFG.evolutionMode
        }
        // 'new' is code-driven: it needs ONLY the host llm service. 'legacy'
        // spawns a real main agent and therefore needs the agents service.
        // Check AFTER mode resolution so an unavailable service yields a clear
        // 503 instead of silently misbehaving (m00997).
        if (resolvedMode === 'new') {
          if (!SVC.llm || typeof SVC.llm.stream !== 'function') {
            writeJson(response, 503, { error: 'code state machine unavailable: host llm service not injected' })
            return
          }
        } else if (!SVC.agents) {
          writeJson(response, 503, { error: 'legacy orchestrator unavailable: host agents service not injected' })
          return
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
          maxConcurrency: resolvedConcurrency,
          mode: resolvedConcurrency <= 1 ? 'serial' : 'concurrent',
          evolutionMode: resolvedMode,
          queued: queue,
          skipped,
          model,
          orchestrator: resolvedMode === 'new' ? 'code-state-machine' : 'main-agent-spawns-subagents',
        })
        // 'new' → the deterministic code state machine (no agents spawned).
        // 'legacy' → spawn ONE real main agent (opens ≤resolvedConcurrency
        // subagents, soft cap in its prompt, reviews/retries once). Both are
        // fire-and-forget: the pipeline takes minutes, the panel polls /jobs.
        if (resolvedMode === 'new') {
          spawnStateMachine(queue, model, resolvedConcurrency, acceptedAt)
        } else {
          spawnMainAgent(queue, model, resolvedConcurrency, resolvedMode).catch((e) => {
            ctx?.logger?.error?.(`skill-evolution-backtest: legacy orchestrator crashed: ${String(e && e.stack || e)}`)
          })
        }
      } catch (e) { writeJson(response, 500, { error: String(e && e.message || e) }) }
    })

    // POST { op: 'score'|'backtest'|'write'|'verify', ...args } → run the matching
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
        } else if (op === 'score') {
          writeJson(response, 200, { ok: true, result: await scoreImpl(body) })
        } else if (op === 'write') {
          writeJson(response, 200, { ok: true, result: await writeImpl(body) })
        } else if (op === 'verify') {
          writeJson(response, 200, { ok: true, result: verifyImpl(body) })
        } else {
          writeJson(response, 400, { error: "op must be 'score', 'backtest', 'write' or 'verify'" })
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

    // POST { jobId } → request a cooperative cancel of a running evolution job.
    register('/api/skill-evolution/cancel', async (request, response) => {
      if (request.method !== 'POST') { writeJson(response, 405, { error: 'method not allowed' }); return }
      try {
        const body = JSON.parse((await readReqBody(request)).toString('utf8') || '{}')
        const jobId = String(body.jobId || '').trim()
        if (!jobId) { writeJson(response, 400, { error: 'jobId is required' }); return }
        const job = RUNNING.get(jobId)
        if (!job) { writeJson(response, 404, { error: 'job not found' }); return }
        if (job.cancelRequested) { writeJson(response, 200, { ok: true, jobId, cancelRequested: true, already: true }); return }
        if (job.status !== 'running') { writeJson(response, 409, { error: 'job is not running', status: job.status }); return }
        job.cancelRequested = true
        writeJson(response, 200, { ok: true, jobId, cancelRequested: true })
      } catch (e) {
        writeJson(response, 500, { error: String((e && e.message) || e) })
      }
    })

    // GET ?id=<draftId> → the draft body for the panel's "view draft" modal.
    // Read-only: never adopts/installs, just returns what writeImpl landed.
    register('/api/skill-evolution/draft', async (request, response) => {
      try {
        if (request.method && String(request.method).toUpperCase() !== 'GET') {
          writeJson(response, 405, { error: 'method not allowed' }); return
        }
        const url = new URL(request.url || '/', 'http://localhost')
        const id = String(url.searchParams.get('id') || '').trim()
        if (!id) { writeJson(response, 400, { error: 'id is required' }); return }
        const ledger = safeReadJson(CFG.ledgerPath)
        const draft = (Array.isArray(ledger.drafts) ? ledger.drafts : []).find((d) => d && d.id === id)
        if (!draft) { writeJson(response, 404, { error: 'draft not found' }); return }
        writeJson(response, 200, { ok: true, draft: {
          id: draft.id,
          skillName: draft.skillName,
          suggestionId: draft.suggestionId,
          action: draft.action,
          status: draft.status,
          baseHash: draft.baseHash,
          notes: draft.notes,
          runIds: draft.runIds,
          createdAt: draft.createdAt,
          updatedAt: draft.updatedAt,
          content: String(draft.content || ''),
        } })
      } catch (e) { writeJson(response, 500, { error: String(e && e.message || e) }) }
    })

    // POST { skillName, draftId?, draftContent?, cases?, suggestionId? } →
    // recompute before/after with the SAME gradeFor path as the pipeline and
    // mirror the result into the in-memory job report so the panel's "no
    // backtest" card turns into a scored card on the next poll. Never rewrites
    // the draft body and never adopts/installs anything.
    register('/api/skill-evolution/rescore', async (request, response) => {
      if (request.method !== 'POST') { writeJson(response, 405, { error: 'method not allowed' }); return }
      try {
        const body = JSON.parse((await readReqBody(request)).toString('utf8') || '{}')
        const skillName = String(body.skillName || '').trim()
        const draftId = String(body.draftId || '').trim()
        if (!skillName) { writeJson(response, 400, { error: 'skillName is required' }); return }
        let content = typeof body.draftContent === 'string' ? body.draftContent : null
        let draft = null
        if (draftId) {
          const ledger = safeReadJson(CFG.ledgerPath)
          draft = (Array.isArray(ledger.drafts) ? ledger.drafts : []).find((d) => d && d.id === draftId) || null
          if (draft) content = String(draft.content || '')
        }
        if (!content) { writeJson(response, 400, { error: 'draftId or draftContent is required' }); return }
        let cases = Array.isArray(body.cases) && body.cases.length ? body.cases : null
        if (!cases) {
          const evals = safeReadJson(CFG.evalsPath)
          const pseudo = draft || { skillName, suggestionId: body.suggestionId }
          cases = rubricForDraft(pseudo, evals.cases || [])
        }
        if (!cases.length) {
          writeJson(response, 422, { error: 'no rubric cases found for this skill — cannot rescore' }); return
        }
        const pc2 = loadPanelConfig()
        const rcModel = pc2.model || null
        const baseline = await scoreImpl({ skillName, cases, model: rcModel })
        const bt = await backtestImpl({ skillName, draftContent: content, cases, before: baseline.baseline, model: rcModel })
        // v2.0.2 (m07155 Q2): when the only failed segment is backtest, the panel's
        // "re-backtest" button lands here. Also flip that segment's step detail from
        // the red failure to a live "after" reading so the re-backtest is visible on
        // the next /jobs poll (the job may already be terminal -- best-effort).
        for (const job of RUNNING.values()) {
          const pr = job && job.progress && job.progress[skillName]
          const bs = pr && pr.steps && pr.steps.backtest
          if (bs && bs.status === 'failed') {
            bs.status = 'done'
            bs.at = new Date().toISOString()
            bs.detail = `after=${bt.after.score} delta=${bt.delta} (re-backtested)`
          }
        }
        const result = {
          skillName,
          draftId: draftId || null,
          beforeScore: bt.before.score,
          afterScore: bt.after.score,
          delta: bt.delta,
          passRate: bt.after.passRate,
          engine: bt.engine,
          beforeFallback: bt.beforeFallback || null,
          casesCount: cases.length,
          rescoredAt: new Date().toISOString(),
        }
        // Mirror into every in-memory job that reports this skill, so the
        // panel reflects the new score on its next /jobs poll.
        let mirrored = 0
        for (const job of RUNNING.values()) {
          const results = job && job.report && Array.isArray(job.report.results) ? job.report.results : null
          if (!results) continue
          for (const r of results) {
            if (!r || r.skill !== skillName) continue
            r.beforeScore = result.beforeScore
            r.afterScore = result.afterScore
            r.delta = result.delta
            r.backtestError = null
            r.scoreOk = true
            r.rescoredAt = result.rescoredAt
            mirrored++
          }
        }
        writeJson(response, 200, { ok: true, result: { ...result, mirrored } })
      } catch (e) { writeJson(response, 500, { error: String(e && e.message || e) }) }
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
        name: 'skill_evolution_score',
        description:
          'Read-only baseline scorer that FREEZES the evaluation standard before evolving. With skillName + a frozen cases[] (same shape as skill_evolution_backtest), grade the CURRENT live SKILL.md once and return a self-contained baseline (baseHash + casesHash + score/passRate/caseRows/engine). Pass that exact baseline object back as the `before` param of skill_evolution_backtest and skill_evolution_write so before and after are judged under the SAME rubric — this prevents scoring distortion from writing the new skill first and grading after. Cases must be frozen BEFORE you call this. Read-only — nothing is written.',
        parameters: {
          type: 'object',
          properties: {
            skillName: { type: 'string', description: 'Skill whose current live SKILL.md is the "before" side, e.g. dsh-plugin-edit-verify.' },
            cases: {
              type: 'array',
              description: 'The FROZEN evaluation rubric. Same shape as skill_evolution_backtest.',
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
          required: ['skillName', 'cases'],
        },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async (args) => j(await scoreImpl(args)),
      })

      sctx.tools.register({
        name: 'skill_evolution_backtest',
        description:
          'Per-check semantic backtest of a candidate improved SKILL.md against the current live one, graded the way the Mnemon host does. You supply skillName, the full draftContent, and cases[] = [{id?,title,checks:[{id?,text,must?,anchors?}]}]. A model judges each check against the body (does the skill actually satisfy the improvement?), anchors are only the offline fallback, case score is must-weighted (must=2, optional=1), and the run score is the case-level mean (passRate = pass cases / graded cases). Returns before/after scores + pass rates, delta, the grading engine, and the per-check breakdown. Read-only — nothing is written. Mark load-bearing checks must:true so a case only passes when they do. OPTIONAL `before`: pass the baseline object returned by skill_evolution_score to reuse a frozen before score (same casesHash + baseHash) instead of re-grading the live file; if the baseline drifted (casesHash/baseHash mismatch) it is rejected with an error so the score is never silently recomputed under a changed rubric.',
        parameters: {
          type: 'object',
          properties: {
            skillName: { type: 'string', description: 'Skill to backtest, e.g. dsh-plugin-edit-verify.' },
            draftContent: { type: 'string', description: 'Full improved SKILL.md text (the after side).' },
            before: {
              type: 'object',
              description: 'Optional frozen baseline from skill_evolution_score. When supplied, the before score is reused verbatim (validated against casesHash + baseHash); omit to grade the live file now.',
            },
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
          'MUTATING: turn a graded improvement into a status=ready Mnemon draft + a before/after run pair, atomic-write both ledgers (generation+1) after timestamped backups, and flip the suggestion to review with draftId set. Grading is host-aligned: a model judges each check semantically (anchors only as fallback), case score is must-weighted (must=2, optional=1), run score is the case-level mean. Guards: refuses if the suggestion is adopted/dismissed or already has a draftId; baseHash is recomputed from the live file. The draft stops at ready for human approval — it does NOT adopt, install, or overwrite the live SKILL.md. Provide skillName, suggestionId, action(update|create), draftContent, notes, cases[] (same shape as backtest). OPTIONAL `before`: pass the baseline object returned by skill_evolution_score so the before run reuses the frozen score (same casesHash + baseHash) instead of re-grading the live file; a drifted baseline is rejected, never silently recomputed.',
        parameters: {
          type: 'object',
          properties: {
            skillName: { type: 'string' },
            suggestionId: { type: 'string', description: 'The pending suggestion this draft answers.' },
            action: { type: 'string', enum: ['update', 'create'], description: 'update = live SKILL.md exists; create = brand-new skill.' },
            draftContent: { type: 'string', description: 'Full improved SKILL.md text.' },
            notes: { type: 'string', description: 'What this draft changes (≤2000 chars).' },
            before: {
              type: 'object',
              description: 'Optional frozen baseline from skill_evolution_score. When supplied, the before run reuses it verbatim (validated against casesHash + baseHash); omit to grade the live file now.',
            },
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