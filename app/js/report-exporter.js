export class ReportExporter {
  constructor({ moduleVersion = '', maintainer = 'Codex', changeNote = '' } = {}) {
    this.moduleVersion = moduleVersion;
    this.maintainer = maintainer;
    this.changeNote = changeNote;
    this.turns = new Map();
    this.installCapture();
    this.ensureChangeLog();
  }

  ensureChangeLog() {
    const changes = this.getChangeLog();
    const upsert = (entry) => {
      const existingIndex = changes.findIndex(item => item.id === entry.id);
      if (existingIndex >= 0) changes[existingIndex] = { ...changes[existingIndex], ...entry, at: changes[existingIndex].at || entry.at };
      else changes.unshift(entry);
    };
    upsert({
      id: 'codex-20260530-report-tools',
      at: new Date().toISOString(),
      actor: this.maintainer,
      tool: 'Codex',
      scope: '상권 AI / 관리자 페이지',
      method: '정적 로컬 앱에 답변별 일반 인쇄, 관리용 인쇄, HTML 저장, 오류 신고, 관리자 보고서 페이지와 수동 수정 이력 등록 폼을 추가했습니다.',
      files: ['app/js/report-exporter.js', 'app/admin-reports.html', 'app/js/chat-ui.js', 'app/js/main.js', 'app/css/styles.css', 'app/index.html'],
      verification: ['JS module import/check 통과', '브라우저 스모크 테스트 통과', '관리자 페이지 로드 확인'],
      note: this.changeNote || '오류 신고는 자동 외부 전송 대신 localStorage와 HTML/JSON 내보내기로 Codex/Claude/Gemini가 확인할 수 있게 구성했습니다.',
    });
    upsert({
      id: 'codex-20260530-data-codebook',
      at: new Date().toISOString(),
      actor: this.maintainer,
      tool: 'Codex',
      scope: '데이터 코드 / 업종 코드북',
      method: '한글 표시 라벨과 내부 식별자를 분리하기 위해 app/data/codebook.json을 추가하고 DataLoader와 ToolDispatcher가 ASCII 업종 코드(ind_0001)를 한글 업종명으로 해석하도록 연결했습니다.',
      files: ['app/data/codebook.json', 'app/js/data-loader.js', 'app/js/tool-dispatcher.js', 'app/js/report-exporter.js', 'app/admin-reports.html', 'app/docs/data-codebook.md'],
      verification: ['codebook ASCII 코드 검증', 'JS syntax check 통과 예정'],
      note: '표시 텍스트는 한글을 유지하고, 저장 키/파일명/업종 코드 같은 기계 처리 값은 영문과 숫자 중심으로 고정했습니다.',
    });
    localStorage.setItem('commercial_ai_change_log', JSON.stringify(changes.slice(0, 100)));
  }

  startTurn(handle, question) {
    if (!handle?.turnId) return;
    this.turns.set(handle.turnId, { turnId: handle.turnId, question: String(question || ''), startedAt: new Date().toISOString() });
  }

  recordError(handle, error, extra = {}) {
    const message = error?.message || String(error || 'Unknown error');
    const turnId = handle?.turnId || extra.turnId || '';
    this.capture({ level: 'error', source: 'app', turnId, message, stack: error?.stack || '', extra });
    if (turnId && this.turns.has(turnId)) {
      this.turns.set(turnId, { ...this.turns.get(turnId), error: { message, stack: error?.stack || '', extra, at: new Date().toISOString() } });
    }
  }

  handleAction({ action, turnId }) {
    if (!turnId) return;
    if (action === 'print-user') return this.print(turnId, 'user');
    if (action === 'print-admin') return this.print(turnId, 'admin');
    if (action === 'save-html') return this.downloadHtml(turnId, 'user');
    if (action === 'report-error') return this.reportError(turnId);
  }

  reportError(turnId) {
    const report = this.buildAdminReport(turnId, { userReported: true });
    const reports = this.getReports();
    reports.unshift(report);
    localStorage.setItem('commercial_ai_error_reports', JSON.stringify(reports.slice(0, 50)));
    this.downloadHtml(turnId, 'admin', { userReported: true });
    alert('오류 신고 보고서를 저장했습니다. 관리자 페이지에서 다시 볼 수 있습니다.');
  }

  print(turnId, mode) {
    const html = this.buildHtml(turnId, mode);
    const win = window.open('', '_blank', 'noopener,noreferrer,width=980,height=720');
    if (!win) return this.downloadHtml(turnId, mode);
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 450);
  }

  downloadHtml(turnId, mode = 'user', options = {}) {
    const html = this.buildHtml(turnId, mode, options);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `commercial-ai-${mode === 'admin' ? 'admin' : 'user'}-report-${this.fileTime()}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  buildHtml(turnId, mode = 'user', options = {}) {
    const row = document.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
    const report = mode === 'admin' ? this.buildAdminReport(turnId, options) : null;
    const question = report?.question || this.findQuestion(row) || '(질문 없음)';
    const title = mode === 'admin' ? '상권AI 관리용 점검 보고서' : '상권AI 분석 결과';
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${this.esc(title)}</title><style>${this.collectCss()}</style><style>${this.reportCss()}</style></head><body><main class="print-report print-report--${mode}"><header class="print-report-header"><div><p class="print-kicker">${mode === 'admin' ? '관리용' : '일반용'}</p><h1>${this.esc(title)}</h1></div><dl><div><dt>생성 시각</dt><dd>${this.esc(new Date().toLocaleString('ko-KR'))}</dd></div><div><dt>모듈</dt><dd>${this.esc(this.moduleVersion || document.documentElement.dataset.aiModuleVersion || '-')}</dd></div></dl></header><section class="print-question"><h2>질문</h2><p>${this.esc(question)}</p></section><section class="print-content">${this.turnHtml(row, mode) || '<p>출력할 답변이 없습니다.</p>'}</section>${mode === 'admin' ? this.adminHtml(report) : ''}</main></body></html>`;
  }

  buildAdminReport(turnId, options = {}) {
    const row = document.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
    const text = (row?.textContent || '').replace(/\s+/g, ' ').trim();
    const logs = (window.__commercialAiErrorLog || []).slice(-80);
    const relatedLogs = logs.filter(item => !item.turnId || item.turnId === turnId || /429|quota|error|오류|실패|warn/i.test(item.message || ''));
    const diagnostics = {
      url: location.href,
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      moduleVersion: document.documentElement.dataset.aiModuleVersion || '',
      mode: document.documentElement.dataset.aiMode || '',
      orchestrator: document.documentElement.dataset.aiOrchestrator || '',
      router: document.documentElement.dataset.aiRouter || '',
      analyst: document.documentElement.dataset.aiAnalyst || '',
      advisor: document.documentElement.dataset.aiAdvisor || '',
      geminiCount: document.documentElement.dataset.aiGeminiCount || '',
      stageCount: document.documentElement.dataset.aiStageCount || '',
      elapsedMs: document.documentElement.dataset.aiElapsedMs || '',
      lastQuestion: document.documentElement.dataset.aiLastQuestion || '',
    };
    return {
      id: `report-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      turnId,
      createdAt: new Date().toISOString(),
      reporter: this.maintainer,
      question: this.findQuestion(row),
      answerText: text,
      diagnostics,
      logs: relatedLogs,
      flags: this.flags(row, text, relatedLogs, options),
      changes: this.getChangeLog().slice(0, 20),
      html: this.turnHtml(row, 'admin'),
    };
  }

  adminHtml(report) {
    return `<section class="admin-panel"><h2>관리용 점검 정보</h2><h3>이상 징후</h3><ul class="admin-flags">${report.flags.map(f => `<li class="${this.esc(f.level)}"><strong>${this.esc(f.label)}</strong><span>${this.esc(f.detail)}</span></li>`).join('') || '<li><strong>특이 사항 없음</strong><span>자동 체크에서 주요 이상 징후가 보이지 않습니다.</span></li>'}</ul><div class="admin-grid"><div><h3>진단값</h3><pre>${this.esc(JSON.stringify(report.diagnostics, null, 2))}</pre></div><div><h3>수정 이력</h3><pre>${this.esc(JSON.stringify(report.changes, null, 2))}</pre></div></div><h3>최근 오류·경고 로그</h3><table class="admin-log"><thead><tr><th>시각</th><th>수준</th><th>출처</th><th>내용</th></tr></thead><tbody>${report.logs.map(l => `<tr><td>${this.esc(l.at)}</td><td>${this.esc(l.level)}</td><td>${this.esc(l.source)}</td><td>${this.esc(l.message)}${l.stack ? `<pre>${this.esc(l.stack)}</pre>` : ''}</td></tr>`).join('') || '<tr><td colspan="4">수집된 오류·경고가 없습니다.</td></tr>'}</tbody></table><h3>화면 텍스트</h3><pre>${this.esc(report.answerText)}</pre></section>`;
  }

  flags(row, text, logs, options = {}) {
    const flags = [];
    if (options.userReported) flags.push({ level: 'warn', label: '사용자 신고', detail: '사용자가 오류 신고 버튼을 눌렀습니다.' });
    if (row?.querySelector('.chat-error')) flags.push({ level: 'error', label: '화면 오류', detail: row.querySelector('.chat-error')?.textContent || '오류가 표시되었습니다.' });
    if (!text) flags.push({ level: 'error', label: '빈 응답', detail: '답변 텍스트가 비어 있습니다.' });
    if (logs.some(l => /429|quota/i.test(l.message || ''))) flags.push({ level: 'warn', label: 'Gemini quota', detail: '최근 로그에 429/quota 관련 경고가 있습니다.' });
    if (/undefined|null|NaN|Infinity/.test(text)) flags.push({ level: 'error', label: '비정상 값 노출', detail: '화면에 undefined/null/NaN/Infinity가 보입니다.' });
    if (/참고값|시군구 평균|직접값이 없어/.test(text)) flags.push({ level: 'info', label: '참고값 포함', detail: '시군구 참고값 또는 직접값 부족 안내가 포함되어 있습니다.' });
    if (/로 해석했습니다|별도 분류가 없어/.test(text)) flags.push({ level: 'info', label: '업종 해석 안내', detail: '질의 업종이 사전 업종으로 재해석되었습니다.' });
    return flags;
  }

  turnHtml(row, mode) {
    if (!row) return '';
    const clone = row.cloneNode(true);
    const sourceCanvases = row.querySelectorAll('canvas');
    clone.querySelectorAll('canvas').forEach((canvas, index) => {
      const source = sourceCanvases[index];
      try {
        if (!source) return;
        const img = document.createElement('img');
        img.className = 'print-chart-image';
        img.src = source.toDataURL('image/png');
        img.alt = '차트 이미지';
        canvas.replaceWith(img);
      } catch {}
    });
    clone.querySelectorAll('.chat-report-actions,.chat-avatar,.leaflet-control-container').forEach(el => el.remove());
    if (mode === 'user') clone.querySelectorAll('.chat-chips-area,button,[role="button"]').forEach(el => el.remove());
    clone.querySelectorAll('[hidden]').forEach(el => el.removeAttribute('hidden'));
    return clone.innerHTML;
  }

  installCapture() {
    window.__commercialAiErrorLog = window.__commercialAiErrorLog || [];
    window.__commercialAiCaptureError = (entry = {}) => this.capture({ level: 'error', source: 'ui', ...entry });
    if (window.__commercialAiReportCaptureInstalled) return;
    window.addEventListener('error', event => this.capture({ level: 'error', source: 'window.onerror', message: event.message, stack: event.error?.stack || '', extra: { filename: event.filename, lineno: event.lineno, colno: event.colno } }));
    window.addEventListener('unhandledrejection', event => this.capture({ level: 'error', source: 'unhandledrejection', message: event.reason?.message || String(event.reason || 'Unhandled rejection'), stack: event.reason?.stack || '' }));
    for (const level of ['warn', 'error']) {
      const original = console[level];
      if (typeof original !== 'function') continue;
      console[level] = (...args) => {
        this.capture({ level, source: `console.${level}`, message: this.formatArgs(args) });
        original.apply(console, args);
      };
    }
    window.__commercialAiReportCaptureInstalled = true;
  }

  capture(entry = {}) {
    const log = window.__commercialAiErrorLog || (window.__commercialAiErrorLog = []);
    log.push({ at: new Date().toISOString(), level: entry.level || 'info', source: entry.source || 'app', message: String(entry.message || ''), turnId: entry.turnId || '', stack: entry.stack || '', extra: entry.extra || null, url: location.href });
    if (log.length > 160) log.splice(0, log.length - 160);
  }

  getReports() { try { return JSON.parse(localStorage.getItem('commercial_ai_error_reports') || '[]'); } catch { return []; } }
  getChangeLog() { try { return JSON.parse(localStorage.getItem('commercial_ai_change_log') || '[]'); } catch { return []; } }
  findQuestion(row) { return row?.previousElementSibling?.querySelector('.chat-user-bubble')?.textContent?.trim() || ''; }
  collectCss() { return Array.from(document.styleSheets).map(sheet => { try { return Array.from(sheet.cssRules || []).map(rule => rule.cssText).join('\n'); } catch { return ''; } }).join('\n'); }
  formatArgs(args) { return args.map(arg => arg instanceof Error ? `${arg.message}\n${arg.stack || ''}` : typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '); }
  fileTime() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
  esc(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
  reportCss() { return `body{overflow:auto!important;background:#f6f4ef;color:#1a1916}.print-report{max-width:920px;margin:0 auto;padding:32px 24px 56px}.print-report-header{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #2d4540;padding-bottom:18px;margin-bottom:22px}.print-report-header h1{margin:0;font-size:24px}.print-kicker{margin:0 0 6px;color:#2d4540;font-size:12px;font-weight:800}.print-report-header dl{margin:0;display:grid;gap:5px;font-size:12px;color:#6f6b62}.print-report-header dt{display:inline;font-weight:700;margin-right:6px}.print-report-header dd{display:inline;margin:0}.print-question{border:1px solid #e1ded5;background:#fff;padding:14px 16px;border-radius:8px;margin:18px 0}.print-question h2,.admin-panel h2{margin:0 0 8px;font-size:16px}.print-question p{margin:0;font-weight:700}.print-content .chat-ai-bubble{box-shadow:none;border:0;padding:0;background:transparent}.print-content .chat-row{max-width:none;margin:0;display:block;animation:none}.print-chart-image{display:block;max-width:100%;height:auto}.admin-panel{page-break-before:always;border-top:2px solid #2d4540;padding-top:18px}.admin-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.admin-panel h3{margin:18px 0 8px;font-size:13px}.admin-panel pre{white-space:pre-wrap;word-break:break-word;background:#f4f0e6;border:1px solid #e1ded5;border-radius:6px;padding:10px;font-size:11px;line-height:1.45}.admin-flags{list-style:none;padding:0;margin:0;display:grid;gap:6px}.admin-flags li{display:grid;gap:2px;border:1px solid #e1ded5;border-left-width:4px;background:#fff;padding:9px 10px;border-radius:6px}.admin-flags li.error{border-left-color:#c53030}.admin-flags li.warn{border-left-color:#8c5a12}.admin-flags li.info{border-left-color:#2d4540}.admin-flags span{color:#6f6b62;font-size:12px}.admin-log{width:100%;border-collapse:collapse;font-size:11px}.admin-log th,.admin-log td{border:1px solid #ddd8cc;padding:6px;vertical-align:top;text-align:left}.admin-log th{background:#f4f0e6}@media print{body{background:#fff}.print-report{padding:0}.chat-report-actions{display:none!important}}`; }
}

export default ReportExporter;