// @local/dsh-scheduled-tasks — Client half (v3)
//
// Registers:
//  - sidebar.panellist icon 'dsh-scheduled-tasks' (clock glyph)
//  - main keyed panel with the same id: task manager
//     (list + create/edit form + run history)
//
// Talks to the Host half via same-origin POST /st-api/<method>.

window.__ModuleLoader__.load({
  id: '@local/dsh-scheduled-tasks',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const PANEL_ID = 'dsh-scheduled-tasks';
    const API = '/st-api/';

    async function api(method, body) {
      const res = await fetch(API + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const json = await res.json().catch(() => null);
      if (!json) throw new Error('服务无响应');
      if (!json.ok) throw new Error(json.error || '未知错误');
      return json.data;
    }

    // ---------- tiny style helpers (self-contained, no theme deps) ----------

    const css = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', fontSize: 13, color: 'inherit' },
      header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px 10px', gap: 12 },
      title: { fontSize: 16, fontWeight: 600, margin: 0 },
      body: { flex: 1, overflow: 'auto', padding: '0 18px 24px' },
      card: { border: '1px solid var(--dsw-border, rgba(127,127,127,0.25))', borderRadius: 10, padding: 12, marginBottom: 10, background: 'var(--dsw-card, rgba(127,127,127,0.06))' },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      col: { display: 'flex', flexDirection: 'column', gap: 8 },
      label: { fontSize: 12, opacity: 0.75, marginBottom: 2 },
      input: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--dsw-border, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', fontSize: 13 },
      select: { padding: '6px 8px', borderRadius: 8, border: '1px solid var(--dsw-border, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', fontSize: 13, maxWidth: '100%' },
      btn: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--dsw-border, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13 },
      btnPrimary: { padding: '7px 16px', borderRadius: 8, border: 'none', background: 'var(--dsw-accent, #4a7dff)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 },
      btnSmall: { padding: '3px 9px', borderRadius: 6, border: '1px solid var(--dsw-border, rgba(127,127,127,0.35))', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 },
      badge: { padding: '1px 8px', borderRadius: 999, fontSize: 11, border: '1px solid var(--dsw-border, rgba(127,127,127,0.35))', opacity: 0.9 },
      meta: { fontSize: 12, opacity: 0.7 },
      error: { color: '#d5484c', fontSize: 12, marginTop: 6 },
      empty: { opacity: 0.55, padding: '28px 0', textAlign: 'center' },
      pickBox: { display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 148, overflow: 'auto', padding: '6px 8px', border: '1px solid var(--dsw-border, rgba(127,127,127,0.28))', borderRadius: 8 },
      chipOff: { padding: '2px 9px', borderRadius: 999, border: '1px solid var(--dsw-border, rgba(127,127,127,0.42))', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, opacity: 0.85 },
      chipOn: { padding: '2px 9px', borderRadius: 999, border: '1px solid var(--dsw-accent, #4a7dff)', background: 'var(--dsw-accent, #4a7dff)', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
    };

    function fmtMs(ms) {
      if (!ms) return '—';
      try {
        return new Intl.DateTimeFormat('zh-CN', {
          timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit',
        }).format(new Date(ms));
      } catch { return String(ms); }
    }

    function repeatLabel(task) {
      if (task.repeat === 'once') return '一次性 · ' + fmtMs(task.nextRunAt || 0);
      if (task.repeat === 'every') return '每 ' + task.everySeconds + ' 秒';
      const m = task.timeOfDayMinutes;
      return '每天 ' + String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    }

    function repeatText(t) {
      return t.repeat === 'once' ? '一次性' : t.repeat === 'every' ? '固定间隔' : '每天';
    }

    // ---------- sidebar icon ----------

    function PanelIcon(props) {
      const size = (props && props.size) || 18;
      const active = !!(props && props.active);
      const color = active ? 'currentColor' : 'currentColor';
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: color, strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block', opacity: active ? 1 : 0.72 },
      },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('path', { d: 'M12 7v5l3.2 2' }),
      );
    }

    // ---------- main panel ----------

    const EMPTY_FORM = {
      id: '', name: '', prompt: '', workspaceId: '', cwd: '',
      model: null, expertId: '', skills: [], connectors: [],
      repeat: 'once', at: '', everySeconds: 3600, timeOfDayMinutes: 540,
      enabled: true,
    };

    const toList = (v) => Array.isArray(v)
      ? v.map((x) => String(x).trim()).filter(Boolean)
      : String(v || '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);

    const toggleIn = (list, value) => (list.includes(value)
      ? list.filter((x) => x !== value)
      : [...list, value]);

    function Panel() {
      const [tasks, setTasks] = useState(null);
      const [runs, setRuns] = useState([]);
      const [catalog, setCatalog] = useState({ workspaces: [], models: [], experts: [], skills: [], connectors: [] });
      const [form, setForm] = useState(null); // null = list view
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [showRuns, setShowRuns] = useState(false);

      const refresh = useCallback(async () => {
        try {
          const safe = (p) => p.catch(() => null);
          const [t, r, ws, md, ex, sk, cx] = await Promise.all([
            api('list-tasks'),
            api('list-runs'),
            safe(api('list-workspaces')),
            safe(api('list-models')),
            safe(api('list-experts')),
            safe(api('list-skills')),
            safe(api('list-connectors')),
          ]);
          setTasks(t.tasks || []);
          setRuns(r.runs || []);
          setCatalog({
            workspaces: Array.isArray(ws) ? ws : (ws?.workspaces || []),
            models: Array.isArray(md) ? md : (md?.models || []),
            experts: Array.isArray(ex) ? ex : (ex?.experts || []),
            skills: Array.isArray(sk) ? sk : (sk?.skills || []),
            connectors: Array.isArray(cx) ? cx : (cx?.connectors || []),
          });
          setError('');
        } catch (e) { setError(String(e.message || e)); }
      }, []);

      useEffect(() => { refresh(); }, [refresh]);

      const cwdOf = (id) => {
        const hit = catalog.workspaces.find((w) => w.id === id);
        return (hit && hit.path) || '';
      };

      const reloadSkills = useCallback((cwd) => {
        api('list-skills', { cwd: cwd || '' })
          .then((rows) => {
            const list = Array.isArray(rows) ? rows : (rows?.skills || []);
            if (list.length) setCatalog((c) => ({ ...c, skills: list }));
          })
          .catch(() => { /* keep whatever we already have */ });
      }, []);

      const openCreate = () => { setError(''); setForm({ ...EMPTY_FORM }); reloadSkills(''); };

      const openEdit = (task) => {
        setError('');
        reloadSkills(cwdOf(task.workspaceId));
        setForm({
          id: task.id, name: task.name || '', prompt: task.prompt || '',
          workspaceId: task.workspaceId || '', cwd: task.cwd || '',
          model: task.model || null, expertId: task.expertId || '',
          skills: toList(task.skills), connectors: toList(task.connectors),
          repeat: task.repeat || 'once',
          at: task.at || '', everySeconds: task.everySeconds || 3600,
          timeOfDayMinutes: task.timeOfDayMinutes || 540,
          enabled: task.enabled !== false,
        });
      };

      const save = async () => {
        setBusy(true); setError('');
        try {
          await api('save-task', form);
          setForm(null);
          await refresh();
        } catch (e) { setError(String(e.message || e)); }
        setBusy(false);
      };

      const remove = async (id) => {
        if (!confirm('删除该定时任务？')) return;
        setBusy(true);
        try { await api('delete-task', { id }); await refresh(); }
        catch (e) { setError(String(e.message || e)); }
        setBusy(false);
      };

      const toggle = async (task) => {
        setBusy(true);
        try { await api('set-enabled', { id: task.id, enabled: !task.enabled }); await refresh(); }
        catch (e) { setError(String(e.message || e)); }
        setBusy(false);
      };

      const runNow = async (id) => {
        setBusy(true);
        try { await api('run-now', { id }); await refresh(); }
        catch (e) { setError(String(e.message || e)); }
        setBusy(false);
      };

      const set = (patch) => setForm((f) => ({ ...f, ...patch }));

      const wsName = (id) => {
        const w = catalog.workspaces.find((x) => x.id === id);
        return w ? (w.title || w.path) : id;
      };

      if (form) {
        return h('div', { style: css.root },
          h('div', { style: css.header },
            h('h2', { style: css.title }, form.id ? '编辑定时任务' : '新建定时任务'),
            h('button', { style: css.btn, onClick: () => setForm(null) }, '返回'),
          ),
          h('div', { style: { ...css.body, maxWidth: 720 } },
            h('div', { style: css.col },
              field('任务名称', h('input', { style: css.input, value: form.name, placeholder: '例如：每日晨报汇总', onChange: (e) => set({ name: e.target.value }) })),
              field('提示词（到期后作为任务发给所选工作区的新会话）',
                h('textarea', { style: { ...css.input, minHeight: 90, resize: 'vertical' }, value: form.prompt, placeholder: '要执行的内容……', onChange: (e) => set({ prompt: e.target.value }) })),

              field('工作区', h('select', {
                style: css.select,
                value: form.workspaceId,
                onChange: (e) => {
                  const id = e.target.value;
                  set({ workspaceId: id, cwd: '' });
                  reloadSkills(cwdOf(id));
                },
              },
                h('option', { value: '' }, '（当前默认）'),
                catalog.workspaces.map((w) => h('option', { key: w.id, value: w.id }, w.title + (w.path ? ' · ' + w.path : ''))))),

              field('模型（留空 = 默认模型）', modelPicker(form, set, catalog)),

              field('专家（agent preset，留空 = 默认）', h('select', { style: css.select, value: form.expertId, onChange: (e) => set({ expertId: e.target.value }) },
                h('option', { value: '' }, '（默认）'),
                catalog.experts.map((x) => h('option', { key: x.id, value: x.id }, x.name || x.id)))),

              field('技能（可选，勾选后任务会优先使用这些 skill）',
                h(PickList, {
                  options: catalog.skills.map((s) => ({ value: s.name, label: s.name, hint: s.title || s.name })),
                  selected: form.skills,
                  onChange: (next) => set({ skills: next }),
                  emptyText: '（未获取到技能列表）',
                })),

              field('连接器（可选，勾选后任务会优先使用这些连接器工具）',
                h(PickList, {
                  options: catalog.connectors.map((c) => ({ value: c.serverName || c.key, label: c.name || c.key, hint: c.key })),
                  selected: form.connectors,
                  onChange: (next) => set({ connectors: next }),
                  emptyText: '（未发现已配置的 MCP 连接器）',
                })),

              field('重复规则', h('div', { style: css.col },
                h('div', { style: css.row },
                  radio('once', '一次性', form, set),
                  radio('every', '固定间隔', form, set),
                  radio('daily', '每天', form, set)),
                form.repeat === 'once' && h('input', { type: 'datetime-local', style: css.input, value: form.at, onChange: (e) => set({ at: e.target.value }) }),
                form.repeat === 'every' && h('div', { style: css.row },
                  h('input', { type: 'number', min: 60, style: { ...css.input, width: 120 }, value: form.everySeconds, onChange: (e) => set({ everySeconds: Number(e.target.value) }) }),
                  h('span', { style: css.meta }, '秒（≥60）')),
                form.repeat === 'daily' && h('input', { type: 'time', style: { ...css.input, width: 140 }, value: minToTime(form.timeOfDayMinutes), onChange: (e) => set({ timeOfDayMinutes: timeToMin(e.target.value) }) }),
              )),

              error && h('div', { style: css.error }, error),
              h('div', { style: css.row },
                h('button', { style: css.btnPrimary, disabled: busy, onClick: save }, busy ? '保存中…' : '保存任务'),
                h('button', { style: css.btn, disabled: busy, onClick: () => setForm(null) }, '取消'),
              ),
            ),
          ),
        );
      }

      return h('div', { style: css.root },
        h('div', { style: css.header },
          h('h2', { style: css.title }, '定时任务'),
          h('div', { style: css.row },
            h('button', { style: css.btnSmall, onClick: () => setShowRuns((v) => !v) }, showRuns ? '隐藏运行历史' : '运行历史'),
            h('button', { style: css.btnPrimary, onClick: openCreate }, '＋ 新建任务'),
          ),
        ),
        h('div', { style: css.body },
          error && h('div', { style: { ...css.error, marginBottom: 10 } }, error),
          tasks === null && h('div', { style: css.empty }, '加载中…'),
          tasks !== null && tasks.length === 0 && h('div', { style: css.empty }, '还没有定时任务。点右上角「新建任务」创建一个。'),
          tasks !== null && tasks.map((t) => h('div', { key: t.id, style: css.card },
            h('div', { style: { ...css.row, justifyContent: 'space-between' } },
              h('div', { style: css.row },
                h('strong', null, t.name || '未命名任务'),
                h('span', { style: css.badge }, repeatText(t)),
                h('span', { style: css.badge }, t.enabled === false ? '已停用' : (t.status === 'done' ? '已完成' : '已启用')),
              ),
              h('div', { style: css.row },
                h('button', { style: css.btnSmall, disabled: busy, onClick: () => runNow(t.id) }, '立即运行'),
                h('button', { style: css.btnSmall, disabled: busy, onClick: () => toggle(t) }, t.enabled === false ? '启用' : '停用'),
                h('button', { style: css.btnSmall, disabled: busy, onClick: () => openEdit(t) }, '编辑'),
                h('button', { style: css.btnSmall, disabled: busy, onClick: () => remove(t.id) }, '删除'),
              ),
            ),
            h('div', { style: { ...css.meta, marginTop: 6 } }, repeatLabel(t)),
            h('div', { style: { ...css.meta, marginTop: 2 } },
              '工作区：' + (t.workspaceId ? wsName(t.workspaceId) : '默认')
              + (t.cwd ? ' · ' + t.cwd : '')
              + (t.model ? ' · 模型 ' + t.model.provider + '/' + t.model.model : '')
              + (t.expertId ? ' · 专家 ' + t.expertId : '')),
            (toList(t.skills).length || toList(t.connectors).length) && h('div', { style: { ...css.meta, marginTop: 2 } },
              (toList(t.skills).length ? '技能：' + toList(t.skills).join('、') + ' ' : '')
              + (toList(t.connectors).length ? '连接器：' + toList(t.connectors).join('、') : '')),
            t.lastRunAt && h('div', { style: { ...css.meta, marginTop: 4 } },
              '上次运行 ' + fmtMs(t.lastRunAt) + ' · ' + (t.lastRunStatus === 'accepted' ? '已派发' : '失败')),
            h('div', { style: { ...css.meta, marginTop: 4, opacity: 0.85 } }, t.prompt),
          )),
          showRuns && h('div', null,
            h('h3', { style: { fontSize: 14, margin: '14px 0 8px' } }, '运行历史'),
            runs.length === 0 && h('div', { style: css.empty }, '暂无运行记录'),
            runs.map((r) => h('div', { key: r.id, style: { ...css.card, padding: 8 } },
              h('div', { style: css.row },
                h('span', { style: { ...css.badge, color: r.status === 'accepted' ? '#2e9e5b' : '#d5484c' } },
                  r.status === 'accepted' ? '已派发' : '失败'),
                h('strong', null, r.taskName || r.taskId),
                h('span', { style: css.meta }, fmtMs(r.startedAt))),
              r.error && h('div', { style: { ...css.error, marginTop: 4 } }, r.error),
              r.sessionId && h('div', { style: { ...css.meta, marginTop: 2 } }, '会话 ' + r.sessionId),
            ))),
        ),
      );
    }

    function field(label, control) {
      return h('label', { style: css.col },
        h('span', { style: css.label }, label),
        control);
    }

    // Multi-select chip picker. options: [{ value, label, hint? }]
    function PickList(props) {
      const options = props.options || [];
      const selected = props.selected || [];
      const [q, setQ] = useState('');
      const chosen = new Set(selected);
      const kw = q.trim().toLowerCase();
      const shown = kw
        ? options.filter((o) => (String(o.label) + ' ' + String(o.hint || '') + ' ' + String(o.value)).toLowerCase().includes(kw))
        : options;
      const header = h('div', { style: { ...css.row, justifyContent: 'space-between' } },
        h('span', { style: { fontSize: 11, opacity: 0.6 } },
          selected.length ? '已选 ' + selected.length + ' 项' : '未选'),
        selected.length
          ? h('button', { type: 'button', style: css.btnSmall, onClick: () => props.onChange([]) }, '清空')
          : null);
      if (!options.length) {
        return h('div', { style: { ...css.meta, padding: '2px 0' } }, props.emptyText || '（暂无可选项）');
      }
      return h('div', { style: css.col },
        header,
        options.length > 12 && h('input', {
          style: css.input,
          placeholder: '筛选…',
          value: q,
          onChange: (e) => setQ(e.target.value),
        }),
        h('div', { style: css.pickBox },
          shown.length === 0
            ? h('span', { style: { ...css.meta, padding: '2px 0' } }, '无匹配项')
            : shown.map((o) => h('button', {
              key: o.value,
              type: 'button',
              title: o.hint || o.value,
              style: chosen.has(o.value) ? css.chipOn : css.chipOff,
              onClick: () => props.onChange(toggleIn(selected, o.value)),
            }, (chosen.has(o.value) ? '✓ ' : '') + o.label))),
      );
    }

    function radio(value, text, form, set) {
      return h('label', { style: { ...css.row, cursor: 'pointer' } },
        h('input', { type: 'radio', name: 'repeat', checked: form.repeat === value, onChange: () => set({ repeat: value }) }),
        h('span', null, text));
    }

    function minToTime(m) {
      return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    }
    function timeToMin(t) {
      const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
      if (!m) return 540;
      return Math.min(1439, (+m[1]) * 60 + (+m[2]));
    }

    function modelPicker(form, set, catalog) {
      const providers = [];
      for (const m of catalog.models) {
        if (!providers.includes(m.provider)) providers.push(m.provider);
      }
      const current = form.model;
      const modelsOf = (p) => catalog.models.filter((m) => m.provider === p).map((m) => m.model);
      return h('div', { style: css.col },
        h('div', { style: css.row },
          h('select', {
            style: css.select,
            value: current ? current.provider : '',
            onChange: (e) => {
              const p = e.target.value;
              if (!p) { set({ model: null }); return; }
              const list = modelsOf(p);
              set({ model: { provider: p, model: list[0] || '' } });
            },
          },
            h('option', { value: '' }, '（默认模型）'),
            providers.map((p) => h('option', { key: p, value: p }, p))),
          current && h('select', {
            style: css.select,
            value: current.model,
            onChange: (e) => set({ model: { provider: current.provider, model: e.target.value } }),
          },
            modelsOf(current.provider).map((m) => h('option', { key: m, value: m }, m))),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 45, label: '定时任务',
        }, PanelIcon));
      },
    };
  },
});
