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
  E.runs.unshift(ar, br)
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

// [8b] benign multi-case verify (singleCaseFocused demoted). A multi-subpoint
// improvement legitimately lands one case per subpoint, which sets
// checks.singleCaseFocused=false. That flag is informational, not a defect gate
// (the coarse-granularity guard is granularityOk). Assert the REAL verify now
// reports allOk=true for a benign multi-case draft while STILL surfacing
// singleCaseFocused=false honestly in checks (flag not stripped).
console.log('\n[8b] REAL verify treats benign multi-case as allOk=true (singleCaseFocused demoted)')
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
  const r8b = fs.mkdtempSync(path.join(os.tmpdir(), 'seb-selftest-multicase-'))
  const skillsRoot8b = path.join(r8b, 'skills')
  const skillDir8b = path.join(skillsRoot8b, 'multi-case-skill')
  fs.mkdirSync(skillDir8b, { recursive: true })
  const body8b = '# Multi Case Skill\n\nnothing here yet\n'
  fs.writeFileSync(path.join(skillDir8b, 'SKILL.md'), body8b, 'utf8')
  const ledgerPath8b = path.join(r8b, 'ledger.json')
  const evalsPath8b = path.join(r8b, 'evals.json')
  const stateDir8b = path.join(r8b, 'state')
  fs.mkdirSync(stateDir8b, { recursive: true })
  fs.writeFileSync(ledgerPath8b, JSON.stringify({
    generation: 3,
    suggestions: [{ id: 'r8b-sug', skillName: 'multi-case-skill', action: 'update', status: 'pending', summary: 's' }],
    drafts: [],
  }, null, 2), 'utf8')
  fs.writeFileSync(evalsPath8b, JSON.stringify({ cases: [], runs: [] }, null, 2), 'utf8')
  entry.apply(fakeCtx, {
    ledgerPath: ledgerPath8b, evalsPath: evalsPath8b, skillsRoot: skillsRoot8b,
    stateDir: stateDir8b, allowWrite: true, backupKeep: 5, model: { provider: 'p', model: 'm' },
  })
  const draft8b = `---\nname: multi-case-skill\ndescription: benign multi-case verify regression fixture\n---\n\n` + body8b + '\n\n## Subpoint A\n\nalpha anchor lives here.\n\n## Subpoint B\n\nbeta anchor lives here.\n'
  // Two subpoints, one case each, 6 checks per case (granularityOk satisfied),
  // every anchor hits draft-only text (Subpoint A / Subpoint B sections).
  const mkCase = (id, anchor) => ({
    id, title: 'subpoint ' + id,
    checks: [1, 2, 3, 4, 5, 6].map((n) => ({ text: anchor + ' check ' + n, anchors: [anchor] })),
  })
  const args8b = {
    skillName: 'multi-case-skill', suggestionId: 'r8b-sug', action: 'update',
    draftContent: draft8b, notes: 'benign multi-case verify regression',
    cases: [mkCase('c1', 'alpha anchor'), mkCase('c2', 'beta anchor')],
  }
  let out8b, threw8b = ''
  try { out8b = JSON.parse(await cap.skill_evolution_write.execute(args8b)) }
  catch (e) { threw8b = String((e && e.message) || e) }
  ok(!threw8b, 'multi-case write did not throw', threw8b)
  if (out8b) {
    const v8b = JSON.parse(cap.skill_evolution_verify.execute({ draftId: out8b.draftId }))
    const c8b = v8b.results && v8b.results[0] && v8b.results[0].checks
    ok(v8b.allOk === true, 'benign multi-case verify reports allOk=true', JSON.stringify(c8b))
    ok(c8b && c8b.singleCaseFocused === false, 'singleCaseFocused still surfaced as false (flag kept, not stripped)', JSON.stringify(c8b))
    ok(c8b && c8b.granularityOk === true, 'granularityOk true (real coarse gate still enforced)', JSON.stringify(c8b))
    ok(fs.readFileSync(path.join(skillDir8b, 'SKILL.md'), 'utf8') === body8b, 'live SKILL.md untouched (8b)')
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
  await handlers['/api/skill-evolution/evolve'](fakeReq('POST', { skills: ['sev-a', 'sev-b', 'sev-c'], evolutionMode: 'legacy' }), res)
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
  await handlers['/api/skill-evolution/evolve'](fakeReq('POST', { skills: ['sev-a', 'sev-b', 'sev-c'], evolutionMode: 'legacy' }), res2)
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

// ---- 10. skill_evolution_score freezes the rubric; before is reused verbatim ----
// The user's fairness gate: score the CURRENT live SKILL.md first, then pass that
// baseline into backtest/write so before and after share one frozen rubric. A
// baseline whose casesHash or baseHash drifted must be rejected, never recomputed
// silently (that would reintroduce the distortion the gate is meant to prevent).
console.log('\n[10] skill_evolution_score freezes a baseline; before reuse + drift rejection')
{
  const entry = await import(pathToFileURL(path.join(import.meta.dirname, 'index.js')).href + '?selftest10=' + Date.now())
  const cap10 = {}
  const handlers10 = {}
  const fakeLlm = {
    async *stream() {
      yield { type: 'text-delta', text: JSON.stringify([{ id: 'k1', pass: true, reason: 'rubric frozen' }]) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const fakeCtx10 = {
    logger: { info() {} }, on() {},
    inject(deps, cb) {
      if (deps[0] === 'tools') return cb({ tools: { register(s) { cap10[s.name] = s } }, effect: (fn) => fn() })
      if (deps[0] === 'webServer') return cb({ webServer: { register(arg) { handlers10[arg.path] = arg.handler; return () => {} } } })
      return cb({ agents: undefined, agentDefaultModel: { currentSelection: () => null }, sessions: { flush() {} }, llm: fakeLlm })
    },
  }
  const r10 = fs.mkdtempSync(path.join(os.tmpdir(), 'seb-selftest-score-'))
  const skillsRoot10 = path.join(r10, 'skills')
  const skillDir10 = path.join(skillsRoot10, 'score-skill')
  fs.mkdirSync(skillDir10, { recursive: true })
  const skillFile10 = path.join(skillDir10, 'SKILL.md')
  fs.writeFileSync(skillFile10, 'CURRENT BODY\n', 'utf8')
  const ledgerPath10 = path.join(r10, 'ledger.json')
  const evalsPath10 = path.join(r10, 'evals.json')
  const stateDir10 = path.join(r10, 'state')
  fs.mkdirSync(stateDir10, { recursive: true })
  fs.writeFileSync(ledgerPath10, JSON.stringify({
    generation: 1, suggestions: [{ id: 'sc-sug', skillName: 'score-skill', action: 'update', status: 'pending' }], drafts: [],
  }, null, 2), 'utf8')
  fs.writeFileSync(evalsPath10, JSON.stringify({ cases: [], runs: [] }, null, 2), 'utf8')
  entry.apply(fakeCtx10, {
    ledgerPath: ledgerPath10, evalsPath: evalsPath10, skillsRoot: skillsRoot10,
    stateDir: stateDir10, allowWrite: true, backupKeep: 5, model: { provider: 'p', model: 'm' },
    gradeEngine: 'auto',
  })

  ok(Boolean(cap10['skill_evolution_score']), 'skill_evolution_score tool is registered')
  ok(Boolean(cap10['skill_evolution_backtest']) && Boolean(cap10['skill_evolution_write']), 'backtest + write tools registered')

  const scoreCases = [{ id: 'c1', title: 't', checks: [{ id: 'k1', text: 'c', must: true, anchors: ['CURRENT'] }] }]
  const callScore = async () => JSON.parse(await cap10['skill_evolution_score'].execute({ skillName: 'score-skill', cases: scoreCases }))
  const callBacktest = async (args) => JSON.parse(await cap10['skill_evolution_backtest'].execute({
    skillName: 'score-skill', draftContent: 'IMPROVED BODY\n', cases: scoreCases, ...args,
  }))

  // (a) score returns a self-contained baseline with both hashes.
  const scored = await callScore()
  ok(scored && scored.baseHash && scored.casesHash, 'score returns baseHash + casesHash')
  ok(Boolean(scored.baseline && scored.baseline.casesHash === scored.casesHash), 'score baseline carries the same casesHash')
  ok(typeof scored.score === 'number' && scored.caseRows && scored.caseRows.length === 1, 'score returns a numeric score + caseRows', JSON.stringify(scored).slice(0, 160))

  // (b) before is reused verbatim, beforeReused flagged true, score equal.
  const reused = await callBacktest({ before: scored.baseline })
  ok(reused.beforeReused === true, 'backtest beforeReused=true when baseline supplied')
  ok(reused.before.score === scored.score, 'reused before score equals the frozen baseline score', `${reused.before.score} vs ${scored.score}`)
  ok(reused.baseHash === scored.baseHash, 'backtest echoes the same baseHash')

  // (c) DIAGNOSTIC fallback: frozen cases changed -> the diagnostic backtest must
  // NOT throw / drop the after score. It falls back to grading the current body
  // under the SAME rubric and records beforeFallback with the rejection reason.
  // (The strict fairness gate that REJECTS a drifted baseline lives in
  // skill_evolution_write, not in this read-only diagnostic — m02504.)
  const drifted = await callBacktest({ before: scored.baseline, cases: [{ id: 'c1', title: 't', checks: [{ id: 'k1', text: 'CHANGED', must: true }] }] })
  ok(typeof drifted.after?.score === 'number', 'backtest still returns an after score under a casesHash-drifted baseline', JSON.stringify(drifted).slice(0, 160))
  ok(drifted.beforeReused === false, 'casesHash-drifted baseline is not reused (beforeReused=false)')
  ok(typeof drifted.beforeFallback === 'string' && (drifted.beforeFallback.includes('casesHash') || drifted.beforeFallback.includes('评测标准变更')), 'casesHash drift reason recorded in beforeFallback', `got "${drifted.beforeFallback}"`)

  // (d) DIAGNOSTIC fallback: live file changed -> baseHash drift. Same contract:
  // after score still returned, beforeFallback records the baseHash rejection.
  fs.writeFileSync(skillFile10, 'CURRENT BODY EDITED\n', 'utf8')
  const driftedHash = await callBacktest({ before: scored.baseline })
  ok(typeof driftedHash.after?.score === 'number', 'backtest still returns an after score under a baseHash-drifted baseline', JSON.stringify(driftedHash).slice(0, 160))
  ok(driftedHash.beforeReused === false, 'baseHash-drifted baseline is not reused (beforeReused=false)')
  ok(typeof driftedHash.beforeFallback === 'string' && (driftedHash.beforeFallback.includes('baseHash') || driftedHash.beforeFallback.includes('SKILL.md 变更')), 'baseHash drift reason recorded in beforeFallback', `got "${driftedHash.beforeFallback}"`)

  // (e) write reuses the frozen baseline and lands a ready draft.
  fs.writeFileSync(skillFile10, 'CURRENT BODY\n', 'utf8')
  const scCases = [{
    id: 'c1', title: 't',
    checks: [{ id: 'k1', text: 'c1', must: true, anchors: ['CURRENT'] }, { id: 'k2', text: 'c2', must: true, anchors: ['CURRENT'] }, { id: 'k3', text: 'c3', must: true }, { id: 'k4', text: 'c4', must: true }, { id: 'k5', text: 'c5', must: true }, { id: 'k6', text: 'c6', must: true }],
  }]
  const scored2 = JSON.parse(await cap10['skill_evolution_score'].execute({ skillName: 'score-skill', cases: scCases }))
  const written = JSON.parse(await cap10['skill_evolution_write'].execute({
    skillName: 'score-skill', suggestionId: 'sc-sug', action: 'update', draftContent: '---\nname: score-skill\ndescription: score gate\n---\n\n# score-skill\n\nCURRENT BODY\n',
    notes: 'before-reuse gate', cases: scCases, before: scored2.baseline,
  }))
  ok(written && written.dryRun === false && written.beforeScore === scored2.score, 'write reuses frozen before score (landed draft)', JSON.stringify(written).slice(0, 200))

  // (f) /run route dispatches op=score to the same pipeline.
  {
    const res = (() => { const o = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(b) { this.bodyStr = b ? b.toString('utf8') : '' } }; return o })()
    const buf = Buffer.from(JSON.stringify({ op: 'score', skillName: 'score-skill', cases: scCases }))
    await handlers10['/api/skill-evolution/run']({ method: 'POST', on(ev, cb) { if (ev === 'data') cb(buf); else if (ev === 'end') cb() } }, res)
    const body = JSON.parse(res.bodyStr)
    ok(body.ok === true && body.result && body.result.baseline, 'run op=score returns a baseline', JSON.stringify(body).slice(0, 160))
  }
}

// ---- 11. runtime concurrency is user-selectable (1..16); 1 = serial, >1 = concurrent ----
// The user keeps BOTH modes: 1 = OLD serial mode, >1 = NEW concurrent mode. The
// number is chosen at trigger time via the request body (maxConcurrency, or the
// concurrency alias), falling back to the panel config. The resolved value must
// reach the spawned main agent (it carries the soft cap in its prompt) and be
// reported back to the panel. Out-of-range values must 400.
console.log('\\n[11] /evolve runtime concurrency: user-selectable 1..16, serial vs concurrent')
{
  const entry = await import(pathToFileURL(path.join(import.meta.dirname, 'index.js')).href + '?selftest11=' + Date.now())
  const cap11 = {}
  const handlers11 = {}
  let lastMainPrompt11 = ''
  const delay11 = (ms) => new Promise((r) => setTimeout(r, ms))
  const fakeAgents11 = {
    async create(opts) {
      const agent = { session: { id: opts.sessionId }, _p: '' }
      agent.followup = async ({ content }) => { agent._p = (content && content[0] && content[0].text) || '' }
      agent.whenIdle = async () => { lastMainPrompt11 = agent._p }
      return { agent }
    },
  }
  const fakeCtx11 = {
    logger: { info() {} }, on() {},
    inject(deps, cb) {
      if (deps[0] === 'tools') return cb({ tools: { register(s) { cap11[s.name] = s } }, effect: (fn) => fn() })
      if (deps[0] === 'webServer') return cb({ webServer: { register(arg) { handlers11[arg.path] = arg.handler; return () => {} } } })
      return cb({ agents: fakeAgents11, agentDefaultModel: { currentSelection: () => null }, sessions: { flush() {} }, llm: undefined })
    },
  }
  const r11 = fs.mkdtempSync(path.join(os.tmpdir(), 'seb-selftest-conc-'))
  const skillsRoot11 = path.join(r11, 'skills')
  for (const s of ['conc-a', 'conc-b']) { const d = path.join(skillsRoot11, s); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), 'body\\n', 'utf8') }
  fs.writeFileSync(path.join(r11, 'ledger.json'), JSON.stringify({
    generation: 1, suggestions: ['conc-a', 'conc-b'].map((n) => ({ id: 'sug-' + n, skillName: n, action: 'update', status: 'pending' })), drafts: [],
  }), 'utf8')
  fs.writeFileSync(path.join(r11, 'evals.json'), JSON.stringify({ cases: [], runs: [] }), 'utf8')
  fs.mkdirSync(path.join(r11, 'state'), { recursive: true })
  entry.apply(fakeCtx11, {
    ledgerPath: path.join(r11, 'ledger.json'), evalsPath: path.join(r11, 'evals.json'),
    skillsRoot: skillsRoot11, stateDir: path.join(r11, 'state'), allowWrite: true, backupKeep: 5,
    model: { provider: 'p', model: 'm' }, maxConcurrency: 2,
  })
  const fakeReq11 = (bodyObj) => { const buf = Buffer.from(JSON.stringify(bodyObj || {})); return { method: 'POST', on(ev, cb) { if (ev === 'data') cb(buf); else if (ev === 'end') cb() } } }
  const fakeRes11 = () => ({ statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(b) { this.bodyStr = b ? b.toString('utf8') : '' } })
  const evolve11 = async (bodyObj) => {
    const res = fakeRes11()
    await handlers11['/api/skill-evolution/evolve'](fakeReq11(bodyObj), res)
    return { status: res.statusCode, body: res.bodyStr ? JSON.parse(res.bodyStr) : null }
  }

  // (a) default: no body field -> falls back to panel config (2); mode=concurrent.
  lastMainPrompt11 = ''
  const a = await evolve11({ skills: ['conc-a', 'conc-b'], evolutionMode: 'legacy' })
  await delay11(80)
  ok(a.status === 200 && a.body.maxConcurrency === 2 && a.body.mode === 'concurrent', 'default concurrency falls back to config (2, concurrent)', JSON.stringify(a.body).slice(0, 160))
  ok(/at most 2 subagents/.test(lastMainPrompt11), 'main agent prompt carries resolved concurrency=2', `prompt has: ${/at most \d+ subagents/.test(lastMainPrompt11)}`)

  // (b) maxConcurrency=1 -> OLD serial mode.
  const b = await evolve11({ skills: ['conc-a'], maxConcurrency: 1, evolutionMode: 'legacy' })
  ok(b.status === 200 && b.body.maxConcurrency === 1 && b.body.mode === 'serial', 'maxConcurrency=1 reports serial mode', JSON.stringify(b.body).slice(0, 160))

  // (c) concurrency alias (4) is honored.
  lastMainPrompt11 = ''
  const c = await evolve11({ skills: ['conc-a'], concurrency: 4, evolutionMode: 'legacy' })
  await delay11(80)
  ok(c.status === 200 && c.body.maxConcurrency === 4 && c.body.mode === 'concurrent', 'concurrency alias=4 honored', JSON.stringify(c.body).slice(0, 160))
  ok(/at most 4 subagents/.test(lastMainPrompt11), 'main agent prompt carries resolved concurrency=4')

  // (d) NEGATIVE: out-of-range (>16) -> 400.
  const d = await evolve11({ skills: ['conc-a'], maxConcurrency: 99, evolutionMode: 'legacy' })
  ok(d.status === 400, 'maxConcurrency=99 rejected with 400', `got ${d.status}`)

  // (e) NEGATIVE: non-finite -> 400.
  const e = await evolve11({ skills: ['conc-a'], maxConcurrency: 'x', evolutionMode: 'legacy' })
  ok(e.status === 400, 'non-numeric maxConcurrency rejected with 400', `got ${e.status}`)
}

// ---- SECTION 12: /evolve mode dispatch (v1.16.0): new=code state machine, legacy=LLM main agent ----
console.log('\\n[12] /evolve evolutionMode: new (code state machine) vs legacy (LLM main agent)')
{
  const entry = await import(pathToFileURL(path.join(import.meta.dirname, 'index.js')).href + '?selftest12=' + Date.now())
  const cap12 = {}
  const handlers12 = {}
  let lastMainPrompt12 = ''
  const delay12 = (ms) => new Promise((r) => setTimeout(r, ms))
  const fakeAgents12 = {
    async create(opts) {
      const agent = { session: { id: opts.sessionId }, _p: '' }
      agent.followup = async ({ content }) => { agent._p = (content && content[0] && content[0].text) || '' }
      agent.whenIdle = async () => { lastMainPrompt12 = agent._p }
      return { agent }
    },
  }
  // llm is deliberately ABSENT here so the new-mode dependency gate is testable.
  const fakeCtx12 = {
    logger: { info() {} }, on() {},
    inject(deps, cb) {
      if (deps[0] === 'tools') return cb({ tools: { register(s) { cap12[s.name] = s } }, effect: (fn) => fn() })
      if (deps[0] === 'webServer') return cb({ webServer: { register(arg) { handlers12[arg.path] = arg.handler; return () => {} } } })
      return cb({ agents: fakeAgents12, agentDefaultModel: { currentSelection: () => null }, sessions: { flush() {} }, llm: undefined })
    },
  }
  const r12 = fs.mkdtempSync(path.join(os.tmpdir(), 'seb-selftest-mode-'))
  const skillsRoot12 = path.join(r12, 'skills')
  for (const s of ['mode-a', 'mode-b']) { const d = path.join(skillsRoot12, s); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), 'body\\n', 'utf8') }
  fs.writeFileSync(path.join(r12, 'ledger.json'), JSON.stringify({
    generation: 1, suggestions: ['mode-a', 'mode-b'].map((n) => ({ id: 'sug-' + n, skillName: n, action: 'update', status: 'pending' })), drafts: [],
  }), 'utf8')
  fs.writeFileSync(path.join(r12, 'evals.json'), JSON.stringify({ cases: [], runs: [] }), 'utf8')
  fs.mkdirSync(path.join(r12, 'state'), { recursive: true })
  entry.apply(fakeCtx12, {
    ledgerPath: path.join(r12, 'ledger.json'), evalsPath: path.join(r12, 'evals.json'),
    skillsRoot: skillsRoot12, stateDir: path.join(r12, 'state'), allowWrite: true, backupKeep: 5,
    model: { provider: 'p', model: 'm' }, maxConcurrency: 2, evolutionMode: 'new',
  })
  const fakeReq12 = (bodyObj) => { const buf = Buffer.from(JSON.stringify(bodyObj || {})); return { method: 'POST', on(ev, cb) { if (ev === 'data') cb(buf); else if (ev === 'end') cb() } } }
  const fakeRes12 = () => ({ statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(b) { this.bodyStr = b ? b.toString('utf8') : '' } })
  const evolve12 = async (bodyObj) => {
    const req = fakeReq12(bodyObj); const res = fakeRes12()
    await handlers12['/api/skill-evolution/evolve'](req, res)
    return { status: res.statusCode, body: JSON.parse(res.bodyStr || '{}') }
  }
  ok(typeof handlers12['/api/skill-evolution/evolve'] === 'function', 'evolve12 handler registered')

  // (a) default mode = new = CODE state machine. It needs ONLY the host llm;
  // with llm absent it must answer 503 rather than spawn an LLM main agent.
  const a12 = await evolve12({ skills: ['mode-a'] })
  ok(a12.status === 503 && /llm/i.test(a12.body.error || ''), 'new mode without host llm -> 503 (code state machine dependency gate)', `got ${a12.status} err=${a12.body.error}`)
  ok(!/main-agent/.test(a12.body.error || ''), 'new mode 503 does NOT blame the agents service', a12.body.error)

  // (b) legacy = the ORIGINAL LLM main-agent orchestrator, kept verbatim.
  lastMainPrompt12 = ''
  const b12 = await evolve12({ skills: ['mode-a'], evolutionMode: 'legacy' })
  await delay12(80)
  ok(b12.status === 200 && b12.body.evolutionMode === 'legacy', 'evolutionMode=legacy in response', JSON.stringify(b12.body).slice(0, 160))
  ok(b12.body.orchestrator === 'main-agent-spawns-subagents', 'legacy reports main-agent orchestrator', `got ${b12.body.orchestrator}`)
  ok(/LEGACY mode/.test(lastMainPrompt12), 'legacy-mode prompt says LEGACY mode')
  ok(/you never grade yourself/.test(lastMainPrompt12), 'legacy-mode prompt: main agent does not grade')

  // (c) NEGATIVE: invalid evolutionMode -> 400
  const c12 = await evolve12({ skills: ['mode-a'], evolutionMode: 'turbo' })
  ok(c12.status === 400 && /new.*legacy/.test(c12.body.error || ''), 'invalid evolutionMode rejected with 400', `got ${c12.status} err=${c12.body.error}`)
}

