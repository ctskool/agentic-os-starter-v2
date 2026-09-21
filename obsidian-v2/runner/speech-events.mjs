// The bridge's subscription to the speech service's /events socket (microphone capture, wake).
// Exactly one retry per socket, whatever this Node version reports and in whatever order.
// Node's WebSocket reports a connection that fails before it opens (nothing listening yet, or a
// service that answers /events with plain HTTP) as 'error' and never as 'close', and close() on
// such a socket reports a second error synchronously. The earlier handler was
// `onerror = () => socket.close()`: it called itself until the stack overflowed, and the uncaught
// RangeError took the whole bridge down whenever the speech service was not accepting sockets:
// at a cold start while the voice models load, and whenever a shared speech service went away.
export function speechEvents(url, onMessage, {Socket = globalThis.WebSocket, retryMs = 5000} = {}) {
  let socket = null, timer = null, stopped = false;
  const connect = () => {
    if (stopped || typeof Socket === 'undefined') return;
    const current = socket = new Socket(url);
    let settled = false;
    const retry = () => {
      if (settled) return;
      settled = true;
      try { current.close(); } catch { /* it never opened */ }
      if (!stopped && socket === current) { timer = setTimeout(connect, retryMs); timer.unref?.(); }
    };
    current.onmessage = onMessage; current.onerror = retry; current.onclose = retry;
  };
  connect();
  return {
    connected: () => socket?.readyState === 1,
    stop() {
      stopped = true; clearTimeout(timer);
      const current = socket; socket = null;
      if (current) { current.onclose = current.onerror = null; try { current.close(); } catch { /* it never opened */ } }
    },
  };
}
