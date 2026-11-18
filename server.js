// Minimal static server. No dependencies: `npm start`.
// ES modules, AudioWorklet and same-origin fetches all work from here.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(new URL('.', import.meta.url).pathname);
const port = Number(process.env.PORT ?? 8080);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/public/index.html';
    else if (!path.startsWith('/public/') && !path.startsWith('/src/') && !path.startsWith('/out/')) {
      path = '/public' + path;
    }
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) throw new Error('outside root');
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(await readFile(file));
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(port, () => {
  console.log(`reed-bore lab: http://localhost:${port}/`);
});
