// Concurrency E2E: fire POST /message and POST /prompt_async for the SAME session
// at the same time (OpenChamber's double-send pattern) and confirm neither hits
// "Prompt already in progress" and the turn completes.
import { createBridge } from '../bin/lib/server.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const cwd = '/home/schnip-cstg/git/openchamber';

async function main() {
  let sawInProgress = false;
  const logger = {
    info: () => {}, warn: () => {},
    error: (...a) => { const s = a.join(' '); if (/already in progress/i.test(s)) sawInProgress = true; console.error(...a); },
  };
  const bridge = await createBridge({ cwd, agent: 'kiro_default', logger });
  const server = bridge.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const log = (...a) => console.log('[e2e-concurrent]', ...a);
  try {
    const session = await (await fetch(`${base}/session`, { method: 'POST', headers: json(), body: '{}' })).json();
    const text = 'Reply with exactly one word: pong';
    // Fire both at once with identical text (the duplicate-send case).
    const a = fetch(`${base}/session/${session.id}/message`, { method: 'POST', headers: json(), body: JSON.stringify({ parts: [{ type: 'text', text }] }) });
    const b = fetch(`${base}/session/${session.id}/prompt_async`, { method: 'POST', headers: json(), body: JSON.stringify({ parts: [{ type: 'text', text }] }) });
    const [ra, rb] = await Promise.all([a, b]);
    log('POST /message status:', ra.status, ' prompt_async status:', rb.status);
    const final = await ra.json();
    await delay(500);
    if (sawInProgress) throw new Error('saw "Prompt already in progress" — serialization failed');
    if (!final?.info?.id) throw new Error('no assistant message from /message');
    log('no "already in progress" error; turn completed. parts:', final.parts.length);

    // Now a distinct second prompt should run cleanly after the first.
    const r2 = await fetch(`${base}/session/${session.id}/message`, { method: 'POST', headers: json(), body: JSON.stringify({ parts: [{ type: 'text', text: 'Reply with exactly one word: ping' }] }) });
    const f2 = await r2.json();
    if (sawInProgress) throw new Error('second prompt hit "already in progress"');
    if (!f2?.info?.id) throw new Error('no assistant message from second prompt');
    log('second distinct prompt completed cleanly');
    log('ALL CHECKS PASSED');
    await bridge.dispose(); server.close(); process.exit(0);
  } catch (e) {
    console.error('[e2e-concurrent] FAILED:', e.message);
    await bridge.dispose(); server.close(); process.exit(1);
  }
}
function json() { return { 'Content-Type': 'application/json' }; }
main();
