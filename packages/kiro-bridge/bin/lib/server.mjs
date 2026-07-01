// HTTP front: presents the subset of the OpenCode server API that OpenChamber
// needs, backed by a single `kiro-cli acp` process via AcpClient + Translator.
//
// Endpoints (OpenCode root paths; OpenChamber strips its own /api prefix before proxying):
//   GET  /global/health                         -> { healthy, version }
//   GET  /global/event, GET /event              -> SSE bus (server.connected + events)
//   GET  /config, /config/providers, /provider  -> minimal provider/model surface
//   GET  /agent                                 -> Kiro modes as OpenCode agents
//   GET  /project, /project/current, /path      -> single project (cwd)
//   GET  /session, POST /session                -> list / create
//   GET|PATCH|DELETE /session/:id
//   GET  /session/status
//   GET  /session/:id/message                   -> history with parts
//   POST /session/:id/message                   -> prompt (streams via SSE), returns final assistant msg
//   POST /session/:id/prompt_async              -> fire-and-forget
//   POST /session/:id/abort                     -> cancel turn
//   POST /session/:id/permissions/:permissionID -> answer a permission prompt
//
// CONSTRAINT: permissions are always routed to OpenChamber; we never auto-approve.

import express from 'express';
import { randomUUID } from 'node:crypto';
import { AcpClient } from './acp-client.mjs';
import { BridgeState, PROVIDER_ID, MODEL_ID } from './state.mjs';
import { EventHub } from './event-hub.mjs';
import { Translator } from './translator.mjs';

const VERSION = '2.0.0';

