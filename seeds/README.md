# Seed folders

A session starts from a seed folder: money, markets, risk, sources and your
own knowledge. The web onboarding builds one for you (and lets you download
it as a zip); you can also write one by hand and import it with
`npm run seed:import -- seeds/<folder>`.

```
seed.yaml          config: bankroll, mode, markets (conditionId, note, prior),
                   risk, intel budget, feeds, keywords
SCHEMA.md          conventions the agents follow when maintaining wiki/
thesis.md          your view, priors and red lines (read by every forecaster)
raw/…              your sources — notes, articles, data (agents never edit)
wiki/index.md      catalog of compiled pages
wiki/log.md        append-only timeline (ingests, compiles, lessons)
wiki/lessons.md    lessons distilled from resolved predictions
wiki/markets/*.md  one page per market, compiled and kept current by agents
```

The folder is stored in SpacetimeDB (`seed_file` rows) once imported; the
engine keeps `wiki/` compiling as news, trades and outcomes arrive, so the
knowledge compounds.

`example-macro-geopolitics/` is a working example (paper mode, $1,000, Fed
and Middle-East markets).
