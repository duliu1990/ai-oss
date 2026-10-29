(() => {
  'use strict';

  const POLL_INTERVAL = 1200;
  const ACTIVE_STATUSES = new Set(['queued', 'analyzing', 'downloading', 'processing', 'uploading']);
  const STATUS_LABELS = {
    queued: '排队中', analyzing: '分析中', downloading: '下载中',
    processing: '处理中', uploading: '上传中', completed: '已完成', failed: '失败'
  };
  const STATUS_DETAILS = {
    queued: '等待本机服务处理', analyzing: '正在识别媒体内容',
    downloading: '正在下载源文件', processing: '正在转换或整理媒体',
    uploading: '正在上传到 OSS', completed: '任务已完成', failed: '任务未完成，请查看错误信息'
  };
  const KIND_LABELS = { audio: '音频', video: '视频', unknown: '待识别' };
  const byId = (id) => document.getElementById(id);
  const ui = {
    urlForm: byId('url-form'), url: byId('media-url'),
    analyze: byId('analyze-button'), analyzeLabel: byId('analyze-button-label'),
    analysisMessage: byId('analysis-message'), results: byId('analysis-results'),
    analysisTitle: byId('analysis-title'), analysisSource: byId('analysis-source'),
    analysisAi: byId('analysis-ai'), candidates: byId('candidate-list'),
    candidateEmpty: byId('candidate-empty'), audio: byId('mode-audio'),
    video: byId('mode-video'), modeHint: byId('mode-hint'), upload: byId('upload-oss'),
    uploadHint: byId('upload-hint'), delivery: byId('delivery-label'),
    create: byId('create-button'), createLabel: byId('create-button-label'),
    createHint: byId('create-hint'), refreshConfig: byId('refresh-config'),
    configStatus: byId('config-status'), configError: byId('config-error'),
    missingBox: byId('oss-missing-box'), missingList: byId('oss-missing-list'),
    ossOverview: byId('oss-overview'), ossDot: byId('oss-dot'),
    aiOverview: byId('ai-overview'), aiDot: byId('ai-dot'),
    retentionOverview: byId('retention-overview'), dependencyHint: byId('dependency-hint'),
    limitFile: byId('limit-file'), limitQueue: byId('limit-queue'),
    limitRetention: byId('limit-retention'), retentionNotice: byId('retention-notice'),
    taskList: byId('task-list'), taskEmpty: byId('task-empty'), taskCount: byId('task-count'),
    navTaskCount: byId('nav-task-count'), emptyTitle: byId('empty-title'),
    emptyDescription: byId('empty-description'), pollStatus: byId('poll-status'),
    pollLabel: byId('poll-status-label'), pollError: byId('poll-error'),
    refreshTasks: byId('refresh-tasks'), toast: byId('toast'),
    objectList: byId('object-list'), objectEmpty: byId('object-empty'), objectCount: byId('object-count'),
    navObjectCount: byId('nav-object-count'), objectEmptyTitle: byId('object-empty-title'),
    objectEmptyDescription: byId('object-empty-description'), objectError: byId('object-error'),
    storageStatus: byId('storage-status'), storageLabel: byId('storage-status-label'),
    refreshObjects: byId('refresh-objects'), loadMoreObjects: byId('load-more-objects')
  };
  const state = {
    config: null, configLoading: false, configLoadedOnce: false,
    analysis: null, analysisUrl: '', analysisEpoch: 0, analysisController: null,
    candidateId: null, analyzing: false, creating: false,
    tasks: new Map(), taskNodes: new Map(), taskBusy: new Map(), taskNotices: new Map(),
    signedLinks: new Map(), revisions: new Map(), revision: 0,
    polling: false, pollTimer: null, pollAgain: false, pollLoaded: false,
    pollError: '', toastTimer: null,
    objects: new Map(), objectNodes: new Map(), objectBusy: new Map(), objectNotices: new Map(),
    objectLinks: new Map(), objectsLoading: false, objectsLoaded: false, objectsError: '',
    objectsTruncated: false, objectsToken: '', objectsEpoch: 0, uploadedKeys: new Set(), catalogError: ''
  };

  function setText(node, value) {
    const next = String(value ?? '');
    if (node.textContent !== next) node.textContent = next;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) setText(node, text);
    return node;
  }

  function text(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value : fallback;
  }

  function identifier(value) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
  }

  function errorText(error) {
    return error instanceof Error ? error.message : '操作未完成，请稍后重试。';
  }

  function setNotice(node, message, type = '') {
    setText(node, message);
    node.className = `notice${type ? ` notice-${type}` : ''}`;
    node.hidden = !message;
  }

  function toast(message, isError = false) {
    window.clearTimeout(state.toastTimer);
    setText(ui.toast, message);
    ui.toast.classList.toggle('is-error', isError);
    ui.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => { ui.toast.hidden = true; }, 5500);
  }

  // Never accept protocol-relative URLs, script schemes, or arbitrary local routes.
  function safeLink(value) {
    if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
    const absolute = /^https?:\/\//i.test(value);
    const local = /^\/api\/tasks(?:\/|\?|$)/.test(value);
    if (!absolute && !local) return null;
    try {
      const parsed = new URL(value, window.location.origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      if (local && (parsed.origin !== window.location.origin || !/^\/api\/tasks(?:\/|$)/.test(parsed.pathname))) return null;
      return absolute ? parsed.href : `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return null;
    }
  }

  function setLink(anchor, value, enabled = true) {
    const href = enabled ? safeLink(value) : null;
    if (href) {
      if (anchor.getAttribute('href') !== href) anchor.setAttribute('href', href);
      anchor.removeAttribute('aria-disabled');
      anchor.removeAttribute('tabindex');
    } else {
      anchor.removeAttribute('href');
      anchor.setAttribute('aria-disabled', 'true');
      anchor.setAttribute('tabindex', '-1');
    }
    return Boolean(href);
  }

  function taskPath(id, suffix = '') {
    return `/api/tasks/${encodeURIComponent(id)}${suffix}`;
  }

  function validInputUrl(value) {
    if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/u.test(value)) return false;
    try {
      const parsed = new URL(value);
      return ['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }

  async function api(path, { method = 'GET', body, signal, timeout = 20000 } = {}) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    const headers = { Accept: 'application/json' };
    const options = { method, headers, signal: controller.signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error' };
    if (method !== 'GET') {
      headers['X-Media-Client'] = 'web';
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body ?? {});
    }
    try {
      const response = await fetch(path, options);
      let data;
      try {
        data = await response.json();
      } catch {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        throw new Error(response.ok ? '服务端返回的数据格式不正确。' : `请求失败（HTTP ${response.status}），请稍后重试。`);
      }
      if (!response.ok) throw new Error(text(data?.detail, `请求失败（HTTP ${response.status}）。`));
      return data;
    } catch (error) {
      if (timedOut) throw new Error('请求超时，结果尚未确认。请查看任务列表后再决定是否重试。');
      if (error?.name === 'AbortError') throw error;
      if (error instanceof TypeError) throw new Error('无法连接本机服务，请确认服务已启动；任务列表会继续自动重试。');
      throw error;
    } finally {
      window.clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }

  function selectedCandidate() {
    return state.analysis?.candidates.find((candidate) => candidate.id === state.candidateId) ?? null;
  }

  function updateControls() {
    const ready = state.config?.oss_ready === true;
    const candidate = selectedCandidate();
    const audioOnly = candidate?.kind === 'audio';
    if (audioOnly) ui.audio.checked = true;
    ui.url.readOnly = state.creating;
    ui.analyze.disabled = state.analyzing || state.creating || !ui.url.value.trim();
    ui.analyze.classList.toggle('is-loading', state.analyzing);
    ui.analyze.setAttribute('aria-busy', String(state.analyzing));
    setText(ui.analyzeLabel, state.analyzing ? '分析中' : '分析链接');
    ui.audio.disabled = state.creating;
    ui.video.disabled = state.creating || audioOnly;
    ui.modeHint.hidden = !audioOnly;
    ui.upload.disabled = !ready || state.configLoading || state.creating;
    if (!ready) ui.upload.checked = false;
    setText(ui.uploadHint, ready
      ? '本机保留一份文件，并上传至已配置的 OSS。'
      : state.configLoading ? '正在读取配置；暂时仅下载到本机。' : 'OSS 未就绪，当前仅下载；请查看环境配置。');
    setText(ui.delivery, ready && ui.upload.checked ? '本地 + OSS' : '仅下载');
    ui.create.disabled = state.creating || state.analyzing || state.configLoading || !candidate || state.analysisUrl !== ui.url.value.trim();
    ui.create.classList.toggle('is-loading', state.creating);
    ui.create.setAttribute('aria-busy', String(state.creating));
    setText(ui.createLabel, state.creating ? '正在创建' : '创建下载任务');
    for (const input of ui.candidates.querySelectorAll('input')) input.disabled = state.creating;
    let hint = '先分析链接，再创建下载任务。';
    if (state.analyzing) hint = '正在识别内容；修改链接会取消本次分析。';
    else if (state.creating) hint = '正在提交，请勿重复操作。';
    else if (candidate) hint = ready && ui.upload.checked ? '保存本地文件，并创建 OSS 副本。' : '仅下载到本机，不上传 OSS。';
    else if (state.analysis) hint = '没有可用候选，请尝试其他链接。';
    setText(ui.createHint, hint);
  }

  function displayConfig(config) {
    const ready = config?.oss_ready === true;
    setText(ui.ossOverview, config ? ready ? '配置已就绪' : '未配置 · 仅下载' : '配置状态未知');
    ui.ossDot.className = `small-dot ${config ? ready ? 'good' : 'warning' : 'neutral'}`;
    setText(ui.aiOverview, config ? config.ai_enabled ? '已启用' : '未启用 · 常规分析' : '配置状态未知');
    ui.aiDot.className = `small-dot ${config?.ai_enabled ? 'good' : 'neutral'}`;
    const missing = Array.isArray(config?.oss_missing) ? config.oss_missing.filter((name) => typeof name === 'string') : [];
    ui.missingList.replaceChildren();
    for (const name of missing) ui.missingList.append(element('li', '', name));
    if (config && !ready && !missing.length) ui.missingList.append(element('li', '', '服务端未提供缺失字段，请检查 .env。'));
    ui.missingBox.hidden = !config || ready;
    const missingDependencies = [];
    for (const name of ['ffmpeg', 'ffprobe', 'node']) {
      const available = config?.dependencies?.[name];
      const node = byId(`dep-${name}`);
      node.className = `dependency ${available === true ? 'good' : available === false ? 'warning' : 'neutral'}`;
      setText(node, `${name} · ${available === true ? '可用' : available === false ? '缺失' : '待确认'}`);
      if (available === false) missingDependencies.push(name);
    }
    setText(ui.dependencyHint, missingDependencies.length ? `缺少 ${missingDependencies.join('、')}，相关媒体处理可能失败；安装后重启服务。` : '依赖状态仅代表本机检测结果。');
    const limits = config?.limits;
    const known = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    setText(ui.limitFile, known(limits?.max_file_mb) ? `${limits.max_file_mb} MB` : '—');
    setText(ui.limitQueue, known(limits?.max_queue) ? `${limits.max_queue} 个任务` : '—');
    setText(ui.limitRetention, known(limits?.retention_hours) ? `${limits.retention_hours} 小时` : '—');
    setText(ui.retentionOverview, known(limits?.retention_hours) ? `${limits.retention_hours} 小时` : '等待配置');
    setText(ui.retentionNotice, known(limits?.retention_hours) ? `本地文件保留 ${limits.retention_hours} 小时后自动清理。` : '本地文件按服务端 retention 设置自动清理。');
    ui.configStatus.className = `config-status${!config ? ' is-error' : !ready || missingDependencies.length ? ' is-warning' : ''}`;
    setText(ui.configStatus, !config ? '配置读取失败，暂时禁用上传。' : ready ? 'OSS 配置已就绪，实际连接以任务结果为准。' : '仅下载模式可用，配置 OSS 后可启用上传。');
  }

  async function loadConfig() {
    if (state.configLoading) return;
    state.configLoading = true;
    ui.refreshConfig.disabled = true;
    setText(ui.refreshConfig, '读取中…');
    setNotice(ui.configError, '');
    updateControls();
    try {
      const config = await api('/api/config');
      if (!config || typeof config.oss_ready !== 'boolean' || typeof config.ai_enabled !== 'boolean' || !config.dependencies || !config.limits) {
        throw new Error('环境配置响应不完整，请检查本机服务。');
      }
      state.config = config;
      if (!state.configLoadedOnce) ui.upload.checked = config.oss_ready;
      state.configLoadedOnce = true;
      displayConfig(config);
    } catch (error) {
      state.config = null;
      displayConfig(null);
      setNotice(ui.configError, errorText(error), 'error');
    } finally {
      state.configLoading = false;
      ui.refreshConfig.disabled = false;
      setText(ui.refreshConfig, '重新读取');
      updateControls();
      renderTasks();
      renderObjects();
      if (state.config?.oss_ready === true && !state.objectsLoaded && !state.objectsLoading) void loadObjects();
    }
  }

  function invalidateAnalysis() {
    state.analysisEpoch += 1;
    state.analysisController?.abort();
    state.analysisController = null;
    state.analysis = null;
    state.analysisUrl = '';
    state.candidateId = null;
    state.analyzing = false;
    ui.results.hidden = true;
    ui.candidates.replaceChildren();
    ui.audio.checked = true;
    setNotice(ui.analysisMessage, '');
    updateControls();
  }

  function renderAnalysis() {
    const analysis = state.analysis;
    setText(ui.analysisTitle, analysis.title);
    setText(ui.analysisSource, `来源：${text(analysis.source, '未提供')} · ${analysis.candidates.length} 个候选`);
    setText(ui.analysisAi, analysis.ai_used === true ? 'AI 辅助分析' : '常规分析');
    ui.candidates.replaceChildren();
    for (const candidate of analysis.candidates) {
      const label = element('label', 'candidate');
      const input = element('input');
      input.type = 'radio';
      input.name = 'candidate';
      input.value = candidate.id;
      input.checked = candidate.id === state.candidateId;
      input.addEventListener('change', () => {
        if (!input.checked || state.creating) return;
        state.candidateId = candidate.id;
        updateControls();
      });
      label.append(input, element('span', 'candidate-title', candidate.title), element('span', 'candidate-kind', KIND_LABELS[candidate.kind]));
      ui.candidates.append(label);
    }
    ui.candidateEmpty.hidden = analysis.candidates.length > 0;
    ui.results.hidden = false;
    setNotice(ui.analysisMessage, text(analysis.warning), 'warning');
    updateControls();
  }

  async function analyze(event) {
    event.preventDefault();
    if (state.analyzing || state.creating) return;
    const url = ui.url.value.trim();
    invalidateAnalysis();
    if (!validInputUrl(url)) {
      setNotice(ui.analysisMessage, '请输入完整的 http / https 链接，不含空白或账号密码。', 'error');
      ui.url.focus();
      return;
    }
    const epoch = state.analysisEpoch;
    const controller = new AbortController();
    state.analysisController = controller;
    state.analysisUrl = url;
    state.analyzing = true;
    updateControls();
    setNotice(ui.analysisMessage, '正在识别媒体与候选内容，请稍候…');
    try {
      const result = await api('/api/analyze', { method: 'POST', body: { url }, signal: controller.signal, timeout: 120000 });
      if (epoch !== state.analysisEpoch || url !== ui.url.value.trim()) return;
      const analysisId = identifier(result?.analysis_id);
      if (!analysisId || !Array.isArray(result.candidates)) throw new Error('分析响应不完整，请重新分析链接。');
      const candidates = [];
      const seen = new Set();
      for (const item of result.candidates) {
        const id = identifier(item?.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        candidates.push({
          id, title: text(item.title, `候选 ${candidates.length + 1}`),
          kind: Object.hasOwn(KIND_LABELS, item.kind) ? item.kind : 'unknown'
        });
      }
      state.analysis = { ...result, analysis_id: analysisId, title: text(result.title, new URL(url).hostname), candidates };
      state.candidateId = candidates[0]?.id ?? null;
      renderAnalysis();
    } catch (error) {
      if (epoch === state.analysisEpoch && error?.name !== 'AbortError') setNotice(ui.analysisMessage, errorText(error), 'error');
    } finally {
      if (epoch === state.analysisEpoch) {
        state.analyzing = false;
        state.analysisController = null;
        updateControls();
      }
    }
  }

  function normalizeTask(value) {
    const id = identifier(value?.id);
    if (!id) throw new Error('服务端返回的任务缺少有效 ID。');
    return { ...value, id };
  }

  function rememberTask(value) {
    const task = normalizeTask(value);
    state.tasks.set(task.id, task);
    state.revisions.set(task.id, ++state.revision);
    renderTasks();
    return task;
  }

  async function createTask() {
    if (state.creating || state.analyzing || state.configLoading) return;
    if (state.analysisUrl !== ui.url.value.trim()) {
      invalidateAnalysis();
      setNotice(ui.analysisMessage, '链接已变化，请重新分析后再创建任务。', 'warning');
      return;
    }
    const candidate = selectedCandidate();
    if (!state.analysis || !candidate) return;
    const body = {
      analysis_id: state.analysis.analysis_id, candidate_id: candidate.id,
      mode: candidate.kind === 'audio' || ui.audio.checked ? 'audio' : 'video',
      upload: state.config?.oss_ready === true && ui.upload.checked
    };
    state.creating = true;
    updateControls();
    try {
      rememberTask(await api('/api/tasks', { method: 'POST', body }));
      toast('任务已创建，请在下方查看状态。');
      setNotice(ui.analysisMessage, text(state.analysis?.warning), 'warning');
      requestPoll();
    } catch (error) {
      setNotice(ui.analysisMessage, errorText(error), 'error');
      requestPoll();
    } finally {
      state.creating = false;
      updateControls();
    }
  }

  const dateFormatter = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

  function formatDate(value) {
    const time = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? dateFormatter.format(new Date(time)) : '时间未知';
  }

  function formatSize(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '';
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(2)} GB`;
  }

  function formatDuration(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
    const total = Math.round(value);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
  }

  function makeTaskNode(id) {
    const root = element('article', 'task-card');
    const top = element('div', 'task-top');
    const icon = element('span', 'task-media-icon');
    icon.setAttribute('aria-hidden', 'true');
    const info = element('div', 'task-info');
    const title = element('h3', 'task-title');
    const meta = element('p', 'task-meta');
    const status = element('span', 'task-status');
    info.append(title, meta);
    top.append(icon, info, status);
    const progressRow = element('div', 'task-progress-row');
    const progressLabel = element('span');
    const progressValue = element('span', 'task-progress-value');
    progressRow.append(progressLabel, progressValue);
    const progress = element('progress', 'task-progress');
    progress.max = 100;
    const file = element('p', 'task-file');
    const objectKey = element('p', 'task-file');
    const error = element('p', 'task-error');
    const actions = element('div', 'task-actions');
    const download = element('a', 'button button-small button-outline', '下载文件 ↓');
    download.setAttribute('download', '');
    const localNote = element('span', 'task-local-note');
    const signed = element('a', 'button button-small button-outline', '签名访问 ↗');
    signed.target = '_blank';
    signed.rel = 'noopener noreferrer';
    signed.referrerPolicy = 'no-referrer';
    const refresh = element('button', 'button button-small button-outline', '生成访问链接');
    refresh.type = 'button';
    refresh.addEventListener('click', () => taskAction(id, 'signed'));
    const retry = element('button', 'button button-small button-outline', '重试上传');
    retry.type = 'button';
    retry.addEventListener('click', () => taskAction(id, 'retry'));
    actions.append(download, localNote, signed, refresh, retry);
    const expiry = element('p', 'task-expiry');
    const notice = element('p', 'task-notice');
    notice.setAttribute('role', 'status');
    root.append(top, progressRow, progress, file, objectKey, error, actions, expiry, notice);
    return { root, icon, title, meta, status, progressLabel, progressValue, progress, file, objectKey, error, download, localNote, signed, refresh, retry, expiry, notice };
  }

  function updateTaskNode(task, nodes) {
    const status = Object.hasOwn(STATUS_LABELS, task.status) ? task.status : 'unknown';
    const active = ACTIVE_STATUSES.has(status);
    const busy = state.taskBusy.get(task.id);
    nodes.root.classList.toggle('is-failed', status === 'failed');
    setText(nodes.icon, task.mode === 'audio' ? '♫' : '▷');
    setText(nodes.title, text(task.title, text(task.filename, '未命名任务')));
    const mode = task.mode === 'audio' ? 'MP3 音频' : task.mode === 'video' ? '视频' : '格式未知';
    setText(nodes.meta, `${mode} · ${task.upload ? '本地 + OSS' : '仅下载'} · ${formatDate(task.created_at)}`);
    nodes.status.className = `task-status ${status}`;
    setText(nodes.status, STATUS_LABELS[status] ?? '状态未知');
    setText(nodes.progressLabel, STATUS_DETAILS[status] ?? '等待服务端状态');
    const progressKnown = typeof task.progress === 'number' && Number.isFinite(task.progress) && task.progress >= 0 && task.progress <= 100;
    setText(nodes.progressValue, progressKnown ? `${Math.round(task.progress * 10) / 10}%` : active ? '进度未知' : '—');
    nodes.progress.setAttribute('aria-label', `${text(task.title, '下载任务')}：${STATUS_LABELS[status] ?? '状态未知'}`);
    if (progressKnown) {
      if (nodes.progress.getAttribute('value') !== String(task.progress)) nodes.progress.value = task.progress;
      nodes.progress.setAttribute('aria-valuetext', `${task.progress}%`);
    } else {
      nodes.progress.removeAttribute('value');
      nodes.progress.setAttribute('aria-valuetext', '服务端尚未提供进度');
    }
    nodes.progress.hidden = !active && !progressKnown;
    const fileParts = [text(task.filename), formatSize(task.size)].filter(Boolean);
    setText(nodes.file, fileParts.join(' · '));
    nodes.file.hidden = fileParts.length === 0;
    setText(nodes.objectKey, task.object_key ? `OSS 对象：${task.object_key}` : '');
    nodes.objectKey.hidden = !task.object_key;
    setText(nodes.error, text(task.error));
    nodes.error.hidden = !text(task.error);

    const localAvailable = task.local_available === true;
    nodes.download.hidden = !localAvailable;
    setLink(nodes.download, taskPath(task.id, '/file'), localAvailable);
    nodes.localNote.hidden = localAvailable;
    setText(nodes.localNote, active ? '文件生成后可下载' : '本地文件不可用（可能已清理）');

    const cachedLink = state.signedLinks.get(task.id);
    const link = cachedLink ?? { signed_url: task.signed_url, expires_at: task.expires_at };
    const rawLink = text(link.signed_url);
    const safe = safeLink(rawLink);
    const expiresAt = typeof link.expires_at === 'string' ? Date.parse(link.expires_at) : NaN;
    const expired = Number.isFinite(expiresAt) && expiresAt <= Date.now();
    const hasObject = Boolean(text(task.object_key));
    const canSign = hasObject || Boolean(rawLink);
    nodes.signed.hidden = !rawLink;
    setLink(nodes.signed, rawLink, !expired);
    setText(nodes.signed, expired ? '签名已过期' : !safe && rawLink ? '链接已拦截' : '签名访问 ↗');
    nodes.refresh.hidden = !canSign;
    nodes.refresh.disabled = Boolean(busy) || state.config?.oss_ready !== true || state.configLoading;
    nodes.refresh.title = state.config?.oss_ready === true ? '生成新的临时访问链接' : '请先确认 OSS 环境配置';
    setText(nodes.refresh, busy === 'signed' ? '生成中…' : rawLink ? '刷新链接' : '生成访问链接');
    nodes.refresh.setAttribute('aria-busy', String(busy === 'signed'));
    nodes.retry.hidden = task.can_retry_upload !== true;
    nodes.retry.disabled = Boolean(busy) || state.config?.oss_ready !== true || state.configLoading;
    nodes.retry.title = state.config?.oss_ready === true ? '重新上传已有本地文件' : '请先配置 OSS 并重启服务';
    setText(nodes.retry, busy === 'retry' ? '提交中…' : '重试上传');
    nodes.retry.setAttribute('aria-busy', String(busy === 'retry'));
    let expiryText = '';
    if (rawLink && !safe) expiryText = '服务端返回的链接不符合安全规则，已禁止访问。';
    else if (expired) expiryText = '签名链接已过期，请刷新后访问。';
    else if (rawLink) expiryText = Number.isFinite(expiresAt) ? `签名有效至 ${formatDate(link.expires_at)}（本机时间）` : '签名有效期未提供，请以服务端设置为准。';
    else if (hasObject) expiryText = 'OSS 文件已记录；生成签名链接后可临时访问。';
    if (canSign && state.config?.oss_ready !== true) expiryText += ' 环境配置未就绪，暂时无法生成或刷新链接。';
    setText(nodes.expiry, expiryText);
    nodes.expiry.hidden = !expiryText;
    nodes.expiry.classList.toggle('expired', expired || Boolean(rawLink && !safe));
    const notice = state.taskNotices.get(task.id) ?? '';
    setText(nodes.notice, notice);
    nodes.notice.hidden = !notice;
  }

  function renderTasks() {
    const tasks = Array.from(state.tasks.values()).sort((a, b) => {
      const difference = (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0);
      return difference || a.id.localeCompare(b.id);
    });
    // Patch stable nodes instead of replacing the list: keep keyboard focus during polling.
    for (const [id, nodes] of state.taskNodes) {
      if (!state.tasks.has(id)) {
        nodes.root.remove();
        state.taskNodes.delete(id);
        state.taskNotices.delete(id);
        state.signedLinks.delete(id);
      }
    }
    tasks.forEach((task, index) => {
      let nodes = state.taskNodes.get(task.id);
      if (!nodes) {
        nodes = makeTaskNode(task.id);
        state.taskNodes.set(task.id, nodes);
      }
      updateTaskNode(task, nodes);
      if (ui.taskList.children[index] !== nodes.root) ui.taskList.insertBefore(nodes.root, ui.taskList.children[index] ?? null);
    });
    const active = tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length;
    setText(ui.taskCount, tasks.length);
    setText(ui.navTaskCount, active || tasks.length);
    ui.taskEmpty.hidden = tasks.length > 0;
    if (state.pollError) {
      setText(ui.emptyTitle, '任务列表暂不可用');
      setText(ui.emptyDescription, '连接恢复后会自动更新，请勿因网络错误重复提交任务。');
    } else if (state.pollLoaded) {
      setText(ui.emptyTitle, '还没有下载任务');
      setText(ui.emptyDescription, '从上方粘贴一个链接开始。仅显示本次服务启动后创建的任务。');
    } else {
      setText(ui.emptyTitle, '正在读取任务');
      setText(ui.emptyDescription, '稍等片刻，获取本次服务运行的任务列表。');
    }
  }

  async function taskAction(id, action) {
    if (state.taskBusy.has(id) || state.config?.oss_ready !== true || state.configLoading) return;
    const task = state.tasks.get(id);
    if (!task || (action === 'retry' && task.can_retry_upload !== true)) return;
    state.taskBusy.set(id, action);
    state.taskNotices.delete(id);
    renderTasks();
    try {
      if (action === 'retry') {
        const result = normalizeTask(await api(taskPath(id, '/retry-upload'), { method: 'POST' }));
        if (result.id !== id) throw new Error('返回的任务 ID 不匹配，请刷新任务列表。');
        state.signedLinks.delete(id);
        rememberTask(result);
        toast('重试上传请求已提交，请查看任务状态。');
      } else {
        const result = await api(taskPath(id, '/signed-url'), { method: 'POST' });
        if (!safeLink(result?.signed_url)) throw new Error('返回的签名链接不符合安全规则，已禁止访问。');
        state.signedLinks.set(id, { signed_url: result.signed_url, expires_at: result.expires_at ?? null });
        state.revisions.set(id, ++state.revision);
        toast('访问链接已更新，请使用“签名访问”。');
      }
      requestPoll();
    } catch (error) {
      state.taskNotices.set(id, errorText(error));
      toast(errorText(error), true);
      requestPoll();
    } finally {
      state.taskBusy.delete(id);
      renderTasks();
    }
  }

  function mergeTaskList(values, requestedAtRevision) {
    const next = new Map();
    for (const value of values) {
      const task = normalizeTask(value);
      // A list request started before a mutation must not overwrite that mutation's result.
      const locallyNewer = (state.revisions.get(task.id) ?? 0) > requestedAtRevision;
      next.set(task.id, locallyNewer && state.tasks.has(task.id) ? state.tasks.get(task.id) : task);
    }
    for (const [id, task] of state.tasks) {
      if (!next.has(id) && (state.revisions.get(id) ?? 0) > requestedAtRevision) next.set(id, task);
    }
    state.tasks = next;
    for (const id of state.revisions.keys()) if (!next.has(id)) state.revisions.delete(id);
  }

  function requestPoll() {
    window.clearTimeout(state.pollTimer);
    if (state.polling) {
      state.pollAgain = true;
      return;
    }
    void pollTasks();
  }

  async function pollTasks() {
    if (state.polling) return;
    state.polling = true;
    const requestedAtRevision = state.revision;
    ui.refreshTasks.disabled = true;
    setText(ui.refreshTasks, '刷新中…');
    if (!state.pollLoaded) ui.taskList.setAttribute('aria-busy', 'true');
    try {
      const result = await api('/api/tasks', { timeout: 15000 });
      if (!Array.isArray(result?.tasks)) throw new Error('任务列表响应不完整，将自动重试。');
      mergeTaskList(result.tasks, requestedAtRevision);
      state.pollLoaded = true;
      state.pollError = '';
      setNotice(ui.pollError, '');
      ui.pollStatus.classList.remove('is-error');
      setText(ui.pollLabel, '每 1.2 秒自动更新');
      noticeNewUploads();
    } catch (error) {
      state.pollError = errorText(error);
      setNotice(ui.pollError, `${state.pollError}\n保留当前列表，稍后自动重试。`, 'error');
      ui.pollStatus.classList.add('is-error');
      setText(ui.pollLabel, '连接中断 · 自动重试中');
    } finally {
      state.polling = false;
      ui.refreshTasks.disabled = false;
      setText(ui.refreshTasks, '立即刷新');
      ui.taskList.setAttribute('aria-busy', 'false');
      // Reschedule even after failure; never use setInterval with an async request.
      const delay = state.pollAgain ? 0 : POLL_INTERVAL;
      state.pollAgain = false;
      window.clearTimeout(state.pollTimer);
      state.pollTimer = window.setTimeout(() => { void pollTasks(); }, delay);
      renderTasks();
    }
  }

  // Refresh the uploaded list once when a task's object first appears, not on every poll.
  function noticeNewUploads() {
    let fresh = false;
    for (const task of state.tasks.values()) {
      const key = text(task.object_key);
      if (key && !state.uploadedKeys.has(key)) {
        state.uploadedKeys.add(key);
        if (state.objectsLoaded && !state.objects.has(key)) fresh = true;
      }
    }
    if (fresh && !state.objectsLoading) void loadObjects();
  }

  function normalizeObject(value) {
    const key = text(value?.key);
    if (!key) return null;
    // Descriptive fields come from catalog.json; objects uploaded before it existed have none.
    const info = value.info && typeof value.info === 'object' ? value.info : {};
    return {
      key, name: text(value.name, key),
      size: typeof value.size === 'number' ? value.size : null,
      last_modified: typeof value.last_modified === 'string' ? value.last_modified : null,
      kind: value.kind === 'audio' || value.kind === 'video' ? value.kind : 'other',
      title: text(info.title), artist: text(info.artist), source: text(info.source),
      source_host: text(info.source_host),
      duration: typeof info.duration === 'number' ? info.duration : null,
      uploaded_at: typeof info.uploaded_at === 'string' ? info.uploaded_at : null
    };
  }

  async function loadObjects(more = false) {
    if (state.objectsLoading || state.config?.oss_ready !== true) return;
    if (more && (!state.objectsTruncated || !state.objectsToken)) return;
    const epoch = ++state.objectsEpoch;
    state.objectsLoading = true;
    renderObjects();
    try {
      const query = more ? `?token=${encodeURIComponent(state.objectsToken)}` : '';
      const result = await api(`/api/objects${query}`, { timeout: 30000 });
      if (epoch !== state.objectsEpoch) return;
      if (!Array.isArray(result?.objects)) throw new Error('已上传文件列表响应不完整，请稍后刷新。');
      if (!more) {
        state.objects = new Map();
        state.objectLinks.clear();
      }
      state.catalogError = text(result.catalog_error);
      for (const item of result.objects) {
        const object = normalizeObject(item);
        if (object) state.objects.set(object.key, object);
      }
      state.objectsTruncated = result.truncated === true && Boolean(text(result.next_token));
      state.objectsToken = state.objectsTruncated ? result.next_token : '';
      state.objectsLoaded = true;
      state.objectsError = '';
    } catch (error) {
      if (epoch !== state.objectsEpoch) return;
      state.objectsError = errorText(error);
    } finally {
      if (epoch === state.objectsEpoch) {
        state.objectsLoading = false;
        renderObjects();
      }
    }
  }

  function makeObjectNode(key) {
    const root = element('article', 'task-card object-card');
    const top = element('div', 'task-top');
    const icon = element('span', 'task-media-icon');
    icon.setAttribute('aria-hidden', 'true');
    const info = element('div', 'task-info');
    const title = element('h3', 'task-title');
    const meta = element('p', 'task-meta');
    const kind = element('span', 'task-status');
    info.append(title, meta);
    top.append(icon, info, kind);
    const source = element('p', 'task-file');
    const objectKey = element('p', 'task-file');
    const actions = element('div', 'task-actions');
    const signed = element('a', 'button button-small button-outline', '签名访问 ↗');
    signed.target = '_blank';
    signed.rel = 'noopener noreferrer';
    signed.referrerPolicy = 'no-referrer';
    const refresh = element('button', 'button button-small button-outline', '生成访问链接');
    refresh.type = 'button';
    refresh.addEventListener('click', () => signObject(key));
    const remove = element('button', 'button button-small button-outline button-danger', '删除');
    remove.type = 'button';
    remove.addEventListener('click', () => deleteObject(key));
    actions.append(signed, refresh, remove);
    const expiry = element('p', 'task-expiry');
    const notice = element('p', 'task-notice');
    notice.setAttribute('role', 'status');
    root.append(top, source, objectKey, actions, expiry, notice);
    return { root, icon, title, meta, kind, source, objectKey, signed, refresh, remove, expiry, notice };
  }

  function updateObjectNode(object, nodes) {
    const busy = state.objectBusy.get(object.key);
    const ready = state.config?.oss_ready === true && !state.configLoading;
    setText(nodes.icon, object.kind === 'audio' ? '♫' : object.kind === 'video' ? '▷' : '□');
    setText(nodes.title, object.title || object.name);
    nodes.title.title = object.title ? `文件名：${object.name}` : '';
    const uploaded = object.uploaded_at || object.last_modified;
    const parts = [object.artist, formatDuration(object.duration), formatSize(object.size), uploaded ? `上传于 ${formatDate(uploaded)}` : ''].filter(Boolean);
    setText(nodes.meta, parts.join(' · ') || '元数据未提供');
    const origin = [object.source, object.source_host].filter(Boolean).join(' · ');
    setText(nodes.source, origin ? `来源：${origin}` : '');
    nodes.source.hidden = !origin;
    nodes.kind.className = `task-status ${object.kind === 'other' ? '' : 'completed'}`.trim();
    setText(nodes.kind, KIND_LABELS[object.kind] ?? '其他文件');
    setText(nodes.objectKey, `OSS 对象：${object.key}`);
    const link = state.objectLinks.get(object.key);
    const rawLink = text(link?.signed_url);
    const safe = safeLink(rawLink);
    const expiresAt = typeof link?.expires_at === 'string' ? Date.parse(link.expires_at) : NaN;
    const expired = Number.isFinite(expiresAt) && expiresAt <= Date.now();
    nodes.signed.hidden = !rawLink;
    setLink(nodes.signed, rawLink, !expired);
    setText(nodes.signed, expired ? '签名已过期' : !safe && rawLink ? '链接已拦截' : '签名访问 ↗');
    nodes.refresh.disabled = Boolean(busy) || !ready;
    nodes.refresh.title = ready ? '生成新的临时访问链接' : '请先确认 OSS 环境配置';
    setText(nodes.refresh, busy === 'sign' ? '生成中…' : rawLink ? '刷新链接' : '生成访问链接');
    nodes.refresh.setAttribute('aria-busy', String(busy === 'sign'));
    nodes.remove.disabled = Boolean(busy) || !ready;
    nodes.remove.title = ready ? '从 OSS 删除此文件，并移除 catalog.json 中的记录' : '请先确认 OSS 环境配置';
    setText(nodes.remove, busy === 'delete' ? '删除中…' : '删除');
    nodes.remove.setAttribute('aria-busy', String(busy === 'delete'));
    let expiryText = '';
    if (rawLink && !safe) expiryText = '服务端返回的链接不符合安全规则，已禁止访问。';
    else if (expired) expiryText = '签名链接已过期，请刷新后访问。';
    else if (rawLink) expiryText = Number.isFinite(expiresAt) ? `签名有效至 ${formatDate(link.expires_at)}（本机时间）` : '签名有效期未提供，请以服务端设置为准。';
    setText(nodes.expiry, expiryText);
    nodes.expiry.hidden = !expiryText;
    nodes.expiry.classList.toggle('expired', expired || Boolean(rawLink && !safe));
    const notice = state.objectNotices.get(object.key) ?? '';
    setText(nodes.notice, notice);
    nodes.notice.hidden = !notice;
  }

  function renderObjects() {
    const ready = state.config?.oss_ready === true;
    const objects = Array.from(state.objects.values()).sort((a, b) => {
      const difference = (Date.parse(b.last_modified) || 0) - (Date.parse(a.last_modified) || 0);
      return difference || a.key.localeCompare(b.key);
    });
    for (const [key, nodes] of state.objectNodes) {
      if (!state.objects.has(key)) {
        nodes.root.remove();
        state.objectNodes.delete(key);
        state.objectNotices.delete(key);
        state.objectLinks.delete(key);
      }
    }
    objects.forEach((object, index) => {
      let nodes = state.objectNodes.get(object.key);
      if (!nodes) {
        nodes = makeObjectNode(object.key);
        state.objectNodes.set(object.key, nodes);
      }
      updateObjectNode(object, nodes);
      if (ui.objectList.children[index] !== nodes.root) ui.objectList.insertBefore(nodes.root, ui.objectList.children[index] ?? null);
    });
    const countText = state.objectsLoaded ? `${objects.length}${state.objectsTruncated ? '+' : ''}` : '—';
    setText(ui.objectCount, countText);
    setText(ui.navObjectCount, countText);
    ui.objectList.setAttribute('aria-busy', String(state.objectsLoading));
    ui.refreshObjects.disabled = !ready || state.objectsLoading || state.configLoading;
    setText(ui.refreshObjects, state.objectsLoading ? '读取中…' : '刷新列表');
    ui.loadMoreObjects.hidden = !state.objectsLoaded || !state.objectsTruncated;
    ui.loadMoreObjects.disabled = state.objectsLoading || !ready;
    setText(ui.loadMoreObjects, state.objectsLoading ? '读取中…' : '加载更多');
    if (state.objectsError) setNotice(ui.objectError, state.objectsError, 'error');
    else setNotice(ui.objectError, state.catalogError, 'warning');
    ui.storageStatus.classList.toggle('is-error', Boolean(state.objectsError));
    setText(ui.storageLabel, !ready ? 'OSS 未就绪' : state.objectsLoading ? '正在读取…' : state.objectsError ? '读取失败' : state.objectsLoaded ? '来自 OSS 列表 + catalog.json' : '等待读取');
    ui.objectEmpty.hidden = objects.length > 0;
    if (!ready) {
      setText(ui.objectEmptyTitle, state.config ? 'OSS 尚未配置' : '等待读取配置');
      setText(ui.objectEmptyDescription, state.config ? '在 .env 中配置 OSS 并重启服务后，这里会列出已上传文件。' : 'OSS 配置就绪后自动读取已上传文件。');
    } else if (state.objectsError && !state.objectsLoaded) {
      setText(ui.objectEmptyTitle, '已上传列表暂不可用');
      setText(ui.objectEmptyDescription, '请检查 OSS 凭据是否具有 ListObjects 权限，稍后点击“刷新列表”。');
    } else if (state.objectsLoaded) {
      setText(ui.objectEmptyTitle, '还没有已上传文件');
      setText(ui.objectEmptyDescription, '勾选“同时上传到 OSS”并完成任务后，文件会出现在这里。');
    } else {
      setText(ui.objectEmptyTitle, '正在读取已上传文件');
      setText(ui.objectEmptyDescription, '稍等片刻，正在从 OSS 获取对象列表。');
    }
  }

  async function signObject(key) {
    if (state.objectBusy.has(key) || state.config?.oss_ready !== true || state.configLoading || !state.objects.has(key)) return;
    state.objectBusy.set(key, 'sign');
    state.objectNotices.delete(key);
    renderObjects();
    try {
      const result = await api('/api/objects/signed-url', { method: 'POST', body: { key } });
      if (!safeLink(result?.signed_url)) throw new Error('返回的签名链接不符合安全规则，已禁止访问。');
      state.objectLinks.set(key, { signed_url: result.signed_url, expires_at: result.expires_at ?? null });
      toast('访问链接已更新，请使用“签名访问”。');
    } catch (error) {
      state.objectNotices.set(key, errorText(error));
      toast(errorText(error), true);
    } finally {
      state.objectBusy.delete(key);
      renderObjects();
    }
  }

  async function deleteObject(key) {
    const object = state.objects.get(key);
    if (!object || state.objectBusy.has(key) || state.config?.oss_ready !== true || state.configLoading) return;
    const label = object.title ? `《${object.title}》（${object.name}）` : object.name;
    if (!window.confirm(`确定从 OSS 删除 ${label} 吗？\n\n删除后无法恢复，catalog.json 中的曲目信息也会一并移除。`)) return;
    state.objectBusy.set(key, 'delete');
    state.objectNotices.delete(key);
    renderObjects();
    try {
      const result = await api('/api/objects/delete', { method: 'POST', body: { key }, timeout: 30000 });
      state.objects.delete(key);
      state.objectLinks.delete(key);
      state.uploadedKeys.delete(key);
      // Tasks that uploaded this object no longer have it; drop their cached links until the next poll.
      for (const task of state.tasks.values()) {
        if (task.object_key === key) {
          task.object_key = null;
          task.signed_url = null;
          task.expires_at = null;
          state.signedLinks.delete(task.id);
        }
      }
      const warning = text(result?.warning);
      const done = result?.catalog === true ? '已删除，并已从 catalog.json 移除记录。' : '已删除（catalog.json 中没有该文件的记录）。';
      toast(warning || done, Boolean(warning));
      requestPoll();
    } catch (error) {
      state.objectNotices.set(key, errorText(error));
      toast(errorText(error), true);
    } finally {
      state.objectBusy.delete(key);
      renderObjects();
    }
  }

  ui.urlForm.addEventListener('submit', analyze);
  ui.url.addEventListener('input', invalidateAnalysis);
  ui.url.addEventListener('change', () => {
    if (state.analysisUrl && state.analysisUrl !== ui.url.value.trim()) invalidateAnalysis();
    else updateControls();
  });
  ui.audio.addEventListener('change', updateControls);
  ui.video.addEventListener('change', updateControls);
  ui.upload.addEventListener('change', updateControls);
  ui.create.addEventListener('click', createTask);
  ui.refreshConfig.addEventListener('click', loadConfig);
  ui.refreshTasks.addEventListener('click', requestPoll);
  ui.refreshObjects.addEventListener('click', () => { void loadObjects(); });
  ui.loadMoreObjects.addEventListener('click', () => { void loadObjects(true); });
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach((item) => item.classList.toggle('is-active', item === link));
    });
  });

  updateControls();
  renderObjects();
  void loadConfig();
  requestPoll();
})();
