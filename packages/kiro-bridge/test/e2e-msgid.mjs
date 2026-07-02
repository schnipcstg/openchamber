// Dedupe/echo test: when OpenChamber sends a prompt_async with a client messageID,
// the bridge must reuse that exact ID for the emitted user message (so its optimistic
// message reconciles instead of duplicating), and must not double-run the turn.
import { createBridge } from '../bin/lib/server.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const cwd = '/home/schnip-cstg/git/openchamber';
async function main() {
  const bridge = await createBridge({ cwd, agent: 'kiro_default', logger: { info: () => {}, warn: () => {}, error: console.error } });
  const server = bridge.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const log = (...a) => console.log('[e2e-msgid]', ...a);
  const userMsgIds = [];
  const controller = new AbortController();
  (async () => {
    const res = await fetch(`${base}/event`, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const dl = block.split('\n').find((l) => l.startsWith('data:')); if (!dl) continue;
        try { const env = JSON.parse(dl.slice(5).trim()); const p = env.payload || env;
          if (p.type === 'message.updated' && p.properties?.info?.role === 'user') userMsgIds.push(p.properties.info.id);
        } catch { /* */ } } }
  })().catch(() => {});
  await delay(200);
  try {
    const s = await (await fetch(`${base}/session`, { method: 'POST', headers: json(), body: '{}' })).json();
    const clientMsgId = 'msg_client_supplied_123';
    // Fire prompt_async + message with the SAME client messageID (OpenChamber's pattern).
    await fetch(`${base}/session/${s.id}/prompt_async`, { method: 'POST', headers: json(), body: JSON.stringify({ messageID: clientMsgId, parts: [{ type: 'text', text: 'Reply with exactly one word: pong' }] }) });
    await delay(4000);
    const uniq = [...new Set(userMsgIds)];
    log('user message ids emitted:', JSON.stringify(uniq));
    if (!uniq.includes(clientMsgId)) throw new Error(`bridge did not reuse client messageID (got ${JSON.stringify(uniq)})`);
    if (uniq.length !== 1) throw new Error(`expected exactly one user message id, got ${uniq.length}`);
    log('client messageID reused; no duplicate user message');
    log('ALL CHECKS PASSED');
    controller.abort(); await bridge.dispose(); server.close(); process.exit(0);
  } catch (e) {
    console.error('[e2e-msgid] FAILED:', e.message);
    controller.abort(); await bridge.dispose(); server.close(); process.exit(1);
  }
}
function json() { return { 'Content-Type': 'application/json' }; }
main();