// ---- SECTION 13: v1.17.0 CODE-DRIVEN state machine E2E + hard invariants I1..I10 ----
// Drives the REAL /evolve route with a fake host llm that authors cases[] +
// draftContent only. Grading is forced to the deterministic anchor engine so the
// test never depends on a live model. Asserts the whole point of the refactor:
// N skills = N logical workers (never 2N), ZERO real agents spawned, HARD
// concurrency bound, BEFORE frozen once and reused, fixed write->verify->
// backtest order, final per-draftId verify, and a CODE-generated honest report.
console.log('\\n[13] /evolve NEW mode: code state machine E2E + invariants')
{
  const entry13 = await import(pathToFileURL(path.join(import.meta.dirname, 'index.js')).href + '?selftest13=' + Date.now())
  const cap13 = {}
  const handlers13 = {}
  let agentCreates13 = 0
  const fakeAgents13 = {
    async create(opts) {
      agentCreates13++
      const agent = { session: { id: opts.sessionId }, _p: '' }
      agent.followup = async () => {}
      agent.whenIdle = async () => {}
      return { agent }
    },
  }
  // One case, 7 checks -> granularityOk (>=6). Every anchor is verbatim in the
  // draft and absent from the current live body, so after > before under anchors.
  const anchors13 = ['EVOLVE-A1', 'EVOLVE-B2', 'EVOLVE-C3', 'EVOLVE-D4', 'EVOLVE-E5', 'EVOLVE-F6', 'EVOLVE-G7']
  const draftContent13 = [
    '---',
    'name: sev-improved',
    'description: deterministic code-state-machine selftest fixture carrying every improvement anchor',
    '---',
    '',
    '# Improved skill',
    '',
    ...anchors13.map((a) => `The improved body documents ${a} explicitly.`),
    '',
  ].join('\n')
  const cases13 = [{
    id: 'case-1', title: 'all improvement points present',
    checks: anchors13.map((a, i) => ({ id: 'c1k' + (i + 1), text: 'documents ' + a, must: true, anchors: [a] })),
  }]
  const artifactJson13 = JSON.stringify({ cases: cases13, draftContent: draftContent13 })
  const fakeLlm13 = {
    async *stream(opts) {
      // v1.18.0 A1: two calls. Call 1 (RUBRIC AUTHOR) -> {"cases":[...]}; call 2 (DRAFT AUTHOR) -> SKILL.md text.
      const sys = String(opts?.messages?.[0]?.content?.[0]?.text || '')
      const payload = sys.includes('RUBRIC AUTHOR') ? JSON.stringify({ cases: cases13 }) : draftContent13
      const pieces = payload.match(/.{1,40}/gs) || []
      for (const p of pieces) yield { type: 'text-delta', index: 0, text: p }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const fakeCtx13 = {
    logger: { info() {} }, on() {},
    inject(deps, cb) {
      if (deps[0] === 'tools') return cb({ tools: { register(s) { cap13[s.name] = s } }, effect: (fn) => fn() })
      if (deps[0] === 'webServer') return cb({ webServer: { register(arg) { handlers13[arg.path] = arg.handler; return () => {} } } })
      return cb({ agents: fakeAgents13, agentDefaultModel: { currentSelection: () => null }, sessions: { flush() {} }, llm: fakeLlm13 })
    },
  }
  const r13 = fs.mkdtempSync(path.join(os.tmpdir(), 'seb-selftest-sm-'))
  const skillsRoot13 = path.join(r13, 'skills')
  const ledgerPath13 = path.join(r13, 'ledger.json')
  const evalsPath13 = path.join(r13, 'evals.json')
  const skills13 = ['sm-a', 'sm-b', 'sm-c']
  for (const s of skills13) { const d = path.join(skillsRoot13, s); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), 'current body: nothing useful\\n', 'utf8') }
  fs.writeFileSync(ledgerPath13, JSON.stringify({
    generation: 1, suggestions: skills13.map((n) => ({ id: 'sug-' + n, skillName: n, action: 'update', status: 'pending' })), drafts: [],
  }), 'utf8')
  fs.writeFileSync(evalsPath13, JSON.stringify({ cases: [], runs: [] }), 'utf8')
  fs.mkdirSync(path.join(r13, 'state'), { recursive: true })
  entry13.apply(fakeCtx13, {
    ledgerPath: ledgerPath13, evalsPath: evalsPath13, skillsRoot: skillsRoot13,
    stateDir: path.join(r13, 'state'), allowWrite: true, backupKeep: 5,
    model: { provider: 'p', model: 'm' }, maxConcurrency: 2, gradeEngine: 'anchor',
  })
  const fakeReq13 = (bodyObj, method = 'POST') => { const buf = Buffer.from(JSON.stringify(bodyObj || {})); return { method, on(ev, cb) { if (ev === 'data') cb(buf); else if (ev === 'end') cb() } } }
  const fakeRes13 = () => ({ statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(b) { this.bodyStr = b ? b.toString('utf8') : '' } })
  const delay13 = (ms) => new Promise((r) => setTimeout(r, ms))

  const res13 = fakeRes13()
  await handlers13['/api/skill-evolution/evolve'](fakeReq13({ skills: skills13 }), res13)
  const body13 = JSON.parse(res13.bodyStr || '{}')
  ok(res13.statusCode === 200 && body13.evolutionMode === 'new', 'default evolutionMode=new with host llm present', JSON.stringify(body13).slice(0, 160))
  ok(body13.orchestrator === 'code-state-machine', 'new mode reports code-state-machine orchestrator', `got ${body13.orchestrator}`)
  ok(Array.isArray(body13.queued) && body13.queued.length === 3, '3 skills queued', `queued=${JSON.stringify(body13.queued)}`)

  // Poll /jobs until the state machine reaches a terminal phase.
  let job13 = null
  for (let i = 0; i < 300; i++) {
    const r = fakeRes13(); await handlers13['/api/skill-evolution/jobs'](fakeReq13({}, 'GET'), r)
    const jobs = JSON.parse(r.bodyStr || '{}').jobs || []
    const j = jobs[0]
    if (j && ['done', 'failed'].includes(j.phase)) { job13 = j; break }
    await delay13(20)
  }
  ok(Boolean(job13), 'code-state-machine job reached terminal phase', job13 ? `phase=${job13.phase}` : 'timed out')
  const rep = job13 && job13.report

  // I1: N skills = N logical workers, NOT 2N (the 928f11 "14 subagents" defect).
  ok(rep && rep.workerCount === 3, 'I1 workerCount=3 (one worker per skill, never 2N)', rep && `workerCount=${rep.workerCount}`)
  // I2: the code driver spawns ZERO real agents — even though `agents` is injected.
  ok(agentCreates13 === 0, 'I2 zero real agents spawned in new mode', `agentCreates=${agentCreates13}`)
  ok(rep && rep.agentCreates === 0, 'I2 report.agentCreates=0 (honest)', rep && `agentCreates=${rep.agentCreates}`)
  // I3: HARD concurrency bound enforced by the code semaphore.
  ok(rep && rep.peakConcurrency >= 1 && rep.peakConcurrency <= 2, 'I3 peakConcurrency <= maxConcurrency(2)', rep && `peak=${rep.peakConcurrency}`)
  // I4: BEFORE frozen exactly once per skill and REUSED (no re-freeze).
  ok(rep && rep.scoreCalls === 3, 'I4 scoreCalls=3 (frozen once per skill)', rep && `scoreCalls=${rep.scoreCalls}`)
  ok(rep && rep.beforeReused >= 3, 'I4 frozen before reused by write+backtest', rep && `beforeReused=${rep.beforeReused}`)
  // I5: fixed deterministic pipeline order executed by code.
  ok(rep && rep.writeCalls === 3, 'I5 writeCalls=3 (code lands drafts)', rep && `writeCalls=${rep.writeCalls}`)
  ok(rep && rep.verifyCalls === 3, 'I5 verifyCalls=3 (code self-audits)', rep && `verifyCalls=${rep.verifyCalls}`)
  ok(rep && rep.backtestCalls === 3, 'I5 backtestCalls=3 (code scores after)', rep && `backtestCalls=${rep.backtestCalls}`)
  // I6: final independent per-draftId verify across the whole batch.
  ok(rep && rep.finalVerifyCalls === 3, 'I6 finalVerifyCalls=3 (one per landed draft)', rep && `finalVerifyCalls=${rep.finalVerifyCalls}`)
  ok(rep && Array.isArray(rep.finalAudit) && rep.finalAudit.length === 3 && rep.finalAudit.every((a) => a.allOk), 'I6 finalAudit allOk for every draft', rep && JSON.stringify(rep.finalAudit))
  // I7: report generated by CODE so declared mode == actual tool ownership.
  ok(rep && rep.orchestrator === 'code-state-machine' && rep.nameMatchesReality === true, 'I7 report is code-generated and honest', rep && `orchestrator=${rep.orchestrator} nmr=${rep.nameMatchesReality}`)
  ok(body13.orchestrator === (rep && rep.orchestrator), 'I7 response orchestrator matches report orchestrator')
  // I8: every skill landed a valid, verified, score-improving draft.
  ok(rep && rep.results && rep.results.length === 3 && rep.results.every((x) => x.status === 'ok'), 'I8 all 3 workers ok', rep && JSON.stringify(rep.results.map((x) => [x.skill, x.status, x.reason])))
  ok(rep && rep.results.every((x) => x.scoreOk && x.verifyAllOk && x.granularityOk), 'I8 scoreOk + verifyAllOk + granularityOk for all', rep && JSON.stringify(rep.results.map((x) => [x.skill, x.scoreOk, x.verifyAllOk, x.granularityOk])))
  const L13 = JSON.parse(fs.readFileSync(ledgerPath13, 'utf8'))
  ok(L13.drafts.filter((d) => d.status === 'ready').length === 3, 'I8 3 ready drafts in ledger (none adopted/installed)', `ready=${L13.drafts.filter((d) => d.status === 'ready').length}`)
  ok(L13.suggestions.every((s) => s.status === 'review'), 'I8 all suggestions flipped to review')
  // I9: PROCESS AS IT ARRIVES — with cap=2 and 3 skills the pool refilled (peak 2).
  ok(rep && rep.peakConcurrency === 2, 'I9 as-it-arrives refill kept both slots busy (peak=2)', rep && `peak=${rep.peakConcurrency}`)
  // I10: per-skill step progress is surfaced through GET /jobs for the inline panel rows.
  const prog13 = job13 && job13.progress
  ok(prog13 && ['sm-a', 'sm-b', 'sm-c'].every((s) => prog13[s]), 'I10 progress has a row for every skill', prog13 && Object.keys(prog13).join(','))
  ok(prog13 && ['sm-a', 'sm-b', 'sm-c'].every((s) => prog13[s].status === 'done'), 'I10 every skill progress status=done', prog13 && JSON.stringify(Object.keys(prog13).map((s) => [s, prog13[s].status])))
  const stepKeys13 = ['dispatch', 'rubric', 'score', 'draft', 'review', 'landing', 'verify']
  ok(prog13 && ['sm-a', 'sm-b', 'sm-c'].every((s) => stepKeys13.every((k) => prog13[s].steps[k] && prog13[s].steps[k].status === 'done')), 'I10 all 7 steps (v2 segments) done for every skill', prog13 && JSON.stringify(Object.keys(prog13).map((s) => [s, stepKeys13.map((k) => prog13[s].steps[k] && prog13[s].steps[k].status)])))
}


