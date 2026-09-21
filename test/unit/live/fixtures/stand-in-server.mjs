import http from 'node:http';
import net from 'node:net';
import { writeFileSync } from 'node:fs';

const hostPort = (value) => {
  const at = value.lastIndexOf(':');
  return { host: value.slice(0, at).replace(/^.*:\/\//, ''), port: Number(value.slice(at + 1)) };
};
const calls = [];
const oscar = hostPort(process.env.OSCAR_LISTENERS);
const toc = hostPort(process.env.TOC_LISTENERS);
const api = hostPort(process.env.API_LISTENER);

net.createServer((s) => s.destroy()).listen(oscar.port, oscar.host);
net.createServer((s) => s.destroy()).listen(toc.port, toc.host);
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/version') return res.writeHead(200).end('{}');
      if (req.url === '/calls') return res.writeHead(200).end(JSON.stringify({ calls, env: process.env, argv: process.argv.slice(2), cwd: process.cwd() }));
      calls.push(`${req.method} ${req.url} ${body}`);
      res.writeHead(req.method === 'PATCH' ? 204 : 201).end();
    });
  })
  .listen(api.port, api.host);

writeFileSync(process.env.DB_PATH, 'stand-in');
process.on('SIGTERM', () => process.exit(0));
