/**
 * capacity.js — Capacity & Forecasting page logic (Phase 8)
 *
 * Per decision #6: build the FULL UI now, backed by a plausible
 * client-computed mock data series. No new backend endpoint in this phase
 * (unlike Infrastructure/Services in Phases 6-7) — everything here runs
 * off locally-generated numbers.
 *
 * BACKEND SWAP-IN PATH (read this before Phase-15-adjacent backend work):
 *   Every control (source tab, History Window, Forecast Horizon, Algorithm)
 *   funnels through the single function getCapacityData({ sourceId,
 *   historyDays, horizonDays, algorithm }) below. It currently computes the
 *   mock series + forecast + comparison rows + recommendations locally and
 *   returns them in one object. When a real backend exists, replace just
 *   this function's body with `return API.getCapacity(params)` — as long
 *   as the endpoint returns the same shape (see the JSDoc on the function),
 *   nothing else on this page needs to change.
 *
 * Sources: "all" (aggregate across every configured MCP server) + one tab
 * per live server (from backend/data/mcpservers.json, same list Settings →
 * MCP Servers edits — same live-servers pattern as dashboard.js/topology.js/
 * user_management.js). Falls back to the legacy fixed CFG.TOOLS list only if
 * no servers are configured yet, so the page still renders something
 * sensible on a fresh install. Nothing here is hardcoded to any specific
 * server names — whatever the live list contains is what renders.
 *
 * DEPENDENCIES (must load before this file):
 *   config.js  → window.CFG   (TOOLS, legacy fallback)
 *   api.js     → window.API   (API.getMcpServers() for the live list; not
 *                used for capacity data yet — see swap-in path above)
 *   common.js  → window.Utils
 *   Chart.js (vendored, loaded in capacity.html <head>)
 */

