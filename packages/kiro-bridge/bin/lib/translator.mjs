// Translator: converts ACP traffic into OpenCode events emitted on the EventHub,
// while maintaining BridgeState. Also owns the permission round-trip.
//
// ACP update variants handled:
//   agent_message_chunk / agent_thought_chunk -> text part deltas
//   tool_call            -> new tool part (running)
//   tool_call_update     -> tool part status/output
//   (Kiro extension) _kiro.dev/session/update tool_call_chunk -> pre-announce tool
//
// Permission: ACP session/request_permission (client-bound request) ->
//   emit OpenCode permission.updated event, park a promise keyed by permissionID,
//   resolve it when OpenChamber calls POST /session/:id/permissions/:permissionID.

import { randomUUID } from 'node:crypto';

const now = () => Date.now();

// OpenCode permission response -> ACP optionId. reject is the safe default.
function opencodeResponseToAcpOptionId(response) {
  switch (response) {
    case 'always': return 'allow_always';
    case 'once': return 'allow_once';
    case 'reject':
    default: return 'reject_once';
  }
}

export class Translator {
  constructor({ state, hub, logger = console }) {
    this.state = state;
    this.hub = hub;
    this.logger = logger;
    // per-session active assistant message id during a turn
    this.activeAssistant = new Map(); // sessionID -> messageID
    // ACP toolCallId -> { messageID, partID }
    this.toolParts = new Map();
    // permissionID -> { resolve } (resolves with OpenCode response string)
    this.pendingPermissions = new Map();
    // ACP toolCallId -> permissionID (to correlate)
    this.toolCallToPermission = new Map();
  }

  _emit(type, properties) {
    this.hub.broadcast({ type, properties }, this.state.cwd);
  }

  _emitPart(part, delta) {
    this._emit('message.part.updated', delta ? { part, delta } : { part });
  }

  _emitMessage(info) {
    this._emit('message.updated', { info });
  }

  beginTurn(sessionID) {
    const info = this.state.startAssistantMessage(sessionID, {});
    this.activeAssistant.set(sessionID, info.id);
    this._emitMessage(info);
    this.state.touchSession(sessionID);
    this._emit('session.updated', { info: this.state.getSession(sessionID) });
    return info.id;
  }

  endTurn(sessionID) {
    const messageID = this.activeAssistant.get(sessionID);
    if (messageID) {
      const info = this.state.completeAssistantMessage(messageID, sessionID);
      if (info) this._emitMessage(info);
    }
    this.activeAssistant.delete(sessionID);
    this._emit('session.idle', { sessionID });
  }

  _activeMessageId(sessionID) {
    let id = this.activeAssistant.get(sessionID);
    if (!id) id = this.beginTurn(sessionID);
    return id;
  }

