// Grader core — per-check pass/fail plus the HOST-ALIGNED aggregation.
//
// HOST-ALIGNED SCORING (full alignment with the Mnemon skill evolution host)
//   The host judges each check semantically and aggregates CASE-LEVEL:
//     * a check's weight is 2 when `must`, else 1
//     * case score = weighted pass / total weight  (compareAutomaticSkillRuns)
//     * case verdict = 'pass' only when EVERY `must` check passes
//     * run score = mean of per-case scores        (runScore)
//     * run passRate = pass cases / graded cases  (runScore)
//   This module reproduces that deterministic aggregation, so a draft that
//   fixes a `must` item is distinguished from one that only fixes optional
//   ones, and a run score is a case-level average rather than a check-level
//   micro-average.
//
// DETERMINISTIC ANCHOR GRADER
//   `gradeCheck` is the deterministic fallback: a check passes iff ALL its
//   anchor regexes hit the body. The LLM semantic judge (lib/llm-judge.mjs) is
//   the primary engine; anchors remain as the offline fallback when no model is
//   reachable, so the backtest never silently turns into a constant.
//
// ANCHOR CALIBRATION (the lesson that cost a re-run)
//   An anchor must encode a SKILL-LEVEL piece of knowledge, never a case-specific
//   string (e.g. a literal `/go` route or `sandbox_permissions` token that only
//   one example happens to use). Anchoring a case-specific string makes `before`
//   artificially red (false negative) or `after` artificially green (false
//   positive) and the whole backtest lies. Before trusting a 0.000 `before`,
//   re-read the anchors and confirm each one is a genuine, currently-missing
//   knowledge point.

export const MUST_WEIGHT = 2
export const OPTIONAL_WEIGHT = 1

// A check's weight under the host's must-weighted scheme.
export function checkWeight(check) {
  return check && check.must ? MUST_WEIGHT : OPTIONAL_WEIGHT
}

// Case verdict: pass only when every `must` check passes. Optional checks never
// gate the verdict (they only dilute the case score).
export function caseVerdict(checks) {
  return (checks || []).every((c) => !c.must || c.pass) ? 'pass' : 'fail'
}

// Case score: weighted pass / total weight. All-must case ⇒ plain pass ratio.
export function caseScore(checks) {
  const cs = checks || []
  const total = cs.reduce((s, c) => s + checkWeight(c), 0)
  if (!total) return 0
  return cs.reduce((s, c) => s + (c.pass ? checkWeight(c) : 0), 0) / total
}

// Run-level aggregation, exactly the host's runScore semantics.
//   graded = results whose verdict is not 'error'
//   passRate = pass cases / graded cases
//   score    = mean of per-case scores
export function aggregate(caseRows) {
  const rows = caseRows || []
  const graded = rows.filter((r) => r.verdict !== 'error')
  const errors = rows.length - graded.length
  const passRate = graded.length
    ? graded.filter((r) => r.verdict === 'pass').length / graded.length
    : 0
  const score = graded.length
    ? graded.reduce((s, r) => s + (typeof r.score === 'number' ? r.score : 0), 0) / graded.length
    : 0
  return { graded: graded.length, errors, passRate, score }
}

export function gradeCheck(body, anchors) {
  const misses = []
  for (const a of anchors || []) {
    let re
    try {
      re = new RegExp(a, 'i')
    } catch {
      misses.push({ anchor: a, error: 'invalid regex' })
      continue
    }
    if (!re.test(body)) misses.push({ anchor: a })
  }
  return { pass: misses.length === 0, misses }
}

// Normalize raw cases into the canonical grading shape: every case and check gets
// a stable id (minted from a counter when the caller did not supply one) so the
// per-check rows, the LLM JSON map and the ledger `checkId` all line up. Input
// objects are NOT mutated — we build fresh copies (the host hands `args` frozen).
export function normalizeCases(cases) {
  return (cases || []).map((c, ci) => ({
    ...(c && typeof c === 'object' ? c : {}),
    id: c && c.id ? String(c.id) : `case-${ci + 1}`,
    title: String(c?.title || ''),
    checks: (Array.isArray(c?.checks) ? c.checks : []).map((k, ki) => ({
      ...(k && typeof k === 'object' ? k : {}),
      id: k && k.id ? String(k.id) : `c${ci + 1}k${ki + 1}`,
      text: String(k?.text || ''),
    })),
  }))
}

// Grade one skill body against a list of {id,title,checks:[{id,text,must,anchors}]}
// cases using the DETERMINISTIC anchor engine. Returns a per-case, per-check
// breakdown plus the host-aligned aggregate.
// `body` is the SKILL.md text (current file for `before`, the draft for `after`).
export function gradeBody(body, cases) {
  const norm = normalizeCases(cases)
  const caseRows = []
  let totalChecks = 0
  let passedChecks = 0
  for (const c of norm) {
    const checkRows = []
    for (const k of c.checks) {
      const r = gradeCheck(body, k.anchors)
      checkRows.push({
        checkId: k.id,
        text: k.text,
        // Host default: a check is `must` only when explicitly marked true.
        must: k.must === true,
        pass: r.pass,
        misses: r.misses,
        engine: 'anchor',
      })
      totalChecks++
      if (r.pass) passedChecks++
    }
    caseRows.push({
      caseId: c.id,
      title: c.title,
      totalChecks: checkRows.length,
      passedChecks: checkRows.filter((k) => k.pass).length,
      score: caseScore(checkRows),
      verdict: caseVerdict(checkRows),
      checks: checkRows,
    })
  }
  const agg = aggregate(caseRows)
  return {
    caseRows,
    totalChecks,
    passedChecks,
    // Host-aligned: run score = mean of case scores, passRate = pass/graded.
    score: agg.score,
    passRate: agg.passRate,
    graded: agg.graded,
    errors: agg.errors,
    engine: 'anchor',
    // Kept for backward compatibility / diagnostics: the old check-level ratio.
    microScore: totalChecks ? passedChecks / totalChecks : 0,
  }
}
