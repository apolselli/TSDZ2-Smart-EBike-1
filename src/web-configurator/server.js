/*
 * TSDZ2 Web Configurator - local build server (zero npm dependencies).
 *
 * Serves the single-page configurator (public/index.html) and a small API:
 *   GET  /api/defaults          -> the proven settings .ini files (read-only)
 *   GET  /api/version           -> first line of commits.txt
 *   POST /api/compile           -> { name, ini, configH } -> { guid }
 *   GET  /api/compile/<guid>    -> { status, position, logTail, hexName, ... }
 *   GET  /api/compile/<guid>/<hex|log|ini|configh> -> artifact download
 *   GET  /compile/<guid>        -> waiting page (polls status)
 *
 * Compilation runs serially (one make at a time) in its own copy of src/,
 * so the working tree is never modified. Requires sdcc + make in PATH.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.resolve(__dirname, '..', '..'); // repository root (src/web-configurator -> repo)
const BUILDS_DIR = path.join(__dirname, 'builds');
const MAX_BUILD_HISTORY = 20;
const MAX_BODY = 1024 * 1024;

// ---------------------------------------------------------------- helpers

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, filePath, downloadName) {
  const stream = fs.createReadStream(filePath);
  stream.on('open', () => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${downloadName}"`,
      'Cache-Control': 'no-store',
    });
    stream.pipe(res);
  });
  stream.on('error', () => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeName(name) {
  const s = String(name || '').replace(/[^A-Za-z0-9_.-]/g, '_');
  return s.length ? s : 'settings';
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function firmwareVersion() {
  try {
    const sh = await fsp.readFile(path.join(ROOT, 'compile_and_flash_20.sh'), 'utf8');
    const m = sh.match(/version="([^"]+)"/);
    if (m) return m[1];
  } catch { /* ignore */ }
  return 'unknown';
}

// Copy the firmware sources into a build dir. The app itself lives in
// src/web-configurator (inside the tree being copied), so fs.cp on the whole
// src/ would fail its self-containment check - copy the children instead and
// skip our own folder.
async function copyFirmwareSources(dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of await fsp.readdir(path.join(ROOT, 'src'), { withFileTypes: true })) {
    if (entry.name === 'web-configurator') continue;
    const from = path.join(ROOT, 'src', entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await fsp.cp(from, to, { recursive: true });
    else if (entry.isFile()) await fsp.copyFile(from, to);
  }
}

// ---------------------------------------------------------------- build queue

const queue = []; // guids, FIFO
let running = false;
const jobs = new Map(); // guid -> meta object

function enqueue(guid) {
  queue.push(guid);
  pump();
}

async function pump() {
  if (running || queue.length === 0) return;
  running = true;
  while (queue.length > 0) {
    const guid = queue.shift();
    try {
      await runJob(guid);
    } catch (err) {
      const job = jobs.get(guid);
      if (job) {
        job.status = 'error';
        job.error = String(err.message || err);
        job.finished = new Date().toISOString();
        await persistMeta(guid).catch(() => {});
      }
      console.error(`[build ${guid}] failed:`, err.message || err);
    }
  }
  running = false;
}

async function persistMeta(guid) {
  const job = jobs.get(guid);
  if (job) await fsp.writeFile(path.join(BUILDS_DIR, guid, 'meta.json'), JSON.stringify(job, null, 2));
}

function runJob(guid) {
  return new Promise(async (resolve, reject) => {
    const job = jobs.get(guid);
    const dir = path.join(BUILDS_DIR, guid);
    job.status = 'running';
    job.started = new Date().toISOString();
    await persistMeta(guid);

    const log = fs.createWriteStream(path.join(dir, 'build.log'), { flags: 'a' });
    log.write(`# TSDZ2 firmware build ${guid}\n# settings: ${job.name}\n\n`);

    let child;
    try {
      // Fresh copy of the firmware sources; the client-generated config.h
      // was already written into it by the POST handler.
      child = spawn('make', ['-C', 'src'], { cwd: dir });
    } catch (err) {
      log.end(`\n# failed to spawn make: ${err.message}\n`);
      job.status = 'error';
      job.error = `failed to spawn make: ${err.message}`;
      job.finished = new Date().toISOString();
      await persistMeta(guid);
      resolve();
      return;
    }

    child.stdout.on('data', (c) => log.write(c));
    child.stderr.on('data', (c) => log.write(c));
    child.on('error', async (err) => {
      log.end(`\n# ${err.message}\n`);
      job.status = 'error';
      job.error = err.code === 'ENOENT'
        ? "make not found - install sdcc and make, ensure both are in PATH"
        : err.message;
      job.finished = new Date().toISOString();
      await persistMeta(guid);
      resolve();
    });
    child.on('close', async (code) => {
      const hexPath = path.join(dir, 'bin', 'main.hex');
      fs.access(hexPath, async (accessErr) => {
        if (code === 0 && !accessErr) {
          job.hexName = `TSDZ2-${job.version}-${safeName(job.name)}.hex`;
          await fsp.rename(hexPath, path.join(dir, job.hexName)).catch(() => {});
          job.status = 'done';
        } else {
          job.status = 'error';
          job.error = code === 0
            ? 'make succeeded but bin/main.hex was not produced'
            : `make exited with code ${code}`;
        }
        job.finished = new Date().toISOString();
        log.end(`\n# result: ${job.status}${job.error ? ' - ' + job.error : ''}\n`);
        await persistMeta(guid);
        console.log(`[build ${guid}] ${job.status}`);
        resolve();
      });
    });
  });
}