  // --- Handle an ACP session/update notification ---
  handleSessionUpdate(sessionID, update) {
    if (!update || typeof update !== 'object') return;
    const kind = update.sessionUpdate;
    switch (kind) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const text = update.content?.text || '';
        if (!text) return;
        const messageID = this._activeMessageId(sessionID);
        // one text part per turn segment; reuse a stable partID per message
        const partID = this._textPartId(messageID);
        const part = this.state.upsertTextPart(sessionID, messageID, partID, text);
        this._emitPart(part, text);
        break;
      }
      case 'tool_call': {
        this._onToolCall(sessionID, update);
        break;
      }
      case 'tool_call_update': {
        this._onToolCallUpdate(sessionID, update);
        break;
      }
      case 'tool_call_chunk': {
        // Kiro pre-announce; create a pending tool part so the UI shows it early.
        this._onToolCall(sessionID, { ...update, status: 'pending' });
        break;
      }
      case 'plan':
      case 'available_commands_update':
      default:
        // Non-fatal: ignore unmapped updates for now.
        break;
    }
  }

  _textPartId(messageID) {
    if (!this._textParts) this._textParts = new Map();
    let pid = this._textParts.get(messageID);
    if (!pid) {
      pid = `prt_${randomUUID()}`;
      this._textParts.set(messageID, pid);
    }
    return pid;
  }

  _onToolCall(sessionID, update) {
    const toolCallId = update.toolCallId;
    if (!toolCallId) return;
    const messageID = this._activeMessageId(sessionID);
    let ref = this.toolParts.get(toolCallId);
    if (!ref) {
      ref = { messageID, partID: `prt_${randomUUID()}` };
      this.toolParts.set(toolCallId, ref);
    }
    const input = update.rawInput || {};
    const state = update.status === 'pending'
      ? { status: 'pending', input, raw: JSON.stringify(input) }
      : { status: 'running', input, title: update.title, time: { start: now() } };
    const part = this.state.upsertToolPart(sessionID, ref.messageID, ref.partID, {
      callID: toolCallId,
      tool: update.title?.split(':')[0] || update.kind || 'tool',
      state,
    });
    this._emitPart(part);
  }

  _onToolCallUpdate(sessionID, update) {
    const toolCallId = update.toolCallId;
    const ref = this.toolParts.get(toolCallId);
    if (!ref) { this._onToolCall(sessionID, update); return; }
    const input = update.rawInput || {};
    let state;
    if (update.status === 'completed') {
      state = {
        status: 'completed',
        input,
        output: this._stringifyOutput(update.rawOutput),
        title: update.title || '',
        metadata: {},
        time: { start: now(), end: now() },
      };
    } else if (update.status === 'error' || update.status === 'failed') {
      state = {
        status: 'error',
        input,
        error: this._stringifyOutput(update.rawOutput) || 'tool failed',
        time: { start: now(), end: now() },
      };
    } else {
      state = { status: 'running', input, title: update.title, time: { start: now() } };
    }
    const part = this.state.upsertToolPart(sessionID, ref.messageID, ref.partID, { state });
    this._emitPart(part);
  }

  _stringifyOutput(rawOutput) {
    if (rawOutput == null) return '';
    if (typeof rawOutput === 'string') return rawOutput;
    // Kiro shape: { items: [{ Json: {...} }] }
    try {
      if (Array.isArray(rawOutput.items)) {
        return rawOutput.items
          .map((it) => {
            const v = it?.Json ?? it?.Text ?? it;
            return typeof v === 'string' ? v : JSON.stringify(v);
          })
          .join('\n');
      }
      return JSON.stringify(rawOutput);
    } catch {
      return String(rawOutput);
    }
  }

  // --- Permission round-trip ---

  // Called by AcpClient.onClientRequest when method === 'session/request_permission'.
  // Returns a Promise resolving to the ACP result once OpenChamber answers.
  requestPermission(params) {
    const sessionID = params.sessionID || params.sessionId;
    const toolCall = params.toolCall || {};
    const permissionID = `per_${randomUUID()}`;
    const messageID = this._activeMessageId(sessionID);

    // Correlate to a tool part if we have one.
    if (toolCall.toolCallId) this.toolCallToPermission.set(toolCall.toolCallId, permissionID);

    const permission = {
      id: permissionID,
      type: 'tool',
      sessionID,
      messageID,
      callID: toolCall.toolCallId,
      title: toolCall.title || 'Permission required',
      metadata: { acpOptions: params.options || [], trustOptions: params._meta?.trustOptions || [] },
      time: { created: now() },
    };
    // Emit OpenCode permission.updated -> OpenChamber shows its permission UI.
    this._emit('permission.updated', permission);

    return new Promise((resolve) => {
      this.pendingPermissions.set(permissionID, {
        resolve: (opencodeResponse) => {
          const optionId = opencodeResponseToAcpOptionId(opencodeResponse);
          resolve({ outcome: { outcome: 'selected', optionId } });
        },
      });
    });
  }

  // Called by the HTTP route POST /session/:id/permissions/:permissionID
  // body: { response: 'once'|'always'|'reject' }
  respondPermission(permissionID, response) {
    const pending = this.pendingPermissions.get(permissionID);
    if (!pending) return false;
    this.pendingPermissions.delete(permissionID);
    pending.resolve(response || 'reject');
    this._emit('permission.replied', { permissionID, response: response || 'reject' });
    return true;
  }
}
