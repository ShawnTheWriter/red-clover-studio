// A small router over node:http. The app is single-user and local, so it needs
// routing and JSON bodies and nothing else. Zero dependencies keeps install
// friction at zero and keeps the supply chain empty.

import http from "node:http";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".fdx": "application/xml",
  ".xml": "application/xml",
};

export const mimeFor = (p) => MIME[path.extname(p).toLowerCase()] || "application/octet-stream";

export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    // "/api/episode/:dir/shots" -> regex with named groups
    const keys = [];
    const rx = new RegExp("^" + pattern.replace(/:[a-zA-Z]+/g, (m) => {
      keys.push(m.slice(1));
      return "([^/]+)";
    }) + "$");
    routes.push({ method, rx, keys, handler });
  };
  return {
    get: (p, h) => add("GET", p, h),
    post: (p, h) => add("POST", p, h),
    put: (p, h) => add("PUT", p, h),
    del: (p, h) => add("DELETE", p, h),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.rx.exec(pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
      return null;
    },
  };
}

// JSON bodies are capped at 64 MB. A raw binary upload (content-type
// application/octet-stream — a video clip imported from the user's computer)
// may be up to 1 GB and comes back as { raw: Buffer } instead of parsed JSON.
export async function readBody(req) {
  const isRaw = (req.headers["content-type"] || "").startsWith("application/octet-stream");
  const limit = isRaw ? 1024 * 1024 * 1024 : 64 * 1024 * 1024;
  const chunks = [];
  let bytes = 0;
  for await (const c of req) {
    bytes += c.length;
    if (bytes > limit) throw new Error("request body too large");
    chunks.push(c);
  }
  if (isRaw) return { raw: Buffer.concat(chunks) };
  if (!chunks.length) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); } catch { throw new Error("body is not valid JSON"); }
}

export function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

// Serve a file, with Range support so <video> can scrub generated takes.
export async function sendFile(res, abs, req) {
  let st;
  try { st = await fs.stat(abs); } catch { return sendJSON(res, 404, { error: "not found" }); }
  if (!st.isFile()) return sendJSON(res, 404, { error: "not a file" });

  const type = mimeFor(abs);
  const range = req && req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (start >= st.size || end >= st.size || start > end) {
        res.writeHead(416, { "content-range": `bytes */${st.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "content-type": type,
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${st.size}`,
        "accept-ranges": "bytes",
      });
      // NOT `return ...pipe(res)`: pipe() returns its destination, so this
      // handed the response object back to serve(), which then wrote a second
      // response on top of the 206 and died on ERR_HTTP_HEADERS_SENT. Every
      // <video> element sends a Range header, so playing one take killed the
      // server and every paid job it was polling.
      fsSync.createReadStream(abs, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, {
    "content-type": type,
    "content-length": st.size,
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
  });
  fsSync.createReadStream(abs).pipe(res);
}

// This function must always resolve to undefined — see the Range branch above.

export function serve({ port, router, staticDir, staticMounts, onListen }) {
  // staticMounts: extra { prefix, dir } roots beyond staticDir — used to expose
  // shared/ read-only to the browser so it imports the exact same prompt/schema
  // modules the server runs, rather than a duplicate copy that can drift.
  const mounts = staticMounts || [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);
    try {
      const hit = router.match(req.method, pathname);
      if (hit) {
        const body = ["POST", "PUT", "DELETE"].includes(req.method) ? await readBody(req) : null;
        const out = await hit.handler({ params: hit.params, query: url.searchParams, body, req, res });
        // headersSent, not writableEnded: a streaming response has sent its
        // headers but keeps writing, so writableEnded stays false for its whole
        // lifetime and anything a handler returned would be written over it.
        if (out !== undefined && !res.headersSent) sendJSON(res, 200, out);
        return;
      }
      if (req.method === "GET") {
        for (const m of mounts) {
          if (pathname === m.prefix || pathname.startsWith(`${m.prefix}/`)) {
            const rel = pathname.slice(m.prefix.length) || "/";
            const abs = path.join(m.dir, rel);
            if (!abs.startsWith(m.dir)) return sendJSON(res, 403, { error: "forbidden" });
            return sendFile(res, abs, req);
          }
        }
        const rel = pathname === "/" ? "/index.html" : pathname;
        const abs = path.join(staticDir, rel);
        if (!abs.startsWith(staticDir)) return sendJSON(res, 403, { error: "forbidden" });
        return sendFile(res, abs, req);
      }
      sendJSON(res, 404, { error: "no route" });
    } catch (err) {
      // Reporting an error must never throw a second time out of the request
      // handler — an unhandled rejection here exits the process and takes every
      // in-flight generation with it.
      if (!res.headersSent) {
        try { sendJSON(res, err.status || 500, { error: err.message }); return; }
        catch { /* fall through to destroy */ }
      }
      res.destroy();
    }
  });
  server.listen(port, "127.0.0.1", () => onListen && onListen(port));
  return server;
}
