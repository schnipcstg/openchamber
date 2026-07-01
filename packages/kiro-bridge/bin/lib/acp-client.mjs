// ACP client: owns a `kiro-cli acp` child process and speaks newline-delimited
// JSON-RPC 2.0 over its stdio. Handles:
//   - outbound requests (initialize, session/new, session/prompt, session/cancel)
//     with id-based response correlation
//   - inbound notifications (session/update, _kiro.dev/*)  -> onNotification
//   - inbound client-bound REQUESTS (session/request_permission, fs/*) that carry
//     an `id` and MUST be answered -> onClientRequest (async, returns the result)
//
// CONSTRAINT: we launch with `--agent kiro_default --trust-tools=` so Kiro emits a
// real session/request_permission for every tool call. We NEVER auto-approve here;
// the answer is produced by the caller (routed to OpenChamber's permission UI).

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const KIRO_BIN = process.env.KIRO_BRIDGE_KIRO_BIN || 'kiro-cli';
// Default agent MUST be one that does not pre-trust tools, so permission prompts fire.
const DEFAULT_AGENT = process.env.KIRO_BRIDGE_AGENT || 'kiro_default';

export class AcpClient extends EventEmitter {
  constructor({ cwd, agent = DEFAULT_AGENT, logger = console } = {}) {
    super();
    this.cwd = cwd || process.cwd();
    this.agent = agent;
    this.logger = logger;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.buf = '';
    this.initialized = false;
    this._starting = null;
    // caller-provided async handler for client-bound requests; must return a JSON-RPC `result`
    this.onClientRequest = async () => ({});
  }

  isAlive() {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  async start() {
    if (this.isAlive()) return;
    if (this._starting) return this._starting;
    this._starting = new Promise((resolve, reject) => {
      const args = ['acp', '--agent', this.agent, '--trust-tools='];
      this.logger.info?.(`[kiro-bridge] spawning: ${KIRO_BIN} ${args.join(' ')} (cwd=${this.cwd})`);
      const child = spawn(KIRO_BIN, args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      this.child = child;

      child.stdout.on('data', (d) => this._onStdout(d));
      child.stderr.on('data', (d) => this.logger.warn?.(`[kiro-cli stderr] ${d.toString().trimEnd()}`));
      child.on('exit', (code, signal) => {
        this.logger.warn?.(`[kiro-bridge] kiro-cli exited code=${code} signal=${signal}`);
        this.initialized = false;
        const err = new Error(`kiro-cli acp exited (code=${code}, signal=${signal})`);
        for (const { reject: rj } of this.pending.values()) rj(err);
        this.pending.clear();
        this.emit('exit', { code, signal });
      });
      child.on('error', (e) => {
        this.logger.error?.(`[kiro-bridge] spawn error: ${e.message}`);
        reject(e);
      });
      // Resolve once the process is up; initialize() is a separate step.
      setImmediate(resolve);
    }).finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  _onStdout(chunk) {
    this.buf += chunk.toString();
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.logger.warn?.(`[kiro-bridge] non-JSON line from kiro-cli: ${line.slice(0, 200)}`);
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Response to one of our requests
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(Object.assign(new Error(msg.error.message || 'ACP error'), { data: msg.error }));
      else resolve(msg.result);
      return;
    }
    // Client-bound REQUEST (has method AND id) -> we must respond
    if (msg.method && msg.id !== undefined) {
      this._handleClientRequest(msg);
      return;
    }
    // Notification (method, no id)
    if (msg.method) {
      this.emit('notification', msg);
      return;
    }
    this.logger.warn?.(`[kiro-bridge] unrecognized ACP message: ${JSON.stringify(msg).slice(0, 200)}`);
  }

  async _handleClientRequest(msg) {
    try {
      const result = await this.onClientRequest(msg.method, msg.params, msg.id);
      this._writeRaw({ jsonrpc: '2.0', id: msg.id, result });
    } catch (e) {
      this._writeRaw({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e?.message || 'client request failed' } });
    }
  }

  _writeRaw(obj) {
    if (!this.isAlive()) throw new Error('kiro-cli acp is not running');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, { timeoutMs = 0 } = {}) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP request timed out: ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      try {
        this._writeRaw(payload);
      } catch (e) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(e);
      }
    });
  }

  notify(method, params) {
    this._writeRaw({ jsonrpc: '2.0', method, params });
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    }, { timeoutMs: 15000 });
    this.initialized = true;
    this.emit('initialized', result);
    return result;
  }

  async stop() {
    if (this.child && this.isAlive()) {
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this.child = null;
    this.initialized = false;
  }
}
