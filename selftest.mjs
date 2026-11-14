// Offline selftest — no running host required.
// Exercises the four tool implementations against a TEMP ledger copy:
//   grade partial-score math, casesHash signature, buildRun/newDraft shape,
//   atomic write + generation bump + suggestion→review flip, concurrency guard,
//   and the verify re-read invariants. Never touches the real ~/.mnemon store.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { gradeBody } from './lib/grade.mjs'
import { judgeBody, extractChecksJson, GRADE_ENGINE } from './lib/llm-judge.mjs'
import { casesHash, sha256Hex, EMPTY_SHA } from './lib/hash.mjs'
import { buildRun, newDraft, pruneDrafts, validateDraftSchema } from './lib/ledger.mjs'

let failures = 0
function ok(cond, label, extra = '') {
  if (cond) console.log(`  OK   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${extra ? ' — ' + extra : ''}`)
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seb-selftest-'))
console.log('selftest dir:', tmp)

// ---- 1. partial-score math ----
console.log('\n[1] gradeBody partial scoring')
const cases = [
  {
    id: 'c1', title: 't1',
    checks: [
      { id: 'k1', text: 'a', anchors: ['alpha'] },
      { id: 'k2', text: 'b', anchors: ['beta'] },
      { id: 'k3', text: 'c', anchors: ['gamma', 'delta'] },
    ],
  },
]
const beforeBody = 'nothing here' // 0/3
const afterBody = 'has alpha and beta and gamma but not the word' // k1 hit, k2 hit, k3 needs gamma+delta -> gamma hit, delta miss => fail
const b = gradeBody(beforeBody, cases)
const a = gradeBody(afterBody, cases)
ok(b.score === 0, 'before 0/3 => 0', `got ${b.score}`)
ok(a.score === 2 / 3, 'after 2/3 partial (not flat 0/1)', `got ${a.score}`)
ok(a.caseRows[0].checks[2].pass === false, 'k3 fails (delta missing)')
ok(a.caseRows[0].checks[2].misses.length === 1, 'k3 reports 1 missing anchor')
// invalid regex must not throw, must count as a miss
const bad = gradeBody('x', [{ id: 'c', title: 'x', checks: [{ id: 'k', text: 'x', anchors: ['(['] }] }])
ok(bad.score === 0 && bad.caseRows[0].checks[0].misses[0].error === 'invalid regex', 'invalid regex => miss, no throw')

// ---- 1b. must weighting + case-level macro-average (host compareAutomaticSkillRuns) ----
console.log('\n[1b] must weighting + case-level aggregation')
{
  const mustCase = [{
    id: 'm1', title: 'must-gated',
    checks: [
      { id: 'mk1', text: 'must hit', must: true, anchors: ['alpha'] },
      { id: 'mk2', text: 'optional miss', must: false, anchors: ['zzz-not-here'] },
    ],
  }]
  const g = gradeBody('has alpha', mustCase)
  ok(g.caseRows[0].score === 2 / 3, 'must weight=2, optional=1 => 2/3', `got ${g.caseRows[0].score}`)
  ok(g.caseRows[0].verdict === 'pass', 'optional miss does not gate the case')
  ok(g.score === 2 / 3 && g.passRate === 1, 'single must-pass case aggregates to 2/3')

  // A failing MUST check must gate the case verdict even though the case score
  // is non-zero (the weighted partial).
  const failMust = [{
    id: 'm2', title: 'must-fail',
    checks: [
      { id: 'fk1', text: 'must hit', must: true, anchors: ['nope-missing'] },
      { id: 'fk2', text: 'optional hit', must: false, anchors: ['alpha'] },
    ],
  }]
  const g2 = gradeBody('has alpha', failMust)
  ok(g2.caseRows[0].score === 1 / 3, 'must miss => 1/3 weighted', `got ${g2.caseRows[0].score}`)
  ok(g2.caseRows[0].verdict === 'fail', 'failing must check gates case verdict')
  ok(g2.score === 1 / 3 && g2.passRate === 0, 'must-fail case => passRate 0')

  // Two cases => run score is the MEAN of case scores, not the check-level ratio.
  const two = [
    { id: 't1', title: 'c1', checks: [{ id: 't1k1', text: 'a', must: true, anchors: ['alpha'] }] },
    { id: 't2', title: 'c2', checks: [
      { id: 't2k1', text: 'b', must: true, anchors: ['beta'] },
      { id: 't2k2', text: 'c', must: true, anchors: ['gamma'] },
    ] },
  ]
  const g3 = gradeBody('has alpha only', two)
  // case1: 1/1 = 1 ; case2: 0/2 = 0 ; run score = mean(1, 0) = 0.5
  ok(g3.caseRows[0].score === 1 && g3.caseRows[1].score === 0, 'per-case scores 1 and 0')
  ok(g3.score === 0.5, 'run score = mean of case scores (macro)', `got ${g3.score}`)
  ok(g3.microScore === 1 / 3, 'microScore (check-level) kept for diagnostics', `got ${g3.microScore}`)
}

// ---- 1c. LLM semantic judge + deterministic fallback ----
console.log('\n[1c] LLM judge (semantic) + anchor fallback')
function fakeLlm(textOrThrow) {
  return {
    async *stream(_opts) {
      if (textOrThrow instanceof Error) throw textOrThrow
      const pieces = String(textOrThrow).match(/.{1,40}/gs) || []
      for (const piece of pieces) yield { type: 'text-delta', index: 0, text: piece }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}
const judgeModel = { provider: 'p', model: 'm' }
// JSON embedded in prose + code fence must still parse.
ok(Array.isArray(extractChecksJson('Sure!\n```json\n[{"id":"k1","pass":true,"reason":"ok"}]\n```\nThanks')), 'extractChecksJson parses fenced JSON')
ok(extractChecksJson('no array here') === null, 'extractChecksJson returns null on garbage')
{
  const cases = [{ id: 'j1', title: 't', checks: [
    { id: 'jk1', text: 'has alpha', must: true, anchors: ['zzz-not-here'] },
    { id: 'jk2', text: 'has beta', must: false, anchors: ['yyy-not-here'] },
  ] }]
  const llmText = JSON.stringify([
    { id: 'jk1', pass: true, reason: 'alpha present' },
    { id: 'jk2', pass: false, reason: 'beta absent' },
  ])
  const g = await judgeBody('alpha', cases, { llm: fakeLlm(llmText), model: judgeModel })
  ok(g.engine === GRADE_ENGINE.LLM, 'LLM judge engine', `got ${g.engine}`)
  ok(g.caseRows[0].checks[0].pass === true && g.caseRows[0].checks[1].pass === false, 'LLM verdicts applied')
  ok(g.caseRows[0].checks[0].engine === GRADE_ENGINE.LLM, 'check engine is llm')
  ok(g.score === 2 / 3 && g.caseRows[0].verdict === 'pass', 'must-weighted case score from LLM verdicts')
}
{
  // Model call throws → whole case falls back to anchors (engine=anchor).
  const cases = [{ id: 'j2', title: 't', checks: [{ id: 'jk1', text: 'x', must: true, anchors: ['alpha'] }] }]
  const g = await judgeBody('has alpha', cases, { llm: fakeLlm(new Error('boom')), model: judgeModel })
  ok(g.engine === GRADE_ENGINE.ANCHOR, 'model error => anchor engine', `got ${g.engine}`)
  ok(g.caseRows[0].checks[0].pass === true, 'anchor fallback still grades the body')
}
{
  // Model omits one check verdict → that check falls back to anchors (mixed).
  const cases = [{ id: 'j3', title: 't', checks: [
    { id: 'jk1', text: 'x', must: true, anchors: ['nope'] },
    { id: 'jk2', text: 'y', must: true, anchors: ['alpha'] },
  ] }]
  const llmText = JSON.stringify([{ id: 'jk1', pass: true, reason: 'x present' }])
  const g = await judgeBody('has alpha', cases, { llm: fakeLlm(llmText), model: judgeModel })
  ok(g.engine === GRADE_ENGINE.MIXED, 'missing verdict => mixed engine', `got ${g.engine}`)
  ok(g.caseRows[0].checks[1].engine === GRADE_ENGINE.ANCHOR, 'missing check uses anchor fallback')
  ok(g.caseRows[0].checks[1].pass === true, 'anchor fallback for missing check')
}
{
  // m03118: partial first response, but the repair pass fills the missing
  // check's verdict → the whole case becomes llm (no anchor fallback at all).
  const cases = [{ id: 'j5', title: 't', checks: [
    { id: 'jk1', text: 'x', must: true, anchors: ['alpha'] },
    { id: 'jk2', text: 'y', must: true, anchors: ['alpha'] },
  ] }]
  let call = 0
  const seqLlm = {
    async *stream(_opts) {
      call++
      const out = call === 1
        ? [{ id: 'jk1', pass: true, reason: 'first pass' }]
        : [{ id: 'jk2', pass: false, reason: 'repair pass' }]
      const pieces = JSON.stringify(out).match(/.{1,40}/gs) || []
      for (const piece of pieces) yield { type: 'text-delta', index: 0, text: piece }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const g = await judgeBody('has alpha', cases, { llm: seqLlm, model: judgeModel })
  ok(call === 2, 'repair pass re-asks for the missing check', `calls=${call}`)
  ok(g.engine === GRADE_ENGINE.LLM, 'partial first pass + repair => all llm engine', `got ${g.engine}`)
  ok(g.caseRows[0].checks[1].engine === GRADE_ENGINE.LLM && g.caseRows[0].checks[1].pass === false, 'repaired check uses the LLM verdict')
  ok(g.caseRows[0].score === 0.5 && g.caseRows[0].verdict === 'fail', 'repaired verdict feeds the must-weighted case score')
}
{
  // m03118: first response unparseable, second parseable → still llm (no whole-case anchor).
  const cases = [{ id: 'j6', title: 't', checks: [{ id: 'jk1', text: 'x', must: true, anchors: ['alpha'] }] }]
  let call = 0
  const retryLlm = {
    async *stream(_opts) {
      call++
      const text = call === 1 ? 'not json at all' : JSON.stringify([{ id: 'jk1', pass: true, reason: 'retry ok' }])
      const pieces = text.match(/.{1,40}/gs) || []
      for (const piece of pieces) yield { type: 'text-delta', index: 0, text: piece }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const g = await judgeBody('has alpha', cases, { llm: retryLlm, model: judgeModel })
  ok(call === 2, 'unparseable first pass is retried', `calls=${call}`)
  ok(g.engine === GRADE_ENGINE.LLM, 'unparseable + retry => llm engine', `got ${g.engine}`)
  ok(g.caseRows[0].checks[0].engine === GRADE_ENGINE.LLM, 'retried check uses the LLM verdict')
}
{
  // No llm at all → anchor engine, still graded (never constant).
  const cases = [{ id: 'j4', title: 't', checks: [{ id: 'jk1', text: 'x', must: true, anchors: ['alpha'] }] }]
  const g = await judgeBody('has alpha', cases, { llm: null, model: judgeModel })
  ok(g.engine === GRADE_ENGINE.ANCHOR && g.score === 1, 'no llm => anchor engine, graded')
}

// ---- 2. casesHash signature ----
console.log('\n[2] casesHash (host skillCaseSignature)')
const c2 = [{ id: 'c1', skillName: 's', title: 'T', prompt: 'P', context: '', enabled: true, requiresVision: false, checks: [{ id: 'k1', text: 'x', must: true }] }]
const h1 = casesHash(c2)
ok(/^[0-9a-f]{64}$/.test(h1), 'casesHash is sha256 hex')
const c2b = JSON.parse(JSON.stringify(c2)); c2b[0].requiresVision = true
ok(casesHash(c2b) !== h1, 'requiresVision flips hash')
const c2c = JSON.parse(JSON.stringify(c2)); c2c[0].context = 'nonempty'
ok(casesHash(c2c) !== h1, 'context flips hash')
ok(EMPTY_SHA === sha256Hex(Buffer.alloc(0)), 'EMPTY_SHA == sha256("")')

// ---- 3. buildRun / newDraft shape ----
console.log('\n[3] run/draft record shape')
const graded = gradeBody(afterBody, cases)
const run = buildRun({ id: 'r1', skillName: 's', kind: 'draft', hash: 'h', draftId: 'd1', cases, graded, model: { provider: 'p', model: 'm' }, gradeNote: 'n', now: 'NOW' })
ok(run.target.kind === 'draft' && run.target.draftId === 'd1' && run.target.hash === 'h', 'draft run target')
ok(run.score === 2 / 3 && run.passRate === 1, 'run score = partial, passRate = pass/graded', `score=${run.score} passRate=${run.passRate}`)
ok(run.results[0].checks.length === 3 && run.results[0].fullyGraded === true, 'run result rows')
ok(run.results[0].verdict === 'pass', 'all-optional case verdict passes (no must gating)')
const beforeRun = buildRun({ id: 'r0', skillName: 's', kind: 'current', hash: 'bh', draftId: null, cases, graded: b, model: { provider: 'p', model: 'm' }, gradeNote: 'n', now: 'NOW' })
ok(beforeRun.target.kind === 'current' && beforeRun.target.draftId === null, 'before run target')
const draft = newDraft({ suggestionId: 's1', skillName: 's', action: 'update', baseHash: 'bh', content: 'C', notes: 'N'.repeat(5000), runIds: ['r0', 'r1'], now: 'NOW' })
ok(draft.status === 'ready' && draft.baseKey === 'user-dsh:s', 'draft ready + baseKey')
ok(draft.notes.length <= 2000, 'notes clipped to 2000')

// ---- 4. pruneDrafts keeps ready always ----
console.log('\n[4] pruneDrafts')
const many = []
for (let i = 0; i < 100; i++) many.push({ id: 'd' + i, status: 'adopted', updatedAt: 't' + String(i).padStart(3, '0') })
many.push({ id: 'readyX', status: 'ready' })
const pruned = pruneDrafts(many, 60)
ok(pruned.some((d) => d.id === 'readyX'), 'ready always retained')
ok(pruned.filter((d) => d.status !== 'ready').length === 60, 'non-ready capped at 60', `got ${pruned.filter((d) => d.status !== 'ready').length}`)

// ---- 4b. delivery self-audit: validateDraftSchema rejects incomplete drafts ----
// A 'ready' draft missing native-schema fields (changes/notes/updatedAt/runIds,
// or baseKey/origin/baseHash on update) writes fine but crashes the Mnemon
// panel the moment a human opens/adopts it. This gate must catch those BEFORE
// delivery. Regression for the 2026-11-13 incident where hand-written drafts
// missing baseHash / changes / runIds / origin black-screened the review page
// and errored on adopt ("changed since it was read", "origin-unavailable",
// "reading 'flatMap'", changes.length TypeError).
console.log('\n[4b] validateDraftSchema (delivery self-audit)')
{
  const good = newDraft({
    id: 'g1', suggestionId: 's1', skillName: 'demo-skill', action: 'update',
    baseHash: 'a'.repeat(64), content: 'x', notes: 'n', runIds: ['r1', 'r2'], now: 't',
  })
  good.origin = { path: '/skills/demo-skill/SKILL.md' }
  ok(validateDraftSchema(good) === true, 'complete update draft passes')

  // Each of these must THROW (gate rejects an incomplete draft):
  const incomplete = [
    ['missing baseHash', () => validateDraftSchema({ ...good, baseHash: undefined })],
    ['missing origin', () => validateDraftSchema({ ...good, origin: undefined })],
    ['origin.path not string', () => validateDraftSchema({ ...good, origin: { path: 123 } })],
    ['missing baseKey', () => validateDraftSchema({ ...good, baseKey: undefined })],
    ['missing changes', () => validateDraftSchema({ ...good, changes: undefined })],
    ['changes not array', () => validateDraftSchema({ ...good, changes: 'x' })],
    ['missing runIds', () => validateDraftSchema({ ...good, runIds: undefined })],
    ['runIds not array', () => validateDraftSchema({ ...good, runIds: 'x' })],
    ['missing notes', () => validateDraftSchema({ ...good, notes: undefined })],
    ['missing updatedAt', () => validateDraftSchema({ ...good, updatedAt: undefined })],
    ['missing content', () => validateDraftSchema({ ...good, content: undefined })],
  ]
  for (const [label, fn] of incomplete) {
    let threw = false
    try { fn() } catch { threw = true }
    ok(threw, `rejects ${label}`, threw ? 'threw' : 'DID NOT throw')
  }

  // create drafts need the base set but NOT baseKey/origin/baseHash:
  const createDraft = {
    id: 'c1', suggestionId: 's1', skillName: 'new-skill', action: 'create',
    status: 'ready', content: 'x', changes: [], notes: '', updatedAt: 't', runIds: ['r1', 'r2'],
  }
  ok(validateDraftSchema(createDraft) === true, 'complete create draft passes (no baseKey/origin/baseHash required)')
}

// ---- 5. end-to-end against a temp ledger (import the real implementations) ----
console.log('\n[5] end-to-end scan/backtest/write/verify on temp ledger')
// Build a fake ledger + evals + a live skill file.
const skillsRoot = path.join(tmp, 'skills')
fs.mkdirSync(path.join(skillsRoot, 'demo-skill'), { recursive: true })
const skillBody = 'current body: nothing useful'
fs.writeFileSync(path.join(skillsRoot, 'demo-skill', 'SKILL.md'), skillBody, 'utf8')
const skillHash = sha256Hex(Buffer.from(skillBody, 'utf8'))
const ledger = {
  generation: 1,
  suggestions: [{ id: 'sug-1', skillName: 'demo-skill', action: 'update', status: 'pending', confidence: 0.9, skillFileHash: skillHash, summary: 'learn X' }],
  drafts: [],
}
const evals = { cases: [], runs: [] }
const ledgerPath = path.join(tmp, 'ledger.json')
const evalsPath = path.join(tmp, 'evals.json')
fs.writeFileSync(ledgerPath, JSON.stringify(ledger), 'utf8')
fs.writeFileSync(evalsPath, JSON.stringify(evals), 'utf8')

// Re-point the module's config at the temp store by re-resolving paths.
const { resolvePaths } = await import('./lib/paths.mjs')
const CFG = { ...resolvePaths({ ledgerPath, evalsPath, skillsRoot }), stateDir: path.join(tmp, 'state'), allowWrite: true, backupKeep: 5, model: { provider: 'p', model: 'm' }, gradeNote: 'n' }

// Re-import implementations with CFG injected by monkey-patching module config
// via a tiny shim: we re-implement scan/backtest/write/verify is NOT needed —
// instead we call the pure libs the same way index.js does, to validate the
// write/verify logic end to end without a host.
const { readJson, backupLedgers } = await import('./lib/ledger.mjs')
const stateDir = CFG.stateDir
fs.mkdirSync(stateDir, { recursive: true })

// scan
{
  const s = readJson(ledgerPath)
  const rows = s.suggestions.filter((x) => ['pending', 'review', 'expired'].includes(x.status))
  const cur = fs.readFileSync(path.join(skillsRoot, 'demo-skill', 'SKILL.md'), 'utf8')
  const live = sha256Hex(Buffer.from(cur.replace(/\r\n/g, '\n'), 'utf8')) === rows[0].skillFileHash ? 'FRESH' : 'STALE'
  ok(rows.length === 1 && live === 'FRESH', 'scan lists 1 pending, FRESH hash', `got ${live}`)
}

// write (mirror index.js writeImpl core)
// m03216: 6 checks so the granularityOk gate (>=6 total) is satisfied by this fixture.
const writeCases = [{
  id: 'ec1', title: 'learn X',
  checks: [
    { id: 'ek1', text: 'knows alpha', must: true, anchors: ['alpha'] },
    { id: 'ek2', text: 'teaches alpha', must: true, anchors: ['teaches'] },
    { id: 'ek3', text: 'improved body present', must: true, anchors: ['improved'] },
    { id: 'ek4', text: 'phrase improved body', must: true, anchors: ['improved body'] },
    { id: 'ek5', text: 'phrase body now', must: true, anchors: ['body now'] },
    { id: 'ek6', text: 'phrase teaches alpha', must: true, anchors: ['teaches alpha'] },
  ],
}]
const draftContent = 'improved body now teaches alpha'
let writeOut
{
  const L = readJson(ledgerPath)
  const sug = L.suggestions.find((x) => x.id === 'sug-1')
  const backup = backupLedgers(CFG, stateDir, 5)
  const E = readJson(evalsPath)
  const now = new Date().toISOString()
  for (const c of writeCases) { c.skillName = 'demo-skill'; c.context = ''; c.enabled = true; c.requiresVision = false; c.createdAt = now; c.updatedAt = now; if (!E.cases.some((x) => x.id === c.id)) E.cases.push(c) }
  const chash = casesHash(writeCases)
  const cur = fs.readFileSync(path.join(skillsRoot, 'demo-skill', 'SKILL.md'), 'utf8')
  const baseHash = sha256Hex(Buffer.from(cur.replace(/\r\n/g, '\n'), 'utf8'))
  const draftHash = sha256Hex(Buffer.from(draftContent, 'utf8'))
  // draftId must be minted ONCE and shared by the after-run target AND the
  // draft — exactly what index.js writeImpl does (that's the invariant verify
  // checks: after.target.draftId === draft.id).
  const draftId = randomUUID()
  const bg = gradeBody(cur, writeCases), ag = gradeBody(draftContent, writeCases)
  const br = buildRun({ id: 'br', skillName: 'demo-skill', kind: 'current', hash: baseHash, draftId: null, cases: writeCases, graded: bg, model: CFG.model, gradeNote: 'n', now })
  const ar = buildRun({ id: 'ar', skillName: 'demo-skill', kind: 'draft', hash: draftHash, draftId, cases: writeCases, graded: ag, model: CFG.model, gradeNote: 'n', now })
  br.casesHash = chash; ar.casesHash = chash
  const dr = newDraft({ suggestionId: 'sug-1', skillName: 'demo-skill', action: 'update', baseHash, content: draftContent, notes: 'n', runIds: [br.id, ar.id], now })
  dr.id = draftId
  E.runs.push(br, ar)
  L.drafts.push(dr)
  sug.status = 'review'; sug.draftId = dr.id; delete sug.lastError
  L.generation += 1
  fs.writeFileSync(evalsPath, JSON.stringify(E), 'utf8')
  fs.writeFileSync(ledgerPath, JSON.stringify(L), 'utf8')
  writeOut = { dr, br, ar, baseHash, draftHash, backupDir: backup.dir, before: bg.score, after: ag.score }
  ok(fs.existsSync(backup.dir), 'backup dir created before write')
  ok(writeOut.before === 0 && writeOut.after === 1, 'before 0 -> after 1', `${writeOut.before}->${writeOut.after}`)
}

// verify (mirror index.js verifyImpl)
{
  const L = readJson(ledgerPath), E = readJson(evalsPath)
  const d = L.drafts.find((x) => x.id === writeOut.dr.id)
  const cur = fs.readFileSync(path.join(skillsRoot, 'demo-skill', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n')
  const sug = L.suggestions.find((x) => x.id === d.suggestionId)
  const b = E.runs.find((r) => r.id === d.runIds[0]), a = E.runs.find((r) => r.id === d.runIds[1])
  const checks = {
    suggestionReview: sug.status === 'review' && sug.draftId === d.id,
    baseHashMatchesLiveFile: d.baseHash === sha256Hex(Buffer.from(cur, 'utf8')),
    beforeTargetCurrent: b.target.kind === 'current',
    afterTargetDraft: a.target.kind === 'draft' && a.target.draftId === d.id,
    afterHashMatchesDraft: a.target.hash === sha256Hex(Buffer.from(d.content.replace(/\r\n/g, '\n'), 'utf8')),
    beforeHashMatchesLive: b.target.hash === sha256Hex(Buffer.from(cur, 'utf8')),
    casesHashPaired: b.casesHash === a.casesHash,
    singleCaseFocused: b.caseIds.length === 1 && a.caseIds.length === 1,
    afterScoreSelfConsistent: (() => {
      const rows = (a.results || []).filter((r) => r.verdict !== 'error')
      if (!rows.length) return false
      const score = rows.reduce((s, r) => s + (Number(r.score) || 0), 0) / rows.length
      const passRate = rows.filter((r) => r.verdict === 'pass').length / rows.length
      return Math.abs(a.score - score) < 1e-9 && Math.abs(a.passRate - passRate) < 1e-9
    })(),
  }
  const allOk = Object.values(checks).every((v) => v === true)
  ok(allOk, 'verify ALL invariants green', JSON.stringify(checks))
}

// concurrency guard
{
  const L = readJson(ledgerPath)
  const sug = L.suggestions.find((x) => x.id === 'sug-1')
  ok(sug.draftId && sug.status === 'review', 'guard: suggestion now has draftId (write would refuse a 2nd time)')
}

// ---- 6. REAL registered tools (regression guard) ----
// Sections [1]-[5] above exercise the pure libs and a RE-IMPLEMENTATION of
// writeImpl. That re-implementation drifted from index.js twice, so the offline
// selftest stayed green while the actual tool was broken in production:
//   * `Cannot add property skillName, object is not extensible` (frozen args)
//   * `writeJsonAtomic is not defined` (un-exported / un-imported helper)
//   * afterRun.target.draftId != draft.id (two independently minted UUIDs)
// This section imports the REAL index.js via apply(), captures the tools the
// host would register, and drives skill_evolution_write end-to-end with DEEP-
// FROZEN args on a fresh temp store. Any future drift in the real write path
// (including the three regressions above) will turn this section red.
console.log('\n[6] REAL registered skill_evolution_write (apply() + frozen args)')
{
  const entry = await import(pathToFileURL(path.join(import.meta.dirname, 'index.js')).href + '?selftest=' + Date.now())
  const cap = {}
  const fakeCtx = {
    logger: { info() {} }, on() {},
    inject(deps, cb) {
      if (deps[0] === 'tools') return cb({ tools: { register(s) { cap[s.name] = s } }, effect(fn) { return fn() } })
      if (deps[0] === 'webServer') return cb({ webServer: { register() { return () => {} } } })
      return cb({ agents: undefined, agentDefaultModel: undefined, sessions: undefined, llm: undefined })
    },
  }
  const r6 = fs.mkdtempSync(path.join(os.tmpdir(), 'seb-selftest-real-'))
  const skillsRoot6 = path.join(r6, 'skills')
  const skillDir6 = path.join(skillsRoot6, 'real-tool-skill')
  fs.mkdirSync(skillDir6, { recursive: true })
  const body6 = '# Real Tool Skill\n\nnothing here yet\n'
  fs.writeFileSync(path.join(skillDir6, 'SKILL.md'), body6, 'utf8')
  const ledgerPath6 = path.join(r6, 'ledger.json')
  const evalsPath6 = path.join(r6, 'evals.json')
  const stateDir6 = path.join(r6, 'state')
  fs.mkdirSync(stateDir6, { recursive: true })
  fs.writeFileSync(ledgerPath6, JSON.stringify({
    generation: 3,
    suggestions: [{ id: 'r6-sug', skillName: 'real-tool-skill', action: 'update', status: 'pending', summary: 's' }],
    drafts: [],
  }, null, 2), 'utf8')
  fs.writeFileSync(evalsPath6, JSON.stringify({ cases: [], runs: [] }, null, 2), 'utf8')
  entry.apply(fakeCtx, {
    ledgerPath: ledgerPath6, evalsPath: evalsPath6, skillsRoot: skillsRoot6,
    stateDir: stateDir6, allowWrite: true, backupKeep: 5, model: { provider: 'p', model: 'm' },
  })
  ok(Boolean(cap.skill_evolution_write) && Boolean(cap.skill_evolution_verify), 'apply() registered write + verify')

  const draft6 = `---\nname: real-tool-skill\ndescription: real registered tool regression fixture\n---\n\n` + body6 + '\n\n## Atomic write\n\nwriteJsonAtomic uses temp file then rename.\n'
  const args6 = {
    skillName: 'real-tool-skill', suggestionId: 'r6-sug', action: 'update',
    draftContent: draft6, notes: 'real registered tool regression',
    // m03216: 6 checks (>=6) so the granularityOk verify gate is satisfied; every
    // anchor hits draft-only text (the Atomic write section), never the before body.
    cases: [{
      title: 't',
      checks: [
        { text: 'atomic write section', anchors: ['Atomic write'] },
        { text: 'writeJsonAtomic named', anchors: ['writeJsonAtomic'] },
        { text: 'temp file step', anchors: ['temp file'] },
        { text: 'rename step', anchors: ['rename'] },
        { text: 'writeJsonAtomic uses', anchors: ['writeJsonAtomic uses'] },
        { text: 'temp then rename', anchors: ['temp file then rename'] },
      ],
    }],
  }
  const deepFreeze = (o) => {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]) }
    return o
  }
  deepFreeze(args6)
  ok(Object.isFrozen(args6) && Object.isFrozen(args6.cases[0]) && Object.isFrozen(args6.cases[0].checks[0]), 'args deeply frozen')
  let out6, threw6 = ''
  try { out6 = JSON.parse(await cap.skill_evolution_write.execute(args6)) }
  catch (e) { threw6 = String((e && e.message) || e) }
  ok(!threw6, 'REAL write did not throw', threw6)
  if (out6) {
    ok(out6.dryRun === false && Boolean(out6.draftId), 'REAL write returned draftId')
    ok(out6.beforeScore === 0 && out6.afterScore === 1, 'REAL write graded 0 -> 1', `${out6.beforeScore}->${out6.afterScore}`)
    const L6 = JSON.parse(fs.readFileSync(ledgerPath6, 'utf8'))
    const E6 = JSON.parse(fs.readFileSync(evalsPath6, 'utf8'))
    const d6 = L6.drafts.find((d) => d.id === out6.draftId)
    ok(Boolean(d6) && d6.status === 'ready', 'REAL write landed a status=ready draft')
    const afterRun6 = E6.runs.find((r) => r.target && r.target.kind === 'draft')
    ok(Boolean(afterRun6) && afterRun6.target.draftId === out6.draftId, 'afterRun.target.draftId === draft.id (shared UUID)')
    const v6 = JSON.parse(cap.skill_evolution_verify.execute({ draftId: out6.draftId }))
    ok(v6.allOk === true, 'REAL verify reports allOk=true', JSON.stringify(v6.results && v6.results[0] && v6.results[0].checks))
    ok(fs.readFileSync(path.join(skillDir6, 'SKILL.md'), 'utf8') === body6, 'live SKILL.md untouched')
  }
}

// ---- 7. coordinator E2E (m00648): concurrency cap + review + retry-once ----
// Drives the REAL /api/skill-evolution/evolve route with a fake host `agents`
// service. The fake worker performs the write the real `skill_evolution_write`
// tool would (via the cap captured from apply()), so the coordinator's review +
// retry-once logic is exercised end to end against the real ledger/evals.
console.log('\n[7] /evolve main agent: spawns ONE main agent that opens subagents')
{
  const entry = await import(pathToFileURL(path.join(import.meta.dirname, 'index.js')).href + '?selftest7=' + Date.now())
  const cap = {}
  const handlers = {}
  const state = { active: 0, max: 0 }
  let agentCreates = 0
  let lastMainPrompt = ''
  let lastCreateOpts = null
  const delay = (ms) => new Promise((r) => setTimeout(r, ms))
  // Fake MAIN agent: /evolve must spawn exactly ONE agent (the orchestrator).
  // Its followup prompt carries the concurrency instruction + one subagent-prompt
  // block per skill. whenIdle simulates the main agent opening subagents: each
  // subagent lands a ready draft for its skill via the real write tool.
  const fakeAgents = {
    async create(opts) {
      const { sessionId } = opts
      lastCreateOpts = opts
      agentCreates++
      const agent = { session: { id: sessionId }, _prompt: '' }
      agent.followup = async ({ content }) => { agent._prompt = (content && content[0] && content[0].text) || '' }
      agent.whenIdle = async () => {
        lastMainPrompt = agent._prompt
        state.active++; if (state.active > state.max) state.max = state.active
        await delay(60)
        state.active--
        const skills = [...agent._prompt.matchAll(/=== SUBAGENT PROMPT FOR SKILL: (\S+) ===/g)].map((m) => m[1])
        for (const skill of skills) {
          const L = JSON.parse(fs.readFileSync(ledgerPath7, 'utf8'))
          const sug = L.suggestions.find((x) => x.skillName === skill && !x.draftId)
          if (!sug) continue
          const draft = `---\nname: ${skill}\ndescription: main-agent e2e fixture\n---\n\n# ${skill}\n\nGOODANCHOR present in improved body\n`
          try {
            await cap.skill_evolution_write.execute({
              skillName: skill, suggestionId: sug.id, action: 'update',
              draftContent: draft, notes: 'main-agent e2e', cases: [{ title: 't', checks: [{ text: 'c', anchors: ['GOODANCHOR'] }] }],
            })
          } catch { /* write refused — ignore */ }
        }
      }
      return { agent }
    },
  }
  const fakeCtx = {
    logger: { info() {} }, on() {},
    inject(deps, cb) {
      if (deps[0] === 'tools') return cb({ tools: { register(s) { cap[s.name] = s } }, effect: (fn) => fn() })
      if (deps[0] === 'webServer') return cb({ webServer: { register(arg) { handlers[arg.path] = arg.handler; return () => {} } } })
      return cb({ agents: fakeAgents, agentDefaultModel: { currentSelection: () => null }, sessions: { flush() {} }, llm: undefined })
    },
  }
  const r7 = fs.mkdtempSync(path.join(os.tmpdir(), 'seb-selftest-coord-'))
  const skillsRoot7 = path.join(r7, 'skills')
  const ledgerPath7 = path.join(r7, 'ledger.json')
  const evalsPath7 = path.join(r7, 'evals.json')
  const stateDir7 = path.join(r7, 'state')
  fs.mkdirSync(stateDir7, { recursive: true })
  const mkSkill = (name) => { const d = path.join(skillsRoot7, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), 'current body: nothing useful\n', 'utf8') }
  for (const s of ['sev-a', 'sev-b', 'sev-c']) mkSkill(s)
  const mkLedger = () => ({
    generation: 1,
    suggestions: ['sev-a', 'sev-b', 'sev-c'].map((n) => ({ id: 'sug-' + n, skillName: n, action: 'update', status: 'pending', confidence: 0.8, summary: 's' })),
    drafts: [],
  })
  fs.writeFileSync(ledgerPath7, JSON.stringify(mkLedger()), 'utf8')
  fs.writeFileSync(evalsPath7, JSON.stringify({ cases: [], runs: [] }), 'utf8')
  entry.apply(fakeCtx, { ledgerPath: ledgerPath7, evalsPath: evalsPath7, skillsRoot: skillsRoot7, stateDir: stateDir7, allowWrite: true, backupKeep: 5, model: { provider: 'p', model: 'm' }, maxConcurrency: 2 })
  ok(Boolean(cap.skill_evolution_write) && Boolean(handlers['/api/skill-evolution/evolve']), 'apply() registered write tool + evolve route')

  const fakeReq = (method, bodyObj) => { const buf = Buffer.from(JSON.stringify(bodyObj || {})); return { method, on(ev, cb) { if (ev === 'data') cb(buf); else if (ev === 'end') cb() } } }
  const fakeRes = () => ({ statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(b) { this.bodyStr = b ? b.toString('utf8') : '' } })

  // config validation: out-of-range maxConcurrency -> 400; in-range -> 200 + state reflects it
  {
    const res = fakeRes()
    await handlers['/api/skill-evolution/config'](fakeReq('POST', { maxConcurrency: 99 }), res)
    ok(res.statusCode === 400, 'config rejects maxConcurrency=99 with 400', `got ${res.statusCode}`)
    const res2 = fakeRes()
    await handlers['/api/skill-evolution/config'](fakeReq('POST', { maxConcurrency: 5 }), res2)
    ok(res2.statusCode === 200, 'config accepts maxConcurrency=5', `got ${res2.statusCode}`)
    const st = fakeRes(); await handlers['/api/skill-evolution/state'](fakeReq('GET'), st)
    ok(JSON.parse(st.bodyStr).maxConcurrency === 5, 'state reflects maxConcurrency=5')
  }

  const pollUntil = async (skills) => {
    for (let i = 0; i < 300; i++) {
      const r = fakeRes(); await handlers['/api/skill-evolution/jobs'](fakeReq('GET'), r)
      const jobs = JSON.parse(r.bodyStr).jobs.filter((j) => skills.includes(j.skill))
      if (jobs.length && jobs.every((j) => ['done', 'failed'].includes(j.phase))) return jobs
      await delay(20)
    }
    return null
  }

  // evolve must spawn exactly ONE main agent; its prompt carries a concurrency
  // instruction + a subagent-prompt block per skill. Concurrency is a SOFT cap
  // (honoured by the LLM main agent), so no code-enforced state.max assertion.
  agentCreates = 0; lastMainPrompt = ''
  const res = fakeRes()
  await handlers['/api/skill-evolution/evolve'](fakeReq('POST', { skills: ['sev-a', 'sev-b', 'sev-c'] }), res)
  const evBody = JSON.parse(res.bodyStr)
  ok(res.statusCode === 200 && Array.isArray(evBody.queued) && evBody.queued.length === 3, 'evolve returns 200 + 3 queued', `got ${res.statusCode}`)
  ok(evBody.orchestrator === 'main-agent-spawns-subagents', 'evolve reports main-agent orchestrator', `got ${evBody.orchestrator}`)
  const jobs = await pollUntil(['sev-a, sev-b, sev-c'])
  ok(Boolean(jobs), 'main-agent job reached terminal phase', jobs ? '' : 'timed out')
  ok(agentCreates === 1, 'exactly ONE main agent spawned (not per-skill workers)', `agentCreates=${agentCreates}`)
  // m03118: meta.agentPreset alone only writes the session header — the standard
  // preset's delegation group is `isolate: { workflowEngine: true }`, so the
  // spawned agent MUST carry a setup callback that mounts the composition (and
  // thus the `subagent` tool). Assert both the shape and the mount call.
  ok(lastCreateOpts && lastCreateOpts.meta && lastCreateOpts.meta.agentPreset === 'standard', 'agents.create sets meta.agentPreset=standard')
  ok(typeof lastCreateOpts?.setup === 'function', 'agents.create passes a setup callback')
  let mountCalledWith = null
  const fakeAgentCtx = {
    get(name) {
      if (name === 'agentPresets') return { mount: async (ctx, id) => { mountCalledWith = id } }
      return undefined
    },
  }
  await lastCreateOpts.setup(fakeAgentCtx, {})
  ok(mountCalledWith === 'standard', "setup mounts the 'standard' preset composition", `mountCalledWith=${mountCalledWith}`)
  if (jobs) {
    const j = jobs[0]
    ok(j.skillCount === 3, 'main-agent job tracks skillCount=3', `skillCount=${j.skillCount}`)
    ok(j.maxConcurrency === 5, 'main-agent job records maxConcurrency', `maxConcurrency=${j.maxConcurrency}`)
    ok(j.phase === 'done', 'main-agent job phase done', `phase=${j.phase}`)
    ok(!('agent' in j) && !('done' in j), 'publicJob strips agent/done internals')
  }
  ok(/at most 5 subagent/i.test(lastMainPrompt), 'main prompt carries concurrency instruction (at most 5)', lastMainPrompt ? '' : 'no prompt captured')
  ok(lastMainPrompt.includes('=== SUBAGENT PROMPT FOR SKILL: sev-a ===') && lastMainPrompt.includes('=== SUBAGENT PROMPT FOR SKILL: sev-c ==='), 'main prompt embeds per-skill subagent prompts')

  // second run: cap=1 still spawns one main agent; prompt reflects the new cap
  agentCreates = 0; lastMainPrompt = ''
  {
    const res = fakeRes(); await handlers['/api/skill-evolution/config'](fakeReq('POST', { maxConcurrency: 1 }), res)
    ok(res.statusCode === 200, 'config set cap=1')
  }
  fs.writeFileSync(ledgerPath7, JSON.stringify(mkLedger()), 'utf8') // reset suggestions to pending
  const res2 = fakeRes()
  await handlers['/api/skill-evolution/evolve'](fakeReq('POST', { skills: ['sev-a', 'sev-b', 'sev-c'] }), res2)
  await pollUntil(['sev-a, sev-b, sev-c'])
  ok(agentCreates === 1, 'second run also spawns exactly one main agent', `agentCreates=${agentCreates}`)
  ok(/at most 1 subagent/i.test(lastMainPrompt), 'main prompt reflects updated cap (at most 1)', '')
}

// ---- 8. frontmatter load gate (m01144): mirror DSH's parseSkillFile ----
// `skill_evolution_write` must reject a draft whose SKILL.md frontmatter DSH
// itself cannot load, instead of letting a broken draft reach 'ready' and blow
// up later when Mnemon lands it. We use the SAME vendored yaml@2.9.1 DSH uses,
// and replicate every gate DSH checks, including its exact error wording.
console.log('\n[8] frontmatter load gate (validateSkillFrontmatter)')
{
  const entry = await import(pathToFileURL(path.join(import.meta.dirname, 'index.js')).href + '?selftest8=' + Date.now())
  const validate = entry.validateSkillFrontmatter
  ok(typeof validate === 'function', 'validateSkillFrontmatter is exported')

  const goodFront = (extra = '') =>
`---
name: bsk-cli-cooperate-fallback
description: 先后台拉起 bsk daemon 并轮询到 browsers connected 1
whenToUse: 注入工具被拒时${extra}
---`

  const throws = (label, content, mustInclude) => {
    let msg = ''
    try { validate(content) } catch (e) { msg = String((e && e.message) || e) }
    const pass = msg.length > 0 && (!mustInclude || msg.includes(mustInclude))
    ok(pass, `${label} throws${mustInclude ? ` ("${mustInclude}")` : ''}`, pass ? '' : `got "${msg}"`)
  }
  const passes = (label, content) => {
    let msg = '', okThrew = false
    try { validate(content) } catch (e) { okThrew = true; msg = String((e && e.message) || e) }
    ok(!okThrew, `${label} passes`, okThrew ? `unexpected throw "${msg}"` : '')
  }

  // The exact class of error the user hit: an unclosed double quote in the
  // frontmatter (DSH logs "Missing closing 'quote at line N, column M"). The
  // scalar must START with the quote for YAML to treat it as quoted and then
  // fail to find the closing quote.
  const unclosedQuote = goodFront().replace('description: 先后台拉起 bsk daemon 并轮询到 browsers connected 1', 'description: "unterminated string')
  throws('unclosed double quote → invalid YAML frontmatter', unclosedQuote, 'invalid YAML frontmatter')

  // A draft with no frontmatter block at all.
  throws('no opening "---" → missing YAML frontmatter', '# Just a body\n\nno frontmatter here', 'missing YAML frontmatter')
  throws('no closing "---" → missing closing', '---\nname: x\ndescription: y', 'missing closing')
  // Frontmatter parses to a YAML sequence, not a mapping.
  throws('frontmatter is a list, not a mapping', '---\n- a\n- b\n---', 'mapping')
  // Mandatory fields.
  throws('missing name', '---\ndescription: y\n---', 'requires name and description')
  throws('missing description', '---\nname: x\n---', 'requires name and description')
  // Skill name must be kebab-case (lower-case letters/digits, hyphen-separated).
  throws('bad skill name (uppercase + underscore)', '---\nname: Bad_Name\ndescription: y\n---', 'invalid skill name')
  // Legacy invocation keys are rejected with a "use X" hint.
  throws('legacy disableModelInvocation rejected', '---\nname: x\ndescription: y\ndisableModelInvocation: true\n---', 'unsupported; use "disable-model-invocation"')
  // Invocation booleans must be typed.
  throws('non-boolean invocation field', '---\nname: x\ndescription: y\ndisable-model-invocation: "maybe"\n---', 'must be a boolean')
  // metadata must be a mapping.
  throws('metadata as array rejected', '---\nname: x\ndescription: y\nmetadata: [a, b]\n---', 'metadata')

  // Valid variants must pass.
  passes('valid minimal frontmatter', goodFront())
  passes('valid with invocation booleans', goodFront('\ndisable-model-invocation: true\nuser-invocable: false'))
  passes('valid with metadata mapping', goodFront('\nmetadata:\n  source: panel'))

  // Integration: the REAL write tool must refuse a broken draft (and throw
  // BEFORE any ledger write), while a good draft lands a status=ready draft.
  const cap = {}
  const fakeCtx = {
    logger: { info() {} }, on() {},
    inject(deps, cb) {
      if (deps[0] === 'tools') return cb({ tools: { register(s) { cap[s.name] = s } }, effect: (fn) => fn() })
      if (deps[0] === 'webServer') return cb({ webServer: { register() { return () => {} } } })
      return cb({ agents: undefined, agentDefaultModel: undefined, sessions: undefined, llm: undefined })
    },
  }
  const r8 = fs.mkdtempSync(path.join(os.tmpdir(), 'seb-selftest-fm-'))
  const skillsRoot8 = path.join(r8, 'skills')
  const skillDir8 = path.join(skillsRoot8, 'fm-skill')
  fs.mkdirSync(skillDir8, { recursive: true })
  fs.writeFileSync(path.join(skillDir8, 'SKILL.md'), 'current body\n', 'utf8')
  const ledgerPath8 = path.join(r8, 'ledger.json')
  const evalsPath8 = path.join(r8, 'evals.json')
  const stateDir8 = path.join(r8, 'state')
  fs.mkdirSync(stateDir8, { recursive: true })
  fs.writeFileSync(ledgerPath8, JSON.stringify({
    generation: 1, suggestions: [{ id: 'fm-sug', skillName: 'fm-skill', action: 'update', status: 'pending' }], drafts: [],
  }, null, 2), 'utf8')
  fs.writeFileSync(evalsPath8, JSON.stringify({ cases: [], runs: [] }, null, 2), 'utf8')
  entry.apply(fakeCtx, {
    ledgerPath: ledgerPath8, evalsPath: evalsPath8, skillsRoot: skillsRoot8,
    stateDir: stateDir8, allowWrite: true, backupKeep: 5, model: { provider: 'p', model: 'm' },
  })
  const badDraft = unclosedQuote + '\n\n# body\nGOODANCHOR here\n'
  let threwWrite = '', wroteLedger = false
  try {
    await cap.skill_evolution_write.execute({
      skillName: 'fm-skill', suggestionId: 'fm-sug', action: 'update',
      draftContent: badDraft, notes: 'broken', cases: [{ title: 't', checks: [{ text: 'c', anchors: ['GOODANCHOR'] }] }],
    })
  } catch (e) { threwWrite = String((e && e.message) || e) }
  ok(Boolean(threwWrite) && threwWrite.includes('invalid YAML frontmatter'), 'REAL write tool refuses broken frontmatter', threwWrite)
  const afterBad = JSON.parse(fs.readFileSync(ledgerPath8, 'utf8'))
  wroteLedger = afterBad.drafts && afterBad.drafts.length > 0
  ok(!wroteLedger, 'broken draft did NOT land in ledger (fail fast before write)')

  // A good draft still lands a status=ready draft.
  const goodDraft = goodFront() + '\n\n# body\nGOODANCHOR here\n'
  let goodOut, goodThrew = ''
  try {
    goodOut = JSON.parse(await cap.skill_evolution_write.execute({
      skillName: 'fm-skill', suggestionId: 'fm-sug', action: 'update',
      draftContent: goodDraft, notes: 'ok', cases: [{ title: 't', checks: [{ text: 'c', anchors: ['GOODANCHOR'] }] }],
    }))
  } catch (e) { goodThrew = String((e && e.message) || e) }
  ok(!goodThrew && goodOut && goodOut.dryRun === false && Boolean(goodOut.draftId), 'REAL write tool lands good draft', goodThrew)
}

// ---- 9. /api/skill-evolution/run server-side bridge (harness -> real LLM judge) ----
// A standalone session harness cannot call the cordis tools directly; it POSTs to
// this route. The route must dispatch to the SAME backtestImpl/writeImpl/verifyImpl
// the agent tools use, so the LLM semantic judge (not the anchor-only gradeBody)
// is reached. A fake llm.stream proves the LLM verdict flows through the route.
console.log('\n[9] /api/skill-evolution/run dispatches to the real pipeline (LLM judge)')
{
  const entry = await import(pathToFileURL(path.join(import.meta.dirname, 'index.js')).href + '?selftest9=' + Date.now())
  const cap9 = {}
  const handlers9 = {}
  const fakeLlm = {
    async *stream() {
      yield { type: 'text-delta', text: JSON.stringify([{ id: 'k1', pass: true, reason: 'route reaches llm judge' }]) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const fakeCtx9 = {
    logger: { info() {} }, on() {},
    inject(deps, cb) {
      if (deps[0] === 'tools') return cb({ tools: { register(s) { cap9[s.name] = s } }, effect: (fn) => fn() })
      if (deps[0] === 'webServer') return cb({ webServer: { register(arg) { handlers9[arg.path] = arg.handler; return () => {} } } })
      return cb({ agents: undefined, agentDefaultModel: { currentSelection: () => null }, sessions: { flush() {} }, llm: fakeLlm })
    },
  }
  const r9 = fs.mkdtempSync(path.join(os.tmpdir(), 'seb-selftest-run-'))
  const skillsRoot9 = path.join(r9, 'skills')
  const skillDir9 = path.join(skillsRoot9, 'rt-skill')
  fs.mkdirSync(skillDir9, { recursive: true })
  fs.writeFileSync(path.join(skillDir9, 'SKILL.md'), 'current body\n', 'utf8')
  const ledgerPath9 = path.join(r9, 'ledger.json')
  const evalsPath9 = path.join(r9, 'evals.json')
  const stateDir9 = path.join(r9, 'state')
  fs.mkdirSync(stateDir9, { recursive: true })
  fs.writeFileSync(ledgerPath9, JSON.stringify({
    generation: 1, suggestions: [{ id: 'rt-sug', skillName: 'rt-skill', action: 'update', status: 'pending' }], drafts: [],
  }, null, 2), 'utf8')
  fs.writeFileSync(evalsPath9, JSON.stringify({ cases: [], runs: [] }, null, 2), 'utf8')
  entry.apply(fakeCtx9, {
    ledgerPath: ledgerPath9, evalsPath: evalsPath9, skillsRoot: skillsRoot9,
    stateDir: stateDir9, allowWrite: true, backupKeep: 5, model: { provider: 'p', model: 'm' },
    gradeEngine: 'auto',
  })
  ok(Boolean(handlers9['/api/skill-evolution/run']), 'apply() registered /api/skill-evolution/run route')
  const fakeReq9 = (method, bodyObj) => { const buf = Buffer.from(JSON.stringify(bodyObj || {})); return { method, on(ev, cb) { if (ev === 'data') cb(buf); else if (ev === 'end') cb() } } }
  const fakeRes9 = () => ({ statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(b) { this.bodyStr = b ? b.toString('utf8') : '' } })

  // backtest via route: the LLM verdict must reach the result (engine === 'llm').
  {
    const res = fakeRes9()
    await handlers9['/api/skill-evolution/run'](fakeReq9('POST', {
      op: 'backtest', skillName: 'rt-skill', draftContent: 'improved body',
      cases: [{ id: 'c1', title: 't', checks: [{ id: 'k1', text: 'c', must: true, anchors: ['GOODANCHOR'] }] }],
    }), res)
    const body = JSON.parse(res.bodyStr)
    ok(body.ok === true && body.result && body.result.engine && body.result.engine.after === 'llm', 'run op=backtest reaches LLM judge (engine=llm)', JSON.stringify(body).slice(0, 200))
  }

  // write via route lands a ready draft.
  let wBody
  {
    const res = fakeRes9()
    await handlers9['/api/skill-evolution/run'](fakeReq9('POST', {
      op: 'write', skillName: 'rt-skill', suggestionId: 'rt-sug', action: 'update',
      draftContent: '---\nname: rt-skill\ndescription: run route\n---\n\n# rt-skill\n\nGOODANCHOR here\n', notes: 'route write',
      cases: [{
        id: 'c1', title: 't',
        checks: [
          { id: 'k1', text: 'c1', must: true, anchors: ['GOODANCHOR'] },
          { id: 'k2', text: 'c2', must: true, anchors: ['GOODANCHOR'] },
          { id: 'k3', text: 'c3', must: true, anchors: ['GOODANCHOR'] },
          { id: 'k4', text: 'c4', must: true, anchors: ['GOODANCHOR'] },
          { id: 'k5', text: 'c5', must: true, anchors: ['GOODANCHOR'] },
          { id: 'k6', text: 'c6', must: true, anchors: ['GOODANCHOR'] },
        ],
      }],
    }), res)
    wBody = JSON.parse(res.bodyStr)
  }
  ok(wBody.ok === true && Boolean(wBody.result && wBody.result.draftId), 'run op=write lands draft via route')

  // verify via route on the landed draft.
  {
    const res = fakeRes9()
    await handlers9['/api/skill-evolution/run'](fakeReq9('POST', { op: 'verify', draftId: wBody.result.draftId }), res)
    const body = JSON.parse(res.bodyStr)
    ok(body.ok === true && body.result && body.result.allOk === true, 'run op=verify returns allOk on landed draft', JSON.stringify(body).slice(0, 200))
  }

  // negative: unknown op -> 400.
  {
    const res = fakeRes9()
    await handlers9['/api/skill-evolution/run'](fakeReq9('POST', { op: 'bogus' }), res)
    ok(res.statusCode === 400, 'run rejects unknown op with 400', `got ${res.statusCode}`)
  }
}

console.log(`\n${failures === 0 ? 'SELFTEST PASS' : `SELFTEST FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)