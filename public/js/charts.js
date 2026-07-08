'use strict';
/* Lightweight SVG chart helpers for the dossier UI. Zero dependencies —
   builds raw <svg> nodes with createElementNS, styled from the paper/ink
   CSS custom properties so charts always match the active mood theme.

   Charts.chartLine(series, opts) -> SVG node
     series: [{x,y}, ...]  OR  [{name, color, points:[{x,y}, ...]}, ...]
     opts: { width, height, xLabels, yFormat(v), title, pad }

   Charts.chartBars(rows, opts) -> SVG node
     rows: [{label, value, color?}, ...]
     opts: { width, height, valueFormat(v), title, horizontal } */

const Charts = {

  /* ---------- shared helpers ---------- */
  _ns: 'http://www.w3.org/2000/svg',
  _svg(tag, attrs) {
    const node = document.createElementNS(this._ns, tag);
    if (attrs) for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) node.setAttribute(k, attrs[k]);
    return node;
  },
  _num(v) { const n = Number(v); return isFinite(n) ? n : 0; },
  _fmtY(v, fn) {
    if (typeof fn === 'function') { try { return fn(v); } catch (e) { /* fall through */ } }
    return (typeof fmtCompact === 'function') ? fmtCompact(v) : String(Math.round(v * 100) / 100);
  },
  _noData(width, height, title) {
    const svg = this._svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg chart-empty' });
    svg.appendChild(this._svg('rect', { x: 0, y: 0, width, height, fill: 'var(--paper)', stroke: 'var(--rule)' }));
    if (title) {
      const t = this._svg('text', { x: width / 2, y: 18, 'text-anchor': 'middle', 'font-family': 'var(--font-mono)', 'font-size': 10, fill: 'var(--ink-soft)', 'letter-spacing': '0.1em' });
      t.textContent = String(title).toUpperCase();
      svg.appendChild(t);
    }
    const msg = this._svg('text', {
      x: width / 2, y: height / 2 + 4, 'text-anchor': 'middle',
      'font-family': 'var(--font-mono)', 'font-size': 11, fill: 'var(--ink-faint)', 'letter-spacing': '0.08em'
    });
    msg.textContent = 'NO DATA';
    svg.appendChild(msg);
    return svg;
  },

  /* ---------- line chart ---------- */
  chartLine(series, opts) {
    opts = opts || {};
    const width = opts.width || 520, height = opts.height || 200;
    const pad = Object.assign({}, opts.pad || { top: 26, right: 16, bottom: 26, left: 46 });

    // Normalize input: either flat point array, or array of named lines.
    let lines;
    if (Array.isArray(series) && series.length && series[0] && Array.isArray(series[0].points)) {
      lines = series.map(s => ({ name: s.name, color: s.color, points: (s.points || []).filter(p => p && p.x !== undefined && p.y !== undefined) }));
    } else {
      lines = [{ name: null, color: opts.color, points: (series || []).filter(p => p && p.x !== undefined && p.y !== undefined) }];
    }
    lines = lines.filter(l => l.points.length);

    const allPoints = lines.reduce((a, l) => a.concat(l.points), []);
    if (!allPoints.length) return this._noData(width, height, opts.title);

    // Pre-measure the legend (multi-series only) and wrap it into rows, then
    // push the plot down below title + legend so nothing ever overlaps.
    const named = lines.filter(l => l.name);
    const defaultColors = ['var(--accent)', 'var(--ink-soft)', 'var(--good)', 'var(--accent-soft)'];
    const legendRows = [];
    if (named.length > 1) {
      const avail = width - pad.left - pad.right;
      let row = [], rowW = 0;
      named.forEach((line, li) => {
        const w = 12 + String(line.name).length * 6 + 16;
        if (rowW + w > avail && row.length) { legendRows.push(row); row = []; rowW = 0; }
        row.push({ line, li }); rowW += w;
      });
      if (row.length) legendRows.push(row);
      pad.top = (opts.title ? 24 : 8) + legendRows.length * 14 + 6;
    }

    const svg = this._svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg chart-line' });
    svg.appendChild(this._svg('rect', { x: 0, y: 0, width, height, fill: 'var(--paper)' }));

    if (opts.title) {
      const t = this._svg('text', { x: pad.left, y: 15, 'font-family': 'var(--font-mono)', 'font-size': 10, fill: 'var(--ink-soft)', 'letter-spacing': '0.1em' });
      t.textContent = String(opts.title).toUpperCase();
      svg.appendChild(t);
    }

    // legend rows, each on its own line under the title
    legendRows.forEach((row, ri) => {
      let lx = pad.left;
      const ly = (opts.title ? 24 : 8) + ri * 14 + 4;
      for (const { line, li } of row) {
        const color = line.color || defaultColors[li % defaultColors.length];
        svg.appendChild(this._svg('rect', { x: lx, y: ly - 7, width: 8, height: 8, fill: color }));
        const lbl = this._svg('text', { x: lx + 12, y: ly, 'font-family': 'var(--font-mono)', 'font-size': 9, fill: 'var(--ink-soft)' });
        lbl.textContent = line.name;
        svg.appendChild(lbl);
        lx += 12 + String(line.name).length * 6 + 16;
      }
    });

    const plotX0 = pad.left, plotX1 = width - pad.right;
    const plotY0 = pad.top, plotY1 = height - pad.bottom;
    const plotW = Math.max(1, plotX1 - plotX0), plotH = Math.max(1, plotY1 - plotY0);

    let yMin = Math.min(...allPoints.map(p => this._num(p.y)));
    let yMax = Math.max(...allPoints.map(p => this._num(p.y)));
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const headroom = (yMax - yMin) * 0.1;
    yMin -= headroom; yMax += headroom;

    const xCount = Math.max(...lines.map(l => l.points.length), 1);
    const xScale = (i) => xCount <= 1 ? (plotX0 + plotW / 2) : plotX0 + (i / (xCount - 1)) * plotW;
    const yScale = (v) => plotY1 - ((this._num(v) - yMin) / (yMax - yMin)) * plotH;

    // outer frame
    svg.appendChild(this._svg('rect', { x: plotX0, y: plotY0, width: plotW, height: plotH, fill: 'none', stroke: 'var(--rule-strong)', 'stroke-width': 1 }));

    // gridlines + y labels (rounded to one decimal — floating-point noise
    // like "0.9999996%" must never reach the axis)
    const gridRows = 4;
    for (let i = 0; i <= gridRows; i++) {
      const gy = plotY0 + (i / gridRows) * plotH;
      const val = Math.round((yMax - (i / gridRows) * (yMax - yMin)) * 10) / 10;
      svg.appendChild(this._svg('line', { x1: plotX0, y1: gy, x2: plotX1, y2: gy, stroke: 'var(--rule)', 'stroke-width': 1 }));
      const lbl = this._svg('text', { x: plotX0 - 6, y: gy + 3, 'text-anchor': 'end', 'font-family': 'var(--font-mono)', 'font-size': 9, fill: 'var(--ink-faint)' });
      lbl.textContent = this._fmtY(val, opts.yFormat);
      svg.appendChild(lbl);
    }

    // x labels
    const xLabels = opts.xLabels || lines[0].points.map(p => p.x);
    const maxLabels = Math.min(xLabels.length, 8);
    const step = Math.max(1, Math.ceil(xLabels.length / maxLabels));
    for (let i = 0; i < xLabels.length; i += step) {
      const lx = xScale(i);
      const lbl = this._svg('text', { x: lx, y: plotY1 + 15, 'text-anchor': 'middle', 'font-family': 'var(--font-mono)', 'font-size': 9, fill: 'var(--ink-faint)' });
      lbl.textContent = String(xLabels[i]);
      svg.appendChild(lbl);
    }

    // lines
    lines.forEach((line, li) => {
      const color = line.color || defaultColors[li % defaultColors.length];
      if (line.points.length === 1) {
        const p = line.points[0];
        svg.appendChild(this._svg('circle', { cx: xScale(0), cy: yScale(p.y), r: 3, fill: color }));
        return;
      }
      const d = line.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i).toFixed(2)} ${yScale(p.y).toFixed(2)}`).join(' ');
      svg.appendChild(this._svg('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.6 }));
    });

    return svg;
  },

  /* ---------- bar chart ---------- */
  chartBars(rows, opts) {
    opts = opts || {};
    const width = opts.width || 520, height = opts.height || 200;
    const clean = (rows || []).filter(r => r && r.label !== undefined).map(r => ({ label: r.label, value: this._num(r.value), color: r.color, onClick: r.onClick }));
    if (!clean.length) return this._noData(width, height, opts.title);
    // hover highlight + optional click-through on a bar
    const wire = (node, r) => {
      node.classList.add('bar-rect');
      if (r.onClick) { node.classList.add('chart-clickable'); node.addEventListener('click', r.onClick); }
      const tip = this._svg('title');
      tip.textContent = `${r.label} — ${(typeof opts.valueFormat === 'function') ? opts.valueFormat(r.value) : this._fmtY(r.value)}`;
      node.appendChild(tip);
      return node;
    };

    const svg = this._svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg chart-bars' });
    svg.appendChild(this._svg('rect', { x: 0, y: 0, width, height, fill: 'var(--paper)' }));

    const titleH = opts.title ? 20 : 6;
    if (opts.title) {
      const t = this._svg('text', { x: 12, y: 15, 'font-family': 'var(--font-mono)', 'font-size': 10, fill: 'var(--ink-soft)', 'letter-spacing': '0.1em' });
      t.textContent = String(opts.title).toUpperCase();
      svg.appendChild(t);
    }

    const maxVal = Math.max(...clean.map(r => r.value), 1);
    const fmtV = (v) => (typeof opts.valueFormat === 'function') ? opts.valueFormat(v) : this._fmtY(v);

    if (opts.horizontal) {
      const padLeft = 90, padRight = 56, padTop = titleH + 4, padBottom = 10;
      const plotW = Math.max(1, width - padLeft - padRight);
      const rowH = Math.max(1, (height - padTop - padBottom) / clean.length);
      clean.forEach((r, i) => {
        const y = padTop + i * rowH + rowH * 0.2;
        const barH = rowH * 0.6;
        const barW = (r.value / maxVal) * plotW;
        const lbl = this._svg('text', { x: padLeft - 8, y: y + barH / 2 + 3, 'text-anchor': 'end', 'font-family': 'var(--font-mono)', 'font-size': 9.5, fill: 'var(--ink-soft)' });
        lbl.textContent = String(r.label);
        svg.appendChild(lbl);
        svg.appendChild(wire(this._svg('rect', {
          x: padLeft, y, width: Math.max(0, barW), height: barH,
          fill: r.color || 'var(--accent)', stroke: 'var(--rule-strong)', 'stroke-width': 0.75
        }), r));
        const val = this._svg('text', { x: padLeft + Math.max(0, barW) + 6, y: y + barH / 2 + 3, 'font-family': 'var(--font-mono)', 'font-size': 9.5, fill: 'var(--ink-faint)' });
        val.textContent = fmtV(r.value);
        svg.appendChild(val);
      });
    } else {
      const padLeft = 34, padRight = 10, padTop = titleH + 14, padBottom = 24;
      const plotW = Math.max(1, width - padLeft - padRight);
      const plotH = Math.max(1, height - padTop - padBottom);
      svg.appendChild(this._svg('line', { x1: padLeft, y1: padTop + plotH, x2: width - padRight, y2: padTop + plotH, stroke: 'var(--rule-strong)', 'stroke-width': 1 }));
      const colW = plotW / clean.length;
      clean.forEach((r, i) => {
        const barW = Math.min(colW * 0.6, 48);
        const barH = (r.value / maxVal) * plotH;
        const x = padLeft + i * colW + (colW - barW) / 2;
        const y = padTop + plotH - barH;
        svg.appendChild(wire(this._svg('rect', {
          x, y, width: barW, height: Math.max(0, barH),
          fill: r.color || 'var(--accent)', stroke: 'var(--rule-strong)', 'stroke-width': 0.75
        }), r));
        const val = this._svg('text', { x: x + barW / 2, y: y - 4, 'text-anchor': 'middle', 'font-family': 'var(--font-mono)', 'font-size': 9, fill: 'var(--ink-faint)' });
        val.textContent = fmtV(r.value);
        svg.appendChild(val);
        const lbl = this._svg('text', { x: x + barW / 2, y: padTop + plotH + 14, 'text-anchor': 'middle', 'font-family': 'var(--font-mono)', 'font-size': 9, fill: 'var(--ink-soft)' });
        lbl.textContent = String(r.label);
        svg.appendChild(lbl);
      });
    }

    return svg;
  },

  /* ---------- pie chart ----------
     rows: [{label, value, color?, onClick?}, ...]
     opts: { width, height, title, valueFormat(v) } — slices are drawn
     clockwise from 12 o'clock with a legend on the right showing each
     label and its percentage share. Rows with onClick highlight on hover
     (slice AND legend line) and fire on click. */
  chartPie(rows, opts) {
    opts = opts || {};
    const width = opts.width || 320, height = opts.height || 170;
    const clean = (rows || [])
      .filter(r => r && r.label !== undefined && this._num(r.value) > 0)
      .map(r => ({ label: r.label, value: this._num(r.value), color: r.color, onClick: r.onClick }))
      .sort((a, b) => b.value - a.value);
    const total = clean.reduce((s, r) => s + r.value, 0);
    if (!clean.length || total <= 0) return this._noData(width, height, opts.title);

    const svg = this._svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg chart-pie' });
    svg.appendChild(this._svg('rect', { x: 0, y: 0, width, height, fill: 'var(--paper)' }));
    const titleH = opts.title ? 20 : 4;
    if (opts.title) {
      const t = this._svg('text', { x: 12, y: 15, 'font-family': 'var(--font-mono)', 'font-size': 10, fill: 'var(--ink-soft)', 'letter-spacing': '0.1em' });
      t.textContent = String(opts.title).toUpperCase();
      svg.appendChild(t);
    }

    // fallback palette for slices without a colour of their own
    const PALETTE = ['#8a3c34', '#3c5a74', '#7a6a34', '#4a6a48', '#6a4a68', '#a0763a', '#54666e', '#8a8054'];
    const cx = 12 + (height - titleH - 16) / 2, cy = titleH + (height - titleH) / 2;
    const R = (height - titleH - 16) / 2;

    // legend layout first: cap rows to the box height (reserving one line for
    // "+n more" when the list is longer) and truncate labels to the width
    const legendX = cx + R + 16;
    const maxChars = Math.max(6, Math.floor((width - legendX - 22) / 5.9));
    const maxRows = Math.max(1, Math.floor((height - titleH - 14) / 15));
    const shown = clean.length > maxRows ? clean.slice(0, maxRows - 1) : clean;
    const fmtV = (v) => (typeof opts.valueFormat === 'function') ? opts.valueFormat(v) : (Math.round(v / total * 1000) / 10) + '%';

    const nodesFor = []; // per-row [slice, legendGroup] pairs for hover sync
    let angle = -Math.PI / 2; // start at 12 o'clock
    const pt = (a) => [cx + R * Math.cos(a), cy + R * Math.sin(a)];
    clean.forEach((r, i) => {
      const sweep = (r.value / total) * Math.PI * 2;
      const color = r.color || PALETTE[i % PALETTE.length];
      let node;
      if (clean.length === 1) {
        node = this._svg('circle', { cx, cy, r: R, fill: color });
      } else {
        const [x1, y1] = pt(angle);
        const [x2, y2] = pt(angle + sweep);
        node = this._svg('path', {
          d: `M ${cx} ${cy} L ${x1} ${y1} A ${R} ${R} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`,
          fill: color
        });
      }
      node.setAttribute('stroke', 'var(--paper)');
      node.setAttribute('stroke-width', '1.5');
      node.setAttribute('class', 'pie-slice' + (r.onClick ? ' chart-clickable' : ''));
      const tip = this._svg('title');
      tip.textContent = `${r.label} — ${Math.round(r.value / total * 1000) / 10}%`;
      node.appendChild(tip);
      svg.appendChild(node);
      nodesFor[i] = [node];
      angle += sweep;
    });

    shown.forEach((r, i) => {
      const y = titleH + 12 + i * 15;
      const lg = this._svg('g', { class: 'pie-legend-row' + (r.onClick ? ' chart-clickable' : '') });
      lg.appendChild(this._svg('rect', { x: legendX, y: y - 8, width: 9, height: 9, fill: r.color || PALETTE[i % PALETTE.length], stroke: 'var(--rule-strong)', 'stroke-width': 0.5 }));
      const suffix = ' · ' + fmtV(r.value);
      const t = this._svg('text', { x: legendX + 14, y, 'font-family': 'var(--font-mono)', 'font-size': 9.5, fill: 'var(--ink-soft)' });
      t.textContent = String(r.label).slice(0, Math.max(3, maxChars - suffix.length)) + suffix;
      lg.appendChild(t);
      svg.appendChild(lg);
      nodesFor[i].push(lg);
    });
    if (clean.length > shown.length) {
      const t = this._svg('text', { x: legendX + 14, y: titleH + 12 + shown.length * 15, 'font-family': 'var(--font-mono)', 'font-size': 9, fill: 'var(--ink-faint)' });
      t.textContent = `+${clean.length - shown.length} more`;
      svg.appendChild(t);
    }

    // hover highlight (slice + legend together) and click-through
    clean.forEach((r, i) => {
      const pair = nodesFor[i].filter(Boolean);
      for (const n of pair) {
        n.addEventListener('mouseenter', () => pair.forEach(x => x.classList.add('chart-hot')));
        n.addEventListener('mouseleave', () => pair.forEach(x => x.classList.remove('chart-hot')));
        if (r.onClick) n.addEventListener('click', r.onClick);
      }
    });
    return svg;
  }
};
