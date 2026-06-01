/**
 * chat-ui.js — 채팅 인터페이스 + 타이핑 애니메이션
 * 기존 answer-card 스택을 시간순 채팅 버블 UI로 대체
 */
export class ChatUI {
  constructor(messagesEl, welcomeEl = null) {
    this._messages = typeof messagesEl === 'string'
      ? document.getElementById(messagesEl)
      : messagesEl;
    this._welcome = welcomeEl;
    this._history = []; // { role, text, ts }
    this._firstMessage = true;
    this._turnSeq = 0;
  }

  /* ── 사용자 메시지 (오른쪽) ── */

  addUserMessage(text) {
    this._hideWelcome();
    const row = el('div', 'chat-row chat-row--user');
    const bubble = el('div', 'chat-user-bubble');
    bubble.textContent = text;
    const avatar = el('div', 'chat-avatar chat-avatar--user');
    avatar.textContent = '나';
    row.append(bubble, avatar);
    this._messages.appendChild(row);
    this._push('user', text);
    this._scroll();
    return row;
  }

  /* ── AI 응답 턴 생성 ── */

  createAssistantTurn() {
    const turnId = `turn-${++this._turnSeq}`;
    const row = el('div', 'chat-row chat-row--ai');
    row.dataset.turnId = turnId;
    const avatar = el('div', 'chat-avatar chat-avatar--ai');
    avatar.textContent = 'AI';
    const bubble = el('div', 'chat-ai-bubble');
    bubble.dataset.turnId = turnId;

    const meta = el('div', 'bot-meta');
    meta.hidden = true;

    const narrative = el('div', 'chat-narrative');
    narrative.hidden = true;
    narrative.setAttribute('aria-live', 'polite');
    narrative.setAttribute('aria-atomic', 'false');

    const filterRow = el('div', 'bot-filter-row');
    filterRow.hidden = true;

    const card = el('div', 'chat-card-area');

    const note = el('div', 'chat-note');
    note.hidden = true;

    const chips = el('div', 'chat-chips-area');

    const actions = el('div', 'chat-report-actions');
    actions.hidden = true;
    actions.innerHTML = this._buildReportActions();

    bubble.append(meta, narrative, filterRow, card, note, chips, actions);
    row.append(avatar, bubble);
    this._messages.appendChild(row);
    this.scrollToTurn({ el: row });

    return { el: row, bubble, meta, narrative, filterRow, card, note, chips, actions, turnId };
  }

  /* ── 로딩 ("분석 중") 표시 ── */

  showThinking(handle) {
    const { narrative } = handle;
    narrative.hidden = false;
    narrative.innerHTML = '<span class="chat-thinking"><span></span><span></span><span></span></span>';
  }

  removeThinking(handle) {
    const { narrative } = handle;
    const dots = narrative.querySelector('.chat-thinking');
    if (dots) dots.remove();
    const echo = narrative.querySelector('.intent-echo');
    if (echo) echo.remove();
    if (!narrative.textContent.trim()) narrative.hidden = true;
  }

  /* ── 의도 에코 (thinking dots를 의도 텍스트 + dots로 교체) ── */

  showIntentEcho(handle, text) {
    const { narrative } = handle;
    narrative.hidden = false;
    narrative.innerHTML =
      `<span class="intent-echo">${text}</span>` +
      '<span class="chat-thinking"><span></span><span></span><span></span></span>';
  }

  updateIntentEcho(handle, text) {
    const { narrative } = handle;
    const echo = narrative.querySelector('.intent-echo');
    if (echo) echo.textContent = text;
    else this.showIntentEcho(handle, text);
  }

  /* ── Gemini 스트리밍 ── */

  startStreaming(handle) {
    const { narrative } = handle;
    narrative.hidden = false;
    const dots = narrative.querySelector('.chat-thinking');
    if (dots) dots.remove();
    narrative.innerHTML = '<span class="typing-cursor"></span>';
    this.scrollToTurn(handle);
  }

  appendToStream(handle, chunk) {
    const { narrative } = handle;
    const cursor = narrative.querySelector('.typing-cursor');
    if (cursor) cursor.insertAdjacentText('beforebegin', chunk);
    else narrative.insertAdjacentText('beforeend', chunk);
  }