// ---- SECTION 14: v1.18.0 A1 (two small LLM calls) + B (live-file action inference) ----
console.log('\\n[14] v1.18.0 A1 two-call artifacts + B live-file action inference')
{
  const entry14 = await import(pathToFileURL(path.join(import.meta.dirname, 'index.js')).href + '?selftest14=' + Date.now())
  const cap14 = {}
  const handlers14 = {}
  let agentCreates14 = 0
  const fakeAgents14 = {
    async create(opts) {
      agentCreates14++
      const agent = { session: { id: opts.sessionId }, _p: '' }
      agent.followup = async () => {}
      agent.whenIdle = async () => {}
      return { agent }
    },
  }
  // v2.0.0: three short streams per skill. RUBRIC AUTHOR -> {"cases":[...]};
  // DRAFT AUTHOR -> SKILL.md text; DRAFT REVIEWER -> {"ok":true,"issues":[]}.
  const calls14 = { rubric: 0, draft: 0, review: 0 }
  const anchors14 = ['AB-A1', 'AB-B2', 'AB-C3', 'AB-D4', 'AB-E5', 'AB-F6', 'AB-G7']
  const cases14 = [{
    id: 'case-1', title: 'all improvement points present',
    checks: anchors14.map((a, i) => ({ id: 'c1k' + (i + 1), text: 'documents ' + a, must: true, anchors: [a] })),
  }]
  const draft14 = [
    '---',
    'name: ab-improved',
    'description: v1.18.0 A1/B selftest draft',
    '---',
    '',
    '# Body',
    '',
    ...anchors14.map((a) => `The improved body documents ${a} explicitly.`),
    '',
  ].join('\n')
  const fakeLlm14 = {
    async *stream(opts) {
      const sys = String(opts?.messages?.[0]?.content?.[0]?.text || '')
      const isRubric = sys.includes('RUBRIC AUTHOR')
      const isReview = sys.includes('DRAFT REVIEWER')
      if (isRubric) calls14.rubric++
      else if (isReview) calls14.review++
      else calls14.draft++
      const payload = isRubric ? JSON.stringify({ cases: cases14 }) : isReview ? JSON.stringify({ ok: true, issues: [] }) : draft14
      const pieces = payload.match(/.{1,40}/gs) || []
      for (const p of pieces) yield { type: 'text-delta', index: 0, text: p }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const fakeCtx14 = {
    logger: { info() {} }, on() {},
    inject(deps, cb) {
      if (deps[0] === 'tools') return cb({ tools: { register(s) { cap14[s.name] = s } }, effect: (fn) => fn() })
      if (deps[0] === 'webServer') return cb({ webServer: { register(arg) { handlers14[arg.path] = arg.handler; return () => {} } } })
      return cb({ agents: fakeAgents14, agentDefaultModel: { currentSelection: () => null }, sessions: { flush() {} }, llm: fakeLlm14 })
    },
  }
  const r14 = fs.mkdtempSync(path.join(os.tmpdir(), 'seb-selftest-ab-'))
  const skillsRoot14 = path.join(r14, 'skills')
  const ledgerPath14 = path.join(r14, 'ledger.json')
  const evalsPath14 = path.join(r14, 'evals.json')
  // 'ab-live' HAS a live SKILL.md (expect action=update); 'ab-new' has NONE (expect action=create, the B fix).
  const skillsLive = ['ab-live']
  const skillsNew = ['ab-new']
  const skills14 = [...skillsLive, ...skillsNew]
  for (const s of skillsLive) { const d = path.join(skillsRoot14, s); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), 'current body: nothing useful\\n', 'utf8') }
  for (const s of skillsNew) { fs.mkdirSync(path.join(skillsRoot14, s), { recursive: true }) }
  fs.writeFileSync(ledgerPath14, JSON.stringify({
    generation: 1,
    suggestions: skills14.map((n) => ({ id: 'sug-' + n, skillName: n, action: 'update', status: 'pending' })),
    drafts: [],
  }), 'utf8')
  fs.writeFileSync(evalsPath14, JSON.stringify({ cases: [], runs: [] }), 'utf8')
  fs.mkdirSync(path.join(r14, 'state'), { recursive: true })
  entry14.apply(fakeCtx14, {
    ledgerPath: ledgerPath14, evalsPath: evalsPath14, skillsRoot: skillsRoot14,
    stateDir: path.join(r14, 'state'), allowWrite: true, backupKeep: 5,
    model: { provider: 'p', model: 'm' }, maxConcurrency: 2, gradeEngine: 'anchor',
  })
  const fakeReq14 = (bodyObj, method = 'POST') => { const buf = Buffer.from(JSON.stringify(bodyObj || {})); return { method, on(ev, cb) { if (ev === 'data') cb(buf); else if (ev === 'end') cb() } } }
  const fakeRes14 = () => ({ statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(b) { this.bodyStr = b ? b.toString('utf8') : '' } })
  const delay14 = (ms) => new Promise((r) => setTimeout(r, ms))

  const res14 = fakeRes14()
  await handlers14['/api/skill-evolution/evolve'](fakeReq14({ skills: skills14 }), res14)
  await delay14(30)
  ok(res14.statusCode === 200 && JSON.parse(res14.bodyStr).ok === true, 'J1 /evolve accepts both skills', res14.bodyStr)

  let job14 = null
  for (let i = 0; i < 120; i++) {
    await delay14(50)
    const jr = fakeRes14()
    await handlers14['/api/skill-evolution/jobs'](fakeReq14(null, 'GET'), jr)
    const jobs = JSON.parse(jr.bodyStr).jobs || []
    job14 = jobs[0] || null
    if (job14 && job14.status === 'done') break
  }
  ok(job14 && job14.status === 'completed', 'J2 job reaches completed', job14 && job14.status)
  ok(agentCreates14 === 0, 'J3 zero real agents spawned (A1 keeps code state machine)', `creates=${agentCreates14}`)
  ok(calls14.rubric === 2 && calls14.draft === 2 && calls14.review === 2, 'J4 v2 exactly three calls per skill (rubric+draft+review)', `rubric=${calls14.rubric} draft=${calls14.draft} review=${calls14.review}`)

  const L14 = JSON.parse(fs.readFileSync(ledgerPath14, 'utf8'))
  const liveDraft = L14.drafts.find((d) => d.skillName === 'ab-live')
  const newDraft = L14.drafts.find((d) => d.skillName === 'ab-new')
  ok(liveDraft && liveDraft.status === 'ready' && liveDraft.action === 'update', 'J5 ab-live landed as update (live file existed)', liveDraft && `${liveDraft.status}/${liveDraft.action}`)
  ok(newDraft && newDraft.status === 'ready' && newDraft.action === 'create', 'J6 ab-new landed as create despite stale update suggestion (B fix)', newDraft && `${newDraft.status}/${newDraft.action}`)
  ok(newDraft && typeof newDraft.content === 'string' && newDraft.content.includes('AB-A1'), 'J7 ab-new draft body (content) authored by DRAFT call and contains anchor', newDraft && String(newDraft.content).length)

  // Panel surfaces the missing-live-file warning for ab-new.
  const pr14 = fakeRes14()
  await handlers14['/api/skill-evolution/state'](fakeReq14(null, 'GET'), pr14)
  const panelSkills14 = JSON.parse(pr14.bodyStr).skills || []
  const abNew14 = panelSkills14.find((s) => s.skillName === 'ab-new')
  const abLive14 = panelSkills14.find((s) => s.skillName === 'ab-live')
  ok(abNew14 && abNew14.skillFileExists === false, 'J8 panel flags ab-new skillFileExists=false', abNew14 && JSON.stringify(abNew14.skillFileExists))
  ok(abLive14 && abLive14.skillFileExists === true, 'J9 panel flags ab-live skillFileExists=true', abLive14 && JSON.stringify(abLive14.skillFileExists))

  ok(calls14.rubric === 2 && calls14.draft === 2 && calls14.review === 2, 'J10 no extra LLM calls after done (three per skill)', `rubric=${calls14.rubric} draft=${calls14.draft} review=${calls14.review}`)
}

