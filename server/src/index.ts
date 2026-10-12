import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { createApiRouter, createAnalysisRouter } from './routes.js';
import { IpLimiter } from './ratelimit.js';

const cfg = loadConfig();
const app = express();
const ipLimiter = new IpLimiter();

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// 每 IP 基础限流
app.use('/api', (req, res, next) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  if (!ipLimiter.allow(ip)) {
    res.status(200).json({ status: -1, message: '请求过于频繁，请稍后再试' });
    return;
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 0, uptime: process.uptime() });
});

// /api/config：仅暴露浏览器端 AK（浏览器端 AK 属公开设计），服务端 AK 永不下发
app.get('/api/config', (_req, res) => {
  res.json({
    status: 0,
    browserAk: cfg.akBrowser,
    hasServerAk: cfg.akServer.length >= 16,
    mock: cfg.akBrowser.length < 16 && cfg.akServer.length < 16,
    version: '0.1.0'
  });
});

app.use('/api/baidu', createApiRouter(cfg));
app.use('/api', createAnalysisRouter(cfg));

// 生产模式：托管前端构建产物
const staticDir = path.isAbsolute(cfg.staticDir) ? cfg.staticDir : path.resolve(process.cwd(), cfg.staticDir);
if (fs.existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

app.listen(cfg.port, () => {
  console.log(`[life-circle] server on http://localhost:${cfg.port}`);
  console.log(`[life-circle] browserAk: ${cfg.akBrowser ? 'configured' : 'MISSING (demo mode)'}, serverAk: ${cfg.akServer ? 'configured' : 'MISSING (proxy disabled)'}`);
});