  finishStream(handle, fullText = '') {
    const { narrative } = handle;
    const cursor = narrative.querySelector('.typing-cursor');
    if (cursor) cursor.remove();
    if (fullText) {
      narrative.innerHTML = this._formatInlineMarkdown(fullText);
      narrative.hidden = false;
    }
    if (!narrative.textContent.trim()) narrative.hidden = true;
    if (fullText) this._push('assistant', String(fullText).replace(/\*\*/g, ''));
    this.showReportActions(handle);
  }

  async typeText(handle, text, { delay = 6, chunkSize = 5 } = {}) {
    const fullText = String(text || '');
    this.startStreaming(handle);
    for (let i = 0; i < fullText.length; i += chunkSize) {
      this.appendToStream(handle, fullText.slice(i, i + chunkSize));
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    this.finishStream(handle, fullText);
  }

  /* ── 인라인 미니맵 카드 (디자인: MapCard) ── */

  setMapCard(handle, mapData, opts = {}) {
    if (!mapData?.districtCode && !mapData?.districtCodes?.length) return;
    const catColor = '#E04A3A'; // 선택 업종: 항상 빨간색

    const card = el('div', 'minimap-card');
    // 헤더: 타이틀
    const head = el('div', 'minimap-card-head');
    const headLeft = el('div', '');
    const title = el('div', 'minimap-card-title');
    title.textContent = mapData.title || mapData.districtName;
    const sub = el('div', 'minimap-card-sub');
    sub.textContent = mapData.subtitle || '+/- 또는 드래그로 지도 탐색';
    headLeft.append(title, sub);

    head.append(headLeft);
    card.appendChild(head);

    // ── 비교: 좌(대상)/우(비교) 두 지도 ──
    if (opts.dual) {
      const dual = el('div', 'minimap-dual');
      const makeCol = (name, variant) => {
        const col = el('div', 'minimap-col');
        const lbl = el('div', 'minimap-col-label');
        lbl.innerHTML = `<span class="minimap-swatch minimap-swatch--${variant}"></span>${escapeHtml(name || '')}`;
        const w = el('div', 'minimap-container');
        col.append(lbl, w);
        dual.appendChild(col);
        return w;
      };
      const left = makeCol(mapData.districtName, 'target');
      const right = makeCol(mapData.compareName, 'compare');
      card.appendChild(dual);
      if (mapData.industry) {
        const legend = el('div', 'minimap-legend');
        legend.innerHTML = `
          <span class="minimap-legend-item"><span class="minimap-dot" style="background:${catColor};border:1.2px solid #fff"></span>${escapeHtml(mapData.industry)}</span>
          <span class="minimap-legend-item"><span class="minimap-dot minimap-dot--sm" style="background:#B3AC9E"></span>기타</span>`;
        card.appendChild(legend);
      }
      handle.card.parentNode.insertBefore(card, handle.card);
      return [left, right];
    }

    // 미니맵 컨테이너
    const mapWrap = el('div', 'minimap-container');
    card.appendChild(mapWrap);

    // 범례
    const legend = el('div', 'minimap-legend');
    // 대상 동
    legend.innerHTML = `
      <span class="minimap-legend-item">
        <span class="minimap-swatch" style="border:2px solid #005F4E;background:rgba(14,124,102,0.28)"></span>
        ${escapeHtml(mapData.districtName) || (mapData.districtCodes?.length ? `선택 지역 ${mapData.districtCodes.length}곳` : '')}
      </span>
      ${mapData.compareName ? `
      <span class="minimap-legend-item">
        <span class="minimap-swatch" style="border:2px dashed #34439B;background:rgba(79,95,168,0.32)"></span>
        ${escapeHtml(mapData.compareName)}
      </span>` : ''}
      ${mapData.industry ? `
      <span class="minimap-legend-item">
        <span class="minimap-dot" style="background:${catColor};border:1.2px solid #fff;box-shadow:0 0 0 0.5px rgba(0,0,0,0.08)"></span>
        ${escapeHtml(mapData.industry)}
      </span>
      <span class="minimap-legend-item">
        <span class="minimap-dot minimap-dot--sm" style="background:#B3AC9E"></span>
        기타
      </span>` : `
      <span class="minimap-legend-item">
        <span class="minimap-dot" style="background:#2D4540;border:1.2px solid #fff;box-shadow:0 0 0 0.5px rgba(0,0,0,0.08)"></span>
        전체 업종
      </span>`}`;
    card.appendChild(legend);

    // card를 분석 카드 영역 앞에 삽입
    handle.card.parentNode.insertBefore(card, handle.card);

    return mapWrap;  // caller가 Leaflet 인스턴스를 생성할 컨테이너
  }

  /* ── 분석 카드 (기존 _build* HTML 재사용) ── */

  setAnalysisContent(handle, html) {
    handle.card.innerHTML = html;
    this.showReportActions(handle);
  }

  /* ── 후속 질문 칩 ── */

  setFollowUpChips(handle, followUps = []) {
    if (!followUps || !followUps.length) return;

    const wrap = el('div', 'chat-follow-chips');

    const hint = el('div', 'chat-chips-hint');
    hint.textContent = '또는 아래에 자유롭게 질문해 보세요';
    wrap.appendChild(hint);

    // 그룹 구조 지원: { groups: [{title, icon, chips: [{text, switchRegion?}]}] }
    if (followUps.groups && followUps.groups.length) {
      followUps.groups.forEach((group, gi) => {
        // 그룹 사이 구분선
        if (gi > 0) {
          const divider = el('hr', 'follow-divider');
          wrap.appendChild(divider);
        }
        const groupLabel = el('div', 'follow-group-label');
        groupLabel.textContent = `${group.icon || ''} ${group.title}`;
        wrap.appendChild(groupLabel);

        const row = el('div', 'chat-chips-row');
        for (const chip of group.chips) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = chip.switchRegion ? 'chip chip--switch' : 'chip';
          btn.dataset.q = chip.text;
          btn.textContent = chip.text;
          row.appendChild(btn);
        }
        wrap.appendChild(row);
      });
    } else {
      // 하위호환: 평면 string[] 배열
      const label = el('div', 'chat-chips-label');
      label.textContent = '이어서 물어보세요';
      wrap.appendChild(label);
      const row = el('div', 'chat-chips-row');
      for (const text of followUps) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chip';
        btn.dataset.q = text;
        btn.textContent = text;
        row.appendChild(btn);
      }
      wrap.appendChild(row);
    }

