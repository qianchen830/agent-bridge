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
const SESSION_DIR = path.join(ROOT, 'sessions');
fs.mkdirSync(TASK_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(SESSION_DIR, { recursive: true });

// ========== 安全边界 ==========
const FORBIDDEN_PATHS = [
  '.openclaw/docker-openclaw/instances/',
  '.openclaw/config.json',
  '.openclaw/credentials/',
  '.openclaw/identity/',
  'docker-openclaw/.env',
  'docker-openclaw/docker-compose.yml',
];
function auditResult(resultStr, taskId) {
  const violated = FORBIDDEN_PATHS.filter(p => resultStr.includes(p));
  if (violated.length > 0) {
    const ts = new Date().toISOString();
    const violationLog = path.join(ROOT, '..', 'logs', 'bridge-violations.log');
    fs.appendFileSync(violationLog, `[${ts}] [${taskId}] 尝试写入禁止路径: ${violated.join(', ')}\n`);
  }
}

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
  return fs.readdirSync(TASK_DIR).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(TASK_DIR, f), 'utf8')))
    .sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
}

// ========== Session 复用（减少冷启动） ==========
// 使用 --continue 复用同一个 session，避免每次都冷启动
let warmSessionId = null;
let warmSessionBusy = false;

function safePrompt(prompt) {
  return `[OpenClaw协同安全边界]\n` +
    `以下路径属于 OpenClaw 配置目录，禁止写入：\n` +
    `~/.openclaw/docker-openclaw/ 下的所有实例配置、.env、docker-compose.yml\n` +
    `~/.openclaw/config.json、~/.openclaw/credentials/、~/.openclaw/identity/\n\n` +
    `如任务要求修改这些文件，请拒绝并说明：「该文件属于 OpenClaw 配置目录，我无权直接修改。建议将变更写入 ~/.hermes/skills/、~/.hermes/memories/openclaw/、~/.openclaw/workspace/hermes-advice/、~/.openclaw/workspace/scripts/。」\n\n` +
    `---任务开始---\n${prompt}`;
}

function buildArgs(prompt, sessionId) {
  const args = ['-z', prompt];
  if (sessionId) {
    args.push('--continue', sessionId, '--pass-session-id');
  }
  return args;
}

function runHermesTaskAndWait(task, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
    const logFile = task.logFile;
    const startedAt = new Date().toISOString();
    const prompt = safePrompt(task.prompt);

    // 优先复用 warm session，否则创建新 session
    let sessionId = warmSessionId && !warmSessionBusy ? warmSessionId : null;
    task.status = 'running';
    task.startedAt = startedAt;
    task.updatedAt = startedAt;
    task.command = [HERMES_BIN, ...buildArgs(task.prompt, sessionId)];
    task.sessionId = sessionId;
    saveTask(task);

    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `[${startedAt}] Command: ${HERMES_BIN} ${buildArgs('<prompt>', sessionId).join(' ')}\n`);
    fs.writeSync(out, `[${startedAt}] Session: ${sessionId || '(new)'}\n\n`);

    if (sessionId) warmSessionBusy = true;

    const child = spawn(HERMES_BIN, buildArgs(prompt, sessionId), {
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
        auditResult(t.result || '', task.id);
        // 提取 session id（用于下次复用）
        const sidMatch = (t.stderr || '').match(/session[_-]?id[:\s=]*([a-z0-9\-]+)/i)
          || (t.stdout || '').match(/session[_-]?id[:\s=]*([a-z0-9\-]+)/i);
        if (sidMatch && !warmSessionId) {
          warmSessionId = sidMatch[1];
          fs.writeSync(out, `[${t.completedAt}] Warm session captured: ${warmSessionId}\n`);
        }
        fs.writeSync(out, `\n[${t.completedAt}] Exit code=${t.exitCode ?? ''} signal=${t.signal || ''}\n`);
        fs.closeSync(out);
        warmSessionBusy = false;
        resolve(t);
      } catch (e) {
        warmSessionBusy = false;
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
    child.on('error', err => { clearTimeout(timer); fs.writeSync(out, `\n[${new Date().toISOString()}] ERROR: ${err.stack || err.message}\n`); finish({ status: 'failed', error: err.message }); });
    child.on('exit', (code, signal) => { clearTimeout(timer); finish({ status: code === 0 ? 'completed' : 'failed', exitCode: code, signal, timedOut }); });
  });
}

