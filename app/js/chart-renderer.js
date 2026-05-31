/**
 * Chart.js 래퍼 — 응답 카드 내 캔버스에 차트 렌더링.
 * Chart.js가 로드되지 않았으면 아무 동작도 하지 않음 (graceful degradation).
 */
export class ChartRenderer {
  constructor() {
    this._instances = new WeakMap();
  }

  /**
   * canvas 엘리먼트에 차트 렌더링.
   * @param {HTMLCanvasElement} canvas
   * @param {{ type: string, title: string, data: Array }} spec
   */
  render(canvas, spec) {
    if (!canvas || !spec || typeof Chart === 'undefined') return;

    // 기존 인스턴스 파괴
    if (this._instances.has(canvas)) {
      this._instances.get(canvas).destroy();
    }

    const builder = {
      bar: () => this._bar(canvas, spec),
      groupedBar: () => this._groupedBar(canvas, spec),
      horizontalBar: () => this._horizontalBar(canvas, spec),
      compareBar: () => this._compareBar(canvas, spec),
      compareBarVertical: () => this._compareBarVertical(canvas, spec),
      trendLine: () => this._trendLine(canvas, spec),
      line: () => this._line(canvas, spec),
      multiLine: () => this._multiLine(canvas, spec),
      stackedBar: () => this._stackedBar(canvas, spec),
      doughnut: () => this._doughnut(canvas, spec),
    };

    const chart = (builder[spec.type] || builder.bar)();
    if (chart) this._instances.set(canvas, chart);
  }

