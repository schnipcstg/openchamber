// Allow-path E2E: approve a permission and confirm the command runs + turn completes.
import { createBridge } from '../bin/lib/server.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const cwd = '/home/schnip-cstg/git/openchamber';
const testFile = '/tmp/kiro-bridge-e2e-allow-ran';

async function main() {
  const fs = await import('node:fs/promises');
  await fs.rm(testFile, { force: true });
  const bridge = await createBridge({ cwd, agent: 'kiro_default', logger: { info: () => {}, warn: () => {}, error: console.error } });
  const server = bridge.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const log = (...a) => console.log('[e2e-allow]', ...a);
  const permissions = [];
  const controller = new AbortController();
  readSse(`${base}/event`, controller.signal, (evt) => { if (evt.type === 'permission.asked') permissions.push(evt.properties); });

  try {
    const session = await (await fetch(`${base}/session`, { method: 'POST', headers: json(), body: '{}' })).json();
    const done = fetch(`${base}/session/${session.id}/message`, {
      method: 'POST', headers: json(),
      body: JSON.stringify({ parts: [{ type: 'text', text: `Run the shell command: touch ${testFile}` }] }),
    });
    const permID = await waitFor(() => permissions[0]?.id, 45000);
    if (!permID) throw new Error('no permission prompt');
    await fetch(`${base}/permission/${permID}/reply`, { method: 'POST', headers: json(), body: JSON.stringify({ response: 'once' }) });
    log('permission APPROVED (once)');
    const final = await (await done).json();
    await delay(300);
    let ran = true; try { await fs.access(testFile); } catch { ran = false; }
    if (!ran) throw new Error('approved command did NOT run');
    log('command ran after approval OK');
    if (!final?.info?.id) throw new Error('no final assistant message');
    log('final message role:', final.info.role, 'parts:', final.parts.length);
    log('ALL CHECKS PASSED');
    controller.abort(); await bridge.dispose(); server.close(); process.exit(0);
  } catch (e) {
    console.error('[e2e-allow] FAILED:', e.message);
    controller.abort(); await bridge.dispose(); server.close(); process.exit(1);
  }
}
function json() { return { 'Content-Type': 'application/json' }; }
async function waitFor(fn, ms) { const s = Date.now(); while (Date.now() - s < ms) { const v = fn(); if (v) return v; await delay(50); } return null; }
async function readSse(url, signal, onEvent) {
  const res = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  try { while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const dl = block.split('\n').find((l) => l.startsWith('data:')); if (!dl) continue;
      try { const env = JSON.parse(dl.slice(5).trim()); const p = env.payload || env; if (p?.type) onEvent(p); } catch { /* */ } } } } catch { /* */ }
}
main();