// ---- SECTION 15: draft frontmatter is repaired in code (K1..K6) ----
// The live host failed every evolve with a missing-closing-delimiter YAML
// frontmatter error because real models emit malformed frontmatter. The DRAFT
// call must never trust the model's frontmatter: repairDraftFrontmatter keeps
// the body and re-synthesizes a valid block. These checks pin that.
console.log('\\n[15] draft frontmatter repair (code-guaranteed)')
{
  const entry15 = await import(pathToFileURL(path.join(import.meta.dirname, 'index.js')).href + '?selftest15=' + Date.now())
  const repair = entry15.repairDraftFrontmatter
  const live15 = ['---', 'name: my-skill', 'description: A real live skill.', '---', '', '# Body'].join('\n')
  const good = repair('# Improved\\n\\nanchor EVOLVE-A1 present', live15)
  let v
  try { entry15.validateSkillFrontmatter(good); v = true } catch (e) { v = false; console.log("    (good threw " + e.message + ")") }
  ok(v, 'K1 repaired well-formed-body draft passes validateSkillFrontmatter')
  // The live bug: model frontmatter with NO closing delimiter.
  const unclosed = ['---', 'name: my-skill', 'description: broken', '', '# Improved body text'].join('\n')
  const fixed = repair(unclosed, live15)
  let v2
  try { entry15.validateSkillFrontmatter(fixed); v2 = true } catch (e) { v2 = false; console.log("    (unclosed threw " + e.message + ")") }
  ok(v2, 'K2 unclosed-delimiter draft is repaired to valid frontmatter')
  ok(fixed.includes('# Improved body text'), 'K3 body preserved after repair', JSON.stringify(fixed))
  // No frontmatter at all.
  const bare = repair('Just a body, no frontmatter.', live15)
  let v3
  try { entry15.validateSkillFrontmatter(bare); v3 = true } catch (e) { v3 = false; console.log("    (bare threw " + e.message + ")") }
  ok(v3, 'K4 draft with no frontmatter is repaired to valid frontmatter')
  // Falls back to live name when model name is invalid.
  const badName = repair(['---', 'name: Bad Name!', 'description: x', '---', '', 'body'].join('\n'), live15)
  ok(/name: *"my-skill"/.test(badName), 'K5 invalid model name falls back to live skill name', badName.split('\n')[1])
  // No live skill (create) still yields a valid block.
  const fresh = repair('# Fresh body', '')
  let v4
  try { entry15.validateSkillFrontmatter(fresh); v4 = true } catch (e) { v4 = false; console.log("    (fresh threw " + e.message + ")") }
  ok(v4, 'K6 create (no live skill) still produces valid frontmatter')
  // K7: an explicit skill name always wins over the model's frontmatter name.
  const named = repair(['---', 'name: improved-skill', 'description: x', '---', '', 'body'].join('\n'), live15, 'dsh-client-plugin-card-ui')
  ok(/name: *"dsh-client-plugin-card-ui"/.test(named), 'K7 explicit skill name overrides model frontmatter name', named.split('\n')[1])
}