  _bar(canvas, spec) {
    const items = this._normalizeItems(spec.data);
    const ctx = canvas.getContext('2d');
    const colors = this._palette(items.length);
    const gradients = colors.map(c => this._gradient(ctx, c, 200));
    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels: items.map((i) => i.label),
        datasets: [{
          label: spec.title || '',
          data: items.map((i) => i.value),
          backgroundColor: gradients,
          borderRadius: 6,
        }],
      },
      options: this._baseOptions(spec.title),
    });
  }

  _groupedBar(canvas, spec) {
    const raw = spec.data || {};
    const labels = raw.labels || [];
    const datasets = raw.datasets || [];
    if (!labels.length || !datasets.length) return this._bar(canvas, spec);

    const ctx = canvas.getContext('2d');
    const colors = this._palette(datasets.length);
    const chartDatasets = datasets.map((ds, i) => ({
      label: ds.label || '',
      data: ds.data || [],
      backgroundColor: colors[i],
      borderRadius: 6,
    }));

    const fmt = (v) => Number(v).toLocaleString('ko-KR');
    return new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets: chartDatasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: !!spec.title, text: spec.title, font: { size: 14, weight: '700' } },
          legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 10 } },
          tooltip: {
            callbacks: {
              label: (tip) => `${tip.dataset.label}: ${fmt(tip.parsed.y ?? 0)}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 } } },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(0,0,0,0.06)' },
            ticks: { font: { size: 11 }, callback: (v) => fmt(v) },
          },
        },
      },
    });
  }

  _horizontalBar(canvas, spec) {
    const items = this._normalizeItems(spec.data);
    const ctx = canvas.getContext('2d');
    const colors = this._palette(items.length);
    const gradients = colors.map(c => this._gradientH(ctx, c, canvas.width || 300));
    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels: items.map((i) => i.label),
        datasets: [{
          label: spec.title || '',
          data: items.map((i) => i.value),
          backgroundColor: gradients,
          borderRadius: 6,
        }],
      },
      options: this._horizontalBarOptions(spec.title),
    });
  }

  _line(canvas, spec) {
    const items = this._normalizeItems(spec.data);
    const values = items.map((i) => i.value ?? i.amt ?? 0);
    const isUp = values.length >= 2 && values[values.length - 1] >= values[0];
    const lineColor = isUp ? '#1f5a4a' : '#b91c1c';
    const ctx = canvas.getContext('2d');
    const fillGrad = ctx.createLinearGradient(0, 0, 0, 200);
    fillGrad.addColorStop(0, isUp ? 'rgba(31,90,74,0.25)' : 'rgba(185,28,28,0.2)');
    fillGrad.addColorStop(1, 'rgba(255,255,255,0)');
    return new Chart(canvas, {
      type: 'line',
      data: {
        labels: items.map((i) => i.label || i.month || ''),
        datasets: [{
          label: spec.title || '',
          data: values,
          borderColor: lineColor,
          backgroundColor: fillGrad,
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: lineColor,
        }],
      },
      options: this._baseOptions(spec.title),
    });
  }

  _doughnut(canvas, spec) {
    const items = this._normalizeItems(spec.data);
    return new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: items.map((i) => i.label),
        datasets: [{
          data: items.map((i) => i.value),
          backgroundColor: this._palette(items.length),
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: !!spec.title, text: spec.title, font: { size: 14 } },
          legend: { position: 'bottom', labels: { boxWidth: 12, padding: 8 } },
        },
      },
    });
  }

  /**
   * multiLine — 2개 이상 데이터셋을 같은 축에 겹침 (비교 시계열).
   * spec.data = { labels: [], datasets: [{ label, data: [] }, ...] }
   */
  _multiLine(canvas, spec) {
    const raw = spec.data || {};
    const labels = raw.labels || [];
    const datasets = raw.datasets || [];
    if (!labels.length || !datasets.length) return this._line(canvas, spec);

    const colors = ['#1f5a4a', '#d4944a', '#3b4686', '#c07050'];
    const ctx = canvas.getContext('2d');
    const chartDatasets = datasets.map((ds, i) => {
      const color = colors[i % colors.length];
      const fillGrad = ctx.createLinearGradient(0, 0, 0, 200);
      fillGrad.addColorStop(0, color + '30');
      fillGrad.addColorStop(1, 'rgba(255,255,255,0)');
      return {
        label: ds.label || '',
        data: ds.data || [],
        borderColor: color,
        backgroundColor: fillGrad,
        fill: i === 0,
        tension: 0.3,
        pointRadius: 3,
        pointHoverRadius: 5,
        pointBackgroundColor: color,
        borderWidth: 2,
      };
    });

    const fmt = (v) => Number(v).toLocaleString('ko-KR');
    return new Chart(canvas, {
      type: 'line',
      data: { labels, datasets: chartDatasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: !!spec.title, text: spec.title, font: { size: 14, weight: '700' } },
          legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 10, usePointStyle: true } },
          tooltip: {
            mode: 'index', intersect: false,
            callbacks: { label: (tip) => `${tip.dataset.label}: ${fmt(tip.parsed.y ?? 0)}` },
          },
        },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 } },
          y: {
            beginAtZero: false,
            grid: { color: 'rgba(0,0,0,0.06)' },
            ticks: { font: { size: 11 }, callback: (v) => fmt(v) },
          },
        },
      },
    });
  }

  /**
   * stackedBar — 업종 구성 등 적층 막대.
   * spec.data = { labels: [], datasets: [{ label, data: [] }, ...] }
   */
  _stackedBar(canvas, spec) {
    const raw = spec.data || {};
    const labels = raw.labels || [];
    const datasets = raw.datasets || [];
    if (!labels.length || !datasets.length) return this._bar(canvas, spec);

    const colors = this._palette(datasets.length);
    const chartDatasets = datasets.map((ds, i) => ({
      label: ds.label || '',
      data: ds.data || [],
      backgroundColor: colors[i],
      borderRadius: 4,
    }));

    const fmt = (v) => Number(v).toLocaleString('ko-KR');
    return new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets: chartDatasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: { display: !!spec.title, text: spec.title, font: { size: 14, weight: '700' } },
          legend: { display: true, position: 'top', labels: { boxWidth: 10, padding: 8 } },
          tooltip: {
            callbacks: { label: (tip) => `${tip.dataset.label}: ${fmt(tip.parsed.y ?? 0)}` },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { font: { size: 11 } } },
          y: {
            stacked: true,
            beginAtZero: true,
            grid: { color: 'rgba(0,0,0,0.06)' },
            ticks: { font: { size: 11 }, callback: (v) => fmt(v) },
          },
        },
      },
    });
  }

  /** CompareCard — 디자인: 수평 bar (동/구/시 3단 비교) */
  _compareBar(canvas, spec) {
    const items = spec.items || [];
    if (!items.length) return null;
    const colors = ['#2D4540', '#7BA898', '#C5D5CE'];
    const fmt = (v) => Number(v).toLocaleString('ko-KR');
    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels: items.map(i => i.label),
        datasets: [{
          data: items.map(i => i.value),
          backgroundColor: items.map((_, i) => colors[i % colors.length]),
          borderRadius: 4,
          barThickness: 18,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (tip) => `${fmt(tip.parsed.x ?? 0)}${spec.unit || ''}`,
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            grid: { color: 'rgba(0,0,0,0.04)' },
            ticks: { font: { size: 11 }, callback: (v) => fmt(v) },
          },
          y: {
            grid: { display: false },
            ticks: { font: { size: 12, weight: '600' }, color: '#1A1916' },
          },
        },
      },
    });
  }

  /** CompareCard 세로 — 요일별 유동인구 등 카테고리 비교 */
  _compareBarVertical(canvas, spec) {
    const items = spec.items || [];
    if (!items.length) return null;
    const colors = ['#2D4540', '#3A6B5E', '#4E8E7D', '#6BB8A8', '#8ECABC', '#A3D5CA', '#C8E6DF'];
    const fmt = (v) => Number(v).toLocaleString('ko-KR');
    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels: items.map(i => i.label),
        datasets: [{
          data: items.map(i => i.value),
          backgroundColor: items.map((_, i) => colors[i % colors.length]),
          borderRadius: 6,
          barThickness: 28,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (tip) => `${fmt(tip.parsed.y ?? 0)}${spec.unit || ''}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 12, weight: '600' }, color: '#1A1916' } },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(0,0,0,0.04)' },
            ticks: { font: { size: 11 }, callback: (v) => fmt(v) },
          },
        },
      },
    });
  }

  /** TrendCard — 디자인: 12개월 3-시리즈 라인차트 */
  _trendLine(canvas, spec) {
    const series = spec.series || [];
    const labels = spec.labels || [];
    if (!series.length || !labels.length) return null;
    const ctx = canvas.getContext('2d');
    const datasets = series.map((s, i) => {
      const color = s.color || ['#2D4540', '#A29E94', '#D6D1C5'][i % 3];
      const fillGrad = i === 0 ? (() => {
        const g = ctx.createLinearGradient(0, 0, 0, 200);
        g.addColorStop(0, color + '20');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        return g;
      })() : false;
      return {
        label: s.label || '',
        data: s.data || [],
        borderColor: color,
        backgroundColor: fillGrad || 'transparent',
        fill: i === 0,
        tension: 0.35,
        pointRadius: 2,
        pointHoverRadius: 5,
        pointBackgroundColor: color,
        borderWidth: i === 0 ? 2.5 : 1.5,
        borderDash: s.dashed ? [6, 3] : s.dotted ? [2, 3] : [],
      };
    });
    const fmt = (v) => Number(v).toLocaleString('ko-KR');
    return new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index', intersect: false,
            callbacks: { label: (tip) => `${tip.dataset.label}: ${fmt(tip.parsed.y ?? 0)}` },
          },
        },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0 } },
          y: {
            beginAtZero: false,
            grid: { color: 'rgba(0,0,0,0.04)' },
            ticks: { font: { size: 11 }, callback: (v) => fmt(v) },
          },
        },
      },
    });
  }

  _normalizeItems(data) {
    if (!Array.isArray(data)) return [];
    return data.map((item) => {
      if (typeof item === 'object' && item !== null) {
        return {
          label: item.label || item.month || item.name || '',
          value: item.value ?? item.amt ?? 0,
        };
      }
      return { label: String(item), value: 0 };
    });
  }

  _baseOptions(title) {
    const fmt = (v) => Number(v).toLocaleString('ko-KR');
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: !!title, text: title, font: { size: 14, weight: '700' } },
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label || ''}: ${fmt(ctx.parsed.y ?? ctx.parsed.x ?? 0)}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(0,0,0,0.06)' },
          ticks: { font: { size: 11 }, callback: (v) => fmt(v) },
        },
      },
    };
  }

  _horizontalBarOptions(title) {
    const fmt = (v) => Number(v).toLocaleString('ko-KR');
    return {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: {
        title: { display: !!title, text: title, font: { size: 14, weight: '700' } },
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label || ''}: ${fmt(ctx.parsed.x ?? 0)}`,
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: 'rgba(0,0,0,0.06)' },
          ticks: { font: { size: 11 }, callback: (v) => fmt(v) },
        },
        y: {
          grid: { display: false },
          ticks: { font: { size: 11 }, autoSkip: false },
        },
      },
    };
  }

  _gradient(ctx, hex, height = 200) {
    const g = ctx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, hex);
    g.addColorStop(1, hex + '26'); // ~15% opacity
    return g;
  }

  _gradientH(ctx, hex, width = 300) {
    const g = ctx.createLinearGradient(0, 0, width, 0);
    g.addColorStop(0, hex);
    g.addColorStop(1, hex + '26');
    return g;
  }

  _palette(count) {
    const base = [
      '#1f5a4a', '#2d7d6b', '#3fa08c', '#6bb8a8', '#a3d5ca',
      '#c8e6df', '#e0b040', '#d4944a', '#c07050', '#a85060',
    ];
    const result = [];
    for (let i = 0; i < count; i += 1) {
      result.push(base[i % base.length]);
    }
    return result;
  }
}

export default ChartRenderer;
