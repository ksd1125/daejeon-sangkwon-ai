/**
 * test-report.js — 테스트 결과 렌더링 + HTML 리포트 export
 *
 * 디자인 토큰: BRAND=#2D4540, BG=#F5F2EC, Pretendard
 * 색상: pass=#4F7A5E, fail=#A84B40, error=#C4883A, skip=#A29E94
 */

const COLORS = {
  pass: '#4F7A5E',
  fail: '#A84B40',
  error: '#C4883A',
  skip: '#A29E94',
  brand: '#2D4540',
  bg: '#F5F2EC',
};

export class TestReport {
  /**
   * @param {HTMLElement} resultsEl  - #results 컨테이너
   * @param {HTMLElement} progressEl - #progress 컨테이너
   * @param {HTMLElement} summaryEl  - #summary 컨테이너
   */
  constructor(resultsEl, progressEl, summaryEl) {
    this._results = resultsEl;
    this._progress = progressEl;
    this._summary = summaryEl;
    this._startTime = 0;
  }

  // ── Progress ──

  startTimer() {
    this._startTime = performance.now();
  }

  updateProgress({ completed, total }) {
    const pct = total ? Math.round((completed / total) * 100) : 0;
    const elapsed = ((performance.now() - this._startTime) / 1000).toFixed(1);
    this._progress.innerHTML = `
      <div class="progress-bar-outer">
        <div class="progress-bar-inner" style="width:${pct}%"></div>
      </div>
      <div class="progress-text">${completed.toLocaleString()} / ${total.toLocaleString()} (${pct}%) · ${elapsed}s</div>
    `;
  }

  // ── Summary + Results ──

  render(results, stats) {
    const elapsed = ((performance.now() - this._startTime) / 1000).toFixed(1);
    this._renderSummary(stats, elapsed);
    this._renderCoverage(results);
    this._renderCategoryBreakdown(results, stats);
    this._renderFailedCases(results);
  }

  _renderSummary(stats, elapsed) {
    const cards = [
      { label: 'Total', value: stats.total, color: COLORS.brand },
      { label: 'Pass', value: stats.pass, color: COLORS.pass },
      { label: 'Fail', value: stats.fail, color: COLORS.fail },
      { label: 'Error', value: stats.error, color: COLORS.error },
    ];

    this._summary.innerHTML = `
      <div class="summary-row">
        ${cards.map(c => `
          <div class="summary-card" style="border-left:4px solid ${c.color}">
            <div class="summary-value" style="color:${c.color}">${c.value.toLocaleString()}</div>
            <div class="summary-label">${c.label}</div>
          </div>
        `).join('')}
        <div class="summary-card" style="border-left:4px solid ${COLORS.skip}">
          <div class="summary-value" style="color:${COLORS.skip}">${elapsed}s</div>
          <div class="summary-label">소요 시간</div>
        </div>
      </div>
      ${stats.fail > 0 || stats.error > 0
        ? `<div class="summary-alert">⚠ ${stats.fail + stats.error}건의 실패/에러가 발견되었습니다.</div>`
        : `<div class="summary-ok">✅ 모든 테스트 통과</div>`}
    `;
  }

  _renderCoverage(results) {
    const districts = new Set();
    const industries = new Set();
    const qTypes = new Set();
    const merges = new Set();

    for (const r of results) {
      if (r.districtCode) districts.add(r.districtCode);
      if (r.expectedIndustry) industries.add(r.expectedIndustry);
      if (r.expectedQuestionType) qTypes.add(r.expectedQuestionType);
      if (r.category === 'merge') merges.add(r.sourceLocation);
    }

    const items = [
      { label: '행정동', value: districts.size, total: 82 },
      { label: '업종', value: industries.size, total: 247 },
      { label: 'Merge 케이스', value: merges.size, total: 37 },
    ];

    const html = `
      <div class="coverage-section">
        <h3>커버리지</h3>
        <div class="coverage-row">
          ${items.map(i => `
            <div class="coverage-item">
              <span class="coverage-value">${i.value}/${i.total}</span>
              <span class="coverage-label">${i.label}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    // append after summary
    this._summary.insertAdjacentHTML('beforeend', html);
  }

