/**
 * Shared URL utilities — extracted from bin/mcp-server.js and bin/api-server.js.
 */

export function slugify(url) {
  try {
    const u = new URL(url);
    const path = u.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\//g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "_");
    return path ? `${u.hostname}/${path}` : u.hostname;
  } catch {
    return url.replace(/[^a-zA-Z0-9-_]/g, "_");
  }
}

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href.replace(/\/+$/, "");
  } catch {
    return url;
  }
}
