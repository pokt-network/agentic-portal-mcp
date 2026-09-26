#!/usr/bin/env node
/**
 * `npx @pocket-network/agentic-portal-mcp` — the stdio entry point.
 *
 * `serveStdio` owns the protocol-revision decision: a 2025-era client opens
 * with `initialize`, a 2026-07-28 client with `server/discover`, and both are
 * served from the same factory. A hand-wired transport answers only the older
 * revision.
 *
 * The deps are built ONCE, outside the factory, so the session's spend total
 * is one budget for the life of the process, whatever the transport does.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createDeps, createServer, stderrLogger } from './server.js';
import { readSettings } from './settings.js';

const logger = stderrLogger();
const settings = readSettings(process.env);
for (const problem of settings.problems) logger.warn(problem);

const deps = createDeps(settings, logger);
serveStdio(() => createServer(deps));
