[![markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02)
[![Rank](https://make.fun/badge/markdown-render-speed-02/giandisruw/markdown-render-speed-02/rank.svg)](https://make.fun/c/markdown-render-speed-02)
[![Reward](https://make.fun/badge/markdown-render-speed-02/giandisruw/markdown-render-speed-02/reward.svg)](https://make.fun/c/markdown-render-speed-02)

# Fast Markdown — a drop-in replacement for marked 18.1.3

An entry for the make.fun bounty [Make Markdown rendering faster](https://make.fun/bounty/markdown-render-speed-02).

## What it is

A dependency-free, single-file ES module (`parse.js`) that exports one function, `parse(markdown)`, and returns exactly the HTML that marked 18.1.3 produces with its default options — GFM on, breaks off, pedantic off — for every CommonMark 0.31.2 spec example, every GFM 0.29 extension example, and long generated README documents. Same output, byte for byte, but it renders the whole practice set faster than marked itself.

The renderer is hand-written: a single-pass block parser plus an inline parser, with no dependencies and no build step. It covers headings, paragraphs, lists, blockquotes, fenced and indented code, tables, strikethrough, autolinks, emphasis, links, images, HTML blocks, and all the edge cases the spec examples exercise.

## Files

- `parse.js` — the renderer. Exports `parse(markdown)`.
- `main.ts` — the driver the harness runs: reads `cases.json`, renders each case with `parse()`, and writes `html.json`.
- `LICENSE` — MIT.
- `package.json` — package metadata.

## Usage

```js
import { parse } from "./parse.js";

const html = parse("# Hello\n\nSome **bold** text.");
```

---

Referral code: 0txwmf1m
