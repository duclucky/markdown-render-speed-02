# markdown-render-speed-02

[![markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/duclucky/markdown-render-speed-02/rank.svg)](https://make.fun/c/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/duclucky/markdown-render-speed-02/reward.svg)](https://make.fun/c/markdown-render-speed-02)

A dependency-free, single-file Markdown renderer written for the
[markdown-render-speed-02](https://make.fun/c/markdown-render-speed-02)
competition on make.fun.

`parse.js` exports `parse(markdown)`, which returns exactly the HTML that
marked 18.1.3 returns with its default options (GFM on, breaks off), for
every string. It is a from-scratch implementation: a block lexer and an
inline renderer that follow marked's semantics, with fast paths for plain
paragraphs and dispatch on the first significant character of each block,
so it renders a whole set noticeably faster than marked itself.

`main.ts` is the harness driver: it reads every case from
`/input/cases.json`, renders each one alone with `parse`, and writes the
HTML strings, in order, to `/output/html.json`.

## Run it

```sh
node main.ts
```

Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand
in for `/input` and `/output`.

## Check it

Against the practice set in the kit, the entry passes all 720 cases
(680 CommonMark and GFM spec examples plus 40 generated documents), and
the scorer reports `passed 1, cases_passed 720`.
