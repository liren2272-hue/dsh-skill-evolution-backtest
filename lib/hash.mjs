// Hashing helpers. The two hashes here are byte-for-byte the ones the host's
// own saveLedger / runScore paths compute, so a draft this plugin writes is
// indistinguishable from a host-written one to the GUI.

import { createHash } from 'node:crypto'

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

// sha256 of '' — the baseHash a `create`-action draft carries when there is no
// live file yet to hash.
export const EMPTY_SHA = sha256Hex(Buffer.alloc(0))

// The skillCaseSignature the host uses to detect "the eval cases changed under
// a run". Field-for-field the host's own tuple, in the host's order:
//   [id, skillName, title, prompt, context||'', enabled, requiresVision===true,
//    checks.map(c => [id, text, must])]
// JSON.stringify is the COMPACT form (no spaces) — the host stringifies the same
// way, and a pretty-printed variant would hash differently and falsely trip the
// "cases changed" guard on the GUI side.
export function casesHash(cases) {
  const sig = [...cases]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => [
      c.id,
      c.skillName,
      c.title,
      c.prompt,
      c.context ?? '',
      c.enabled,
      c.requiresVision === true,
      (c.checks || []).map((k) => [k.id, k.text, k.must]),
    ])
  return sha256Hex(Buffer.from(JSON.stringify(sig), 'utf8'))
}