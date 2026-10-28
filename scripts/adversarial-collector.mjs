import { appendFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname } from 'node:path';

const logPath = '/redteam/collector-log/events.jsonl';
await mkdir(dirname(logPath), { recursive: true });
let queue = Promise.resolve();
const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/collect') {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > 65536) request.destroy();
    else chunks.push(chunk);
  });
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    queue = queue.then(() =>
      appendFile(
        logPath,
        JSON.stringify({ timestamp: new Date().toISOString(), body }) + '\n',
      ),
    );
    queue.then(
      () => response.end('ok'),
      () => response.writeHead(500).end(),
    );
  });
});
server.listen(18080, '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
