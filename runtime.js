// @local/dsh-scheduled-tasks — Host half (v4, runtime entry)
//
// WorkBuddy-style scheduled tasks for DSH.
// - Persistence: ~/.dsh/plugins/dsh-scheduled-tasks/state.json (atomic tmp+rename
//   via node builtins dynamic import; degrades to in-memory if fs unavailable).
// - Scheduler: ctx.timer.interval ticks every 15s; due tasks dispatch via
//   sessionController.create → (optional) selectModel → prompt(mode:'queue', signal).
// - Client RPC: POST /st-api/<method> routes on the webServer service.
//
// v4 hardening:
//   * services snapshotted at apply time (handlers never touch a dead ctx proxy)
//   * apply() returns a disposer (routes + timer unwound on disable)
//   * prompt() called with an explicit AbortSignal (session-controller Remote
//     signature is (request, signal); index.ts:346 signal.throwIfAborted())
//
// All wall-clock rules are interpreted in Asia/Shanghai (the GUI's pinned zone).

const ZONE = 'Asia/Shanghai';
const TICK_MS = 15000;
const MAX_RUNS = 50;
const MIN_EVERY_SECONDS = 60;
const ROUTE_BASE = '/st-api/';
const STATE_REL = '.dsh/plugins/dsh-scheduled-tasks/state.json';

export const inject = [
  'sessionController', 'workspaceRegistry', 'agentPresets',
  'sessionSkillCatalog', 'skills', 'llm', 'timer', 'webServer',
  'sessions', 'permissionPresets',
];

function firstOf(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// ---------- zone-safe time helpers ----------

function zoneOffsetAt(utcMs, zone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    (+parts.hour) % 24, +parts.minute, +parts.second,
  );
  return asUtc - utcMs;
}

function zoneDateParts(utcMs, zone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  return { y: +parts.year, mo: +parts.month, d: +parts.day };
}

// Wall clock (Y/M/D h:mi) in `zone` → UTC instant (two-pass for DST edges).
function zonedToUtcMs(y, mo, d, h, mi, zone = ZONE) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let off = zoneOffsetAt(guess, zone);
  const ts = guess - off;
  off = zoneOffsetAt(ts, zone);
  return guess - off;
}

// 'YYYY-MM-DDTHH:mm' (wall clock in ZONE) → UTC ms, or 0 when unparseable.
function parseWallMs(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(text || '').trim());
  if (!m) return 0;
  return zonedToUtcMs(+m[1], +m[2], +m[3], +m[4], +m[5]);
}

function computeDailyNext(task, fromMs) {
  const total = Math.max(0, Math.min(1439, Math.floor(Number(task.timeOfDayMinutes) || 0)));
  const h = Math.floor(total / 60);
  const mi = total % 60;
  const p1 = zoneDateParts(fromMs, ZONE);
  const c1 = zonedToUtcMs(p1.y, p1.mo, p1.d, h, mi);
  if (c1 > fromMs) return c1;
  const p2 = zoneDateParts(fromMs + 86400000, ZONE);
  return zonedToUtcMs(p2.y, p2.mo, p2.d, h, mi);
}

function everyMs(task) {
  return Math.max(MIN_EVERY_SECONDS, Math.floor(Number(task.everySeconds) || MIN_EVERY_SECONDS)) * 1000;
}

// ---------- module state (per loaded module instance) ----------

let state = null; // { tasks: [], runs: [] }
let writeChain = Promise.resolve();
let dispatching = false;

