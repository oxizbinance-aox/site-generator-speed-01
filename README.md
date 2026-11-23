# site-generator-speed-01

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/oxizbinance-aox/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/oxizbinance-aox/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in for makefun-site 1.0.0: it builds the same static-site output
tree, byte for byte, from the same input — front matter, template dialect,
Markdown subset, slug rule and build report — but faster.

Bounty: https://make.fun/bounty/site-generator-speed-01-run-20261122

## How it is fast

- Markdown is rendered directly, block by block, with no token objects: a
  single-pass inline scanner that flushes plain runs as slices instead of
  escaping character by character.
- Slugs are cached (titles, headings and tags repeat across a site).
- Templates are parsed once and compiled to small JS functions; scopes are
  prototype-chained null-prototype objects, so a variable lookup is a plain
  property read instead of a scope-chain walk.
- Cards are built once per post and reused by index, tag and recent lists;
  output is accumulated in arrays and joined once.

## Layout

- `solve.js` — dependency-free ES module, `run(input)` returns the output tree.
- `main.ts` — driver: reads `/input/cases.json`, answers each case with `run`,
  writes `/output/answers.json`.

Run it with Node 22, standard library only:

    node main.ts