  _renderCategoryBreakdown(results, stats) {
    const categories = {};
    for (const r of results) {
      const cat = r.category || 'unknown';
      if (!categories[cat]) categories[cat] = { pass: 0, fail: 0, error: 0, total: 0, items: [] };
      categories[cat].total++;
      categories[cat][r.status]++;
      if (r.status !== 'pass') categories[cat].items.push(r);
    }

    const catNames = {
      merge: '법정동 Merge',
      abbreviation: '약어 Merge (가양, 갈마 등)',
      locationAlias: '위치별칭 Merge (과학단지, 성심당 등)',
      questionType: 'QuestionType 커버리지',
      districtResolution: '행정동 이름 해석',
      dataIntegrity: '데이터 무결성 (L2)',
      followUpChain: 'Follow-up 체인 (꼬리물기)',
      fullMatrix: '전체 매트릭스 (L3)',
    };

    let html = '<div class="category-section"><h3>카테고리별 결과</h3>';

    for (const [cat, data] of Object.entries(categories)) {
      const isAllPass = data.fail === 0 && data.error === 0;
      const statusIcon = isAllPass ? '✅' : '❌';
      const statusColor = isAllPass ? COLORS.pass : COLORS.fail;

      html += `
        <details class="category-group" ${isAllPass ? '' : 'open'}>
          <summary style="color:${statusColor}">
            ${statusIcon} ${catNames[cat] || cat}
            <span class="cat-stats">
              ${data.pass}✓ ${data.fail ? data.fail + '✗' : ''} ${data.error ? data.error + '!' : ''}
              / ${data.total}
            </span>
          </summary>
          ${data.items.length > 0 ? `
            <table class="fail-table">
              <thead><tr><th>ID</th><th>질문</th><th>Phase</th><th>에러</th></tr></thead>
              <tbody>
                ${data.items.map(item => item.errors.map(e => `
                  <tr class="status-${item.status}">
                    <td class="cell-id">${this._escapeHtml(item.id)}</td>
                    <td class="cell-q">${this._escapeHtml(item.question)}</td>
                    <td class="cell-phase">${e.phase}</td>
                    <td class="cell-err">${this._escapeHtml(e.message)}</td>
                  </tr>
                `).join('')).join('')}
              </tbody>
            </table>
          ` : '<p class="all-pass-note">모든 케이스 통과</p>'}
        </details>
      `;
    }

    html += '</div>';
    this._results.innerHTML = html;
  }