// ---- SECTION 16: panel v2 endpoints — GET /draft + POST /rescore ----
// The redesigned evolution panel's "view draft" modal and "rescore" button call
// two new server routes. Pin that they are registered, return the draft body
// read-only, recompute before/after through the same gradeFor path, and reject
// bad input with the documented status codes.
console.log("[16] panel v2 endpoints (draft view + rescore)")
{
  const entry16 = await import(pathToFileURL(path.join(import.meta.dirname, 'index.js')).href + '?selftest16=' + Date.now())
  const handlers16 = {}
  const fakeCtx16 = {
    logger: { info() {} }, on() {},
    inject(deps, cb) {
      if (deps[0] === 'tools') return cb({ tools: { register() {} }, effect: (fn) => fn() })
      if (deps[0] === 'webServer') return cb({ webServer: { register(arg) { handlers16[arg.path] = arg.handler; return () => {} } } })
      return cb({ agents: undefined, agentDefaultModel: { currentSelection: () => null }, sessions: { flush() {} }, llm: {} })
    },
  }
  const r16 = fs.mkdtempSync(path.join(os.tmpdir(), 'seb-selftest-v2-'))
  const skillsRoot16 = path.join(r16, 'skills')
  const skillDir16 = path.join(skillsRoot16, 'rt-skill')
  fs.mkdirSync(skillDir16, { recursive: true })
  fs.writeFileSync(path.join(skillDir16, 'SKILL.md'), 'current body ANCHORX\n', 'utf8')
  const ledgerPath16 = path.join(r16, 'ledger.json')
  const evalsPath16 = path.join(r16, 'evals.json')
  const stateDir16 = path.join(r16, 'state')
  fs.mkdirSync(stateDir16, { recursive: true })
  const draftCases = [{
    id: 'c1', title: 't', skillName: 'rt-skill',
    checks: [
      { id: 'k1', text: 'has anchor', must: true, anchors: ['ANCHORX'] },
      { id: 'k2', text: 'optional', anchors: ['UNLIKELY'] },
    ],
    origin: { suggestionId: 'sg1' },
    updatedAt: '2026-01-01T00:00:00Z',
  }]
  fs.writeFileSync(ledgerPath16, JSON.stringify({
    generation: 1,
    suggestions: [{ id: 'sg1', skillName: 'rt-skill', action: 'update', status: 'review' }],
    drafts: [{ id: 'dt1', suggestionId: 'sg1', skillName: 'rt-skill', action: 'update', status: 'ready',
      baseHash: 'abc', notes: 'test draft', runIds: [], createdAt: 'c', updatedAt: 'u',
      content: 'improved body ANCHORX\n' }],
  }, null, 2), 'utf8')
  fs.writeFileSync(evalsPath16, JSON.stringify({ cases: draftCases, runs: [] }, null, 2), 'utf8')
  entry16.apply(fakeCtx16, {
    ledgerPath: ledgerPath16, evalsPath: evalsPath16, skillsRoot: skillsRoot16,
    stateDir: stateDir16, allowWrite: true, gradeEngine: 'anchor',
  })
  ok(Boolean(handlers16['/api/skill-evolution/draft']), 'apply() registered /api/skill-evolution/draft route')
  ok(Boolean(handlers16['/api/skill-evolution/rescore']), 'apply() registered /api/skill-evolution/rescore route')

  const fakeRes16 = () => ({ statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(b) { this.bodyStr = b ? b.toString('utf8') : '' } })
  const getReq = (url) => ({ method: 'GET', url })
  const postReq = (bodyObj) => { const buf = Buffer.from(JSON.stringify(bodyObj || {})); return { method: 'POST', url: '/api/skill-evolution/rescore', on(ev, cb) { if (ev === 'data') cb(buf); else if (ev === 'end') cb() } } }

  // GET /draft — happy path returns the whitelist + content.
  {
    const res = fakeRes16()
    await handlers16['/api/skill-evolution/draft'](getReq('/api/skill-evolution/draft?id=dt1'), res)
    const body = JSON.parse(res.bodyStr)
    ok(res.statusCode === 200 && body.ok === true && body.draft && body.draft.content.includes('ANCHORX'),
      'GET /draft returns draft content (200)', JSON.stringify(body).slice(0, 200))
    ok(body.draft && body.draft.id === 'dt1' && body.draft.skillName === 'rt-skill',
      'GET /draft returns draft identity fields')
  }
  // GET /draft — unknown id → 404, missing id → 400, POST → 405.
  {
    const res = fakeRes16()
    await handlers16['/api/skill-evolution/draft'](getReq('/api/skill-evolution/draft?id=nope'), res)
    ok(res.statusCode === 404, 'GET /draft unknown id → 404', `got ${res.statusCode}`)
  }
  {
    const res = fakeRes16()
    await handlers16['/api/skill-evolution/draft'](getReq('/api/skill-evolution/draft'), res)
    ok(res.statusCode === 400, 'GET /draft missing id → 400', `got ${res.statusCode}`)
  }
  {
    const res = fakeRes16()
    await handlers16['/api/skill-evolution/draft']({ method: 'POST', url: '/api/skill-evolution/draft' }, res)
    ok(res.statusCode === 405, 'GET /draft rejects POST → 405', `got ${res.statusCode}`)
  }

  // POST /rescore — draftId + no explicit cases → rubricForDraft finds sg1 cases → scored result.
  {
    const res = fakeRes16()
    await handlers16['/api/skill-evolution/rescore'](postReq({ skillName: 'rt-skill', draftId: 'dt1' }), res)
    const body = JSON.parse(res.bodyStr)
    ok(res.statusCode === 200 && body.ok === true && body.result,
      'POST /rescore with draftId → 200 ok', JSON.stringify(body).slice(0, 220))
    ok(body.result && typeof body.result.beforeScore === 'number' && typeof body.result.afterScore === 'number' && typeof body.result.delta === 'number',
      'POST /rescore result carries before/after/delta numbers', JSON.stringify(body.result || {}).slice(0, 220))
    ok(body.result && body.result.casesCount === 1, 'POST /rescore used rubricForDraft cases (casesCount=1)', JSON.stringify(body.result || {}).slice(0, 220))
    ok(body.result && body.result.engine && body.result.engine.after === 'anchor', 'POST /rescore grades through gradeFor (engine=anchor)', JSON.stringify(body.result || {}).slice(0, 220))
  }
  // POST /rescore — explicit cases path.
  {
    const res = fakeRes16()
    await handlers16['/api/skill-evolution/rescore'](postReq({
      skillName: 'rt-skill', draftContent: 'improved body ANCHORX',
      cases: [{ id: 'x', title: 'x', checks: [{ id: 'k', text: 'k', must: true, anchors: ['ANCHORX'] }] }],
    }), res)
    const body = JSON.parse(res.bodyStr)
    ok(res.statusCode === 200 && body.ok === true && body.result && body.result.casesCount === 1,
      'POST /rescore with explicit draftContent+cases → 200', JSON.stringify(body).slice(0, 220))
  }
  // POST /rescore — bad inputs.
  {
    const res = fakeRes16()
    await handlers16['/api/skill-evolution/rescore'](postReq({ draftId: 'dt1' }), res)
    ok(res.statusCode === 400, 'POST /rescore missing skillName → 400', `got ${res.statusCode}`)
  }
  {
    const res = fakeRes16()
    await handlers16['/api/skill-evolution/rescore'](postReq({ skillName: 'rt-skill' }), res)
    ok(res.statusCode === 400, 'POST /rescore missing draft/content → 400', `got ${res.statusCode}`)
  }
  {
    const res = fakeRes16()
    await handlers16['/api/skill-evolution/rescore'](postReq({ skillName: 'nocase-skill', draftContent: 'body' }), res)
    ok(res.statusCode === 422, 'POST /rescore with no rubric cases → 422', `got ${res.statusCode}`)
  }
  {
    const res = fakeRes16()
    await handlers16['/api/skill-evolution/rescore'](getReq('/api/skill-evolution/rescore'), res)
    ok(res.statusCode === 405, 'POST /rescore rejects GET → 405', `got ${res.statusCode}`)
  }
}

