/**
 * autocomplete.js — 검색 입력 자동완성 (제시어 예측)
 * 지역명, 업종명, 질문 템플릿을 실시간 추천
 */
export class Autocomplete {
  /**
   * @param {HTMLTextAreaElement} inputEl — 검색 입력 필드
   * @param {{ districts: {name:string,sgg:string}[], industries: string[], aliases: object }} data
   * @param {(q: string) => void} onSelect — 제시어 선택 시 콜백
   */
  constructor(inputEl, data, onSelect) {
    this._input = inputEl;
    this._onSelect = onSelect;
    this._districts = data.districts || [];
    this._industries = data.industries || [];
    this._aliases = data.aliases || {};
    this._selectedIdx = -1;
    this._visible = false;

    // 드롭다운 생성
    this._dropdown = document.createElement('div');
    this._dropdown.className = 'ac-dropdown';
    this._dropdown.hidden = true;
    inputEl.parentElement.style.position = 'relative';
    inputEl.parentElement.appendChild(this._dropdown);

    // 자주 쓰는 질문 템플릿
    this._templates = [
      { text: '{district} 어때?', label: '종합 현황' },
      { text: '{district} {industry} 매출', label: '매출 분석' },
      { text: '{district} {industry} 추세', label: '추세 분석' },
      { text: '{district} {industry} vs {industry2} 비교', label: '업종 비교' },
    ];

    // 이벤트 연결
    this._input.addEventListener('input', () => this._onInput());
    this._input.addEventListener('keydown', (e) => this._onKeydown(e));
    this._input.addEventListener('focus', () => { if (this._input.value.trim()) this._onInput(); });
    document.addEventListener('click', (e) => {
      if (!this._dropdown.contains(e.target) && e.target !== this._input) this._hide();
    });
  }

  /* ── 입력 변경 시 ── */

  _onInput() {
    const raw = this._input.value.trim();
    if (!raw) { this._hide(); return; }

    const suggestions = this._buildSuggestions(raw);
    if (!suggestions.length) { this._hide(); return; }

    this._render(suggestions);
    this._show();
  }

  /* ── 제시어 생성 ── */

  _buildSuggestions(query) {
    const q = query.toLowerCase().replace(/\s+/g, '');
    const results = [];
    const seen = new Set();

    // 1) 지역명 매칭
    for (const d of this._districts) {
      if (results.length >= 8) break;
      const dn = d.name.toLowerCase().replace(/\s+/g, '');
      if (dn.includes(q) || q.includes(dn.replace('동', ''))) {
        // 지역 발견 → 질문 템플릿 제시
        const key = `d:${d.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ type: 'query', text: `${d.name} 어때?`, tag: d.sgg, icon: '📍' });
        if (results.length < 8) {
          results.push({ type: 'query', text: `${d.name} 카페 매출`, tag: '매출', icon: '☕' });
        }
      }
    }

    // 2) 업종명 매칭
    for (const ind of this._industries) {
      if (results.length >= 8) break;
      const ci = ind.toLowerCase().replace(/\s+/g, '');
      if (ci.includes(q) || q.includes(ci)) {
        const key = `i:${ind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ type: 'industry', text: ind, tag: '업종', icon: '🏪' });
      }
    }

    // 3) 별칭 매칭
    for (const [alias, canonical] of Object.entries(this._aliases)) {
      if (results.length >= 8) break;
      if (alias.includes(q) || q.includes(alias.toLowerCase())) {
        const key = `a:${canonical}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ type: 'industry', text: `${alias} → ${canonical}`, tag: '별칭', icon: '🔄', value: canonical });
      }
    }

    // 4) 복합 매칭: 지역+업종 조합 인식
    if (results.length < 4) {
      const distMatch = this._districts.find(d => {
        const dn = d.name.replace('동', '');
        return q.includes(dn.toLowerCase());
      });
      const indMatch = this._industries.find(ind => {
        return q.includes(ind.toLowerCase().replace(/\s+/g, ''));
      });
      if (distMatch && indMatch) {
        const templates = [
          `${distMatch.name} ${indMatch} 매출 어때?`,
          `${distMatch.name} ${indMatch} 추세`,
          `${distMatch.name} ${indMatch} 업소 수`,
        ];
        for (const t of templates) {
          if (results.length >= 8) break;
          const key = `t:${t}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ type: 'query', text: t, tag: '추천', icon: '✨' });
        }
      }
    }

    return results.slice(0, 7);
  }

  /* ── 렌더링 ── */

  _render(suggestions) {
    this._selectedIdx = -1;
    this._dropdown.innerHTML = suggestions.map((s, i) => `
      <div class="ac-item" data-idx="${i}" data-value="${this._escHtml(s.value || s.text)}">
        <span class="ac-icon">${s.icon}</span>
        <span class="ac-text">${this._highlight(s.text, this._input.value.trim())}</span>
        <span class="ac-tag">${s.tag}</span>
      </div>
    `).join('');

    // 클릭 이벤트
    this._dropdown.querySelectorAll('.ac-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const val = el.dataset.value;
        // "별칭 → 정식명" 형태면 정식명만 입력에 넣기
        const cleanVal = val.includes('→') ? val.split('→').pop().trim() : val;
        this._select(cleanVal);
      });
    });
  }

  _highlight(text, query) {
    if (!query) return this._escHtml(text);
    const escaped = this._escHtml(text);
    const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escaped.replace(new RegExp(`(${q})`, 'gi'), '<mark>$1</mark>');
  }

  /* ── 키보드 네비게이션 ── */

  _onKeydown(e) {
    if (!this._visible) return;
    const items = this._dropdown.querySelectorAll('.ac-item');
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._selectedIdx = Math.min(this._selectedIdx + 1, items.length - 1);
      this._updateSelection(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._selectedIdx = Math.max(this._selectedIdx - 1, -1);
      this._updateSelection(items);
    } else if (e.key === 'Enter' && this._selectedIdx >= 0) {
      e.preventDefault();
      e.stopPropagation();
      const val = items[this._selectedIdx].dataset.value;
      const cleanVal = val.includes('→') ? val.split('→').pop().trim() : val;
      this._select(cleanVal);
    } else if (e.key === 'Escape') {
      this._hide();
    }
  }

  _updateSelection(items) {
    items.forEach((el, i) => el.classList.toggle('ac-active', i === this._selectedIdx));
    if (this._selectedIdx >= 0) items[this._selectedIdx].scrollIntoView({ block: 'nearest' });
  }

  /* ── 선택/제출 ── */

  _select(text) {
    this._input.value = text;
    this._input.style.height = 'auto';
    this._input.style.height = Math.min(this._input.scrollHeight, 160) + 'px';
    this._hide();
    // 선택된 텍스트가 완전한 질문이면 바로 전송
    if (text.includes('어때') || text.includes('매출') || text.includes('추세') || text.includes('비교') || text.includes('업소')) {
      this._onSelect(text);
    } else {
      this._input.focus();
    }
  }

  _show() {
    this._dropdown.hidden = false;
    this._visible = true;
  }

  _hide() {
    this._dropdown.hidden = true;
    this._visible = false;
    this._selectedIdx = -1;
  }

  _escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