  _renderFailedCases(results) {
    const failed = results.filter(r => r.status !== 'pass');
    if (failed.length === 0) return;

    let html = `
      <div class="failed-section">
        <h3>실패/에러 전체 목록 (${failed.length}건)</h3>
        <table class="fail-table full-width">
          <thead>
            <tr>
              <th>ID</th><th>질문</th><th>카테고리</th><th>상태</th><th>Phase</th><th>에러 메시지</th><th>ms</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const item of failed) {
      for (const e of item.errors) {
        html += `
          <tr class="status-${item.status}">
            <td class="cell-id">${this._escapeHtml(item.id)}</td>
            <td class="cell-q">${this._escapeHtml(item.question)}</td>
            <td>${item.category}</td>
            <td class="cell-status-${item.status}">${item.status}</td>
            <td class="cell-phase">${e.phase}</td>
            <td class="cell-err">${this._escapeHtml(e.message)}</td>
            <td>${item.elapsed?.toFixed(0) || '-'}</td>
          </tr>
        `;
      }
    }

    html += '</tbody></table></div>';
    this._results.insertAdjacentHTML('beforeend', html);
  }

  // ── HTML Export ──

  exportHTML(results, stats) {
    const elapsed = ((performance.now() - this._startTime) / 1000).toFixed(1);
    const now = new Date().toLocaleString('ko-KR');
    const level = Math.max(...results.map(r => r.level));
    const failed = results.filter(r => r.status !== 'pass');

    // 카테고리별 집계
    const catSummary = {};
    for (const r of results) {
      const cat = r.category || 'unknown';
      if (!catSummary[cat]) catSummary[cat] = { pass: 0, fail: 0, error: 0, total: 0 };
      catSummary[cat].total++;
      catSummary[cat][r.status]++;
    }

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>상권AI 테스트 리포트 — ${now}</title>
<style>
  @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Pretendard,sans-serif;background:${COLORS.bg};color:#333;line-height:1.6}
  .container{max-width:960px;margin:0 auto;padding:24px}
  h1{color:${COLORS.brand};font-size:1.5rem;margin-bottom:4px}
  h2{color:${COLORS.brand};font-size:1.2rem;margin:24px 0 12px;border-bottom:2px solid ${COLORS.brand};padding-bottom:4px}
  .meta{color:#888;font-size:.85rem;margin-bottom:20px}
  .summary-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}
  .summary-card{background:#fff;border-radius:8px;padding:16px 20px;min-width:120px;border-left:4px solid #ccc}
  .summary-value{font-size:1.6rem;font-weight:700}
  .summary-label{font-size:.8rem;color:#888}
  .ok{color:${COLORS.pass};font-weight:600;font-size:1rem;margin:8px 0}
  .alert{color:${COLORS.fail};font-weight:600;font-size:1rem;margin:8px 0}
  table{width:100%;border-collapse:collapse;font-size:.82rem;margin:12px 0}
  th{background:${COLORS.brand};color:#fff;padding:8px;text-align:left}
  td{padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top}
  tr.status-fail td{background:#fef2f0}
  tr.status-error td{background:#fff8ef}
  .cat-header{background:#e8e5df;padding:8px 12px;border-radius:4px;margin:8px 0 4px;font-weight:600}
  .pass-tag{color:${COLORS.pass}}
  .fail-tag{color:${COLORS.fail}}
  .error-tag{color:${COLORS.error}}
  @media print{body{background:#fff}.container{padding:0}}
</style>
</head>
<body>
<div class="container">
  <h1>상권AI 자동화 테스트 리포트</h1>
  <div class="meta">Level ${level} · ${now} · 소요 ${elapsed}s · 총 ${stats.total.toLocaleString()}건</div>

  <div class="summary-row">
    <div class="summary-card" style="border-color:${COLORS.brand}">
      <div class="summary-value" style="color:${COLORS.brand}">${stats.total.toLocaleString()}</div>
      <div class="summary-label">Total</div>
    </div>
    <div class="summary-card" style="border-color:${COLORS.pass}">
      <div class="summary-value" style="color:${COLORS.pass}">${stats.pass.toLocaleString()}</div>
      <div class="summary-label">Pass</div>
    </div>
    <div class="summary-card" style="border-color:${COLORS.fail}">
      <div class="summary-value" style="color:${COLORS.fail}">${stats.fail.toLocaleString()}</div>
      <div class="summary-label">Fail</div>
    </div>
    <div class="summary-card" style="border-color:${COLORS.error}">
      <div class="summary-value" style="color:${COLORS.error}">${stats.error.toLocaleString()}</div>
      <div class="summary-label">Error</div>
    </div>
  </div>

  ${stats.fail + stats.error === 0
    ? '<p class="ok">✅ 모든 테스트 통과</p>'
    : `<p class="alert">⚠ ${stats.fail + stats.error}건의 실패/에러 발견</p>`}

  <h2>카테고리별 요약</h2>
  <table>
    <thead><tr><th>카테고리</th><th>Total</th><th>Pass</th><th>Fail</th><th>Error</th></tr></thead>
    <tbody>
      ${Object.entries(catSummary).map(([cat, s]) => `
        <tr>
          <td>${this._escapeHtml(cat)}</td>
          <td>${s.total}</td>
          <td class="pass-tag">${s.pass}</td>
          <td class="fail-tag">${s.fail || '-'}</td>
          <td class="error-tag">${s.error || '-'}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  ${failed.length > 0 ? `
  <h2>실패/에러 상세 (${failed.length}건)</h2>
  <table>
    <thead><tr><th>ID</th><th>질문</th><th>상태</th><th>Phase</th><th>에러 메시지</th></tr></thead>
    <tbody>
      ${failed.map(item => item.errors.map(e => `
        <tr class="status-${item.status}">
          <td>${this._escapeHtml(item.id)}</td>
          <td>${this._escapeHtml(item.question)}</td>
          <td>${item.status}</td>
          <td>${e.phase}</td>
          <td>${this._escapeHtml(e.message)}</td>
        </tr>
      `).join('')).join('')}
    </tbody>
  </table>
  ` : ''}

</div>
</body>
</html>`;

    return html;
  }

  // ── Helpers ──

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str || '');
    return div.innerHTML;
  }
}
