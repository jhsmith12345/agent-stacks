import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Protocol } from './protocol.js';
import { fileStore } from './store.js';
import { acquireLock } from './lock.js';
import { ProtocolError } from './errors.js';

export function createApp(protocol) {
  return createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const respond = (status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathId = prefix => { try { return decodeURIComponent(url.pathname.slice(prefix)); } catch { throw new ProtocolError('BAD_PATH', 'Malformed URL path'); } };
      if (req.method === 'GET' && url.pathname === '/health') return respond(protocol.storageFault ? 503 : 200, { ok: !protocol.storageFault, mode: 'local-test-chips', protocol: 'agent-stacks/local/v1', serverTime: protocol.now() });
      if (req.method === 'GET' && url.pathname === '/v1/matches') return respond(200, { matches: protocol.list() });
      if (req.method === 'GET' && url.pathname.startsWith('/v1/matches/')) return respond(200, { match: protocol.get(pathId(12)) });
      if (req.method === 'GET' && url.pathname.startsWith('/v1/wallets/')) return respond(200, protocol.publicWallet(pathId(12)));
      if (req.method === 'POST' && url.pathname === '/v1/commands') {
        if (!req.headers['content-type']?.startsWith('application/json')) return respond(415, { error: { code: 'CONTENT_TYPE', message: 'Use application/json' } });
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 16_384) return respond(413, { error: { code: 'BODY_TOO_LARGE', message: 'Maximum command size is 16 KiB' } });
        }
        let envelope;
        try { envelope = JSON.parse(body); } catch { return respond(400, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }); }
        return respond(200, protocol.execute(envelope));
      }
      respond(404, { error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } });
    } catch (error) {
      if (error instanceof ProtocolError) respond(error.code === 'NOT_FOUND' ? 404 : 400, { error: { code: error.code, message: error.message } });
      else { console.error(error); respond(500, { error: { code: 'INTERNAL', message: 'Internal server error' } }); }
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.env.AGENT_STACKS_DATA ?? '.agent-stacks');
  const release = acquireLock(directory);
  process.once('exit', release);
  const { initial, persist } = fileStore(directory);
  const protocol = new Protocol(initial, { persist });
  protocol.assertConservation(initial);
  const server = createApp(protocol);
  const port = Number(process.env.PORT ?? 8787);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(); server.closeAllConnections(); process.exit(0);
  });
  server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
    console.log(`Agent Stacks: http://${process.env.HOST ?? '127.0.0.1'}:${server.address().port} (test chips; trusted local dealer)`);
    console.log(`Private state: ${directory}`);
  });
}
