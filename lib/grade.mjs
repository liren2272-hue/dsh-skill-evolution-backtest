// Anchor grader — the per-check PARTIAL-SCORE evaluator.
//
// WHY ANCHORS (and not an LLM judging pass/fail)
//   A skill improvement is only real if specific knowledge actually landed in
//   the text. An anchor is a regex that a piece of that knowledge MUST match.
//   A check passes when ALL of its anchors hit the skill body; a check with
//   even one missing anchor fails. The case score is then `passed checks /
//   total checks`, so a draft that fixes 2 of 3 checks scores 0.667 — not a
//   flat 0/1. This is the "grade it the original way, give me a number I can
//   judge" semantic, aligned with the host's runScore (passRate = pass/graded,
//   score = avg(score)).
//
// ANCHOR CALIBRATION (the lesson that cost a re-run)
//   An anchor must encode a SKILL-LEVEL piece of knowledge, never a case-specific
//   string (e.g. a literal `/go` route or `sandbox_permissions` token that only
//   one example happens to use). Anchoring a case-specific string makes `before`
//   artificially red (false negative) or `after` artificially green (false
//   positive) and the whole backtest lies. Before trusting a 0.000 `before`,
//   re-read the anchors and confirm each one is a genuine, currently-missing
//   knowledge point.

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

// Grade one skill body against a list of {id,title,checks:[{id,text,must}]}
// cases. Returns a per-case, per-check breakdown plus the aggregate score.
// `body` is the SKILL.md text (current file for `before`, the draft for `after`).
export function gradeBody(body, cases) {
  const caseRows = []
  let totalChecks = 0
  let passedChecks = 0
  for (const c of cases) {
    const checkRows = []
    let cTotal = 0
    let cPassed = 0
    for (const k of c.checks || []) {
      const r = gradeCheck(body, k.anchors)
      checkRows.push({
        checkId: k.id,
        text: k.text,
        must: k.must !== false,
        pass: r.pass,
        misses: r.misses,
      })
      cTotal++
      if (r.pass) cPassed++
    }
    totalChecks += cTotal
    passedChecks += cPassed
    caseRows.push({
      caseId: c.id,
      title: c.title,
      totalChecks: cTotal,
      passedChecks: cPassed,
      score: cTotal ? cPassed / cTotal : 0,
      checks: checkRows,
    })
  }
  return {
    caseRows,
    totalChecks,
    passedChecks,
    // Aggregate = micro-average over all checks, matching runScore's
    // pass/graded semantics rather than a naive mean of case ratios.
    score: totalChecks ? passedChecks / totalChecks : 0,
  }
}