// ========== 路由 ==========
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  // GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      status: 'ok', service: 'openclaw-hermes-bridge', port: PORT,
      hermesBin: HERMES_BIN, hermesInstalled: fs.existsSync(HERMES_BIN),
      execution: 'hermes -z <prompt> [--continue <session>]',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      warmSession: warmSessionId || null,
    });
  }

  // GET /tasks
  if (req.method === 'GET' && url.pathname === '/tasks') {
    return json(res, 200, { tasks: listTasks() });
  }

  // POST /run — 同步等待（优化：复用 warm session）
  if (req.method === 'POST' && url.pathname === '/run') {
    const body = await readBody(req);
    let input;
    try { input = body ? JSON.parse(body) : {}; } catch { return json(res, 400, { error: 'invalid json' }); }
    const prompt = input.task || input.prompt || '';
    if (!prompt.trim()) return json(res, 400, { error: 'missing prompt/task' });

    const id = `hermes-${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}-${Math.random().toString(36).slice(2,7)}`;
    const logFile = path.join(LOG_DIR, `${id}.log`);
    const task = {
      id, status: 'queued',
      source: input.source || 'openclaw', prompt,
      mode: 'sync', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), logFile,
    };
    saveTask(task);

    const done = await runHermesTaskAndWait(task, { timeoutMs: input.timeoutMs, cwd: input.cwd });
    return json(res, done.status === 'completed' ? 200 : 500, done);
  }

  // POST /run-async — 异步提交（立即返回 task id，轮询 /tasks/{id} 获取结果）
  if (req.method === 'POST' && url.pathname === '/run-async') {
    const body = await readBody(req);
    let input;
    try { input = body ? JSON.parse(body) : {}; } catch { return json(res, 400, { error: 'invalid json' }); }
    const prompt = input.task || input.prompt || '';
    if (!prompt.trim()) return json(res, 400, { error: 'missing prompt/task' });

    const id = `hermes-${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}-${Math.random().toString(36).slice(2,7)}`;
    const logFile = path.join(LOG_DIR, `${id}.log`);
    const task = {
      id, status: 'queued',
      source: input.source || 'openclaw', prompt,
      mode: 'async', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), logFile,
    };
    saveTask(task);

    // 后台执行，不阻塞
    runHermesTaskInBackground(task, { timeoutMs: input.timeoutMs || DEFAULT_TIMEOUT_MS, cwd: input.cwd });
    return json(res, 202, { taskId: id, status: 'queued', pollUrl: `/tasks/${id}` });
  }

  // GET /tasks/{id}
  const m = url.pathname.match(/^\/tasks\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    try { return json(res, 200, loadTask(m[1])); } catch { return json(res, 404, { error: 'not found' }); }
  }

  // GET /tasks/{id}/logs
  const lm = url.pathname.match(/^\/tasks\/([^/]+)\/logs$/);
  if (req.method === 'GET' && lm) {
    try {
      const t = loadTask(lm[1]);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(fs.existsSync(t.logFile) ? fs.readFileSync(t.logFile, 'utf8') : '');
    } catch { return json(res, 404, { error: 'not found' }); }
  }

  return json(res, 404, { error: 'not found' });
}

// 后台任务执行（不阻塞）
function runHermesTaskInBackground(task, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  const logFile = task.logFile;
  const startedAt = new Date().toISOString();
  const prompt = safePrompt(task.prompt);
  let sessionId = warmSessionId && !warmSessionBusy ? warmSessionId : null;

  task.status = 'running';
  task.startedAt = startedAt;
  task.updatedAt = startedAt;
  task.command = [HERMES_BIN, ...buildArgs(task.prompt, sessionId)];
  saveTask(task);

  const out = fs.openSync(logFile, 'a');
  fs.writeSync(out, `[${startedAt}] [async] Command: ${HERMES_BIN} ${buildArgs('<prompt>', sessionId).join(' ')}\n`);
  if (sessionId) warmSessionBusy = true;

  const child = spawn(HERMES_BIN, buildArgs(prompt, sessionId), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH || ''}`, HERMES_ACCEPT_HOOKS: '1' },
    cwd: opts.cwd || ROOT,
  });

  let stdout = '', stderr = '';
  const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, timeoutMs);
  timer.unref?.();

  child.stdout.on('data', chunk => { const s = chunk.toString(); stdout += s; fs.writeSync(out, s); });
  child.stderr.on('data', chunk => { const s = chunk.toString(); stderr += s; fs.writeSync(out, s); });
  child.on('error', err => {
    clearTimeout(timer);
    const t = loadTask(task.id);
    Object.assign(t, { status: 'failed', error: err.message, stdout: stdout.trim(), stderr: stderr.trim(), completedAt: new Date().toISOString() });
    saveTask(t);
    fs.closeSync(out);
    warmSessionBusy = false;
  });
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    const t = loadTask(task.id);
    Object.assign(t, { status: code === 0 ? 'completed' : 'failed', exitCode: code, signal, stdout: stdout.trim(), stderr: stderr.trim(), result: stdout.trim(), completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    saveTask(t);
    auditResult(t.result || '', task.id);
    fs.writeSync(out, `\n[${t.completedAt}] [async] Exit code=${code} signal=${signal || ''}\n`);
    fs.closeSync(out);
    warmSessionBusy = false;
  });
}

http.createServer((req,res)=>handle(req,res).catch(e=>json(res,500,{error:e.message}))).listen(PORT, '127.0.0.1', () => {
  console.log(`OpenClaw-Hermes Bridge listening on http://127.0.0.1:${PORT}`);
});
