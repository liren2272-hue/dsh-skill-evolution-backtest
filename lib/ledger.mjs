// Ledger read/write for the Mnemon skill-evolution store.
//
// The two files this touches are the memory plugin's own ledgers:
//   ledger.json — suggestions (improvement ideas) + drafts (ready-to-approve
//                 improved skills) + reviews + versions.
//   evals.json  — backtest cases + runs (a run = one before/after evaluation).
//
// WRITE CONTRACT (mirrors the host's own saveLedger semantics)
//   * Back up BOTH files to <stateDir>/backups/<timestamp>/ BEFORE mutating.
//   * Read fresh, mutate, atomic-write (temp file + rename) — a crash mid-write
//     can never leave a truncated ledger.
//   * generation += 1 on every ledger write (the host counts on this).
//   * The `write` tool refuses when the suggestion is no longer in an expected
//     source status or already carries a draftId — that is the concurrency
//     guard that stops two writers (or a writer and the GUI) from clobbering.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

// Timestamped backup of both ledgers into stateDir/backups/<ts>/. Returns the
// backup dir so the caller can report it (and a human can restore from it).
export function backupLedgers(paths, stateDir, keep = 20) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = path.join(stateDir, 'backups', ts)
  fs.mkdirSync(dir, { recursive: true })
  const copied = []
  for (const f of [paths.ledgerPath, paths.evalsPath]) {
    if (fs.existsSync(f)) {
      fs.copyFileSync(f, path.join(dir, path.basename(f)))
      copied.push(path.basename(f))
    }
  }
  pruneBackups(path.join(stateDir, 'backups'), keep)
  return { dir, copied }
}