// ---- SECTION 17: panel job cancel — POST /cancel ----
// The evolution panel's per-job "Cancel" button calls a new server route. Pin
// that it is registered and behaves per contract: 405 on GET, 400 on missing
// jobId, 404 on an unknown jobId, and a cooperative cancelRequested on a known
// running job (idempotent second call reports already:true).
console.log("[17] panel job cancel (POST /cancel)")
{
  const entry17 = await import(pathToFileURL(path.join(import.meta.dirname, 'index.js')).href + '?selftest17=' + Date.now())
  const handlers17 = {}
  const fakeCtx17 = {
    logger: { info() {} }, on() {},
    inject(deps, cb) {
      if (deps[0] === 'tools') return cb({ tools: { register() {} }, effect: (fn) => fn() })
      if (deps[0] === 'webServer') return cb({ webServer: { register(arg) { handlers17[arg.path] = arg.handler; return () => {} } } })
      return cb({ agents: undefined, agentDefaultModel: { currentSelection: () => null }, sessions: { flush() {} }, llm: {} })
    },
  }
  const r17 = fs.mkdtempSync(path.join(os.tmpdir(), 'seb-selftest-v3-'))
  const skillsRoot17 = path.join(r17, 'skills')
  const skillDir17 = path.join(skillsRoot17, 'rt-skill')
  fs.mkdirSync(skillDir17, { recursive: true })
  fs.writeFileSync(path.join(skillDir17, 'SKILL.md'), 'current body ANCHORX\n', 'utf8')
  const ledgerPath17 = path.join(r17, 'ledger.json')
  const evalsPath17 = path.join(r17, 'evals.json')
  const stateDir17 = path.join(r17, 'state')
  fs.mkdirSync(stateDir17, { recursive: true })
  fs.writeFileSync(ledgerPath17, JSON.stringify({ generation: 0, suggestions: [], drafts: [] }, null, 2), 'utf8')
  fs.writeFileSync(evalsPath17, JSON.stringify({ cases: [], runs: [] }, null, 2), 'utf8')
  entry17.apply(fakeCtx17, {
    ledgerPath: ledgerPath17, evalsPath: evalsPath17, skillsRoot: skillsRoot17,
    stateDir: stateDir17, allowWrite: false, gradeEngine: 'anchor',
  })
  ok(Boolean(handlers17['/api/skill-evolution/cancel']), 'apply() registered /api/skill-evolution/cancel route')

  // Seed a fake running job into the RUNNING registry through the /jobs surface.
  // The cancel route reads RUNNING directly, so drive it via the real registry by
  // first observing /jobs returns [] (empty), then exercising the route's input
  // contract against that empty registry.
  const fakeRes17 = () => ({ statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(b) { this.bodyStr = b ? b.toString('utf8') : '' } })
  const postReq17 = (bodyObj) => {
    const buf = Buffer.from(JSON.stringify(bodyObj || {}))
    return { method: 'POST', url: '/api/skill-evolution/cancel', on(ev, cb) { if (ev === 'data') cb(buf); else if (ev === 'end') cb() } }
  }
  const getReq17 = (url) => ({ method: 'GET', url })
  {
    const res = fakeRes17()
    await handlers17['/api/skill-evolution/cancel'](getReq17('/api/skill-evolution/cancel'), res)
    ok(res.statusCode === 405, 'POST /cancel rejects GET → 405', `got ${res.statusCode}`)
  }
  {
    const res = fakeRes17()
    await handlers17['/api/skill-evolution/cancel'](postReq17({}), res)
    ok(res.statusCode === 400, 'POST /cancel missing jobId → 400', `got ${res.statusCode}`)
  }
  {
    const res = fakeRes17()
    await handlers17['/api/skill-evolution/cancel'](postReq17({ jobId: 'no-such-job' }), res)
    ok(res.statusCode === 404, 'POST /cancel unknown jobId → 404', `got ${res.statusCode}`)
  }
}

