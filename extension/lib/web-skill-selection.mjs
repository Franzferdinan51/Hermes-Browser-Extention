const SKILL_TOKEN_RE = /(^|\s)([@/])([a-z0-9][a-z0-9_-]{0,63})(?=$|\s)/gi;
const MAX_SELECTED_WEB_SKILLS = 5;

function catalogByName(skills = []) {
  const catalog = new Map();
  for (const skill of Array.isArray(skills) ? skills : []) {
    const name = String(skill?.name || '').trim();
    if (!name) continue;
    catalog.set(name.toLowerCase(), name);
  }
  return catalog;
}

/**
 * Resolve only skills advertised by the connected Hermes runtime. Unknown
 * @/ commands remain in the user message so normal agent handling is intact.
 */
export function extractSelectedWebSkills(value = '', skills = []) {
  const text = String(value || '');
  const catalog = catalogByName(skills);
  const selectedSkills = [];
  const seen = new Set();
  let output = '';
  let cursor = 0;
  let match;
  SKILL_TOKEN_RE.lastIndex = 0;

  while ((match = SKILL_TOKEN_RE.exec(text))) {
    const [token, leading, , rawName] = match;
    const canonical = catalog.get(rawName.toLowerCase());
    if (!canonical) {
      continue;
    }
    output += text.slice(cursor, match.index) + leading;
    cursor = match.index + token.length;
    if (!seen.has(canonical) && selectedSkills.length < MAX_SELECTED_WEB_SKILLS) {
      seen.add(canonical);
      selectedSkills.push(canonical);
    }
  }

  output += text.slice(cursor);
  return {
    selectedSkills,
    message: output.replace(/\s{2,}/g, ' ').trim(),
  };
}