export async function createBridge({ cwd = process.cwd(), agent, logger = console } = {}) {
  const projectID = `prj_${Buffer.from(cwd).toString('hex').slice(0, 16)}`;
  const state = new BridgeState({ cwd, projectID });
  const hub = new EventHub({ logger });
  const translator = new Translator({ state, hub, logger });
  const acp = new AcpClient({ cwd, agent, logger });

  // Route ACP client-bound requests (permission, fs/*) here.
  acp.onClientRequest = async (method, params) => {
    if (method === 'session/request_permission') {
      return translator.requestPermission(params);
    }
    if (method === 'fs/read_text_file') {
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(params.path, 'utf8');
      return { content };
    }
    if (method === 'fs/write_text_file') {
      // Writes still pass through Kiro's own permission gate before reaching us.
      const fs = await import('node:fs/promises');
      await fs.writeFile(params.path, params.content ?? '', 'utf8');
      return {};
    }
    logger.warn?.(`[kiro-bridge] unhandled ACP client request: ${method}`);
    return {};
  };

  // ACP notifications -> translator.
  acp.on('notification', (msg) => {
    const { method, params } = msg;
    if (method === 'session/update' || method === '_kiro.dev/session/update') {
      const sid = params.sessionID || params.sessionId;
      if (sid) translator.handleSessionUpdate(sid, params.update);
    } else if (method === '_kiro.dev/metadata') {
      // context/token usage — parked for M3 cost readout.
    }
    // other _kiro.dev/* notifications ignored for now
  });

  await acp.start();
  await acp.initialize();

  // Prime Kiro's mode list so GET /agent works before OpenChamber creates a session.
  // ACP `modes` are only returned by session/new, so we create one probe session and
  // capture its modes. The probe session is kept ACP-side but not surfaced to OpenChamber.
  try {
    const probe = await acp.request('session/new', { cwd, mcpServers: [] }, { timeoutMs: 30000 });
    state.setModes(probe.modes);
    logger.info?.(`[kiro-bridge] captured ${state.listAgents().length} Kiro agents (modes)`);
  } catch (e) {
    logger.warn?.(`[kiro-bridge] could not prime modes: ${e.message}`);
  }

  const app = express();
  app.use(express.json({ limit: '32mb' }));

  const send = (res, body) => res.json(body);

  // --- health ---
  app.get(['/global/health', '/health'], (_req, res) => send(res, { healthy: true, version: VERSION }));

  // --- SSE bus ---
  app.get(['/global/event', '/event'], (req, res) => {
    req.socket.setTimeout?.(0);
    res.setHeader?.('Connection', 'keep-alive');
    hub.addClient(res, { directory: cwd });
  });

  // --- provider / config / agent surface ---
  app.get('/config', (_req, res) => send(res, {}));
  app.get('/config/providers', (_req, res) =>
    send(res, {
      providers: [providerObject()],
      default: { [PROVIDER_ID]: MODEL_ID },
    }),
  );
  app.get('/provider', (_req, res) =>
    send(res, {
      all: [providerObject()],
      default: { [PROVIDER_ID]: MODEL_ID },
      connected: { [PROVIDER_ID]: true },
    }),
  );
  app.get('/agent', (_req, res) => send(res, state.listAgents()));
  app.get(['/project', '/project/current'], (_req, res) => send(res, projectObject(projectID, cwd)));
  app.get('/path', (_req, res) => send(res, { directory: cwd, worktree: cwd }));

  // --- sessions ---
  app.get('/session', (_req, res) => send(res, state.listSessions()));
  app.get('/session/status', (_req, res) => send(res, {}));

  app.post('/session', async (req, res) => {
    try {
      const { parentID, title } = req.body || {};
      const result = await acp.request('session/new', { cwd, mcpServers: [] }, { timeoutMs: 30000 });
      const sessionID = result.sessionId;
      state.setModes(result.modes);
      const session = state.createSession(sessionID, { title, parentID });
      hub.broadcast({ type: 'session.created', properties: { info: session } }, cwd);
      send(res, session);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/session/:id', (req, res) => {
    const s = state.getSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    send(res, s);
  });

  app.patch('/session/:id', (req, res) => {
    const s = state.getSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    if (req.body?.title) s.title = req.body.title;
    s.time.updated = Date.now();
    hub.broadcast({ type: 'session.updated', properties: { info: s } }, cwd);
    send(res, s);
  });

  app.delete('/session/:id', (req, res) => {
    state.deleteSession(req.params.id);
    hub.broadcast({ type: 'session.deleted', properties: { info: { id: req.params.id } } }, cwd);
    send(res, true);
  });

  app.get('/session/:id/message', (req, res) => {
    if (!state.getSession(req.params.id)) return res.status(404).json({ error: 'not found' });
    send(res, state.messagesWithParts(req.params.id));
  });

  app.get('/session/:id/message/:messageID', (req, res) => {
    const withParts = state.messagesWithParts(req.params.id).find((m) => m.info.id === req.params.messageID);
    if (!withParts) return res.status(404).json({ error: 'not found' });
    send(res, withParts);
  });

  // --- prompt (streamed via SSE; HTTP resolves at end of turn) ---
  const runPrompt = async (sessionID, parts, { agent: agentOverride } = {}) => {
    const text = extractText(parts);
    state.addUserMessage(sessionID, { agent: agentOverride, text });
    state.touchSession(sessionID);
    translator.beginTurn(sessionID);
    const promptParts = [{ type: 'text', text }];
    await acp.request('session/prompt', { sessionId: sessionID, prompt: promptParts }, { timeoutMs: 0 });
    translator.endTurn(sessionID);
  };

  app.post('/session/:id/message', async (req, res) => {
    const sessionID = req.params.id;
    if (!state.getSession(sessionID)) return res.status(404).json({ error: 'not found' });
    try {
      await runPrompt(sessionID, req.body?.parts || [], { agent: req.body?.agent });
      const msgs = state.messagesWithParts(sessionID);
      const last = msgs[msgs.length - 1];
      send(res, last || {});
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/session/:id/prompt_async', async (req, res) => {
    const sessionID = req.params.id;
    if (!state.getSession(sessionID)) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
    runPrompt(sessionID, req.body?.parts || [], { agent: req.body?.agent }).catch((e) =>
      logger.error?.(`[kiro-bridge] async prompt error: ${e.message}`),
    );
  });

  app.post('/session/:id/abort', async (req, res) => {
    try {
      await acp.request('session/cancel', { sessionId: req.params.id }).catch(() => {});
    } catch { /* ignore */ }
    translator.endTurn(req.params.id);
    send(res, true);
  });

  // --- permission answer (constraint-critical) ---
  app.post('/session/:id/permissions/:permissionID', (req, res) => {
    const response = req.body?.response; // 'once' | 'always' | 'reject'
    const ok = translator.respondPermission(req.params.permissionID, response);
    if (!ok) return res.status(404).json({ error: 'unknown permission' });
    send(res, true);
  });

  // --- graceful fallback for unimplemented endpoints ---
  app.all(/.*/, (req, res) => {
    logger.warn?.(`[kiro-bridge] unhandled ${req.method} ${req.path} -> {}`);
    if (req.method === 'GET') return res.json({});
    return res.json({});
  });

  return {
    app,
    async dispose() {
      hub.dispose();
      await acp.stop();
    },
  };
}

function providerObject() {
  return {
    id: PROVIDER_ID,
    name: 'Kiro CLI',
    env: [],
    models: {
      [MODEL_ID]: {
        id: MODEL_ID,
        name: 'Kiro CLI Agent',
        release_date: '2026-01-01',
        attachment: true,
        reasoning: false,
        temperature: false,
        tool_call: true,
        cost: { input: 0, output: 0 },
        limit: { context: 200000, output: 8192 },
        options: {},
      },
    },
  };
}

function projectObject(projectID, cwd) {
  return { id: projectID, worktree: cwd, directory: cwd, time: { created: Date.now() } };
}

function extractText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}
