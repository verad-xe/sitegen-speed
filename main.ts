// sitegen-speed: the harness runs `node main.ts` (node22). It reads every
// case from /input/cases.json (a JSON array of {id, input}), answers each
// one alone with run() from solve.js, and writes /output/answers.json: a
// JSON array of the answers, one per case and in the cases' order.
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.
//
// The answers are serialised one case at a time and joined, so the driver
// never holds both the whole answers array and its whole JSON text at
// once; the bytes written are exactly JSON.stringify of the answers array.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of
// its work runs under it.
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const parts: string[] = ['['];
for (let i = 0; i < cases.length; i++) {
  if (i > 0) parts.push(',');
  parts.push(JSON.stringify(run(cases[i].input)));
}
parts.push(']');
writeFileSync(join(OUTPUT_DIR, 'answers.json'), parts.join(''));
