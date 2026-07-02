// Recovery E2E: prompt a session id that was NEVER created via POST /session
// (simulates OpenChamber restoring a session from its own DB). The bridge should
// transparently create a fresh ACP session and complete the turn instead of erroring.
import { createBridge } from '../bin/lib/server.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const cwd = '/home/schnip-cstg/git/openchamber';

async function main() {
  const bridge = await createBridge({ cwd, agent: 'kiro_default', logger: { info: () => {}, warn: () => {}, error: console.error } });
  const server = bridge.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const log = (...a) => console.log('[e2e-recover]', ...a);
  try {
    const staleId = 'stale-session-not-created-here-123';
    // No POST /session. Directly prompt with a plain (no-tool) message.
    const resp = await fetch(`${base}/session/${staleId}/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'Reply with exactly one word: pong' }] }),
    });
    if (!resp.ok) throw new Error(`prompt failed: ${resp.status} ${await resp.text()}`);
    const final = await resp.json();
    if (!final?.info?.id) throw new Error('no assistant message returned after recovery');
    log('recovered + completed turn; final role:', final.info.role, 'parts:', final.parts.length);
    // session should now be listed
    const sessions = await (await fetch(`${base}/session`)).json();
    if (!sessions.find((s) => s.id === staleId)) throw new Error('recovered session not listed');
    log('recovered session is listed OK');
    log('ALL CHECKS PASSED');
    await bridge.dispose(); server.close(); process.exit(0);
  } catch (e) {
    console.error('[e2e-recover] FAILED:', e.message);
    await bridge.dispose(); server.close(); process.exit(1);
  }
}
main();
