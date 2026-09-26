/**
 * @pocket-network/agentic-portal-mcp — the buyer's MCP server.
 *
 * A buyer: it pays the portal from the outside through the buyer client (the
 * `buyer/` module in the public repository), as any agent would, and the
 * portal never imports it.
 */
export { createDeps, createServer, SERVER_NAME, SERVER_VERSION, stderrLogger } from './server.js';
export { readSettings, type Settings } from './settings.js';
export { Budget, BudgetExhausted } from './budget.js';
export { Catalogue, priceAtomic } from './catalogue.js';
export { checkRoute } from './routes.js';
export {
  callService,
  describeService,
  searchServices,
  type Deps,
  type ToolResult,
} from './tools.js';
