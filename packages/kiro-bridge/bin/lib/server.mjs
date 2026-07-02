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

  // Maps ACP session id -> OpenCode session id (they're identical for sessions we
  // create directly, but differ for recovered/stale sessions).
  const acpToOpenCode = new Map();

  // ACP notifications -> translator.
  acp.on('notification', (msg) => {
    const { method, params } = msg;
    if (method === 'session/update' || method === '_kiro.dev/session/update') {
      const acpSid = params.sessionID || params.sessionId;
      if (acpSid) {
        const sid = acpToOpenCode.get(acpSid) || acpSid;
        translator.handleSessionUpdate(sid, params.update);
      }
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
      const acpSessionId = result.sessionId;
      state.setModes(result.modes);
      // Use the ACP session id as the OpenCode session id too (1:1), so events line up.
      const session = state.createSession(acpSessionId, { title, parentID });
      state.setAcpSession(acpSessionId, acpSessionId);
      hub.broadcast({ type: 'session.created', properties: { info: session } }, cwd);
      send(res, session);
    } catch (e) {
      logger.error?.(`[kiro-bridge] session create failed: ${e.message} ${JSON.stringify(e.data || {})}`);
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

  // Ensure an ACP session exists for the given OpenCode sessionID. If OpenChamber
  // restored a session id from its own DB that this bridge run never created,
  // spin up a fresh ACP session and map it, so prompts don't fail with "Internal error".
  const ensureAcpSession = async (sessionID) => {
    let acpId = state.getAcpSession(sessionID);
    if (acpId) return acpId;
    const result = await acp.request('session/new', { cwd, mcpServers: [] }, { timeoutMs: 30000 });
    acpId = result.sessionId;
    state.setModes(result.modes);
    if (!state.getSession(sessionID)) {
      const s = state.createSession(sessionID, {});
      hub.broadcast({ type: 'session.created', properties: { info: s } }, cwd);
    }
    state.setAcpSession(sessionID, acpId);
    // Map ACP notifications for this new ACP id back to the OpenCode sessionID.
    acpToOpenCode.set(acpId, sessionID);
    logger.warn?.(`[kiro-bridge] recovered unknown session ${sessionID} -> new ACP ${acpId}`);
    return acpId;
  };

  // --- prompt (streamed via SSE; HTTP resolves at end of turn) ---
  // A single kiro-cli ACP session can only run ONE prompt turn at a time (a second
  // session/prompt returns "Prompt already in progress"). We therefore serialize
  // prompts per session: each new prompt chains onto the previous one for that
  // session so turns never overlap. This also absorbs OpenChamber issuing both
  // POST /message and prompt_async for a single send (the second simply waits,
  // and since it carries the same text we skip the empty duplicate).
  const sessionQueue = new Map(); // sessionID -> Promise (tail of the chain)

  const runPromptInner = async (sessionID, parts, { agent: agentOverride, messageID } = {}) => {
    const text = extractText(parts);
    const acpId = await ensureAcpSession(sessionID);
    const userInfo = state.addUserMessage(sessionID, { agent: agentOverride, text, id: messageID });
    translator.emitUserMessage(sessionID, userInfo);
    state.touchSession(sessionID);
    translator.beginTurn(sessionID);
    const promptParts = [{ type: 'text', text }];
    logger.info?.(`[kiro-bridge] turn START session=${sessionID} acp=${acpId} text=${JSON.stringify(text.slice(0, 60))}`);
    // Watchdog: if nothing streams back within 30s, log it (helps spot hung turns).
    const watchdog = setTimeout(() => {
      logger.warn?.(`[kiro-bridge] turn for ${sessionID} still running after 30s with no result yet`);
    }, 30000);
    try {
      const result = await acp.request('session/prompt', { sessionId: acpId, prompt: promptParts }, { timeoutMs: 0 });
      logger.info?.(`[kiro-bridge] turn DONE session=${sessionID} stopReason=${result?.stopReason}`);
    } catch (e) {
      logger.error?.(`[kiro-bridge] prompt failed for ${sessionID} (acp ${acpId}): ${e.message} ${JSON.stringify(e.data || {})}`);
      throw e;
    } finally {
      clearTimeout(watchdog);
      translator.endTurn(sessionID);
    }
  };

  const lastPromptKey = new Map(); // sessionID -> dedupe key (messageID or text)
  const runPrompt = (sessionID, parts, opts = {}) => {
    const text = extractText(parts);
    const key = opts.messageID || text;
    const tail = sessionQueue.get(sessionID) || Promise.resolve();

    // Dedupe: OpenChamber issues the same send via prompt_async (and sometimes
    // /message). Keyed on the stable client messageID, the duplicate joins the
    // active turn instead of enqueuing a second prompt.
    if (sessionQueue.has(sessionID) && lastPromptKey.get(sessionID) === key && key) {
      logger.warn?.(`[kiro-bridge] duplicate prompt for ${sessionID} (key=${key}); joining active turn`);
      return tail;
    }

    lastPromptKey.set(sessionID, key);
    const next = tail
      .catch(() => {}) // isolate: a failed prior turn shouldn't cancel the next
      .then(() => runPromptInner(sessionID, parts, opts));
    const settled = next.finally(() => {
      if (sessionQueue.get(sessionID) === settled) {
        sessionQueue.delete(sessionID);
        lastPromptKey.delete(sessionID);
      }
    });
    sessionQueue.set(sessionID, settled);
    return next;
  };

  app.post('/session/:id/message', async (req, res) => {
    const sessionID = req.params.id;
    try {
      await runPrompt(sessionID, req.body?.parts || [], { agent: req.body?.agent, messageID: req.body?.messageID });
      const msgs = state.messagesWithParts(sessionID);
      const last = msgs[msgs.length - 1];
      send(res, last || {});
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/session/:id/prompt_async', async (req, res) => {
    const sessionID = req.params.id;
    res.status(204).end();
    runPrompt(sessionID, req.body?.parts || [], { agent: req.body?.agent, messageID: req.body?.messageID }).catch((e) =>
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
  // OpenChamber replies via POST /permission/:permissionID/reply  { response }.
  // We also accept the legacy /session/:id/permissions/:permissionID path.
  const handlePermissionReply = (permissionID, response, res) => {
    const ok = translator.respondPermission(permissionID, response);
    if (!ok) return res.status(404).json({ error: 'unknown permission' });
    return send(res, true);
  };
  app.post('/permission/:permissionID/reply', (req, res) =>
    handlePermissionReply(req.params.permissionID, req.body?.response, res),
  );
  app.post('/session/:id/permissions/:permissionID', (req, res) =>
    handlePermissionReply(req.params.permissionID, req.body?.response, res),
  );

  // --- files / search (backed by local FS) ---
  app.get('/find/file', async (req, res) => {
    const query = String(req.query.query || req.query.pattern || '').trim();
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      // Use ripgrep-style listing if available; fall back to find.
      let files = [];
      try {
        const { stdout } = await run('bash', ['-lc', `cd ${shq(cwd)} && (git ls-files 2>/dev/null || find . -type f) | head -2000`]);
        files = stdout.split('\n').map((s) => s.replace(/^\.\//, '')).filter(Boolean);
      } catch { files = []; }
      if (query) {
        const q = query.toLowerCase();
        files = files.filter((f) => f.toLowerCase().includes(q));
      }
      send(res, files.slice(0, 100));
    } catch {
      send(res, []);
    }
  });

  app.get(['/find', '/find/symbol'], (_req, res) => send(res, []));

  app.get('/file', async (req, res) => {
    // directory listing
    const rel = String(req.query.path || '').replace(/^\/+/, '');
    try {
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const abs = path.resolve(cwd, rel);
      if (!abs.startsWith(cwd)) return res.status(403).json({ error: 'outside workspace' });
      const entries = await fs.readdir(abs, { withFileTypes: true });
      send(res, entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })));
    } catch {
      send(res, []);
    }
  });

  app.get('/file/content', async (req, res) => {
    const rel = String(req.query.path || '').replace(/^\/+/, '');
    try {
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const abs = path.resolve(cwd, rel);
      if (!abs.startsWith(cwd)) return res.status(403).json({ error: 'outside workspace' });
      const content = await fs.readFile(abs, 'utf8');
      send(res, { content, type: 'raw' });
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  app.get('/file/status', (_req, res) => send(res, []));

  // --- stubs for endpoints OpenChamber polls (return correct empty shapes) ---
  // Arrays: these are lists the UI iterates over; {} would break it.
  app.get(['/command', '/mcp', '/lsp', '/skill', '/experimental/session'], (_req, res) => send(res, []));
  // /vcs -> repo/branch info object (empty is fine)
  app.get('/vcs', (_req, res) => send(res, {}));
  // /question -> pending questions (none). /permission -> pending permission requests.
  app.get('/question', (_req, res) => send(res, []));
  app.get('/permission', (_req, res) => send(res, translator.allPendingPermissions()));

  // --- graceful fallback for unimplemented endpoints ---
  app.all(/.*/, (req, res) => {
    logger.warn?.(`[kiro-bridge] unhandled ${req.method} ${req.path} -> {}`);
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

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function extractText(parts) {  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}