    handle.chips.appendChild(wrap);
  }

  /* ── 지도 보기 버튼 ── */

  addMapTrigger(handle, districtName) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip chip--map';
    btn.dataset.mapDistrict = districtName;
    btn.textContent = `🗺️ ${districtName} 지도에서 보기`;
    handle.chips.appendChild(btn);
  }

  /* ── 응답 메타 (디자인: botMeta) ── */

  setMeta(handle, metaData, badge = null) {
    if (!metaData || !handle.meta) return;
    const parts = [metaData.district, metaData.month].filter(Boolean).map(escapeHtml);
    let html = `<span class="bot-meta-dot"></span><span class="bot-meta-text">${escapeHtml(metaData.status || '분석 완료')}</span>`;
    if (badge) {
      // #RRGGBB 또는 hsl(h,s%,l%)만 허용 (CSS 주입 방지). response-builder는 hsl 생성.
      const valid = /^(#[0-9a-fA-F]{6}|hsl\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*\))$/.test(badge.color);
      const color = valid ? badge.color : '#2D4540';
      const bg = color.startsWith('hsl(') ? color.replace('hsl(', 'hsla(').replace(/\)$/, ', 0.1)') : color + '1A';
      html += `<span class="bot-meta-badge" style="background:${bg};color:${color}"><span class="bot-meta-badge-dot" style="background:${color}"></span>${escapeHtml(badge.label)}</span>`;
    }
    if (parts.length) html += `<span class="bot-meta-sub">· ${parts.join(' · ')}</span>`;
    handle.meta.innerHTML = html;
    handle.meta.hidden = false;
  }

  /* ── 필터 칩 (디자인: filterRow) ── */

  setFilterRow(handle, filters) {
    if (!filters?.length || !handle.filterRow) return;
    handle.filterRow.innerHTML = filters.map(f =>
      `<span class="filter-chip"><span class="filter-key">${escapeHtml(f.key)}</span><span class="filter-val">${escapeHtml(f.value)}</span></span>`
    ).join('');
    handle.filterRow.hidden = false;
  }

  /* ── 참고 각주 (디자인: note) ── */

  setNote(handle, noteText) {
    if (!noteText || !handle.note) return;
    handle.note.textContent = noteText;
    handle.note.hidden = false;
  }

  /* ── 에러 메시지 ── */

  showError(handle, message) {
    handle.narrative.hidden = false;
    handle.narrative.innerHTML = '';
    const errEl = el('div', 'chat-error');
    errEl.textContent = message;
    handle.narrative.appendChild(errEl);
    window.__commercialAiCaptureError?.({ turnId: handle.turnId, message });
    const dots = handle.narrative.querySelector('.chat-thinking');
    if (dots) dots.remove();
    this.scrollToTurn(handle);
  }

  /* ── 카드 내 인터랙션 ── */


  showReportActions(handle, { isError = false } = {}) {
    if (!handle?.actions) return;
    handle.actions.hidden = false;
    handle.actions.classList.toggle('has-error', Boolean(isError));
    const reportBtn = handle.actions.querySelector('[data-report-action="report-error"]');
    if (reportBtn && isError) reportBtn.classList.add('is-urgent');
  }

  onReportAction(callback) {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-report-action]');
      if (!btn) return;
      const row = btn.closest('[data-turn-id]');
      if (!row) return;
      e.preventDefault();
      callback({ action: btn.dataset.reportAction, turnId: row.dataset.turnId, button: btn, row });
    });
  }

  _buildReportActions() {
    return [
      '<button type="button" class="report-action" data-report-action="print-user" title="일반용 결과만 인쇄합니다">일반 인쇄</button>',
      '<button type="button" class="report-action" data-report-action="print-admin" title="오류·경고·진단 정보와 수정 이력을 포함해 인쇄합니다">관리용 인쇄</button>',
      '<button type="button" class="report-action" data-report-action="save-html" title="현재 결과를 HTML 파일로 저장합니다">HTML 저장</button>',
      '<button type="button" class="report-action report-action--danger" data-report-action="report-error" title="관리용 오류 보고서 HTML을 저장하고 관리자 페이지에 보관합니다">오류 신고</button>',
    ].join('');
  }
  initInteractions(handle) {
    // StatsCard / CompareCard / TrendCard 자체 인터랙션으로 충분
  }

  /* ── Gemini 맥락용 대화 기록 (최근 5턴 = 10 메시지) ── */

  getConversationHistory() {
    return this._history.slice(-10);
  }

  /* ── 새 대화 (대화 초기화 + 웰컴 복원) ── */

  resetConversation() {
    // 미니맵 Leaflet 인스턴스 정리 (메모리 누수 방지)
    this._messages.querySelectorAll('.minimap-container').forEach(mc => {
      if (mc._leafletMap) {
        mc._leafletMap.remove();
        mc._leafletMap = null;
      }
    });
    // 채팅 메시지 전부 제거 (웰컴 빼고)
    const rows = this._messages.querySelectorAll('.chat-row');
    rows.forEach(r => r.remove());
    this._history = [];
    this._firstMessage = true;
    this._turnSeq = 0;
    // 웰컴 복원 (새 대화 → 홈 상태)
    document.body.classList.remove('is-chatting');
    if (this._welcome) {
      this._welcome.hidden = false;
      this._welcome.style.transition = 'opacity 0.3s ease';
      this._welcome.style.opacity = '1';
      this._welcome.style.maxHeight = '';
      this._welcome.style.overflow = '';
    }
    this._scroll();
  }

  /* ── private ── */

  _hideWelcome() {
    if (!this._welcome || !this._firstMessage) return;
    this._firstMessage = false;
    document.body.classList.add('is-chatting'); // 홈→대화 전환: orbit/토글 노출
    this._welcome.style.transition = 'opacity 0.3s ease, max-height 0.4s ease';
    this._welcome.style.opacity = '0';
    this._welcome.style.maxHeight = '0';
    this._welcome.style.overflow = 'hidden';
    setTimeout(() => {
      this._welcome.hidden = true;
      this._scroll();  // 웰컴 숨김 후 레이아웃 변경 보정
    }, 400);
  }

  _push(role, text) {
    this._history.push({ role, text, ts: Date.now() });
    if (this._history.length > 10) this._history.splice(0, 2);
  }

  _formatInlineMarkdown(text) {
    return escapeHtml(String(text || ''))
      .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  _scroll() {
    // 이중 rAF — DOM 레이아웃 완전 완료 후 스크롤
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this._messages.scrollTop = this._messages.scrollHeight;
      });
    });
  }

  scrollToTurn(handle) {
    const target = handle?.el;
    if (!target || !this._messages) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const containerRect = this._messages.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const offset = targetRect.top - containerRect.top;
        this._messages.scrollTop += offset - 18;
      });
    });
  }
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export default ChatUI;
