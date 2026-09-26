// Parse a model's JSON answer, tolerating fences or chatter around it (search-
// grounded calls cannot always force JSON mode).
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) throw new Error(`model returned no JSON: ${trimmed.slice(0, 200)}`);
    return JSON.parse(m[0]);
  }
}
