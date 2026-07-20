import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const host = "127.0.0.1";
const port = Number(process.env.PIXEL_FORGE_PORT || 8765);
const root = process.cwd();
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

createServer(async (request, response) => {
  try {
    const requestPath = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
    const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
    const filePath = normalize(join(root, relativePath));
    if (!filePath.startsWith(root)) throw new Error("Forbidden");
    if (!(await stat(filePath)).isFile()) throw new Error("Not found");
    response.writeHead(200, {
      "Content-Type": types[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(await readFile(filePath));
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, host, () => {
  console.log(`PIXEL FORGE running at http://${host}:${port}`);
});
