# SCHEMA — how agents maintain this folder

This folder is a living knowledge base for one trading session. Humans write
`raw/` and `thesis.md`; agents compile and maintain `wiki/`.

## Layers
- `raw/` — immutable sources (notes, articles, data). Agents read, never edit.
- `wiki/` — compiled knowledge. Agents create and update pages; every claim
  cites its source as `[news:<id>]`, `[raw:<path>]`, or `[trade:<ref>]`.
- `seed.yaml` — configuration. Only the human changes money and risk.

## Pages
- `wiki/index.md` — one line per page: `- [[path]] — summary`. Update on every write.
- `wiki/log.md` — append-only. `## [YYYY-MM-DD HH:MM] <kind> | <title>` then 1–3 lines.
- `wiki/markets/<slug>.md` — question, resolution criteria, current fair value
  with reasoning, key drivers, what would change our mind, recent signals.
- `wiki/entities/<slug>.md` — who/what it is, relations, recent developments.
- `wiki/lessons.md` — lessons from resolved predictions: pattern → evidence → rule.

## Operations
- **ingest**: a new source or headline → touch every page it affects (often 5–15),
  append to log.md, refresh index.md.
- **query**: answer from the wiki first; file durable answers back as pages.
- **lint**: find contradictions, stale claims, orphans, missing cross-links; fix them.

## Rules
- Prefer updating an existing page over creating a near-duplicate.
- Mark uncertainty explicitly; never state a probability without its basis.
- When newer facts contradict a page, rewrite the claim and log the change.
