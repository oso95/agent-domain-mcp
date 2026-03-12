#!/usr/bin/env node
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, mkdirSync, cpSync, readdirSync } from 'fs';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = createRequire(import.meta.url)('../package.json');

const cmd = process.argv[2];

if (cmd === 'install') {
  // Install Claude Code skills to ~/.claude/skills/
  const skillsSrc = resolve(__dirname, '../skills');
  const skillsDst = join(homedir(), '.claude', 'skills');

  if (!existsSync(skillsSrc)) {
    console.error('Skills directory not found in package. Please reinstall.');
    process.exit(1);
  }

  mkdirSync(skillsDst, { recursive: true });

  const skills = readdirSync(skillsSrc, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const skill of skills) {
    const src = join(skillsSrc, skill);
    const dst = join(skillsDst, skill);
    cpSync(src, dst, { recursive: true });
    console.log(`  installed: /domain-${skill.replace(/^domain-/, '')}  →  ${dst}`);
  }

  console.log(`\nInstalled ${skills.length} skills. Restart Claude Code to activate them.\n`);
  console.log('Available commands:');
  for (const skill of skills) {
    console.log(`  /${skill}`);
  }
  console.log('');

} else if (cmd === 'config') {
  // Print Claude Desktop / MCP client config snippet
  console.log(`
Add to your claude_desktop_config.json (or your MCP client's settings):

{
  "mcpServers": {
    "domain": {
      "command": "npx",
      "args": ["-y", "domain-suite-mcp@${pkg.version}"],
      "env": {
        "PORKBUN_API_KEY": "pk1_...",
        "PORKBUN_SECRET_API_KEY": "sk1_..."
      }
    }
  }
}

Environment variables (add only what you need):

  PORKBUN_API_KEY / PORKBUN_SECRET_API_KEY
  NAMECHEAP_API_KEY / NAMECHEAP_API_USER
  GODADDY_API_KEY / GODADDY_API_SECRET
  CLOUDFLARE_API_TOKEN

See docs/PROVIDERS.md for full setup instructions.
`);

} else if (cmd === '--version' || cmd === '-v') {
  console.log(pkg.version);

} else if (cmd === '--help' || cmd === '-h') {
  console.log(`
domain-suite-mcp v${pkg.version}
MCP server for AI agents to manage domains and DNS.

Usage:
  npx domain-suite-mcp              Start the MCP server (stdio transport)
  npx domain-suite-mcp install      Install Claude Code skills to ~/.claude/skills/
  npx domain-suite-mcp config       Print MCP client configuration snippet
  npx domain-suite-mcp --version    Print version
`);

} else if (cmd !== undefined) {
  console.error(`Unknown command: ${cmd}`);
  console.error('Run with --help for usage.');
  process.exit(1);

} else {
  // Default: start MCP server
  import('../dist/index.js').catch((err) => {
    console.error('Failed to start domain-suite-mcp:', err);
    process.exit(1);
  });
}