async function pruneBuilds() {
  let entries;
  try {
    entries = await fsp.readdir(BUILDS_DIR, { withFileTypes: true });
  } catch { return; }
  const dirs = entries.filter((e) => e.isDirectory() && GUID_RE.test(e.name));
  if (dirs.length <= MAX_BUILD_HISTORY) return;
  const withTime = await Promise.all(dirs.map(async (e) => {
    const st = await fsp.stat(path.join(BUILDS_DIR, e.name));
    return { name: e.name, mtime: st.mtimeMs };
  }));
  withTime.sort((a, b) => a.mtime - b.mtime);
  for (const d of withTime.slice(0, withTime.length - MAX_BUILD_HISTORY)) {
    await fsp.rm(path.join(BUILDS_DIR, d.name), { recursive: true, force: true }).catch(() => {});
    jobs.delete(d.name);
  }
}

// ---------------------------------------------------------------- routes

async function handleCompilePost(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' });
    return;
  }
  const { name, ini, configH } = body;
  if (typeof configH !== 'string' || !configH.length || typeof ini !== 'string' || !ini.length) {
    sendJson(res, 400, { error: 'missing ini or configH' });
    return;
  }

  const guid = crypto.randomUUID();
  const dir = path.join(BUILDS_DIR, guid);
  try {
    await copyFirmwareSources(path.join(dir, 'src'));
    // The client generated config.h - overwrite the repo copy in the job dir.
    await fsp.writeFile(path.join(dir, 'src', 'config.h'), configH);
    await fsp.writeFile(path.join(dir, 'settings.ini'), ini);
  } catch (err) {
    sendJson(res, 500, { error: `failed to prepare build dir: ${err.message}` });
    return;
  }

  const job = {
    guid,
    name: safeName(name),
    version: await firmwareVersion(),
    status: 'queued',
    created: new Date().toISOString(),
    hexName: null,
    error: null,
  };
  jobs.set(guid, job);
  await persistMeta(guid);
  pruneBuilds(); // fire and forget
  enqueue(guid);
  console.log(`[build ${guid}] queued (settings: ${job.name})`);
  sendJson(res, 200, { guid });
}

async function jobStatus(guid) {
  const job = jobs.get(guid);
  if (job) {
    return {
      ...job,
      position: job.status === 'queued' ? queue.indexOf(guid) + 1 : 0,
    };
  }
  // Server may have restarted; try to recover meta from disk.
  try {
    const meta = JSON.parse(await fsp.readFile(path.join(BUILDS_DIR, guid, 'meta.json'), 'utf8'));
    jobs.set(guid, meta);
    return { ...meta, position: 0 };
  } catch {
    return null;
  }
}

async function handleCompileGet(req, res, guid, artifact) {
  if (!GUID_RE.test(guid)) {
    sendJson(res, 400, { error: 'bad guid' });
    return;
  }
  const dir = path.join(BUILDS_DIR, guid);

  if (!artifact) {
    const st = await jobStatus(guid);
    if (!st) {
      sendJson(res, 404, { error: 'unknown build' });
      return;
    }
    let logTail = '';
    try {
      const log = await fsp.readFile(path.join(dir, 'build.log'), 'utf8');
      logTail = log.length > 16384 ? log.slice(log.length - 16384) : log;
    } catch { /* no log yet */ }
    sendJson(res, 200, { ...st, logTail });
    return;
  }

  const st = await jobStatus(guid);
  if (!st) {
    sendJson(res, 404, { error: 'unknown build' });
    return;
  }
  const map = {
    hex: () => [path.join(dir, st.hexName || 'bin/main.hex'), st.hexName || 'main.hex'],
    log: () => [path.join(dir, 'build.log'), `build-${guid}.log`],
    ini: () => [path.join(dir, 'settings.ini'), `${st.name}.ini`],
    configh: () => [path.join(dir, 'src', 'config.h'), 'config.h'],
  };
  const maker = map[artifact];
  if (!maker) {
    sendJson(res, 404, { error: 'unknown artifact' });
    return;
  }
  const [file, download] = maker();
  fs.access(file, (err) => {
    if (err) {
      sendJson(res, 404, { error: 'artifact not ready' });
      return;
    }
    sendFile(res, file, download);
  });
}

// ---------------------------------------------------------- waiting page