// ---- SECTION 18: v2.2.18 score concurrency (not starved behind draft) -------
console.log('[18] v2.2.18 score runs concurrently with draft (LLM slot not idle)')
{
  const src18 = fs.readFileSync(path.join(import.meta.dirname, 'index.js'), 'utf8')
  ok(!/Promise\.allSettled\(\[rubricTask, draftTask\]\)/.test(src18),
    'score no longer waits behind a rubric+draft-only allSettled barrier',
    'still has the two-element barrier')
  ok(/const scoreTask = rubricTask\.then\(/.test(src18),
    'scoreTask launches off rubricTask alone (concurrent with draft)',
    'no rubricTask.then scoreTask')
  ok(/Promise\.allSettled\(\[rubricTask, draftTask, scoreTask\]\)/.test(src18),
    'barrier includes scoreTask so its result is awaited before review',
    'three-way barrier missing')
}

// ---- SECTION 19: v2.2.19 live-poll liveness + unified segment clock -------
console.log('[19] v2.2.19 poll from fresh snapshot + continuous segment clock')
{
  const csrc19 = fs.readFileSync(path.join(import.meta.dirname, 'lib/client/index.js'), 'utf8')
  ok(!/jobsRef\.current\.some\(/.test(csrc19),
    'poll liveness no longer reads a stale one-render-old jobsRef')
  ok(/setTimeout\(tick, fresh && isRunning\(fresh\) \? 3000 : 5000\)/.test(csrc19),
    'poll cadence comes from the fresh snapshot and keeps a slow idle poll')
  ok(!/const priorRun = Number\(cur\.runMs\) \|\| 0/.test(csrc19),
    'active segment no longer adds runMs (the 76->56 jump source)')
  ok(/v2\.2\.24: a WAITING segment carries NO clock/.test(csrc19),
    'v2.2.24 queued/pending segments carry no clock (only status, no seconds)')
}

// ---- SECTION 20: v2.2.20 score-queue clock + config persistence -------
console.log('\n[20] score queued placeholder + config memory + /models route')
{
  const isrc20 = fs.readFileSync(path.join(import.meta.dirname, 'index.js'), 'utf8')
  ok(!isrc20.includes("setStep(job, skill, 'score', 'active', 'freezing"), 'score no longer marked active in code')
  ok(isrc20.includes("setStep(job, skill, 'score', 'queued', 'freezing"), 'score starts as queued placeholder')
  ok(isrc20.includes('const persisted = loadPanelConfig()'), 'configure backfills CFG from disk')
  ok(isrc20.includes('maxConcurrency: pc.maxConcurrency,'), 'state reports persisted concurrency')
  ok(!isrc20.includes('readPanelConfig()'), 'no undefined readPanelConfig call')
}

// ---- SECTION 21: v2.2.21 seven-color overview chain + merged label -------
console.log('\n[21] overview chain inline colors + status/time on one line')
{
  const csrc21 = fs.readFileSync(path.join(import.meta.dirname, 'lib/client/index.js'), 'utf8')
  ok(!csrc21.includes("'--c': SEG_COLORS[i]"), 'overview chain no longer relies on sanitizer-stripped var(--c)')
  ok(csrc21.includes("style: (st === 'done' || st === 'active' || st === 'queued') ? { backgroundColor: SEG_COLORS[i] } : undefined"),
    'overview pmbar colors all seven segments with inline backgroundColor')
  ok(csrc21.includes('.exec(rawDur)'), 'merged label parses the numeric duration from segTime')
  ok(csrc21.includes("t('progress.timeSep')") && csrc21.includes("t('progress.seconds')"),
    'status and time merged with locale-aware separator and unit')
  ok(!csrc21.includes("className: 'seb2-labt'"), 'separate time-label node removed')
  ok((csrc21.match(/'progress\.timeSep':/g) || []).length === 2, 'timeSep defined in both zh and en locales')
  ok((csrc21.match(/'progress\.seconds':/g) || []).length === 2, 'seconds defined in both zh and en locales')
}

// ---- SECTION 22: v2.2.23 single-skill bar animations (flow / done tick / fail cross) ----
console.log('\n[22] single-skill bar animations: active flow + done tick + fail cross')
{
  const csrc22 = fs.readFileSync(path.join(import.meta.dirname, 'lib/client/index.js'), 'utf8')
  // active keeps a light track (no solid inline color) so the sliding flow stays visible
  ok(csrc22.includes("style: (st === 'done' || st === 'queued') ? { backgroundColor: SEG_COLORS[i] } : undefined }"),
    'single-skill active segment no longer painted solid')
  ok(csrc22.includes("@keyframes seb2flow{0%{left:-30%;}100%{left:110%;}}"),
    'flow keyframes slide the bright bar across the track')
  ok(csrc22.includes(".seb2-flow{position:absolute;top:0;left:0;height:100%;width:58%;") &&
     csrc22.includes("animation:seb2flow 2.2s ease-in-out infinite;"),
    'flow bar has width/position and looping animation')
  ok(csrc22.includes("className: 'seb2-flow', key: 'f', style: { backgroundColor: SEG_COLORS[i], boxShadow:"),
    'flow bar keeps full-opacity color plus design glow (no opacity dimming)')
  // done ✓ tick re-added as a sibling pushed after the seg, above the colored bar
  ok(csrc22.includes("if (st === 'done') kids.push(React.createElement('span', { className: 'seb2-tick', key: 'k' }, '✓'))"),
    'done segments render a white ✓ tick')
  ok(csrc22.includes("pointer-events:none;z-index:1;}"),
    'tick z-index:1 paints above the colored bar')
  // fail ✕ stays via CSS ::after
  ok(csrc22.includes(".seb2-seg.fail::after{content:\"✕\""), 'fail segments keep the white ✕ via CSS')
  // overview chain paths were NOT changed by the single-skill fix
  ok((csrc22.match(/style: \(st === 'done' \|\| st === 'active' \|\| st === 'queued'\) \? \{ backgroundColor: SEG_COLORS\[i\] \} : undefined/g) || []).length === 2,
    'overview mini-chain and pmbar keep their seven-color inline paints')
}

// ---- SECTION 23: v2.2.24 pure-run segment timing -----------------------
console.log('\n[23] v2.2.24 queued has no clock + active/done subtract folded wait')
{
  const csrc24 = fs.readFileSync(path.join(import.meta.dirname, 'lib/client/index.js'), 'utf8')
  ok(/cur\.status === 'queued' \|\| cur\.status === 'pending'\) return '—'/.test(csrc24),
    'queued/pending segments render an em-dash (no seconds)')
  ok(!csrc24.includes('segWs'), 'old live waitStartAt queue clock is gone')
  ok(!csrc24.includes('cur.firstStartAt || cur.startAt'), 'old firstStartAt wall-clock origin is gone')
  ok(csrc24.includes('(endMs - start) - waitMs'), 'run time subtracts folded queue wait (accumMs)')
  ok(!csrc24.includes('const fmtTime ='), 'unused fmtTime helper removed')
}
console.log(`\n${failures === 0 ? 'SELFTEST PASS' : `SELFTEST FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
