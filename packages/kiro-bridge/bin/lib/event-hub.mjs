// SSE event hub. OpenChamber connects to /global/event and /event and reads
// newline-block SSE frames whose `data:` is the OpenCode Event JSON.
// The upstream reader aborts after 20s of silence, so we heartbeat well under that.

const HEARTBEAT_MS = 8000;

export class EventHub {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.clients = new Set(); // res objects
    this.seq = 0;
    this._heartbeat = setInterval(() => this._sendHeartbeat(), HEARTBEAT_MS);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }

  addClient(res, { directory } = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // First event MUST be server.connected so OpenChamber marks the server live.
    this._writeTo(res, { type: 'server.connected', properties: {} }, directory);
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
    this.logger.info?.(`[kiro-bridge] SSE client connected (${this.clients.size} total)`);
  }

  _frame(payload, directory) {
    const id = `${Date.now()}-${this.seq++}`;
    const envelope = directory ? { payload, directory } : { payload };
    return `id: ${id}\ndata: ${JSON.stringify(envelope)}\n\n`;
  }

  _writeTo(res, payload, directory) {
    try {
      res.write(this._frame(payload, directory));
    } catch {
      this.clients.delete(res);
    }
  }

  // Broadcast an OpenCode Event {type, properties} to all SSE clients.
  broadcast(payload, directory) {
    for (const res of this.clients) this._writeTo(res, payload, directory);
  }

  _sendHeartbeat() {
    for (const res of this.clients) {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  dispose() {
    clearInterval(this._heartbeat);
    for (const res of this.clients) {
      try { res.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }
}