(function (global) {
  "use strict";

  if (!global.CFG) {
    console.error("[capacity.js] CFG not found — did config.js load?");
    return;
  }

  /* Live MCP servers list — populated by loadSources(), falls back to
     CFG.TOOLS (legacy fixed 4) if no servers are configured yet. */
  let SOURCES = global.CFG.TOOLS || [];

  async function loadSources() {
    try {
      if (global.API && typeof global.API.getMcpServers === "function") {
        const { servers } = await global.API.getMcpServers();
        if (Array.isArray(servers) && servers.length > 0) {
          SOURCES = servers.map(s => ({
            id:    s.id,
            name:  s.name,
            color: s.color || "#6366f1",
          }));
        }
      }
    } catch (e) {
      console.warn("[capacity] getMcpServers failed, falling back to CFG.TOOLS:", e);
    }
  }

  /* ─── State ───────────────────────────────────────────────────────────── */
  const state = {
    sourceId:    "all",
    historyDays: 14,
    horizonDays: 7,
    algorithm:   "linear",
    loaded:      false,
  };

  let cpuChart = null;
  let memChart = null;

  const ALGO_META = {
    linear:        { label: "Linear Regression",     bestFor: "Steady, trending growth" },
    moving_avg:    { label: "Moving Average",         bestFor: "Stable, low-variance workloads" },
    exp_smoothing: { label: "Exponential Smoothing",  bestFor: "Recent-weighted, noisy signals" },
    seasonal:      { label: "Seasonal (7-day)",       bestFor: "Workloads with weekly cycles" },
  };

  /* ─── Deterministic pseudo-random (seeded) ───────────────────────────────
     Same seed → same series every time, so switching tabs back and forth
     doesn't visibly "reshuffle" data that was already shown. Not
     cryptographic — just a small mulberry32-style PRNG.
  ──────────────────────────────────────────────────────────────────────── */
  function seededRandom(seed) {
    let s = seed >>> 0;
    return function () {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSeed(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return h;
  }

  /* ─── Mock historical series generator ───────────────────────────────────
     Produces `days` points ending "today" for one metric (cpu|mem), with a
     mild upward trend + weekly seasonality + bounded noise, clamped 0-100.
  ──────────────────────────────────────────────────────────────────────── */
  function generateSeries(sourceId, metric, days) {
    const rand = seededRandom(hashSeed(sourceId + ":" + metric));
    const base = metric === "cpu" ? 38 + rand() * 12 : 48 + rand() * 15;
    const trendPerDay = 0.15 + rand() * 0.35;
    const points = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayIndex = days - 1 - i;
      const seasonal = Math.sin((dayIndex / 7) * Math.PI * 2) * 4;
      const noise = (rand() - 0.5) * 8;
      const value = base + trendPerDay * dayIndex + seasonal + noise;
      points.push(Math.max(2, Math.min(98, value)));
    }
    return points;
  }

  /* ─── Forecast algorithms ─────────────────────────────────────────────────
     Each takes the historical series (array of numbers) and a horizon
     (number of future points) and returns { forecast: number[], confidence }
     confidence is 0-1, used for the comparison table's confidence bar.
  ──────────────────────────────────────────────────────────────────────── */
  function linearRegressionForecast(series, horizon) {
    const n = series.length;
    const xs = series.map((_, i) => i);
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = series.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - meanX) * (series[i] - meanY);
      den += (xs[i] - meanX) ** 2;
    }
    const slope = den === 0 ? 0 : num / den;
    const intercept = meanY - slope * meanX;
    const forecast = [];
    for (let i = 0; i < horizon; i++) {
      const x = n + i;
      forecast.push(clamp(intercept + slope * x));
    }
    return { forecast, confidence: 0.78 };
  }

  function movingAverageForecast(series, horizon) {
    const window = Math.min(5, series.length);
    const recent = series.slice(-window);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const forecast = new Array(horizon).fill(clamp(avg));
    return { forecast, confidence: 0.62 };
  }

  function exponentialSmoothingForecast(series, horizon) {
    const alpha = 0.35;
    let level = series[0];
    for (let i = 1; i < series.length; i++) {
      level = alpha * series[i] + (1 - alpha) * level;
    }
    const forecast = new Array(horizon).fill(clamp(level));
    return { forecast, confidence: 0.7 };
  }

  function seasonalForecast(series, horizon) {
    const period = 7;
    const forecast = [];
    for (let i = 0; i < horizon; i++) {
      const idx = series.length - period + (i % period);
      const base = series[((idx % series.length) + series.length) % series.length];
      forecast.push(clamp(base));
    }
    return { forecast, confidence: 0.66 };
  }

  function runForecast(algorithm, series, horizon) {
    switch (algorithm) {
      case "moving_avg":    return movingAverageForecast(series, horizon);
      case "exp_smoothing": return exponentialSmoothingForecast(series, horizon);
      case "seasonal":      return seasonalForecast(series, horizon);
      case "linear":
      default:              return linearRegressionForecast(series, horizon);
    }
  }

  function clamp(v) { return Math.max(0, Math.min(100, v)); }

  /**
   * getCapacityData(params)
   * @param {{sourceId:string, historyDays:number, horizonDays:number, algorithm:string}} params
   * @returns {{
   *   cpu:    { history:number[], forecast:number[], currentAvg:number, forecastAvg:number },
   *   memory: { history:number[], forecast:number[], currentAvg:number, forecastAvg:number },
   *   comparison: Array<{ algo:string, label:string, bestFor:string, cpuForecastAvg:number, memForecastAvg:number, confidence:number }>,
   *   recommendations: string[],
   * }} — SAME SHAPE a future /api/capacity response should return.
   */
  async function getCapacityData(params) {
    const { sourceId, historyDays, horizonDays, algorithm } = params;

    const cpuHistory = generateSeries(sourceId, "cpu", historyDays);
    const memHistory = generateSeries(sourceId, "mem", historyDays);

    const cpuFc = runForecast(algorithm, cpuHistory, horizonDays);
    const memFc = runForecast(algorithm, memHistory, horizonDays);

    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

    const comparison = Object.keys(ALGO_META).map(key => {
      const cFc = runForecast(key, cpuHistory, horizonDays);
      const mFc = runForecast(key, memHistory, horizonDays);
      return {
        algo: key,
        label: ALGO_META[key].label,
        bestFor: ALGO_META[key].bestFor,
        cpuForecastAvg: avg(cFc.forecast),
        memForecastAvg: avg(mFc.forecast),
        confidence: cFc.confidence,
      };
    });

    const cpuCurrentAvg = avg(cpuHistory.slice(-Math.min(3, cpuHistory.length)));
    const memCurrentAvg = avg(memHistory.slice(-Math.min(3, memHistory.length)));
    const cpuForecastAvg = avg(cpuFc.forecast);
    const memForecastAvg = avg(memFc.forecast);

    const recommendations = buildRecommendations({
      sourceId, cpuCurrentAvg, memCurrentAvg, cpuForecastAvg, memForecastAvg, horizonDays,
    });

    return {
      cpu:    { history: cpuHistory, forecast: cpuFc.forecast, currentAvg: cpuCurrentAvg, forecastAvg: cpuForecastAvg },
      memory: { history: memHistory, forecast: memFc.forecast, currentAvg: memCurrentAvg, forecastAvg: memForecastAvg },
      comparison,
      recommendations,
    };
  }

  function buildRecommendations({ sourceId, cpuCurrentAvg, memCurrentAvg, cpuForecastAvg, memForecastAvg, horizonDays }) {
    const label = sourceId === "all" ? "across all sources" : sourceLabel(sourceId);
    const recs = [];

    if (cpuForecastAvg - cpuCurrentAvg > 8) {
      recs.push(`CPU usage ${label} is trending up — projected to reach <strong>${cpuForecastAvg.toFixed(1)}%</strong> average within ${horizonDays} days. Consider scaling compute headroom ahead of that window.`);
    }
    if (memForecastAvg - memCurrentAvg > 8) {
      recs.push(`Memory usage ${label} is climbing — forecast average of <strong>${memForecastAvg.toFixed(1)}%</strong> over the next ${horizonDays} days. Review memory limits or plan for additional capacity.`);
    }
    if (cpuForecastAvg > 80 || memForecastAvg > 80) {
      recs.push(`Forecast crosses <strong>80%</strong> utilization ${label} — this is close enough to saturation that it's worth flagging for proactive capacity planning, not just monitoring.`);
    }
    if (recs.length === 0) {
      recs.push(`No significant growth trend detected ${label} over the selected history/horizon — current capacity looks sufficient for now.`);
    }
    return recs;
  }

  function sourceLabel(sourceId) {
    if (sourceId === "all") return "across all sources";
    const source = SOURCES.find(s => s.id === sourceId);
    return source ? `on ${source.name}` : `on ${sourceId}`;
  }

  /* ─── Rendering: source tabs ──────────────────────────────────────────── */
  function renderSourceTabs() {
    const el = document.getElementById("cap-source-tabs");
    if (!el) return;

    const tabs = [{ id: "all", name: "All Sources", color: "var(--accent-indigo, #6366f1)" }]
      .concat(SOURCES.map(s => ({ id: s.id, name: s.name, color: s.color || "var(--accent-indigo, #6366f1)" })));

    el.innerHTML = tabs.map(t => `
      <button type="button" class="cap-source-tab${t.id === state.sourceId ? " active" : ""}" data-source="${Utils.escapeHtml(t.id)}" role="tab" aria-selected="${t.id === state.sourceId}">
        <span class="dot" style="background:${t.color}"></span>${Utils.escapeHtml(t.name)}
      </button>
    `).join("");

    el.querySelectorAll(".cap-source-tab").forEach(btn => {
      btn.addEventListener("click", function () {
        state.sourceId = btn.getAttribute("data-source");
        renderSourceTabs();
        loadAndRender();
      });
    });
  }

  /* ─── Rendering: stat cards ───────────────────────────────────────────── */
  function trendHtml(current, forecast) {
    const delta = forecast - current;
    const up = delta >= 0;
    const icon = up ? "trending-up" : "trending-down";
    const cls = up ? "up" : "down";
    return `<span class="stat-trend ${cls}"><i data-lucide="${icon}"></i>${up ? "+" : ""}${delta.toFixed(1)}%</span>`;
  }

  function renderStatCards(data) {
    const el = document.getElementById("cap-stat-grid");
    if (!el) return;
    el.innerHTML = `
      <div class="stat-card accent-indigo">
        <div class="stat-header">
          <span class="stat-label">AVG CPU — CURRENT</span>
          <i data-lucide="cpu" class="stat-icon"></i>
        </div>
        <span class="stat-value">${data.cpu.currentAvg.toFixed(1)}%</span>
        <span class="stat-sub">last ${state.historyDays}d avg</span>
      </div>
      <div class="stat-card accent-teal">
        <div class="stat-header">
          <span class="stat-label">AVG CPU — FORECAST</span>
          <i data-lucide="cpu" class="stat-icon"></i>
        </div>
        <span class="stat-value">${data.cpu.forecastAvg.toFixed(1)}%</span>
        <span class="stat-sub">${trendHtml(data.cpu.currentAvg, data.cpu.forecastAvg)}</span>
      </div>
      <div class="stat-card accent-indigo">
        <div class="stat-header">
          <span class="stat-label">AVG MEMORY — CURRENT</span>
          <i data-lucide="memory-stick" class="stat-icon"></i>
        </div>
        <span class="stat-value">${data.memory.currentAvg.toFixed(1)}%</span>
        <span class="stat-sub">last ${state.historyDays}d avg</span>
      </div>
      <div class="stat-card accent-teal">
        <div class="stat-header">
          <span class="stat-label">AVG MEMORY — FORECAST</span>
          <i data-lucide="memory-stick" class="stat-icon"></i>
        </div>
        <span class="stat-value">${data.memory.forecastAvg.toFixed(1)}%</span>
        <span class="stat-sub">${trendHtml(data.memory.currentAvg, data.memory.forecastAvg)}</span>
      </div>
    `;
    Utils.refreshIcons();
  }

  /* ─── Rendering: charts ───────────────────────────────────────────────── */
  function buildChartLabels(historyDays, horizonDays) {
    const labels = [];
    for (let i = historyDays - 1; i >= 0; i--) labels.push(`-${i}d`);
    for (let i = 1; i <= horizonDays; i++) labels.push(`+${i}d`);
    return labels;
  }

  function chartColors() {
    const styles = getComputedStyle(document.documentElement);
    return {
      actual:   styles.getPropertyValue("--accent-indigo").trim() || "#6366f1",
      forecast: styles.getPropertyValue("--accent-teal").trim() || "#14b8a6",
      grid:     styles.getPropertyValue("--border").trim() || "#2a2a35",
      text:     styles.getPropertyValue("--muted-foreground").trim() || "#8b8b96",
    };
  }

  function buildDatasets(history, forecast) {
    // Bridge point: forecast line starts at the last actual point so the
    // two segments connect visually instead of leaving a gap.
    const actualData   = history.concat(new Array(forecast.length).fill(null));
    const forecastData = new Array(history.length - 1).fill(null)
      .concat([history[history.length - 1]])
      .concat(forecast);
    return { actualData, forecastData };
  }

  function renderChart(canvasId, existingChart, history, forecast, historyDays, horizonDays) {
    const ctx = document.getElementById(canvasId);
    if (!ctx || typeof Chart === "undefined") return existingChart;

    const colors = chartColors();
    const labels = buildChartLabels(historyDays, horizonDays);
    const { actualData, forecastData } = buildDatasets(history, forecast);

    const cfg = {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Actual",
            data: actualData,
            borderColor: colors.actual,
            backgroundColor: "transparent",
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
            spanGaps: false,
          },
          {
            label: "Forecast",
            data: forecastData,
            borderColor: colors.forecast,
            backgroundColor: "transparent",
            borderWidth: 2,
            borderDash: [5, 4],
            pointRadius: 0,
            tension: 0.3,
            spanGaps: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: colors.grid }, ticks: { color: colors.text, font: { size: 9 }, maxTicksLimit: 10 } },
          y: { grid: { color: colors.grid }, ticks: { color: colors.text, font: { size: 9 } }, min: 0, max: 100 },
        },
      },
    };

    if (existingChart) {
      existingChart.data = cfg.data;
      existingChart.options = cfg.options;
      existingChart.update();
      return existingChart;
    }
    return new Chart(ctx, cfg);
  }

  function renderCharts(data) {
    cpuChart = renderChart("cap-cpu-chart", cpuChart, data.cpu.history, data.cpu.forecast, state.historyDays, state.horizonDays);
    memChart = renderChart("cap-mem-chart", memChart, data.memory.history, data.memory.forecast, state.historyDays, state.horizonDays);
  }

  /* ─── Rendering: algorithm comparison table ──────────────────────────── */
  function renderComparison(data) {
    const tbody = document.getElementById("cap-compare-tbody");
    if (!tbody) return;
    tbody.innerHTML = data.comparison.map(row => `
      <tr class="${row.algo === state.algorithm ? "selected" : ""}">
        <td class="algo-name"><i data-lucide="check" class="check"></i>${Utils.escapeHtml(row.label)}</td>
        <td>${Utils.escapeHtml(row.bestFor)}</td>
        <td>${row.cpuForecastAvg.toFixed(1)}%</td>
        <td>${row.memForecastAvg.toFixed(1)}%</td>
        <td>
          <div class="cap-confidence-bar-wrap">
            <div class="cap-confidence-bar"><div class="cap-confidence-bar-fill" style="width:${Math.round(row.confidence * 100)}%"></div></div>
            <span>${Math.round(row.confidence * 100)}%</span>
          </div>
        </td>
      </tr>
    `).join("");
    Utils.refreshIcons();
  }

  /* ─── Rendering: recommendations ─────────────────────────────────────── */
  function renderRecommendations(data) {
    const el = document.getElementById("cap-reco-list");
    if (!el) return;
    if (!data.recommendations.length) {
      el.innerHTML = `<div class="cap-reco-empty">No recommendations at this time.</div>`;
      return;
    }
    el.innerHTML = data.recommendations.map(text => `
      <div class="cap-reco-item">
        <div class="icon-badge"><i data-lucide="lightbulb"></i></div>
        <div class="reco-text">${text}</div>
      </div>
    `).join("");
    Utils.refreshIcons();
  }

  /* ─── Error banner ────────────────────────────────────────────────────── */
  function setError(message) {
    const banner = document.getElementById("error-banner");
    const text   = document.getElementById("error-banner-text");
    if (!banner) return;
    if (message) {
      if (text) text.textContent = message;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  /* ─── Load + render pipeline ──────────────────────────────────────────── */
  async function loadAndRender() {
    try {
      setError("Capacity data shown below is a client-computed mock forecast — no live backend yet (Phase 8 scope).");
      const data = await getCapacityData({
        sourceId:    state.sourceId,
        historyDays: state.historyDays,
        horizonDays: state.horizonDays,
        algorithm:   state.algorithm,
      });
      renderStatCards(data);
      renderCharts(data);
      renderComparison(data);
      renderRecommendations(data);

      const stamp = document.getElementById("cap-last-updated");
      if (stamp) stamp.textContent = `Computed ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[capacity] getCapacityData error:", msg);
      setError(`Failed to compute capacity data: ${msg}`);
    }
  }

  /* ─── Control wiring ──────────────────────────────────────────────────── */
  function wireControls() {
    const historySel = document.getElementById("cap-history-select");
    const horizonSel = document.getElementById("cap-horizon-select");
    const algoSel     = document.getElementById("cap-algo-select");
    const refreshBtn  = document.getElementById("cap-refresh-btn");

    if (historySel) historySel.addEventListener("change", function () {
      state.historyDays = parseInt(historySel.value, 10);
      loadAndRender();
    });
    if (horizonSel) horizonSel.addEventListener("change", function () {
      state.horizonDays = parseInt(horizonSel.value, 10);
      loadAndRender();
    });
    if (algoSel) algoSel.addEventListener("change", function () {
      state.algorithm = algoSel.value;
      loadAndRender();
    });
    if (refreshBtn) refreshBtn.addEventListener("click", function () {
      loadAndRender();
    });
  }

  /* ─── Bootstrap ──────────────────────────────────────────────────────────
     Same lazy-load-once convention as infrastructure.js/services.js: no
     initial load here — data is computed exactly once, when
     onTabActivated(true) fires. Controls/tabs are wired immediately since
     they're cheap and don't depend on data being loaded yet.
  ──────────────────────────────────────────────────────────────────────── */
  document.addEventListener("DOMContentLoaded", async function () {
    if (global.Utils && typeof global.Utils.initHeader === "function") {
      global.Utils.initHeader();
    }
    if (global.lucide) {
      global.lucide.createIcons();
    }
    await loadSources();
    renderSourceTabs();
    wireControls();
  });

  global.onTabActivated = function onTabActivated(isFirstActivation) {
    if (isFirstActivation && !state.loaded) {
      state.loaded = true;
      loadAndRender();
    }
  };

  /* ─── Public surface ─────────────────────────────────────────────────── */
  global.CAPACITY = {
    reload: loadAndRender,
    getState: () => Object.assign({}, state),
  };

})(window);