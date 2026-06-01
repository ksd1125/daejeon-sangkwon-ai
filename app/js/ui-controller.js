export class UIController {
  constructor() {
    this.els = {
      layout: document.getElementById('layout'),
      sidebar: document.getElementById('sidebar'),
      sidebarClose: document.getElementById('sidebarClose'),
      hamburger: document.getElementById('hamburger'),
      mobileHeader: document.getElementById('mobileHeader'),
      searchInput: document.getElementById('searchInput'),
      btnSubmit: document.getElementById('btnSubmit'),
      notice: document.getElementById('notice'),
      historyList: document.getElementById('historyList'),
      btnSettings: document.getElementById('btnSettings'),
      settingsModal: document.getElementById('settingsModal'),
      modalClose: document.getElementById('modalClose'),
      apiKeyRouter: document.getElementById('apiKeyRouter'),
      apiKeyAnalyst: document.getElementById('apiKeyAnalyst'),
      apiKeyAdvisor: document.getElementById('apiKeyAdvisor'),
      btnSameKey: document.getElementById('btnSameKey'),
      btnSaveKey: document.getElementById('btnSaveKey'),
      btnClearKey: document.getElementById('btnClearKey'),
      orbitTitle: document.getElementById('orbitTitle'),
      orbitSteps: document.getElementById('orbitSteps'),
      chatInputArea: document.getElementById('chatInputArea'),
      orbitToggle: document.getElementById('orbitToggle'),
      headerNew: document.getElementById('headerNew'),
      sidebarNew: document.getElementById('sidebarNew'),
      sidebarBrand: document.getElementById('sidebarBrand'),
    };
    this.overlay = null;
    this._chartId = 0;
    this._lastIntent = null;
    this._history = [];
    this.defaultPrompts = [
      '중앙동 어때?',
      '둔산1동 카페 매출 어때?',
      '유성구 편의점 최근 추세는?',
      '노은1동 치킨 비슷한 상권',
    ];
    this._setupSidebar();
    this._setupModal();
    this._setupTextarea();
    this._setupOrbitToggle();
    this._updateOrbitFromText('');
  }

  /* ═══════════════
     SETUP
     ═══════════════ */

  _setupSidebar() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'sidebar-overlay';
    document.body.appendChild(this.overlay);
    this.els.hamburger?.addEventListener('click', () => this._toggleSidebar(true));
    this.els.sidebarClose?.addEventListener('click', () => this._toggleSidebar(false));
    this.overlay.addEventListener('click', () => this._toggleSidebar(false));

    // 스와이프: 사이드바에서 왼쪽으로 밀면 닫기
    let sx = 0;
    this.els.sidebar?.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
    this.els.sidebar?.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - sx;
      if (dx < -60) this._toggleSidebar(false);
    }, { passive: true });
  }

  _toggleSidebar(open) {
    this.els.sidebar?.classList.toggle('open', open);
    this.overlay?.classList.toggle('active', open);
  }

  _setupModal() {
    const KEY_NAMES = ['gemini_api_key_router', 'gemini_api_key_analyst', 'gemini_api_key_advisor'];
    const KEY_ELS = [this.els.apiKeyRouter, this.els.apiKeyAnalyst, this.els.apiKeyAdvisor];

    this.els.btnSettings?.addEventListener('click', () => {
      this._lastFocused = document.activeElement;
      KEY_NAMES.forEach((k, i) => {
        if (KEY_ELS[i]) KEY_ELS[i].value = localStorage.getItem(k) || '';
      });
      this.els.settingsModal?.showModal();
      this.els.apiKeyRouter?.focus();
    });
    this.els.modalClose?.addEventListener('click', () => this.els.settingsModal?.close());
    // 닫힘(버튼/백드롭/ESC/저장) 시 포커스를 열었던 요소로 복원
    this.els.settingsModal?.addEventListener('close', () => this._lastFocused?.focus?.());

    // 같은 키 일괄 입력: 첫 번째(라우터) 키를 나머지에 복사
    this.els.btnSameKey?.addEventListener('click', () => {
      const key = this.els.apiKeyRouter?.value?.trim() || '';
      if (this.els.apiKeyAnalyst) this.els.apiKeyAnalyst.value = key;
      if (this.els.apiKeyAdvisor) this.els.apiKeyAdvisor.value = key;
    });

    this.els.btnSaveKey?.addEventListener('click', () => {
      // API 키 형식 경고 (차단 아님)
      const warnEl = this.els.settingsModal?.querySelector('.key-format-warn');
      if (warnEl) warnEl.hidden = true;
      let hasWarn = false;
      KEY_ELS.forEach(el => {
        const val = el?.value?.trim();
        if (val && (!/^AIza/.test(val) || val.length !== 39)) hasWarn = true;
      });
      if (hasWarn && warnEl) {
        warnEl.textContent = '⚠ Gemini API 키는 보통 "AIza"로 시작하는 39자입니다. 형식을 확인해 주세요.';
        warnEl.hidden = false;
      }

      KEY_NAMES.forEach((k, i) => {
        const val = KEY_ELS[i]?.value?.trim();
        if (val) localStorage.setItem(k, val);
        else localStorage.removeItem(k);
      });
      const routerKey = this.els.apiKeyRouter?.value?.trim() || '';
      if (routerKey) localStorage.setItem('gemini_api_key', routerKey);
      else localStorage.removeItem('gemini_api_key');
      window.__commercialAiRefreshDiagnostics?.();
      if (!hasWarn) this.els.settingsModal?.close();
    });
    this.els.btnClearKey?.addEventListener('click', () => {
      KEY_NAMES.forEach((k, i) => {
        localStorage.removeItem(k);
        if (KEY_ELS[i]) KEY_ELS[i].value = '';
      });
      localStorage.removeItem('gemini_api_key');
      window.__commercialAiRefreshDiagnostics?.();
    });
    this.els.settingsModal?.addEventListener('click', (e) => {
      if (e.target === this.els.settingsModal) this.els.settingsModal.close();
    });
  }

  _setupTextarea() {
    const ta = this.els.searchInput;
    if (!ta) return;
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
      this._updateOrbitFromText(ta.value);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.els.btnSubmit?.click();
      }
    });
  }

  /* ═══════════════
     PUBLIC API
     ═══════════════ */

  getQuestion() { return this.els.searchInput?.value?.trim() || ''; }

  setQuestion(text) {
    if (this.els.searchInput) {
      this.els.searchInput.value = text;
      this.els.searchInput.dispatchEvent(new Event('input'));
    }
  }

  /* ── Orbit ── */

  _setupOrbitToggle() {
    this.els.orbitToggle?.addEventListener('click', () => {
      const collapsed = this.els.chatInputArea?.classList.contains('orbit-collapsed');
      this._setOrbitCollapsed(!collapsed);
    });
  }

  /** 분석 과정(orbit) 접기/펼치기 — 모바일에서만 시각적으로 적용(CSS), 데스크톱은 항상 표시 */
  _setOrbitCollapsed(collapsed) {
    const area = this.els.chatInputArea;
    const btn = this.els.orbitToggle;
    if (!area) return;
    area.classList.toggle('orbit-collapsed', collapsed);
    if (btn) {
      btn.setAttribute('aria-expanded', String(!collapsed));
      const label = btn.querySelector('.orbit-toggle-label');
      if (label) label.textContent = collapsed ? '분석 과정 보기' : '분석 과정 숨기기';
    }
  }

  updateOrbitFromIntent(intent, mode = 'loading') {
    const title = this.els.orbitTitle;
    const steps = this.els.orbitSteps;
    if (!title || !steps || !intent) return;
    this._lastIntent = intent;

    const district = intent.district?.name || '';
    const sgg = intent.sgg || '';
    const industry = intent.industry || '';
    const qType = intent.questionType || '';
    const metricMap = { sales: '매출', upso: '업소 수', pop: '유동인구', trend: '추세', similar: '유사 상권', overview: '종합', density: '밀도 분석', compare: '비교', merge: '지역 합산' };
    const metric = metricMap[qType] || '';
    const hasCompare = ['similar', 'trend'].includes(qType);

    const items = [
      { label: '지역', value: district || sgg, done: Boolean(district || sgg) },
      { label: '업종', value: industry, done: Boolean(industry) },
      { label: '지표', value: metric, done: Boolean(metric) },
      { label: '비교', value: hasCompare ? '포함' : '', done: hasCompare },
    ];

    if (mode === 'complete') {
      title.textContent = '분석 완료';
    } else {
      const parts = [district || sgg, industry].filter(Boolean);
      title.textContent = parts.length ? `${parts.join(' ')} 분석 중` : '데이터를 맞춰 보는 중';
    }
    // 결과가 나오면(완료) 분석 과정 자동 접기, 분석 중이면 펼치기 (모바일)
    this._setOrbitCollapsed(mode === 'complete');

    steps.innerHTML = items.map((item, i) => {
      const classes = ['orbit-step'];
      if (item.done || mode === 'complete') classes.push('done');
      if (mode === 'loading' && !item.done && items.slice(0, i).every(p => p.done)) classes.push('active');
      const valHtml = item.value ? `<span class="orbit-val">${esc(item.value)}</span>` : '';
      return `<span class="${classes.join(' ')}" style="transition-delay:${i * 150}ms">${item.label}${valHtml}</span>`;
    }).join('');
  }

  _updateOrbitFromText(text = '', mode = 'draft') {
    const title = this.els.orbitTitle;
    const steps = this.els.orbitSteps;
    if (!title || !steps) return;

    const value = String(text || '');
    const hasRegion = /[가-힣0-9]+(동|구)/.test(value);
    const hasIndustry = /(카페|편의점|치킨|한식|음식|미용|병원|약국|학원|마트|업종|상권)/.test(value);
    const hasMetric = /(매출|업소|점포|유동|인구|추세|상위|평균)/.test(value);
    const hasCompare = /(비슷|비교|대비|랭킹|상위|추세)/.test(value);
    const states = [hasRegion, hasIndustry, hasMetric, hasCompare];
    const labels = ['지역', '업종', '지표', '비교'];
    const activeIndex = Math.max(0, states.findIndex(done => !done));
    const doneCount = states.filter(Boolean).length;

    if (mode === 'loading') title.textContent = '데이터를 맞춰 보는 중';
    else if (mode === 'complete') title.textContent = '분석 완료';
    else if (!value.trim()) title.textContent = '질문을 기다리는 중';
    else if (doneCount >= 3) title.textContent = '바로 조회할 수 있는 질문입니다';
    else title.textContent = '질문 의도를 읽는 중';

    // 결과가 나오면(완료) 분석 과정 자동 접기 (모바일)
    if (mode === 'complete') this._setOrbitCollapsed(true);
    else if (mode === 'loading') this._setOrbitCollapsed(false);

    steps.innerHTML = labels.map((label, index) => {
      const classes = ['orbit-step'];
      if (states[index]) classes.push('done');
      if (index === activeIndex || (mode === 'complete' && index === labels.length - 1)) classes.push('active');
      return `<span class="${classes.join(' ')}">${label}</span>`;
    }).join('');
  }

  /* ═══════════════════════════════════════
     HTML BUILDERS (카드 콘텐츠 생성)
     ═══════════════════════════════════════ */

  /**
   * response → 카드 내부 HTML 문자열.
   * ChatUI가 이 HTML을 AI 버블 안에 삽입.
   */
  buildCardHTML(response) {
    return this._buildDataNotice(response.dataNotice)
      + this._buildSynthesisCard(response)
      + this._buildStatsCard(response.statsCard)
      + this._buildCompareCard(response.compareCard)
      + this._buildDongDetailCard(response.dongDetailCard)
      + this._buildTrendCard(response.trendCard)
      + this._buildTrendCard(response.trendCard2)
      + this._buildDisambiguation(response.disambiguation);
  }

  /** 차트 캔버스 수집 */
  getChartCanvases(container) {
    return Array.from((container || document).querySelectorAll('.chart-canvas[data-chart]'));
  }

  /* ── Events ── */

  onChipClick(callback) {
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip[data-q], .suggest-btn[data-q]');
      if (!chip) return;
      e.preventDefault();
      const q = chip.dataset.q;
      this.setQuestion(q);
      callback(q);
    });
  }

  onSubmit(callback) {
    this.els.btnSubmit?.addEventListener('click', () => {
      const q = this.getQuestion();
      if (q) callback(q);
    });
  }

  /** 히스토리에 항목 추가 */
  addHistoryItem(intent, question) {
    const label = this._buildHistoryLabel(intent, question);
    const typeMap = { sales: '매출', upso: '업소', pop: '유동인구', trend: '추세', similar: '유사', overview: '현황', compare: '비교' };
    const badge = typeMap[intent.questionType] || '';
    this._history.push({ label, badge, question });
    this._renderHistory();
  }

  /** 히스토리 초기화 */
  clearHistory() {
    this._history = [];
    this._renderHistory();
  }

  /** intent + question → 간결한 라벨 */
  _buildHistoryLabel(intent, question) {
    const parts = [];
    const district = intent.district?.name || '';
    const sgg = intent.sgg || '';
    const industry = intent.industry || '';
    if (district) parts.push(district);
    else if (sgg) parts.push(sgg);
    if (industry) parts.push(industry);
    if (parts.length === 0) {
      // fallback: 질의에서 핵심 키워드 추출
      return question.length > 20 ? question.slice(0, 18) + '…' : question;
    }
    return parts.join(' · ');
  }

  _renderHistory() {
    const list = this.els.historyList;
    if (!list) return;
    if (this._history.length === 0) {
      list.innerHTML = '<div class="history-empty">질문하면 여기에 기록됩니다.</div>';
      return;
    }
    const icon = `<svg class="history-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`;
    list.innerHTML = this._history.map((h, i) => {
      const active = i === this._history.length - 1 ? ' active' : '';
      const badgeHtml = h.badge ? `<div class="history-badge">${esc(h.badge)}</div>` : '';
      return `<button type="button" class="history-item${active}" data-idx="${i}" data-q="${esc(h.question)}">${icon}<div class="history-label-wrap"><div class="history-label">${esc(h.label)}</div>${badgeHtml}</div></button>`;
    }).reverse().join('');
  }

  onHistoryClick(callback) {
    this.els.historyList?.addEventListener('click', (e) => {
      const item = e.target.closest('.history-item[data-q]');
      if (!item) return;
      callback(item.dataset.q);
    });
  }

  onNewChat(callback) {
    this.els.headerNew?.addEventListener('click', () => callback());
    this.els.sidebarNew?.addEventListener('click', () => callback());
    this.els.sidebarBrand?.addEventListener('click', () => callback());
    this.els.sidebarBrand?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); callback(); }
    });
  }

  /* ═══════════════════════
     PRIVATE HTML BUILDERS
     ═══════════════════════ */

  /** sgg_sub 등 신뢰도 경고를 카드 최상단에 표시 (#9). 직접값 확인 메시지는 노이즈라 제외 */
  _buildDataNotice(notice) {
    if (!notice || !/부족|참고값|없습니다/.test(notice)) return '';
    return '<div class="data-notice" style="background:#fff9ef;border:1px solid #f0e4c8;border-left:3px solid #c89a3c;border-radius:8px;padding:8px 12px;margin:0 0 10px;font-size:12.5px;color:#7a5a12;line-height:1.5">⚠ '
      + esc(notice) + '</div>';
  }

  _buildSynthesisCard(response) {
    const summary = String(response?.summary?.text || '').trim();
    const bullets = (response?.summary?.bullets || []).filter(Boolean).slice(0, 3);
    const cells = (response?.statsCard?.cells || [])
      .filter(c => c && c.value !== undefined && c.value !== null && String(c.value).trim() !== '')
      .slice(0, 3);
    if (!summary && !bullets.length && !cells.length) return '';

    const facts = cells.map(c => '<span class="synthesis-fact"><b>' + esc(c.label) + '</b><span>' + esc(c.value) + esc(c.unit || '') + '</span></span>').join('');
    const bulletHtml = bullets.length
      ? '<ul class="synthesis-bullets">' + bullets.map(b => '<li>' + esc(b) + '</li>').join('') + '</ul>'
      : '';
    return '<section class="synthesis-card" aria-label="핵심 요약">'
      + '<div class="synthesis-title">핵심 요약</div>'
      + (summary ? '<p class="synthesis-text">' + esc(summary) + '</p>' : '')
      + (facts ? '<div class="synthesis-facts">' + facts + '</div>' : '')
      + bulletHtml
      + '</section>';
  }
  _buildStatsCard(statsCard) {
    if (!statsCard?.cells?.length) return '';
    const cells = statsCard.cells.map(c => {
      let deltaHtml = '';
      if (Number.isFinite(c.delta)) {
        const label = c.deltaLabel ? ` ${esc(c.deltaLabel)}` : '';
        if (c.delta === 0) {
          deltaHtml = `<div class="stat-delta stat-delta--flat">— 0.0%${label}</div>`;  // 보합: 화살표 없음 (#46)
        } else {
          const isUp = c.delta > 0;
          deltaHtml = `<div class="stat-delta ${isUp ? 'stat-delta--up' : 'stat-delta--down'}">${isUp ? '▲' : '▼'} ${Math.abs(c.delta).toFixed(1)}%${label}</div>`;
        }
      }
      // 값이 "-"(데이터 없음)이면 단위 미부착하여 "-%" 방지 (#17)
      const isEmpty = String(c.value).trim() === '-';
      const unitHtml = isEmpty ? '' : `<span class="stat-unit">${esc(c.unit || '')}</span>`;
      // 큰 금액(만원)에 억 단위 보조 표기 (#47)
      const numVal = Number(String(c.value).replace(/[,\s]/g, ''));
      const eokHtml = (c.unit === '만원' && Number.isFinite(numVal) && Math.abs(numVal) >= 10000)
        ? `<span class="stat-eok" style="font-size:.72em;color:#9a958a;margin-left:4px">≈${(numVal / 10000).toFixed(Math.abs(numVal) >= 100000 ? 0 : 1)}억</span>`
        : '';
      return `<div class="stat-cell">
        <div class="stat-label">${esc(c.label)}</div>
        <div class="stat-value">${c.value}${unitHtml}${eokHtml}</div>
        ${deltaHtml}
      </div>`;
    }).join('');
    const sub = statsCard.subtitle ? `<div class="card-sub">${esc(statsCard.subtitle)}</div>` : '';
    return `
      <div class="stats-card">
        <div class="stats-card-head">
          <div class="stats-card-title">${esc(statsCard.title || '현재 현황')}</div>
          ${sub}
        </div>
        <div class="stat-grid">${cells}</div>
      </div>`;
  }

  _buildCompareCard(compareCard) {
    if (!compareCard?.items?.length) return '';
    const id = `chart-${++this._chartId}`;
    const spec = JSON.stringify({
      type: compareCard.vertical ? 'compareBarVertical' : 'compareBar',
      title: compareCard.title || '지역 비교',
      items: compareCard.items,
      unit: compareCard.unit || '',
    });
    return `
      <div class="compare-card">
        <div class="compare-card-head">
          <div class="compare-card-title">${esc(compareCard.title || '지역 비교')}</div>
        </div>
        <div class="compare-chart-wrap">
          <canvas class="chart-canvas" id="${id}" data-chart='${spec}'></canvas>
        </div>
      </div>`;
  }

  _buildDongDetailCard(card) {
    if (!card?.dongs?.length) return '';
    const cols = card.dongs.map(dong => {
      const rows = (dong.cells || []).map(c => {
        let deltaHtml = '';
        if (Number.isFinite(c.delta)) {
          const isUp = c.delta > 0;
          const cls = isUp ? 'stat-delta--up' : 'stat-delta--down';
          const arrow = isUp ? '▲' : '▼';
          const lbl = c.deltaLabel ? ` ${esc(c.deltaLabel)}` : '';
          deltaHtml = `<div class="stat-delta ${cls}">${arrow} ${Math.abs(c.delta).toFixed(1)}%${lbl}</div>`;
        }
        return `<div class="dong-row">
          <div class="stat-label">${esc(c.label)}</div>
          <div class="dong-row-val">${c.value}<span class="stat-unit">${esc(c.unit || '')}</span></div>
          ${deltaHtml}
        </div>`;
      }).join('');
      return `<div class="dong-col">
        <div class="dong-col-name">${esc(dong.name)}</div>
        ${rows}
      </div>`;
    }).join('');
    return `
      <div class="dong-detail-card">
        <div class="dong-detail-head">
          <div class="dong-detail-title">${esc(card.title || '행정동별 상세')}</div>
        </div>
        <div class="dong-detail-cols">${cols}</div>
      </div>`;
  }

  _buildTrendCard(trendCard) {
    if (!trendCard?.series?.length) return '';
    const id = `chart-${++this._chartId}`;
    const spec = JSON.stringify({
      type: 'trendLine',
      title: trendCard.title || '',
      series: trendCard.series,
      labels: trendCard.labels || [],
    });
    const legendItems = trendCard.series.map(s => {
      const style = s.dashed ? 'border-top:2px dashed' : s.dotted ? 'border-top:2px dotted' : 'border-top:2px solid';
      return `<span class="trend-legend-item"><span class="trend-legend-line" style="${style} ${s.color}"></span>${esc(s.label)}</span>`;
    }).join('');
    const sub = trendCard.subtitle ? `<div class="card-sub">${esc(trendCard.subtitle)}</div>` : '';
    return `
      <div class="trend-card">
        <div class="trend-card-head">
          <div class="trend-card-title">${esc(trendCard.title || '추세')}</div>
          ${sub}
        </div>
        <div class="trend-legend">${legendItems}</div>
        <div class="trend-chart-wrap">
          <canvas class="chart-canvas" id="${id}" data-chart='${spec}'></canvas>
        </div>
      </div>`;
  }

  _buildDisambiguation(dis) {
    if (!dis) return '';
    if (typeof dis === 'string') {
      return `<div class="disambiguation"><p>${esc(dis)}</p></div>`;
    }
    if (dis.message && dis.candidates) {
      const chips = dis.candidates
        .map(c => `<button type="button" class="chip" data-q="${esc(c)}">${esc(c)}</button>`)
        .join('');
      return `
        <div class="disambiguation">
          <p>${esc(dis.message)}</p>
          <div class="chips">${chips}</div>
        </div>`;
    }
    return '';
  }
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