function pruneBackups(root, keep) {
  let entries
  try {
    entries = fs.readdirSync(root).filter((e) => fs.statSync(path.join(root, e)).isDirectory()).sort()
  } catch {
    return
  }
  while (entries.length > keep) {
    const old = entries.shift()
    try {
      fs.rmSync(path.join(root, old), { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}

// Build the run record for one side of a before/after pair.
//   kind 'current' → target.hash = baseHash (the live file), draftId null
//   kind 'draft'   → target.hash = sha256(draftContent), draftId = the new draft
// target={kind,hash,skillKey,draftId}; result keys answer,caseId,checks,
// fullyGraded,score,steps,summary,title,verdict(pass/fail/error); check keys
// checkId,pass,note. runScore: passRate=pass/graded, score=avg(score).
export function buildRun({ id, skillName, kind, hash, draftId, cases, graded, model, gradeNote, now }) {
  const caseIds = cases.map((c) => c.id)
  const results = graded.caseRows.map((row) => ({
    caseId: row.caseId,
    title: row.title,
    // Host rule: a case passes only when every `must` check passes. Falls back
    // to the old all-checks rule for rows built before verdict existed.
    verdict: row.verdict || (row.passedChecks === row.totalChecks ? 'pass' : 'fail'),
    score: row.score,
    checks: row.checks.map((k) => ({
      checkId: k.checkId,
      pass: k.pass,
      note: gradeNote,
      engine: k.engine,
    })),
    steps: [],
    answer: '',
    summary: `${kind}：${row.passedChecks}/${row.totalChecks} check 通过，case 加权分 ${row.score.toFixed(4)}（verdict=${row.verdict || (row.passedChecks === row.totalChecks ? 'pass' : 'fail')}，must=2）。`,
    fullyGraded: true,
  }))
  const score = graded.score
  const passRate = typeof graded.passRate === 'number' ? graded.passRate : score
  return {
    id,
    skillName,
    status: 'completed',
    target: { kind, hash, skillKey: `user-dsh:${skillName}`, draftId: draftId ?? null },
    model,
    caseIds,
    casesHash: null, // filled by caller (needs the persisted cases)
    startedAt: now,
    finishedAt: now,
    progress: { done: caseIds.length, total: caseIds.length },
    score,
    passRate,
    results,
  }
}

export function newDraft({ id, suggestionId, skillName, action, baseHash, content, notes, runIds, now }) {
  return {
    // `id` may be supplied by the caller so the draft's id and the after-run's
    // target.draftId are the SAME id (verifyImpl asserts afterTargetDraft).
    id: id || randomUUID(),
    suggestionId,
    skillName,
    action,
    baseKey: `user-dsh:${skillName}`,
    baseHash,
    origin: { path: null }, // filled by caller
    notes: String(notes || '').slice(0, 2000),
    changes: [],
    guidance: [],
    status: 'ready',
    runIds,
    createdAt: now,
    updatedAt: now,
    content,
  }
}

// Prune non-ready drafts the way the host does: `ready` is ALWAYS retained
// (it is waiting on the human), everything else keeps only the most recent 60.
export function pruneDrafts(drafts, keep = 60) {
  const ready = drafts.filter((d) => d.status === 'ready')
  const rest = drafts.filter((d) => d.status !== 'ready').slice(-keep)
  return [...ready, ...rest]
}

// ---- delivery self-audit (交付前自我审查) ----
// A 'ready' draft is not just this plugin's data — the Mnemon PANEL and the
// host `draft()`/adoptDraft() services read it with HARD field requirements.
// A draft missing any of these fields looks fine to us but blows up the moment
// a human opens or adopts it in the panel:
//   - DraftReview client.js reads draft.changes.length / notes / updatedAt
//     → undefined throws a TypeError = the whole review page BLACK-SCREENS.
//   - host adoptDraft (update) calls requireHash(..., draft.baseHash); a missing
//     baseHash throws "changed since it was read" on adopt.
//   - host adoptDraft (update) resolves the original via draft.baseKey + draft
//     .origin; a missing/malformed origin throws "The original workspace was not
//     recorded reliably" (origin-unavailable).
//   - host draft() reads draft.runIds.flatMap → undefined throws.
// So BEFORE we commit a draft to the ledger we re-check every one of these
// fields is present and well-formed. This is the "self-review before delivery"
// gate: it turns a silent late-crash-when-a-human-clicks into a loud failure
// RIGHT HERE, at write time, where it is cheap to fix.
const DRAFT_REQUIRED_FIELDS = [
  'id', 'suggestionId', 'skillName', 'action', 'status',
  'content', 'changes', 'notes', 'updatedAt', 'runIds',
]

export function validateDraftSchema(draft) {
  const problems = []
  for (const field of DRAFT_REQUIRED_FIELDS) {
    if (draft?.[field] === undefined || draft?.[field] === null) {
      problems.push(`missing field "${field}"`)
    }
  }
  // update drafts additionally need baseKey + origin + baseHash, because the
  // host resolves and hash-checks the ORIGINAL skill file on adopt.
  if (draft?.action === 'update') {
    if (!draft.baseKey) problems.push('update draft missing "baseKey" (host resolves the original via it)')
    if (draft.origin === undefined || draft.origin === null || typeof draft.origin !== 'object') {
      problems.push('update draft missing object "origin" (host reads origin.path to find the original)')
    } else if (typeof draft.origin.path !== 'string' || !draft.origin.path) {
      problems.push('update draft "origin.path" is not a non-empty string')
    }
    if (!draft.baseHash) problems.push('update draft missing "baseHash" (host requireHash checks it on adopt)')
  }
  if (!Array.isArray(draft?.changes)) problems.push('"changes" must be an array (DraftReview reads changes.length)')
  if (!Array.isArray(draft?.runIds)) problems.push('"runIds" must be an array (host reads runIds.flatMap)')
  if (problems.length) {
    throw new Error(
      `draft schema self-audit FAILED — refusing to deliver an incomplete draft ` +
      `(it would crash/err the panel on open or adopt): ${problems.join('; ')}`
    )
  }
  return true
}