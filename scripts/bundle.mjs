#!/usr/bin/env node
/**
 * Build the published entry point, `bundle/bin.js`.
 *
 * The buyer client is inlined from source. In Pocket Network Foundation's
 * monorepo it is a private workspace package, aliased below to its source;
 * the public repository vendors it under `src/buyer/` and drops the alias.
 * Everything in `dependencies` stays external and is installed by npm, so the
 * published package runs the same reference x402 client and MCP SDK it
 * declares.
 *
 * Runs on `prepack`, so `npm pack` and `npm publish` can never ship an old bundle.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).flatMap((name) => [name, `${name}/*`]);

await build({
  absWorkingDir: root,
  entryPoints: ['src/bin.ts'],
  outfile: 'bundle/bin.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external,
  legalComments: 'none',
  logLevel: 'info',
});