function waitingPage(guid) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Compiling TSDZ2 firmware...</title>
<style>
 body{font-family:sans-serif;background:#f2f4f7;margin:0;padding:2rem}
 .card{max-width:56rem;margin:0 auto;background:#fff;border:1px solid #d8dee6;border-radius:8px;padding:1.5rem}
 h1{font-size:1.2rem;margin:0 0 .5rem}
 .meta{color:#555;font-size:.9rem;margin-bottom:1rem}
 .status{font-weight:bold;padding:.4rem .8rem;border-radius:4px;display:inline-block;margin-bottom:1rem}
 .queued{background:#fff3cd}.running{background:#cfe2ff}.done{background:#d1e7dd}.error{background:#f8d7da}
 pre{background:#101418;color:#cfe3ff;padding:1rem;border-radius:6px;overflow:auto;max-height:24rem;font-size:.8rem;white-space:pre-wrap}
 a.btn,span.dim{display:inline-block;margin:.3rem .6rem .3rem 0;padding:.5rem 1rem;background:#0d6efd;color:#fff;text-decoration:none;border-radius:6px}
 span.dim{background:#6c757d}
 .spin{display:inline-block;animation:r 1s linear infinite}
 @keyframes r{to{transform:rotate(360deg)}}
</style></head><body>
<div class="card">
 <h1>TSDZ2 firmware compilation</h1>
 <div class="meta">Build <code>${guid}</code> &middot; <a href="/">back to configurator</a></div>
 <div id="status" class="status queued">queued</div><span id="spin" class="spin">&#9696;</span>
 <div id="queuepos"></div>
 <pre id="log">waiting for build output...</pre>
 <div id="links"></div>
</div>
<script>
const guid = location.pathname.split('/').pop();
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const linksEl = document.getElementById('links');
const spinEl = document.getElementById('spin');
const queueEl = document.getElementById('queuepos');
let last = '';
async function poll() {
  try {
    const r = await fetch('/api/compile/' + guid);
    const j = await r.json();
    statusEl.textContent = j.status;
    statusEl.className = 'status ' + j.status;
    queueEl.textContent = (j.status === 'queued' && j.position > 0)
      ? 'position in queue: ' + j.position : '';
    if (j.logTail) { logEl.textContent = j.logTail; logEl.scrollTop = logEl.scrollHeight; }
    if (j.status === 'done') {
      spinEl.style.display = 'none';
      linksEl.innerHTML = '<a class="btn" href="/api/compile/' + guid + '/hex">Download firmware (' + (j.hexName || 'main.hex') + ')</a>'
        + '<a class="btn" href="/api/compile/' + guid + '/configh">config.h</a>'
        + '<a class="btn" href="/api/compile/' + guid + '/ini">settings.ini</a>'
        + '<a class="btn" href="/api/compile/' + guid + '/log">build log</a>'
        + '<span class="dim">flash it yourself with: stm8flash -c stlinkv2 -p stm8s105?6 -w &lt;hex&gt;</span>';
      clearInterval(t);
    } else if (j.status === 'error') {
      spinEl.style.display = 'none';
      linksEl.innerHTML = '<div style="color:#b02a37;margin-bottom:.5rem">Build failed: ' + (j.error || 'unknown error')
        + '</div><a class="btn" href="/api/compile/' + guid + '/log">build log</a>';
      clearInterval(t);
    }
  } catch (e) { /* keep polling */ }
}
const t = setInterval(poll, 1500);
poll();
</script></body></html>`;
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = await fsp.readFile(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && p === '/api/defaults') {
      const dir = path.join(ROOT, 'proven settings');
      const names = (await fsp.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.ini')).sort();
      const files = await Promise.all(names.map(async (n) => ({
        name: n,
        ini: await fsp.readFile(path.join(dir, n), 'utf8'),
      })));
      sendJson(res, 200, { files });
      return;
    }

    if (req.method === 'GET' && p === '/api/version') {
      let version = '';
      try {
        version = (await fsp.readFile(path.join(ROOT, 'commits.txt'), 'utf8')).split('\n')[0];
      } catch { /* ignore */ }
      sendJson(res, 200, { version });
      return;
    }

    if (req.method === 'POST' && p === '/api/compile') {
      await handleCompilePost(req, res);
      return;
    }

    let m = p.match(/^\/api\/compile\/([^/]+)(?:\/(hex|log|ini|configh))?$/);
    if (m && req.method === 'GET') {
      await handleCompileGet(req, res, m[1], m[2]);
      return;
    }

    m = p.match(/^\/compile\/([^/]+)$/);
    if (m && req.method === 'GET' && GUID_RE.test(m[1])) {
      const html = waitingPage(m[1]);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    console.error('request error:', err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

// sendFile for the index page with inline download disabled
server.on('listening', () => {
  console.log(`TSDZ2 web configurator: http://${HOST}:${PORT}/`);
  console.log(`repository root: ${ROOT}`);
  console.log('compilation needs sdcc + make in PATH; flashing is out of scope.');
});

server.listen(PORT, HOST);