export function apply(ctx) {
  const log = (...a) => console.log('[dsh-scheduled-tasks]', ...a);

  // ---- snapshot services NOW (fiber active); handlers never touch ctx again ----
  const svc = {
    sessionController: ctx.sessionController,
    workspaceRegistry: ctx.workspaceRegistry,
    agentPresets: ctx.agentPresets,
    sessionSkillCatalog: ctx.sessionSkillCatalog,
    skills: ctx.skills,
    llm: ctx.llm,
    timer: ctx.timer,
    webServer: ctx.webServer,
    sessions: ctx.sessions,
    permissionPresets: ctx.permissionPresets,
  };

  // ---------- persistence ----------

  async function statePaths() {
    const os = await import('node:os');
    const path = await import('node:path');
    const file = path.join(os.homedir(), ...STATE_REL.split('/'));
    return { dir: path.dirname(file), file };
  }

  async function loadState() {
    if (state) return;
    try {
      const fs = await import('node:fs/promises');
      const { file } = await statePaths();
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      state = {
        tasks: Array.isArray(parsed?.tasks) ? parsed.tasks : [],
        runs: Array.isArray(parsed?.runs) ? parsed.runs : [],
      };
    } catch {
      state = { tasks: [], runs: [] };
    }
  }

  async function saveState() {
    const fs = await import('node:fs/promises');
    const { dir, file } = await statePaths();
    await fs.mkdir(dir, { recursive: true });
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  function persist() {
    writeChain = writeChain.then(saveState).catch((e) => {
      console.error('[dsh-scheduled-tasks] save failed:', e);
    });
    return writeChain;
  }

  // ---------- task validation ----------

  function randomId() {
    return (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
      ? globalThis.crypto.randomUUID()
      : 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  // Accepts either an array of picks (new UI) or a legacy comma/space list string.
  function asList(v) {
    if (Array.isArray(v)) {
      return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 64);
    }
    return String(v || '')
      .split(/[,，、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 64);
  }

  // Permission presets are owned by the permissionPresets service; the plugin
  // only stores a preset NAME per task and applies it to the fresh session.
  function permissionNames() {
    try {
      const names = svc.permissionPresets?.names;
      return Array.isArray(names) ? names.map(String) : [];
    } catch {
      return [];
    }
  }

  function validateAndPrepare(input) {
    const prompt = String(input?.prompt ?? '').trim();
    if (!prompt) throw new Error('提示词不能为空');
    const repeat = ['once', 'every', 'daily'].includes(input?.repeat) ? input.repeat : null;
    if (!repeat) throw new Error('无效的重复规则');
    const now = Date.now();
    const task = {
      id: input?.id ? String(input.id) : randomId(),
      name: String(input?.name || '').trim() || '未命名任务',
      workspaceId: String(input?.workspaceId || ''),
      cwd: String(input?.cwd || ''),
      model: input?.model?.provider && input?.model?.model
        ? { provider: String(input.model.provider), model: String(input.model.model) }
        : null,
      expertId: String(input?.expertId || ''),
      skills: asList(input?.skills),
      connectors: asList(input?.connectors),
      permission: String(input?.permission || ''),
      repeat,
      enabled: input?.enabled !== false,
      prompt,
      createdAt: Number(input?.createdAt) || now,
    };
    if (repeat === 'once') {
      const at = String(input?.at || '');
      const ms = parseWallMs(at);
      if (!ms) throw new Error('无效的执行时间');
      if (ms <= now) throw new Error('执行时间必须晚于当前时间');
      task.at = at;
      task.nextRunAt = ms;
    } else if (repeat === 'every') {
      const sec = Math.floor(Number(input?.everySeconds));
      if (!Number.isFinite(sec) || sec < MIN_EVERY_SECONDS) {
        throw new Error('固定间隔不能小于 ' + MIN_EVERY_SECONDS + ' 秒');
      }
      task.everySeconds = sec;
      task.nextRunAt = now + sec * 1000; // anchor resets on every save
    } else {
      const total = Math.floor(Number(input?.timeOfDayMinutes));
      if (!Number.isFinite(total) || total < 0 || total > 1439) throw new Error('无效的每日时间');
      task.timeOfDayMinutes = total;
      task.nextRunAt = computeDailyNext(task, now);
    }
    if (task.permission) {
      const names = permissionNames();
      if (names.length && !names.includes(task.permission)) {
        throw new Error('无效的权限预设：' + task.permission);
      }
    }
    return task;
  }

  // ---------- dispatch ----------

  function buildPromptText(task) {
    const lines = [task.prompt];
    const skills = asList(task.skills);
    const connectors = asList(task.connectors);
    if (skills.length) {
      lines.push('\n请优先使用以下技能（可用 skill 工具加载后执行）：' + skills.join('、'));
    }
    if (connectors.length) {
      lines.push('\n如需外部数据或文档，请优先使用这些连接器提供的工具：' + connectors.join('、'));
    }
    return lines.join('\n');
  }

  // Apply a permission preset to the freshly created session.
  // permissionPresets.set(session, name) is the only write path (it folds into
  // sandbox/mode + approval events), and it needs the live Session object, so we
  // resolve it through the sessions service. A missing preset or an unknown name
  // is recorded on the run instead of aborting the dispatch.
  async function applyPermission(sessionId, presetName) {
    if (!presetName) return null;
    const svcPerm = svc.permissionPresets;
    if (!svcPerm || typeof svcPerm.set !== 'function') {
      throw new Error('permissionPresets service unavailable');
    }
    const names = permissionNames();
    if (names.length && !names.includes(presetName)) {
      throw new Error('未知权限预设：' + presetName);
    }
    const session = svc.sessions && typeof svc.sessions.get === 'function'
      ? svc.sessions.get(sessionId)
      : null;
    if (!session) throw new Error('会话不存在，无法应用权限预设');
    svcPerm.set(session, presetName);
    return presetName;
  }

  async function dispatchTask(task, now) {
    const run = {
      id: randomId(),
      taskId: task.id,
      taskName: task.name,
      startedAt: now,
      status: 'accepted',
    };
    state.runs.unshift(run);
    if (state.runs.length > MAX_RUNS) state.runs.length = MAX_RUNS;
    try {
      const createReq = {};
      if (task.workspaceId) createReq.workspaceId = task.workspaceId;
      if (task.cwd) createReq.cwd = task.cwd;
      if (task.expertId) createReq.agentPreset = task.expertId;
      const created = await svc.sessionController.create(createReq);
      const sessionId = firstOf(created || {}, ['sessionId', 'id', 'session']);
      if (!sessionId) throw new Error('session create returned no sessionId');
      if (task.permission) {
        try {
          run.permission = await applyPermission(sessionId, task.permission);
        } catch (err) {
          run.permissionError = String((err && err.message) || err);
          log('applyPermission failed:', run.permissionError);
        }
      }
      if (task.model) {
        await svc.sessionController.selectModel({
          sessionId,
          provider: task.model.provider,
          model: task.model.model,
        });
      }
      await svc.sessionController.prompt({
        requestId: randomId(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: buildPromptText(task) }],
        clientTimeZone: ZONE,
      }, new AbortController().signal);
      run.sessionId = sessionId;
    } catch (err) {
      run.status = 'error';
      run.error = String((err && err.message) || err);
    }
    task.lastRunAt = now;
    task.lastRunStatus = run.status;
    if (task.repeat === 'once') {
      task.enabled = false;
      task.status = 'done';
    } else if (task.repeat === 'every') {
      task.nextRunAt = now + everyMs(task); // latest-only catch-up
    } else if (task.repeat === 'daily') {
      task.nextRunAt = computeDailyNext(task, now);
    }
    return run;
  }

  async function tick() {
    if (dispatching || !state) return;
    const now = Date.now();
    const due = state.tasks.filter((t) => t && t.enabled
      && Number(t.nextRunAt) > 0 && Number(t.nextRunAt) <= now);
    if (!due.length) return;
    dispatching = true;
    try {
      for (const task of due) await dispatchTask(task, Date.now());
      await persist();
    } finally {
      dispatching = false;
    }
  }

  // ---------- catalog normalizers ----------

  function normalizeWorkspaces(list) {
    const rows = Array.isArray(list) ? list
      : (list?.items ?? list?.workspaces ?? list?.entries ?? []);
    return rows.map((w) => ({
      id: String(firstOf(w, ['id', 'workspaceId', 'key']) ?? ''),
      title: String(firstOf(w, ['title', 'name', 'label']) ?? ''),
      path: String(firstOf(w, ['path', 'cwd', 'root', 'directory']) ?? ''),
    })).filter((w) => w.id);
  }

  function normalizeExperts(roster) {
    const rows = Array.isArray(roster) ? roster
      : (roster?.items ?? roster?.presets ?? roster?.entries ?? roster?.roster ?? []);
    return rows.map((e) => {
      const nested = e && typeof e.preset === 'object' ? e.preset : e;
      return {
        id: String(firstOf(e, ['id', 'presetId', 'key', 'name'])
          ?? firstOf(nested, ['id', 'name']) ?? ''),
        name: String(firstOf(nested, ['title', 'name', 'label', 'displayName']) ?? ''),
      };
    }).filter((e) => e.id);
  }

  function normalizeSkills(list) {
    const rows = Array.isArray(list) ? list : (list?.items ?? list?.skills ?? []);
    return rows.map((s) => ({
      name: String(firstOf(s, ['name', 'skill', 'id', 'key']) ?? ''),
      title: String(firstOf(s, ['title', 'label', 'description']) ?? '').slice(0, 160),
    })).filter((s) => s.name)
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 400);
  }

  function pickKnownSessionId() {
    try {
      const hit = (state?.runs || []).find((r) => r && r.sessionId);
      if (hit) return String(hit.sessionId);
    } catch { /* ignore */ }
    return '';
  }

  // Anchor session for "which skills does a session in this profile see".
  // Prefer a session we already created, else borrow the newest existing one.
  async function anchorSessionId() {
    await loadState();
    const known = pickKnownSessionId();
    if (known) return known;
    try {
      const res = await svc.sessionController.list({});
      const rows = Array.isArray(res) ? res : (res?.sessions ?? res?.items ?? res?.list ?? []);
      const sorted = rows.slice().sort((a, b) =>
        Number(firstOf(b, ['updatedAt', 'lastActiveAt', 'createdAt']) ?? 0) -
        Number(firstOf(a, ['updatedAt', 'lastActiveAt', 'createdAt']) ?? 0));
      const id = sorted.length ? String(firstOf(sorted[0], ['id', 'sessionId']) ?? '') : '';
      if (id) return id;
    } catch (err) {
      log('sessionController.list anchor failed:', err && err.message ? err.message : err);
    }
    return '';
  }

  async function listModelsFlat() {
    const providers = await svc.llm.listProviders();
    const out = [];
    for (const p of (providers ?? [])) {
      const pid = typeof p === 'string' ? p : String(firstOf(p, ['id', 'provider', 'key', 'name']) ?? '');
      if (!pid) continue;
      try {
        const models = await svc.llm.listModels(pid);
        for (const m of (models ?? [])) {
          const mid = typeof m === 'string' ? m : String(firstOf(m, ['id', 'model', 'name', 'key']) ?? '');
          if (mid) out.push({ provider: pid, model: mid });
        }
      } catch (err) {
        log('listModels(' + pid + ') failed:', err);
      }
    }
    return out;
  }

  // MCP connectors are owned by the mcp-connector plugin, which persists its
  // connections in ~/.dsh/storages/mcp_connector.json (tables.connections map).
  // We only read it to offer a pick list; any failure degrades to an empty list.
  async function listMcpConnectors() {
    try {
      const os = await import('node:os');
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const file = path.join(os.homedir(), '.dsh', 'storages', 'mcp_connector.json');
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      const table = parsed?.tables?.connections;
      const rows = Array.isArray(table) ? table : Object.values(table || {});
      return rows
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({
          key: String(firstOf(c, ['key', 'connectorId', 'serverName', 'name']) ?? ''),
          name: String(firstOf(c, ['name', 'title', 'serverName', 'key']) ?? ''),
          serverName: String(firstOf(c, ['serverName', 'key']) ?? ''),
          enabled: c.enabled !== false,
        }))
        .filter((c) => c.key || c.name)
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      log('listMcpConnectors failed:', err);
      return [];
    }
  }

  // ---------- RPC routes (POST /st-api/<method>) ----------

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 1048576) {
          reject(new Error('payload too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  const routeDisposers = [];

  function addRoute(name, fn) {
    try {
      const dispose = svc.webServer.register({
        kind: 'exact',
        path: ROUTE_BASE + name,
        handler: async (req, res) => {
          let body = {};
          try { body = await readJson(req); } catch { body = {}; }
          try {
            const data = await fn(body);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, data }));
          } catch (err) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
        },
      });
      routeDisposers.push(dispose);
    } catch (err) {
      console.error('[dsh-scheduled-tasks] route ' + ROUTE_BASE + name + ' register failed:', err);
    }
  }

  addRoute('ping', async () => ({ pong: true, zone: ZONE }));

  addRoute('list-workspaces', async () => normalizeWorkspaces(await svc.workspaceRegistry.list()));

  addRoute('list-models', async () => listModelsFlat());

  addRoute('list-experts', async () => normalizeExperts(await svc.agentPresets.list()));

  addRoute('list-skills', async (body) => {
    const cwd = String(body?.cwd || '').trim();
    await loadState();
    // 1) Session-addressed catalog: the documented shape of "skills a session sees".
    //    It needs a real SessionId, so reuse the newest known one from run history.
    const sessionId = await anchorSessionId();
    if (sessionId) {
      try {
        const rows = normalizeSkills(await svc.sessionSkillCatalog.list({ sessionId }));
        if (rows.length) return rows;
      } catch (err) {
        log('sessionSkillCatalog.list failed:', err && err.message ? err.message : err);
      }
    }
    // 2) Host skill registry: no session needed, returns SkillSummary[].
    if (svc.skills && typeof svc.skills.list === 'function') {
      const attempts = [];
      if (cwd) attempts.push({ cwd });
      attempts.push({});
      for (const opts of attempts) {
        try {
          const rows = await svc.skills.list(opts);
          if (Array.isArray(rows) && rows.length) return normalizeSkills(rows);
        } catch (err) {
          log('skills.list(' + JSON.stringify(opts) + ') failed:', err && err.message ? err.message : err);
        }
      }
    }
    return [];
  });

  addRoute('list-connectors', async () => listMcpConnectors());

  // Permission presets (read-only projection for the picker).
  // Labels mirror the product wording used by the permission row in the chat UI
  // (packages/client/ui-permission-presets/src/client/locales.ts) so a task's
  // permission reads the same here as it does there.
  const PERMISSION_LABELS = {
    'read-only': { zh: '仅可查看', en: 'Read Only' },
    'workspace-write': { zh: '工作区内修改', en: 'Workspace Write' },
    'danger-full-access': { zh: '完全权限', en: 'Full access' },
  };
  addRoute('list-permissions', async () => {
    const names = permissionNames();
    return names.map((name) => {
      let option = null;
      try {
        option = svc.permissionPresets.optionOf(name) || null;
      } catch { /* unknown preset in this deployment */ }
      const hostName = String(firstOf(option || {}, ['name']) ?? name);
      const builtin = PERMISSION_LABELS[name];
      // Follow the product rule: a host name only counts as "built-in" while it
      // still equals the machine value or the stock English label.
      const localized = builtin && (hostName === name || hostName === builtin.en);
      return {
        value: name,
        name: localized ? builtin.zh : hostName,
        label: localized ? builtin.zh : hostName,
        description: String(firstOf(option || {}, ['description']) ?? ''),
      };
    });
  });

  addRoute('list-tasks', async () => {
    await loadState();
    return { tasks: state.tasks };
  });

  addRoute('list-runs', async () => {
    await loadState();
    return { runs: state.runs };
  });

  addRoute('save-task', async (body) => {
    await loadState();
    const task = validateAndPrepare(body);
    const idx = state.tasks.findIndex((t) => t && t.id === task.id);
    if (idx >= 0) state.tasks[idx] = task;
    else state.tasks.push(task);
    await persist();
    return { task };
  });

  addRoute('delete-task', async (body) => {
    await loadState();
    const id = String(body?.id || '');
    const before = state.tasks.length;
    state.tasks = state.tasks.filter((t) => t && t.id !== id);
    await persist();
    return { deleted: before - state.tasks.length };
  });

  addRoute('set-enabled', async (body) => {
    await loadState();
    const id = String(body?.id || '');
    const enabled = body?.enabled !== false;
    const task = state.tasks.find((t) => t && t.id === id);
    if (!task) throw new Error('任务不存在');
    if (enabled) {
      const now = Date.now();
      if (task.repeat === 'once') {
        const ms = parseWallMs(task.at);
        if (!ms) throw new Error('无效的执行时间');
        if (ms <= now) throw new Error('执行时间已过，请编辑任务后重新启用');
        task.nextRunAt = ms;
      } else if (task.repeat === 'every') {
        task.nextRunAt = now + everyMs(task);
      } else {
        task.nextRunAt = computeDailyNext(task, now);
      }
      task.status = 'active';
    }
    task.enabled = enabled;
    await persist();
    return { task };
  });

  addRoute('run-now', async (body) => {
    await loadState();
    const id = String(body?.id || '');
    const task = state.tasks.find((t) => t && t.id === id);
    if (!task) throw new Error('任务不存在');
    if (dispatching) throw new Error('调度器忙碌中，请稍后重试');
    dispatching = true;
    try {
      const run = await dispatchTask(task, Date.now());
      await persist();
      return { run };
    } finally {
      dispatching = false;
    }
  });

  // ---------- scheduler ----------

  loadState()
    .then(() => tick())
    .catch((e) => log('init failed:', e));
  const stopTimer = svc.timer.interval(() => {
    tick().catch((e) => log('tick failed:', e));
  }, TICK_MS);

  log('active; RPC at ' + ROUTE_BASE + '*');

  // Unwind on disable: timer first, then routes (ghost-route hygiene).
  return () => {
    try { stopTimer(); } catch { /* already collected by the fiber */ }
    for (const d of routeDisposers) {
      try { d(); } catch { /* route table already gone */ }
    }
    log('disposed');
  };
}
