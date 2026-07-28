export class NextResponse {
  static json(body, init = {}) {
    return {
      body,
      status: init.status || 200,
      headers: new Map(),
      headers: {
        set(k, v) { this._headers = this._headers || {}; this._headers[k] = v; },
      },
    };
  }
}
