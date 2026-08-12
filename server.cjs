#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.HERMES_BRIDGE_PORT || 3002);
const ROOT = path.resolve(__dirname, '..');
const TASK_DIR = path.join(ROOT, 'shared-tasks');
const LOG_DIR = path.join(ROOT, 'logs');
const HERMES_BIN = process.env.HERMES_BIN || path.join(process.env.HOME || '', '.local/bin/hermes');
const DEFAULT_TIMEOUT_MS = Number(process.env.HERMES_BRIDGE_TIMEOUT_MS || 10 * 60 * 1000);
fs.mkdirSync(TASK_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2_000_000) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
function taskPath(id) { return path.join(TASK_DIR, `${id}.json`); }
function loadTask(id) { return JSON.parse(fs.readFileSync(taskPath(id), 'utf8')); }
function saveTask(t) { fs.writeFileSync(taskPath(t.id), JSON.stringify(t, null, 2)); }
function listTasks() {
  return fs.readdirSync(TASK_DIR).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(TASK_DIR, f), 'utf8'))).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
}

function runHermesTask(task, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  const logFile = task.logFile;
  const startedAt = new Date().toISOString();
  task.status = 'running';
  task.startedAt = startedAt;
  task.updatedAt = startedAt;
  task.command = [HERMES_BIN, '-z', task.prompt];
  saveTask(task);

  const out = fs.openSync(logFile, 'a');
  fs.writeSync(out, `[${startedAt}] Command: ${HERMES_BIN} -z <prompt>\n`);
  fs.writeSync(out, `[${startedAt}] Prompt:\n${task.prompt}\n\n`);

  const child = spawn(HERMES_BIN, ['-z', task.prompt], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.local/bin:${process.env.PATH || ''}`,
      HERMES_ACCEPT_HOOKS: process.env.HERMES_ACCEPT_HOOKS || '1',
    },
    cwd: opts.cwd || ROOT,
  });

  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref?.();
  }, timeoutMs);
  timer.unref?.();

  child.stdout.on('data', chunk => {
    const s = chunk.toString();
    stdout += s;
    fs.writeSync(out, s);
  });
  child.stderr.on('data', chunk => {
    const s = chunk.toString();
    stderr += s;
    fs.writeSync(out, s);
  });
  child.on('error', err => {
    clearTimeout(timer);
    try {
      const t = loadTask(task.id);
      t.status = 'failed';
      t.error = err.message;
      t.stdout = stdout.trim();
      t.stderr = stderr.trim();
      t.updatedAt = new Date().toISOString();
      saveTask(t);
      fs.writeSync(out, `\n[${t.updatedAt}] ERROR: ${err.stack || err.message}\n`);
      fs.closeSync(out);
    } catch {}
  });
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    try {
      const t = loadTask(task.id);
      t.status = code === 0 ? 'completed' : 'failed';
      t.exitCode = code;
      t.signal = signal;
      t.stdout = stdout.trim();
      t.stderr = stderr.trim();
      t.result = stdout.trim();
      t.completedAt = new Date().toISOString();
      t.updatedAt = t.completedAt;
      saveTask(t);
      fs.writeSync(out, `\n[${t.completedAt}] Exit code=${code} signal=${signal || ''}\n`);
      fs.closeSync(out);
    } catch {}
  });
}

function runHermesTaskAndWait(task, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
    const logFile = task.logFile;
    const startedAt = new Date().toISOString();
    task.status = 'running';
    task.startedAt = startedAt;
    task.updatedAt = startedAt;
    task.command = [HERMES_BIN, '-z', task.prompt];
    saveTask(task);

    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `[${startedAt}] Command: ${HERMES_BIN} -z <prompt>\n`);
    fs.writeSync(out, `[${startedAt}] Prompt:\n${task.prompt}\n\n`);

    const child = spawn(HERMES_BIN, ['-z', task.prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.local/bin:${process.env.PATH || ''}`,
        HERMES_ACCEPT_HOOKS: process.env.HERMES_ACCEPT_HOOKS || '1',
      },
      cwd: opts.cwd || ROOT,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const finish = (patch) => {
      try {
        const t = loadTask(task.id);
        Object.assign(t, patch);
        t.stdout = stdout.trim();
        t.stderr = stderr.trim();
        t.result = stdout.trim();
        t.completedAt = new Date().toISOString();
        t.updatedAt = t.completedAt;
        saveTask(t);
        fs.writeSync(out, `\n[${t.completedAt}] Exit code=${t.exitCode ?? ''} signal=${t.signal || ''}\n`);
        fs.closeSync(out);
        resolve(t);
      } catch (e) {
        resolve({ ...task, status: 'failed', error: e.message, stdout: stdout.trim(), stderr: stderr.trim() });
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', chunk => { const s = chunk.toString(); stdout += s; fs.writeSync(out, s); });
    child.stderr.on('data', chunk => { const s = chunk.toString(); stderr += s; fs.writeSync(out, s); });
    child.on('error', err => {
      clearTimeout(timer);
      fs.writeSync(out, `\n[${new Date().toISOString()}] ERROR: ${err.stack || err.message}\n`);
      finish({ status: 'failed', error: err.message });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      finish({ status: code === 0 ? 'completed' : 'failed', exitCode: code, signal, timedOut });
    });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { status: 'ok', service: 'openclaw-hermes-bridge', port: PORT, hermesBin: HERMES_BIN, hermesInstalled: fs.existsSync(HERMES_BIN), execution: 'hermes -z <prompt>', timeoutMs: DEFAULT_TIMEOUT_MS });
  }
  if (req.method === 'GET' && url.pathname === '/tasks') {
    return json(res, 200, { tasks: listTasks() });
  }
  if (req.method === 'POST' && url.pathname === '/run') {
    const body = await readBody(req);
    let input;
    try { input = body ? JSON.parse(body) : {}; } catch { return json(res, 400, { error: 'invalid json' }); }
    const prompt = input.task || input.prompt || '';
    if (!prompt.trim()) return json(res, 400, { error: 'missing prompt/task' });
    const id = `hermes-${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}-${Math.random().toString(36).slice(2,7)}`;
    const logFile = path.join(LOG_DIR, `${id}.log`);
    const task = { id, status: 'queued', source: input.source || 'openclaw', prompt, mode: 'sync', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), logFile };
    saveTask(task);
    const done = await runHermesTaskAndWait(task, { timeoutMs: input.timeoutMs, cwd: input.cwd });
    return json(res, done.status === 'completed' ? 200 : 500, done);
  }
  if (req.method === 'POST' && url.pathname === '/tasks') {
    const body = await readBody(req);
    let input;
    try { input = body ? JSON.parse(body) : {}; } catch { return json(res, 400, { error: 'invalid json' }); }
    const id = `hermes-${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}-${Math.random().toString(36).slice(2,7)}`;
    const logFile = path.join(LOG_DIR, `${id}.log`);
    const task = { id, status: 'queued', source: input.source || 'openclaw', prompt: input.task || input.prompt || '', mode: input.mode || 'async', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), logFile };
    if (!task.prompt.trim()) return json(res, 400, { error: 'missing prompt/task' });
    saveTask(task);
    if (input.execute === true) {
      runHermesTask(task, { timeoutMs: input.timeoutMs, cwd: input.cwd });
    }
    return json(res, 202, task);
  }
  const m = url.pathname.match(/^\/tasks\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    try { return json(res, 200, loadTask(m[1])); } catch { return json(res, 404, { error: 'not found' }); }
  }
  const lm = url.pathname.match(/^\/tasks\/([^/]+)\/logs$/);
  if (req.method === 'GET' && lm) {
    try { const t = loadTask(lm[1]); res.writeHead(200, {'content-type':'text/plain; charset=utf-8'}); return res.end(fs.existsSync(t.logFile) ? fs.readFileSync(t.logFile, 'utf8') : ''); } catch { return json(res, 404, { error: 'not found' }); }
  }
  return json(res, 404, { error: 'not found' });
}

http.createServer((req,res)=>handle(req,res).catch(e=>json(res,500,{error:e.message}))).listen(PORT, '127.0.0.1', () => {
  console.log(`OpenClaw-Hermes Bridge listening on http://127.0.0.1:${PORT}`);
});
