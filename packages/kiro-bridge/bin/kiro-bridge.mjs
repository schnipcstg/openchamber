#!/usr/bin/env node
// kiro-bridge: presents `kiro-cli acp` as an OpenCode server for OpenChamber.
//
// Usage:
//   node bin/kiro-bridge.mjs [--port 4599] [--cwd /path/to/project] [--agent kiro_default]
//
// Then launch OpenChamber pointed at the bridge:
//   OPENCODE_HOST=http://127.0.0.1:4599 OPENCODE_SKIP_START=true openchamber

import { createBridge } from './lib/server.mjs';

function parseArgs(argv) {
  const args = { port: 4599, cwd: process.cwd(), agent: undefined, host: '127.0.0.1' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = parseInt(argv[++i], 10);
    else if (a === '--cwd') args.cwd = argv[++i];
    else if (a === '--agent') args.agent = argv[++i];
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: kiro-bridge [--port 4599] [--cwd DIR] [--agent kiro_default] [--host 127.0.0.1]');
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const { port, cwd, agent, host } = parseArgs(process.argv);
  const logger = console;

  logger.info(`[kiro-bridge] starting (cwd=${cwd}, agent=${agent || 'kiro_default'})`);
  const bridge = await createBridge({ cwd, agent, logger });

  const server = bridge.app.listen(port, host, () => {
    logger.info('');
    logger.info(`[kiro-bridge] listening on http://${host}:${port}`);
    logger.info('[kiro-bridge] Attach OpenChamber with:');
    logger.info(`    OPENCODE_HOST=http://${host}:${port} OPENCODE_SKIP_START=true openchamber`);
    logger.info('');
    logger.info('[kiro-bridge] Tool permissions are routed to OpenChamber; nothing is auto-approved.');
  });

  const shutdown = async (sig) => {
    logger.info(`[kiro-bridge] ${sig} received, shutting down...`);
    server.close();
    await bridge.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('[kiro-bridge] fatal:', e);
  process.exit(1);
});
