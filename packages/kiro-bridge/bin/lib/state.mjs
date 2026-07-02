// In-memory store of OpenCode-shaped domain objects the bridge synthesizes from
// ACP traffic. One BridgeState per running bridge; sessions map 1:1 to ACP sessions
// (same UUID string is used for both, since Kiro returns a UUID sessionId).

import { randomUUID } from 'node:crypto';

const now = () => Date.now();

export const PROVIDER_ID = 'kiro';
export const MODEL_ID = 'kiro-cli';

export class BridgeState {
  constructor({ cwd, projectID }) {
    this.cwd = cwd;
    this.projectID = projectID;
    this.sessions = new Map(); // sessionID -> Session
    this.messages = new Map(); // sessionID -> Message[] (info objects)
    this.parts = new Map(); // messageID -> Map(partID -> Part)
    this.modes = { currentModeId: null, availableModes: [] };
    this.permissions = new Map(); // permissionID -> { resolve, meta }
    this.acpBySession = new Map(); // openCode sessionID -> ACP sessionId
  }

  setAcpSession(sessionID, acpSessionId) {
    this.acpBySession.set(sessionID, acpSessionId);
  }

  getAcpSession(sessionID) {
    return this.acpBySession.get(sessionID) || null;
  }

  setModes(modes) {
    if (modes && Array.isArray(modes.availableModes)) this.modes = modes;
  }

  listAgents() {
    // OpenCode Agent[] synthesized from Kiro ACP modes.
    return (this.modes.availableModes || []).map((m) => ({
      name: m.id,
      description: m.description || m.name || m.id,
      mode: 'primary',
      builtIn: false,
      permission: { edit: 'ask', bash: { '*': 'ask' }, webfetch: 'ask' },
      tools: {},
      options: {},
    }));
  }

  createSession(sessionID, { title, parentID } = {}) {
    const session = {
      id: sessionID,
      projectID: this.projectID,
      directory: this.cwd,
      title: title || 'Kiro session',
      version: '2.0.0',
      time: { created: now(), updated: now() },
      ...(parentID ? { parentID } : {}),
    };
    this.sessions.set(sessionID, session);
    this.messages.set(sessionID, []);
    return session;
  }

  getSession(sessionID) {
    return this.sessions.get(sessionID) || null;
  }

  listSessions() {
    return [...this.sessions.values()].sort((a, b) => b.time.updated - a.time.updated);
  }

  touchSession(sessionID) {
    const s = this.sessions.get(sessionID);
    if (s) s.time.updated = now();
    return s;
  }

  deleteSession(sessionID) {
    const msgs = this.messages.get(sessionID) || [];
    for (const m of msgs) this.parts.delete(m.id);
    this.sessions.delete(sessionID);
    this.messages.delete(sessionID);
  }

  addUserMessage(sessionID, { agent, text, id: providedId }) {
    const id = providedId || `msg_${randomUUID()}`;
    const info = {
      id,
      sessionID,
      role: 'user',
      time: { created: now() },
      agent: agent || this.modes.currentModeId || 'kiro_default',
      model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
    };
    this.messages.get(sessionID)?.push(info);
    this.parts.set(id, new Map());
    if (text) {
      this.upsertTextPart(sessionID, id, `prt_${randomUUID()}`, text, { done: true });
    }
    return info;
  }

  startAssistantMessage(sessionID, { mode }) {
    const id = `msg_${randomUUID()}`;
    const info = {
      id,
      sessionID,
      role: 'assistant',
      parentID: this._lastUserMessageId(sessionID) || '',
      time: { created: now() },
      modelID: MODEL_ID,
      providerID: PROVIDER_ID,
      mode: mode || this.modes.currentModeId || 'kiro_default',
      path: { cwd: this.cwd, root: this.cwd },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    this.messages.get(sessionID)?.push(info);
    this.parts.set(id, new Map());
    return info;
  }

  completeAssistantMessage(messageID, sessionID) {
    const info = this._findMessage(sessionID, messageID);
    if (info && info.role === 'assistant') {
      info.time.completed = now();
      info.finish = 'stop';
    }
    return info;
  }

  _lastUserMessageId(sessionID) {
    const msgs = this.messages.get(sessionID) || [];
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return msgs[i].id;
    return null;
  }

  _findMessage(sessionID, messageID) {
    return (this.messages.get(sessionID) || []).find((m) => m.id === messageID) || null;
  }

  messagesWithParts(sessionID) {
    const msgs = this.messages.get(sessionID) || [];
    return msgs.map((info) => ({
      info,
      parts: [...(this.parts.get(info.id)?.values() || [])],
    }));
  }

  // --- Parts ---

  upsertTextPart(sessionID, messageID, partID, text, { done = false } = {}) {
    const map = this.parts.get(messageID) || new Map();
    let part = map.get(partID);
    if (!part) {
      part = {
        id: partID,
        sessionID,
        messageID,
        type: 'text',
        text: '',
        time: { start: now() },
      };
      map.set(partID, part);
    }
    part.text += text;
    if (done && part.time) part.time.end = now();
    this.parts.set(messageID, map);
    return part;
  }

  upsertToolPart(sessionID, messageID, partID, { callID, tool, state }) {
    const map = this.parts.get(messageID) || new Map();
    let part = map.get(partID);
    if (!part) {
      part = { id: partID, sessionID, messageID, type: 'tool', callID, tool, state };
      map.set(partID, part);
    } else {
      if (callID) part.callID = callID;
      if (tool) part.tool = tool;
      if (state) part.state = state;
    }
    this.parts.set(messageID, map);
    return part;
  }
}
