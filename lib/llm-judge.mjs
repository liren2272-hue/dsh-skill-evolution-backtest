// LLM semantic judge — the primary grading engine, host-aligned.
//
// WHY AN LLM JUDGE
//   The host (dsh-mnemon-source-skills) does NOT decide pass/fail with regexes:
//   it hands each case to an evaluating agent/model and aggregates the returned
//   per-case scores (`caseResult`, `runScore`). Anchors can only tell you that a
//   literal string is present; they cannot tell you whether a SKILL actually
//   teaches or enforces the improvement. This module reproduces the host's
//   semantics: the model judges each check against the skill body, and the score
//   is the host's case-level weighted aggregate.
//
// FALLBACK (never silently constant)
//   If no model is reachable, the call errors, the output cannot be parsed, or a
//   single check's verdict is missing, that check/case falls back to the
//   deterministic anchor grader in grade.mjs. The engine is recorded per case so
//   a run's provenance is auditable ('llm' vs 'anchor' vs 'llm+anchor').

import {
  normalizeCases,
  gradeCheck,
  caseScore,
  caseVerdict,
  aggregate,
  checkWeight,
} from './grade.mjs'

export const GRADE_ENGINE = {
  LLM: 'llm',
  ANCHOR: 'anchor',
  MIXED: 'llm+anchor',
}

const SYSTEM_PROMPT = `You are a strict evaluator for a DSH skill file (SKILL.md).

For each improvement-point "check" below, decide whether the SKILL body SATISFIES the check's intent — i.e. the skill actually teaches, documents, or enforces the required knowledge. A string merely being mentioned does NOT satisfy a check unless the skill genuinely covers it. Judge strictly and independently per check.

Respond with ONLY a JSON array, no prose, no markdown fences. Each element:
{"id": "<checkId>", "pass": true|false, "reason": "<one short clause>"}
Include every check id exactly once. Do not add, drop, or rename checks.`

function buildUserPrompt(body, cases) {
  const checks = []
  for (const c of cases) {
    for (const k of c.checks) {
      checks.push({ id: k.id, text: k.text, must: k.must === true })
    }
  }
  return [
    'SKILL body to evaluate:\n<<<SKILL\n' + body + '\nSKILL>>>\n',
    'Checks to judge:\n' + JSON.stringify(checks, null, 2),
    '\nReturn the JSON array now.',
  ].join('\n')
}

// Extract the first JSON array from an LLM text response, tolerating prose,
// code fences and trailing commentary.
export function extractChecksJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  let s = text.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('[')
  if (start < 0) return null
  // Scan to the matching close bracket so trailing prose is ignored.
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        const candidate = s.slice(start, i + 1)
        try {
          const parsed = JSON.parse(candidate)
          if (Array.isArray(parsed)) return parsed
        } catch {
          /* keep scanning */
        }
      }
    }
  }
  return null
}

// Call the host llm.stream and concatenate the assistant text. Throws on a
// terminal non-stop finish or a transport error, so callers can fall back.

// v2.2.11: classify a thrown error as a transport/network failure (network down,
// connection refused, DNS, TLS, socket hang up). These are NOT worth retrying --
// retrying just burns MAX_STEP_ATTEMPTS x draftTimeoutMs before surfacing the
// failure, which made the panel keep "running" for ~15min during a network outage
// (user m10079). AbortError (user cancel / the slow timeout) is deliberately NOT a
// transport error so the cancel + slow-timeout retry paths keep working.
function isTransportErr(e) {
  if (!e || typeof e !== 'object') return false
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return false
  if (e.isTransport) return true
  const code = e.code || (e.cause && e.cause.code)
  if (typeof code === 'string' && /^(ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/i.test(code)) return true
  const msg = String(e.message || '')
  if (/fetch failed|socket hang up|network error|connection (refused|reset|closed)|getaddrinfo/i.test(msg)) return true
  const cause = e.cause
  if (cause && cause !== e && isTransportErr(cause)) return true
  return false
}
export async function streamAssistantText(llm, model, { system, user, signal } = {}) {
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm.stream unavailable')
  const messages = []
  if (system) messages.push({ role: 'system', content: [{ type: 'text', text: system }] })
  messages.push({ role: 'user', content: [{ type: 'text', text: user }] })
  let text = ''
  try {
    for await (const chunk of llm.stream({
      provider: model?.provider,
      model: model?.model,
      messages,
      ...(signal ? { signal } : {}),
      purpose: 'skill-evolution-backtest',
    })) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        continue
      }
      if (chunk.type === 'finish' && chunk.reason?.kind && chunk.reason.kind !== 'stop') {
        throw new Error(`llm.stream finished with ${chunk.reason.kind}`)
      }
    }
  } catch (e) {
    // v2.2.11: tag transport/network failures so callers can fail fast instead of
    // burning the whole retry budget while the network is down (user m10079).
    if (isTransportErr(e) && e.name !== 'AbortError') {
      try { e.isTransport = true } catch {}
    }
    throw e
  }
  return text
}

