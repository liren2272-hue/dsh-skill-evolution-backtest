// Path resolution for the skill-evolution-backtest tools.
// All three roots are overridable from cordis.patch.yml config; the defaults
// match the stock Windows desktop layout. Resolved once at apply() and reused.

import path from 'node:path'
import os from 'node:os'

export function resolvePaths(cfg = {}) {
  const home = os.homedir()
  const ledgerPath = cfg.ledgerPath || path.join(home, '.mnemon', 'skills', 'ledger.json')
  const evalsPath = cfg.evalsPath || path.join(home, '.mnemon', 'skills', 'evals.json')
  const skillsRoot = cfg.skillsRoot || path.join(home, '.dsh', 'skills')
  // A skill lives at <skillsRoot>/<skillName>/SKILL.md.
  const skillFile = (skillName) => path.join(skillsRoot, skillName, 'SKILL.md')
  return { ledgerPath, evalsPath, skillsRoot, skillFile }
}