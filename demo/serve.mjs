import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const types = {'.html':'text/html','.json':'application/json'};
/** Serve only the self-contained demo assets on loopback. */
createServer(async (request, response) => {
  const relative = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname).replace(/^\//u,'') || 'scene.html';
  const path = resolve(root, relative);
  if (!path.startsWith(root)) { response.writeHead(403).end(); return; }
  try {
    const content = await readFile(path);
    response.writeHead(200,{'Content-Type':types[extname(path)] ?? 'application/octet-stream'}).end(content);
  } catch { response.writeHead(404).end(); }
}).listen(4177,'127.0.0.1',()=>console.log('Staged demo at http://127.0.0.1:4177'));