// Judge ONE case's checks. Returns { rows:[{checkId,text,must,pass,engine,reason}], judge }.
// `judge` is 'llm' on a clean model verdict, otherwise 'anchor'.
export async function judgeCase(llm, model, body, c, signal) {
  const norm = normalizeCases([c])[0]
  if (!llm || typeof llm.stream !== 'function' || !model?.provider || !model?.model) {
    return anchorCase(norm, body)
  }
  try {
    const verdicts = await collectVerdicts(llm, model, body, norm, signal)
    if (verdicts.size === 0) throw new Error('unparseable judge output')
    const rows = norm.checks.map((k) => {
      const item = verdicts.get(k.id)
      if (item) {
        return {
          checkId: k.id,
          text: k.text,
          must: k.must === true,
          pass: item.pass,
          engine: GRADE_ENGINE.LLM,
          reason: typeof item.reason === 'string' ? item.reason : undefined,
        }
      }
      // Still missing after the repair pass → anchor fallback for this check.
      const r = gradeCheck(body, k.anchors)
      return {
        checkId: k.id,
        text: k.text,
        must: k.must === true,
        pass: r.pass,
        engine: GRADE_ENGINE.ANCHOR,
        misses: r.misses,
      }
    })
    const judge = rows.every((r) => r.engine === GRADE_ENGINE.LLM) ? GRADE_ENGINE.LLM : GRADE_ENGINE.MIXED
    return { rows, judge }
  } catch (e) {
    // Whole-case fallback on transport / parse failure.
    return anchorCase(norm, body, String((e && e.message) || e))
  }
}

// Ask the model for verdicts on a case's checks. Small/fast judge models often
// drop some entries when asked for many at once, so when the first response is
// partial we re-ask ONLY for the missing checks and merge (m03118 judge
// strengthening). Returns a Map<checkId, {id, pass, reason}> of clean verdicts.
async function collectVerdicts(llm, model, body, c, signal) {
  let first
  try {
    first = await callJudge(llm, model, body, c, signal)
  } catch (e) {
    // Unparseable / transport failure on the first pass: give the model one
    // more chance before the whole case falls back to anchor.
    try {
      first = await callJudge(llm, model, body, c, signal)
    } catch {
      throw e
    }
  }
  const byId = new Map()
  for (const item of first) {
    if (item && item.id != null) byId.set(String(item.id), item)
  }
  const missing = c.checks.filter((k) => {
    const it = byId.get(k.id)
    return !(it && typeof it.pass === 'boolean')
  })
  // Only repair a genuinely partial response — not an empty/garbage one (that
  // would just re-ask the whole case and risk the same failure again).
  if (missing.length > 0 && missing.length < c.checks.length) {
    try {
      const repair = await callJudge(llm, model, body, { ...c, checks: missing }, signal)
      for (const item of repair) {
        if (item && item.id != null) byId.set(String(item.id), item)
      }
    } catch {
      /* repair failed — keep the first pass's verdicts */
    }
  }
  const out = new Map()
  for (const item of byId.values()) {
    if (item && typeof item.pass === 'boolean') out.set(String(item.id), item)
  }
  return out
}

// One LLM round-trip: stream the model text and parse the checks JSON array.
async function callJudge(llm, model, body, c, signal) {
  const text = await streamAssistantText(
    llm,
    model,
    { system: SYSTEM_PROMPT, user: buildUserPrompt(body, [c]), signal }
  )
  const parsed = extractChecksJson(text)
  if (!parsed || !parsed.length) throw new Error('unparseable judge output')
  return parsed
}

function anchorCase(norm, body, fallbackReason) {
  const rows = norm.checks.map((k) => {
    const r = gradeCheck(body, k.anchors)
    return {
      checkId: k.id,
      text: k.text,
      must: k.must === true,
      pass: r.pass,
      engine: GRADE_ENGINE.ANCHOR,
      misses: r.misses,
      ...(fallbackReason ? { fallbackReason } : {}),
    }
  })
  return { rows, judge: GRADE_ENGINE.ANCHOR }
}

// Grade a skill body with the LLM judge (primary) and anchor fallback (safety).
// `engine` forces 'llm' | 'anchor' | 'auto' (default 'auto').
export async function judgeBody(body, cases, { llm, model, signal, engine = 'auto' } = {}) {
  const norm = normalizeCases(cases)
  const useLlm = engine !== GRADE_ENGINE.ANCHOR && llm && typeof llm.stream === 'function' && model?.provider && model?.model
  const caseRows = []
  let totalChecks = 0
  let passedChecks = 0
  let anyLlm = false
  let anyAnchor = false
  for (const c of norm) {
    let judged
    if (useLlm) {
      judged = await judgeCase(llm, model, body, c, signal)
    } else {
      judged = anchorCase(c, body)
    }
    if (judged.judge === GRADE_ENGINE.LLM) anyLlm = true
    else if (judged.judge === GRADE_ENGINE.MIXED) {
      anyLlm = true
      anyAnchor = true
    } else anyAnchor = true
    const rows = judged.rows
    for (const r of rows) {
      totalChecks++
      if (r.pass) passedChecks++
    }
    caseRows.push({
      caseId: c.id,
      title: c.title,
      totalChecks: rows.length,
      passedChecks: rows.filter((k) => k.pass).length,
      score: caseScore(rows),
      verdict: caseVerdict(rows),
      checks: rows,
      judge: judged.judge,
    })
  }
  const agg = aggregate(caseRows)
  return {
    caseRows,
    totalChecks,
    passedChecks,
    score: agg.score,
    passRate: agg.passRate,
    graded: agg.graded,
    errors: agg.errors,
    engine: anyLlm && anyAnchor ? GRADE_ENGINE.MIXED : anyLlm ? GRADE_ENGINE.LLM : GRADE_ENGINE.ANCHOR,
    // Check-level ratio, kept for diagnostics only.
    microScore: totalChecks ? passedChecks / totalChecks : 0,
  }
}

export { checkWeight }
