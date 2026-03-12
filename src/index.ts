import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { buildRegistry } from './registry.js';
import { createServer } from './server.js';

async function main() {
  const config = loadConfig();
  const registry = await buildRegistry(config);
  const server = createServer(registry, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown on both SIGINT (Ctrl+C) and SIGTERM (Docker/systemd/Claude Desktop)
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
