// E2E smoke test for the bridge. Boots the bridge on a random port, connects to
// the SSE bus, creates a session, sends a tool-using prompt, and verifies:
//   1. /global/health is healthy
//   2. server.connected arrives first on SSE
//   3. session.created + message.part.updated (text) stream in
//   4. permission.asked fires for the tool call; we answer 'reject' via HTTP
//      and confirm the command did NOT run (no auto-approval).
import { createBridge } from '../bin/lib/server.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const cwd = '/home/schnip-cstg/git/openchamber';
const testFile = '/tmp/kiro-bridge-e2e-should-not-exist';

async function main() {
  const fs = await import('node:fs/promises');
  await fs.rm(testFile, { force: true });

  const bridge = await createBridge({ cwd, agent: 'kiro_default', logger: quietLogger() });
  const server = bridge.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const log = (...a) => console.log('[e2e]', ...a);

  try {
    // 1. health
    const health = await (await fetch(`${base}/global/health`)).json();
    assert(health.healthy === true, 'health.healthy');
    log('health OK', JSON.stringify(health));

    // 2. SSE
    const events = [];
    const permissions = [];
    const controller = new AbortController();
    const ssePromise = readSse(`${base}/event`, controller.signal, (evt) => {
      events.push(evt.type);
      if (evt.type === 'permission.asked') permissions.push(evt.properties);
    });
    await delay(300);
    assert(events[0] === 'server.connected', `first event server.connected (got ${events[0]})`);
    log('SSE first event OK:', events[0]);

    // 3. create session
    const session = await (await fetch(`${base}/session`, { method: 'POST', headers: json(), body: '{}' })).json();
    assert(session.id, 'session.id');
    log('session created:', session.id);

    // 4. tool-using prompt (fire async so we can answer the permission mid-turn)
    const promptDone = fetch(`${base}/session/${session.id}/message`, {
      method: 'POST', headers: json(),
      body: JSON.stringify({ parts: [{ type: 'text', text: `Run the shell command: touch ${testFile}` }] }),
    });

    // wait for a permission prompt
    const permID = await waitFor(() => permissions[0]?.id, 45000);
    assert(permID, 'permission.asked fired');
    log('permission prompt received:', permID, JSON.stringify(permissions[0].title));

    // answer REJECT
    const rej = await fetch(`${base}/permission/${permID}/reply`, {
      method: 'POST', headers: json(), body: JSON.stringify({ response: 'reject' }),
    });
    assert(rej.ok, 'permission reject accepted');
    log('permission rejected via HTTP');

    await promptDone;
    await delay(500);

    // 5. verify command did NOT run
    let created = true;
    try { await fs.access(testFile); } catch { created = false; }
    assert(created === false, 'command must NOT have run after reject (no auto-approval)');
    log('CONSTRAINT OK: rejected command did not execute');

    // text streamed?
    assert(events.includes('message.part.updated'), 'text/tool parts streamed');
    log('event types seen:', [...new Set(events)].join(', '));

    controller.abort();
    log('ALL CHECKS PASSED');
    await bridge.dispose();
    server.close();
    process.exit(0);
  } catch (e) {
    console.error('[e2e] FAILED:', e.message);
    try { await bridge.dispose(); server.close(); } catch { /* ignore */ }
    process.exit(1);
  }
}

function json() { return { 'Content-Type': 'application/json' }; }
function assert(c, m) { if (!c) throw new Error('assert failed: ' + m); }
function quietLogger() {
  return { info: () => {}, warn: () => {}, error: (...a) => console.error(...a) };
}
async function waitFor(fn, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await delay(50);
  }
  return null;
}
async function readSse(url, signal, onEvent) {
  const res = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        try {
          const env = JSON.parse(dataLine.slice(5).trim());
          const payload = env.payload || env;
          if (payload?.type) onEvent(payload);
        } catch { /* ignore */ }
      }
    }
  } catch { /* aborted */ }
}

main();
