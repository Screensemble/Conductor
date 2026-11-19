import { createServer } from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { triggerRouter } from './triggers.js';
import { handlePlayerConnection } from './players.js';

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', role: config.serverRole });
});

app.use('/api/triggers', triggerRouter);

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/player' });
wss.on('connection', handlePlayerConnection);

server.listen(config.port, config.host, () => {
  console.log(
    `screensemble-server listening on ${config.host}:${config.port} (role: ${config.serverRole})`,
  );
});
