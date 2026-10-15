// Quick smoke: which route hangs? Run with a 20s global timer.
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-smoke-'));
process.env.DSH_HOME = home;
setTimeout(() => { console.log('TIMEOUT — aborting'); process.exit(2); }, 20000).unref();

const { apply } = await import('./lib/index.js');
const { saveToken } = await import('./lib/vault.js');
saveToken('fake-token', null);

const routes = new Map();
const effects = [];
const fakeCtx = {
  effect: (factory) => { const d = factory(); effects.push(d); },
  inject: (services, callback) => {
    if (services.includes('webServer')) {
      callback({
        effect: (factory) => fakeCtx.effect(factory),
        webServer: { register: (route) => { routes.set(`${route.kind} ${route.path}`, route.handler); return () => {}; } },
      });
    }
  },
};
apply(fakeCtx);
console.log('routes:', [...routes.keys()].join(' | '));

const server = http.createServer((request, response) => {
  const handler = routes.get(`exact ${new URL(request.url, 'http://x').pathname}`);
  if (!handler) { response.writeHead(404); return response.end(); }
  return handler(request, response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log('port', port);

// 1. /upload with a tiny body
console.log('--- POST /upload');
const t0 = Date.now();
const res = await fetch(`http://127.0.0.1:${port}/dsh-deepseek-web-chat/upload`, {
  method: 'POST',
  headers: { host: `127.0.0.1:${port}`, 'content-type': 'text/plain', 'x-file-name': 'a.txt' },
  body: 'hello',
});
console.log('upload status', res.status, `${Date.now() - t0}ms`, await res.text());

// 2. /files
console.log('--- GET /files');
const t1 = Date.now();
const res2 = await fetch(`http://127.0.0.1:${port}/dsh-deepseek-web-chat/files?file_ids=x`, { headers: { host: `127.0.0.1:${port}` } });
console.log('files status', res2.status, `${Date.now() - t1}ms`, await res2.text());

console.log('done');
server.close();
rmSync(home, { recursive: true, force: true });
process.exit(0);
