// DNS rebinding protection: the hostnames this server answers to, for /mcp, the viewer and /ws.
// Without it, a web page on another site could rebind its domain to this machine and drive the server
// from the victim's browser.

const LOCAL = ['localhost', '127.0.0.1', '[::1]'];
const WILDCARD = new Set(['0.0.0.0', '::', '']);

/** Hostname (no port, lowercased, IPv6 in brackets) of a Host header or URL, or null if it doesn't parse. */
export function hostnameOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

/** Loopback names, the bind address (unless it's a wildcard), PUBLIC_URL's host and any extras. */
export function allowedHostnames(opts: { host: string; publicUrl: string; extra?: string }): string[] {
  const out = new Set(LOCAL);
  if (!WILDCARD.has(opts.host)) {
    const h = hostnameOf(opts.host.includes(':') && !opts.host.startsWith('[') ? `[${opts.host}]` : opts.host);
    if (h) out.add(h);
  }
  const pub = hostnameOf(opts.publicUrl);
  if (pub) out.add(pub);
  for (const e of (opts.extra ?? '').split(',')) {
    const h = hostnameOf(e.trim());
    if (h) out.add(h);
  }
  return [...out];
}

/** True if the request's Host is allowed and, when the browser sent an Origin, that is allowed too. */
export function isAllowedRequest(allowed: string[], host: string | undefined, origin: string | undefined): boolean {
  const h = hostnameOf(host);
  if (!h || !allowed.includes(h)) return false;
  if (origin === undefined) return true; // non-browser clients (agents, the example bot) send no Origin
  const o = hostnameOf(origin);
  return o !== null && allowed.includes(o);
}
