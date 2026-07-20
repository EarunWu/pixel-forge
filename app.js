(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const COLOR_OPTIONS = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096];

  const sourceCanvas = document.createElement("canvas");
  const resultCanvas = document.createElement("canvas");
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  const resultContext = resultCanvas.getContext("2d", { willReadFrequently: true });
  const displayCanvas = $("#displayCanvas");
  const displayContext = displayCanvas.getContext("2d", { alpha: true });
  const gridOverlay = $("#gridOverlay");
  const gridPath = $("#gridPath");
  const dropZone = $("#dropZone");
  const canvasScene = $("#canvasScene");

  const state = {
    mode: "auto",
    view: "original",
    originalData: null,
    resultData: null,
    fileName: "pixel-art.png",
    fileSize: 0,
    zoom: 1,
    fitScale: 1,
    panX: 0,
    panY: 0,
    panning: false,
    panPointerId: null,
    panLastX: 0,
    panLastY: 0,
    detectedCellSize: 1,
    detectedCellWidth: 1,
    detectedCellHeight: 1,
    detectedGridCols: 0,
    detectedGridRows: 0,
    detectionConfidence: 0,
    logicalResultData: null,
    processing: false,
    palette: [],
    sourcePaletteSize: 0,
    dirHandle: null,
    eyedropper: false,
    processTimer: null,
    toastTimer: null,
    db: null,
    historyObjectUrls: []
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function gcd(a, b) {
    while (b) [a, b] = [b, a % b];
    return Math.abs(a);
  }

  function hexToRgb(hex) {
    const safe = /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#000000";
    return {
      r: parseInt(safe.slice(1, 3), 16),
      g: parseInt(safe.slice(3, 5), 16),
      b: parseInt(safe.slice(5, 7), 16)
    };
  }

  function rgbToHex(r, g, b) {
    return `#${[r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("")}`;
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 KB";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function baseName(name) {
    return (name || "pixel-art").replace(/\.[^.]+$/, "").replace(/[^\w\-\u4e00-\u9fff]+/g, "-");
  }

  function cloneImageData(imageData) {
    return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
  }

  function showToast(message, type = "info") {
    const toast = $("#toast");
    clearTimeout(state.toastTimer);
    toast.textContent = message;
    toast.classList.toggle("error", type === "error");
    toast.classList.add("show");
    state.toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
  }

  function setStatus(message, kind = "") {
    const status = $("#processStatus");
    status.className = `process-status ${kind}`.trim();
    status.querySelector("span").textContent = message;
  }

  function setEnabled(hasImage) {
    ["#runPipelineButton", "#eyedropperButton", "#outlineButton", "#exportButton", "#exportOnePxButton",
      "#downloadPaletteButton", "#exportPaletteImageButton", "#copyPaletteButton"]
      .forEach(selector => { $(selector).disabled = !hasImage; });
  }

  function setMode(mode) {
    state.mode = mode;
    const isAuto = mode === "auto";
    $("#autoModeButton").classList.toggle("active", isAuto);
    $("#manualModeButton").classList.toggle("active", !isAuto);
    $("#autoModeButton").setAttribute("aria-selected", String(isAuto));
    $("#manualModeButton").setAttribute("aria-selected", String(!isAuto));
    $("#manualControls").hidden = isAuto;
    $("#reconstructRow").hidden = isAuto;
    $("#cellSizeBadge").textContent = isAuto ? "AUTO" : "MANUAL";
    updateGridInfo();
    if (state.originalData) scheduleProcessing();
  }

  function setView(view) {
    state.view = view;
    const original = view === "original";
    $("#originalTab").classList.toggle("active", original);
    $("#resultTab").classList.toggle("active", !original);
    $("#originalTab").setAttribute("aria-selected", String(original));
    $("#resultTab").setAttribute("aria-selected", String(!original));
    renderDisplay();
    updateAnalysis();
  }

  function currentData() {
    if (!state.originalData) return null;
    return state.view === "result" && state.resultData ? state.resultData : state.originalData;
  }

  function currentCellSize() {
    return state.mode === "auto" ? state.detectedCellSize : Number($("#cellSizeRange").value);
  }

  async function decodeImage(file) {
    if ("createImageBitmap" in window) {
      try { return await createImageBitmap(file); } catch (_) { /* fallback below */ }
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = objectUrl;
      await image.decode();
      return image;
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }
  }

  async function loadFile(file, customName = "", skipHistory = false) {
    const candidateName = customName || file?.name || "";
    if (!file || (!file.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|svg)$/i.test(candidateName))) {
      showToast("请选择 PNG、JPG、WEBP、GIF 或 SVG 图片", "error");
      return;
    }
    if (file.size > 40 * 1024 * 1024) {
      showToast("图片超过 40 MB，请先缩小文件", "error");
      return;
    }

    setStatus("正在读取图片…", "busy");
    try {
      const bitmap = await decodeImage(file);
      const width = bitmap.width || bitmap.naturalWidth;
      const height = bitmap.height || bitmap.naturalHeight;
      if (!width || !height || width * height > 24_000_000) throw new Error("图片尺寸过大");

      sourceCanvas.width = resultCanvas.width = width;
      sourceCanvas.height = resultCanvas.height = height;
      sourceContext.clearRect(0, 0, width, height);
      sourceContext.imageSmoothingEnabled = false;
      sourceContext.drawImage(bitmap, 0, 0, width, height);
      bitmap.close?.();

      state.originalData = sourceContext.getImageData(0, 0, width, height);
      state.resultData = cloneImageData(state.originalData);
      state.logicalResultData = null;
      resultContext.putImageData(state.resultData, 0, 0);
      state.fileName = customName || file.name || "pixel-art.png";
      state.fileSize = file.size || 0;
      const grid = detectPixelGrid(state.originalData);
      state.detectedCellSize = grid.cellSize;
      state.detectedCellWidth = grid.cellWidth;
      state.detectedCellHeight = grid.cellHeight;
      state.detectedGridCols = grid.cols;
      state.detectedGridRows = grid.rows;
      state.detectionConfidence = grid.confidence;
      state.zoom = 1;
      state.panX = 0;
      state.panY = 0;
      state.panning = false;
      state.panPointerId = null;
      dropZone.classList.remove("is-panning");
      state.sourcePaletteSize = countColors(state.originalData).total;
      state.view = "original";

      $("#emptyState").hidden = true;
      $("#canvasScene").hidden = false;
      $("#resultDot").classList.remove("ready");
      $("#imageMeta").textContent = `${width} × ${height} PX · ${formatBytes(state.fileSize)} · GRID ${grid.cols}×${grid.rows} · CELL ${grid.cellWidth}${grid.cellWidth !== grid.cellHeight ? `×${grid.cellHeight}` : ""}`;
      setEnabled(true);
      setStatus("图片已载入", "ready");
      updateAtlasSummary();
      renderDisplay();
      updateAnalysis();
      if (!skipHistory) addHistory(file, state.fileName, width, height).catch(() => {});

      if (state.mode === "auto") await processImage();
      else showToast(`已载入 ${state.fileName}`);
    } catch (error) {
      console.error(error);
      setStatus("读取失败");
      showToast(error.message || "无法读取这张图片", "error");
    }
  }

  function detectRunCellSize(imageData) {
    const { data, width, height } = imageData;
    if (width < 4 || height < 4) return 1;
    const runs = [];
    const rowStep = Math.max(1, Math.floor(height / 24));
    for (let y = 0; y < height && runs.length < 2500; y += rowStep) {
      let start = 0;
      let last = -1;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const color = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
        if (x && color !== last) {
          const length = x - start;
          if (length <= 128) runs.push(length);
          start = x;
        }
        last = color;
      }
      if (width - start <= 128) runs.push(width - start);
    }
    if (runs.length < 5) return 1;
    for (let candidate = Math.min(16, gcd(width, height)); candidate >= 2; candidate--) {
      const divisible = runs.filter(length => length % candidate === 0).length / runs.length;
      if (divisible >= 0.68) return candidate;
    }
    return 1;
  }

  function analyzeGridSpectrum(imageData, axis) {
    const { data, width, height } = imageData;
    const horizontal = axis === "x";
    const length = (horizontal ? width : height) - 1;
    const crossLength = horizontal ? height : width;
    if (length < 31 || crossLength < 8) return { valid: false, count: 0, cell: 1, confidence: 0 };

    const samples = Math.min(256, crossLength);
    const signal = new Float64Array(length);
    for (let sample = 0; sample < samples; sample++) {
      const cross = Math.min(crossLength - 1, Math.floor((sample + .5) * crossLength / samples));
      for (let position = 0; position < length; position++) {
        const x1 = horizontal ? position : cross;
        const y1 = horizontal ? cross : position;
        const x2 = horizontal ? position + 1 : cross;
        const y2 = horizontal ? cross : position + 1;
        const a = (y1 * width + x1) * 4;
        const b = (y2 * width + x2) * 4;
        const difference = (Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2])) / 3;
        if (difference > 10) signal[position]++;
      }
    }

    let mean = 0;
    for (let i = 0; i < length; i++) { signal[i] /= samples; mean += signal[i]; }
    mean /= length;
    for (let i = 0; i < length; i++) signal[i] -= mean;

    const firstFrequency = Math.max(4, Math.ceil(length / 24));
    const lastFrequency = Math.min(512, Math.floor(length / 2));
    if (firstFrequency >= lastFrequency) return { valid: false, count: 0, cell: 1, confidence: 0 };

    const amplitudes = [];
    let peak = 0;
    let peakFrequency = 0;
    for (let frequency = firstFrequency; frequency <= lastFrequency; frequency++) {
      const coefficient = 2 * Math.cos(2 * Math.PI * frequency / length);
      let previous = 0, beforePrevious = 0;
      for (let i = 0; i < length; i++) {
        const current = signal[i] + coefficient * previous - beforePrevious;
        beforePrevious = previous;
        previous = current;
      }
      const amplitude = Math.sqrt(Math.max(0, beforePrevious * beforePrevious + previous * previous - coefficient * previous * beforePrevious));
      amplitudes.push(amplitude);
      if (amplitude > peak) { peak = amplitude; peakFrequency = frequency; }
    }
    const sorted = [...amplitudes].sort((a, b) => a - b);
    const baseline = sorted[Math.floor(sorted.length / 2)] || 1e-9;
    const confidence = peak / baseline;
    const normalizedPeak = 2 * peak / length;
    const cell = Math.round((horizontal ? width : height) / peakFrequency);
    const valid = confidence >= 8 && normalizedPeak >= .025 && cell >= 2 && cell <= 24;
    return { valid, count: valid ? peakFrequency : 0, cell: valid ? cell : 1, confidence, normalizedPeak };
  }

  function detectPixelGrid(imageData) {
    const x = analyzeGridSpectrum(imageData, "x");
    const y = analyzeGridSpectrum(imageData, "y");
    let cols = x.count;
    let rows = y.count;

    if (x.valid && y.valid && imageData.width === imageData.height && Math.abs(cols - rows) <= Math.max(3, Math.round(Math.max(cols, rows) * .06))) {
      cols = rows = Math.round((cols + rows) / 2);
    } else if (x.valid && !y.valid && imageData.width === imageData.height) {
      rows = cols;
    } else if (y.valid && !x.valid && imageData.width === imageData.height) {
      cols = rows;
    }

    if (!cols || !rows) {
      const runCell = detectRunCellSize(imageData);
      return {
        cellSize: runCell,
        cellWidth: runCell,
        cellHeight: runCell,
        cols: Math.max(1, Math.floor(imageData.width / runCell)),
        rows: Math.max(1, Math.floor(imageData.height / runCell)),
        confidence: 0
      };
    }

    const cellWidth = clamp(Math.round(imageData.width / cols), 1, 24);
    const cellHeight = clamp(Math.round(imageData.height / rows), 1, 24);
    return {
      cellSize: Math.min(cellWidth, cellHeight),
      cellWidth,
      cellHeight,
      cols,
      rows,
      confidence: Math.min(x.valid ? x.confidence : Infinity, y.valid ? y.confidence : Infinity)
    };
  }

  function resampleNearest(imageData, targetWidth, targetHeight) {
    if (targetWidth === imageData.width && targetHeight === imageData.height) return cloneImageData(imageData);
    const output = new ImageData(targetWidth, targetHeight);
    for (let y = 0; y < targetHeight; y++) {
      const sourceY = Math.min(imageData.height - 1, Math.floor((y + .5) * imageData.height / targetHeight));
      for (let x = 0; x < targetWidth; x++) {
        const sourceX = Math.min(imageData.width - 1, Math.floor((x + .5) * imageData.width / targetWidth));
        const sourceIndex = (sourceY * imageData.width + sourceX) * 4;
        const targetIndex = (y * targetWidth + x) * 4;
        output.data[targetIndex] = imageData.data[sourceIndex];
        output.data[targetIndex + 1] = imageData.data[sourceIndex + 1];
        output.data[targetIndex + 2] = imageData.data[sourceIndex + 2];
        output.data[targetIndex + 3] = imageData.data[sourceIndex + 3];
      }
    }
    return output;
  }

  function reconstructLogical(imageData, cellWidth, cellHeight) {
    if (cellWidth <= 1 && cellHeight <= 1) return cloneImageData(imageData);
    const output = new ImageData(imageData.width * cellWidth, imageData.height * cellHeight);
    for (let y = 0; y < output.height; y++) {
      const sourceY = Math.floor(y / cellHeight);
      for (let x = 0; x < output.width; x++) {
        const sourceX = Math.floor(x / cellWidth);
        const sourceIndex = (sourceY * imageData.width + sourceX) * 4;
        const targetIndex = (y * output.width + x) * 4;
        output.data[targetIndex] = imageData.data[sourceIndex];
        output.data[targetIndex + 1] = imageData.data[sourceIndex + 1];
        output.data[targetIndex + 2] = imageData.data[sourceIndex + 2];
        output.data[targetIndex + 3] = imageData.data[sourceIndex + 3];
      }
    }
    return output;
  }

  function srgbLinear(value) {
    value /= 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  }

  function linearSrgb(value) {
    value = value <= .0031308 ? 12.92 * value : 1.055 * Math.max(value, 0) ** (1 / 2.4) - .055;
    return clamp(Math.round(value * 255), 0, 255);
  }

  function rgbToOklab(r, g, b) {
    r = srgbLinear(r); g = srgbLinear(g); b = srgbLinear(b);
    const l = .4122214708 * r + .5363325363 * g + .0514459929 * b;
    const m = .2119034982 * r + .6806995451 * g + .1073969566 * b;
    const s = .0883024619 * r + .2817188376 * g + .6299787005 * b;
    const l3 = Math.cbrt(l), m3 = Math.cbrt(m), s3 = Math.cbrt(s);
    return [
      .2104542553 * l3 + .793617785 * m3 - .0040720468 * s3,
      1.9779984951 * l3 - 2.428592205 * m3 + .4505937099 * s3,
      .0259040371 * l3 + .7827717662 * m3 - .808675766 * s3
    ];
  }

  function oklabToRgb(L, a, b) {
    const l3 = (L + .3963377774 * a + .2158037573 * b) ** 3;
    const m3 = (L - .1055613458 * a - .0638541728 * b) ** 3;
    const s3 = (L - .0894841775 * a - 1.291485548 * b) ** 3;
    return [
      linearSrgb(4.0767416621 * l3 - 3.3077115913 * m3 + .2309699292 * s3),
      linearSrgb(-1.2684380046 * l3 + 2.6097574011 * m3 - .3413193965 * s3),
      linearSrgb(-.0041960863 * l3 - .7034186147 * m3 + 1.707614701 * s3)
    ];
  }

  function mergeNearColors(imageData, deltaE) {
    if (!deltaE) return imageData;
    const out = cloneImageData(imageData);
    // The UI value follows the source tool's perceptual Delta-E scale. Oklab
    // distances are much smaller numerically, so using /100 over-merges a
    // 200×200 logical image (Delta-E 2 could collapse it below 512 colours).
    const tolerance = Math.max(.0005, deltaE / 400);
    const toleranceSquared = tolerance * tolerance;
    const histogram = new Map();
    for (let i = 0; i < out.data.length; i += 4) {
      if (!out.data[i + 3]) continue;
      const packed = out.data[i] << 16 | out.data[i + 1] << 8 | out.data[i + 2];
      histogram.set(packed, (histogram.get(packed) || 0) + 1);
    }

    const colors = [...histogram.entries()].map(([packed, count]) => {
      const r = packed >> 16 & 255, g = packed >> 8 & 255, b = packed & 255;
      return { packed, count, r, g, b, lab: rgbToOklab(r, g, b) };
    }).sort((a, b) => b.count - a.count);

    const buckets = new Map();
    const representatives = [];
    const mapping = new Map();
    const bucketKey = (L, a, b) => `${Math.floor(L / tolerance)},${Math.floor(a / tolerance)},${Math.floor(b / tolerance)}`;

    for (const color of colors) {
      const [L, a, b] = color.lab;
      const qL = Math.floor(L / tolerance), qa = Math.floor(a / tolerance), qb = Math.floor(b / tolerance);
      let best = -1;
      let bestDistance = toleranceSquared;
      for (let dL = -1; dL <= 1; dL++) for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) {
        const candidates = buckets.get(`${qL + dL},${qa + da},${qb + db}`);
        if (!candidates) continue;
        for (const candidateIndex of candidates) {
          const candidate = representatives[candidateIndex];
          const lDiff = L - candidate.lab[0], aDiff = a - candidate.lab[1], bDiff = b - candidate.lab[2];
          const distance = lDiff * lDiff + aDiff * aDiff + bDiff * bDiff;
          if (distance <= bestDistance) { bestDistance = distance; best = candidateIndex; }
        }
      }
      if (best < 0) {
        best = representatives.length;
        representatives.push(color);
        const key = bucketKey(L, a, b);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(best);
      }
      mapping.set(color.packed, representatives[best].packed);
    }

    for (let i = 0; i < out.data.length; i += 4) {
      if (!out.data[i + 3]) continue;
      const packed = out.data[i] << 16 | out.data[i + 1] << 8 | out.data[i + 2];
      const replacement = mapping.get(packed) ?? packed;
      out.data[i] = replacement >> 16 & 255;
      out.data[i + 1] = replacement >> 8 & 255;
      out.data[i + 2] = replacement & 255;
    }
    return out;
  }

  function cleanRegions(imageData, amount) {
    if (amount <= 0) return imageData;
    // 0.1 is the source tool's effectively lossless floor: it builds the
    // region map but should not replace isolated, intentional pixel details.
    if (amount <= .1) return cloneImageData(imageData);
    let current = cloneImageData(imageData);
    const { width, height } = current;
    const passes = clamp(Math.ceil(amount * 1.5), 1, 4);
    const requiredMatches = amount < .5 ? 1 : amount < 1.2 ? 2 : 3;
    const offsets = [-1, 0, 1];
    for (let pass = 0; pass < passes; pass++) {
      const next = cloneImageData(current);
      const src = current.data, dst = next.data;
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const index = (y * width + x) * 4;
          if (!src[index + 3]) continue;
          const own = src[index] | (src[index + 1] << 8) | (src[index + 2] << 16);
          const neighbors = new Map();
          let matches = 0;
          for (const oy of offsets) for (const ox of offsets) {
            if (!ox && !oy) continue;
            const ni = ((y + oy) * width + x + ox) * 4;
            if (!src[ni + 3]) continue;
            const color = src[ni] | (src[ni + 1] << 8) | (src[ni + 2] << 16);
            if (color === own) matches++;
            neighbors.set(color, (neighbors.get(color) || 0) + 1);
          }
          if (matches >= requiredMatches || !neighbors.size) continue;
          const replacement = [...neighbors].sort((a, b) => b[1] - a[1])[0][0];
          dst[index] = replacement & 255;
          dst[index + 1] = (replacement >>> 8) & 255;
          dst[index + 2] = (replacement >>> 16) & 255;
        }
      }
      current = next;
    }
    return current;
  }

  function buildColorHistogram(imageData) {
    const counts = new Map();
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      if (!data[i + 3]) continue;
      const packed = data[i] << 16 | data[i + 1] << 8 | data[i + 2];
      counts.set(packed, (counts.get(packed) || 0) + 1);
    }
    return [...counts.entries()].map(([packed, count]) => ({
      packed,
      r: packed >> 16 & 255,
      g: packed >> 8 & 255,
      b: packed & 255,
      count
    }));
  }

  function makeBox(colors) {
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0, count = 0;
    for (const color of colors) {
      rMin = Math.min(rMin, color.r); rMax = Math.max(rMax, color.r);
      gMin = Math.min(gMin, color.g); gMax = Math.max(gMax, color.g);
      bMin = Math.min(bMin, color.b); bMax = Math.max(bMax, color.b);
      count += color.count;
    }
    return { colors, count, rMin, rMax, gMin, gMax, bMin, bMax, score: Math.max(rMax - rMin, gMax - gMin, bMax - bMin) * Math.sqrt(count) };
  }

  function medianCut(colors, target) {
    if (colors.length <= target) {
      return {
        palette: colors.map(({ r, g, b }) => [r, g, b]),
        lookup: new Map(colors.map(color => [color.packed, [color.r, color.g, color.b]]))
      };
    }
    const boxes = [makeBox(colors)];
    while (boxes.length < target) {
      boxes.sort((a, b) => b.score - a.score);
      const box = boxes.shift();
      if (!box || box.colors.length < 2) { if (box) boxes.push(box); break; }
      const ranges = { r: box.rMax - box.rMin, g: box.gMax - box.gMin, b: box.bMax - box.bMin };
      const channel = Object.entries(ranges).sort((a, b) => b[1] - a[1])[0][0];
      box.colors.sort((a, b) => a[channel] - b[channel]);
      const half = box.count / 2;
      let sum = 0, split = 1;
      for (; split < box.colors.length; split++) { sum += box.colors[split - 1].count; if (sum >= half) break; }
      split = clamp(split, 1, box.colors.length - 1);
      boxes.push(makeBox(box.colors.slice(0, split)), makeBox(box.colors.slice(split)));
    }
    const palette = [];
    const lookup = new Map();
    for (const box of boxes) {
      let r = 0, g = 0, b = 0, count = 0;
      for (const color of box.colors) {
        r += color.r * color.count; g += color.g * color.count; b += color.b * color.count; count += color.count;
      }
      const mean = [r / count, g / count, b / count];
      // Keep the representative on an actually-used source colour.  Besides
      // avoiding invented/duplicate RGB values, this guarantees that a
      // requested N-colour quantisation really produces N occupied colours.
      let representative = box.colors[0];
      let bestDistance = Infinity;
      for (const color of box.colors) {
        const distance = (color.r - mean[0]) ** 2 + (color.g - mean[1]) ** 2 + (color.b - mean[2]) ** 2;
        if (distance < bestDistance) { bestDistance = distance; representative = color; }
      }
      const outputColor = [representative.r, representative.g, representative.b];
      palette.push(outputColor);
      for (const color of box.colors) lookup.set(color.packed, outputColor);
    }
    return { palette, lookup };
  }

  function limitColors(imageData, target) {
    const out = cloneImageData(imageData);
    const sourceColors = buildColorHistogram(out);
    if (sourceColors.length <= target) return out;
    const { lookup } = medianCut(sourceColors, target);
    const data = out.data;
    for (let i = 0; i < data.length; i += 4) {
      if (!data[i + 3]) continue;
      const packed = data[i] << 16 | data[i + 1] << 8 | data[i + 2];
      const nearest = lookup.get(packed);
      data[i] = nearest[0]; data[i + 1] = nearest[1]; data[i + 2] = nearest[2];
    }
    return out;
  }

  function reconstructPixels(imageData, cellSize) {
    if (cellSize <= 1) return imageData;
    const out = cloneImageData(imageData);
    const { width, height, data } = out;
    for (let y0 = 0; y0 < height; y0 += cellSize) {
      for (let x0 = 0; x0 < width; x0 += cellSize) {
        const counts = new Map();
        for (let y = y0; y < Math.min(y0 + cellSize, height); y++) {
          for (let x = x0; x < Math.min(x0 + cellSize, width); x++) {
            const i = (y * width + x) * 4;
            const packed = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
            counts.set(packed, (counts.get(packed) || 0) + 1);
          }
        }
        const color = [...counts].sort((a, b) => b[1] - a[1])[0][0];
        for (let y = y0; y < Math.min(y0 + cellSize, height); y++) {
          for (let x = x0; x < Math.min(x0 + cellSize, width); x++) {
            const i = (y * width + x) * 4;
            data[i] = color & 255; data[i + 1] = color >>> 8 & 255; data[i + 2] = color >>> 16 & 255; data[i + 3] = color >>> 24 & 255;
          }
        }
      }
    }
    return out;
  }

  async function processImage() {
    if (!state.originalData || state.processing) return;
    state.processing = true;
    $("#runPipelineButton").disabled = true;
    setStatus("像素流水线运行中…", "busy");
    await new Promise(resolve => setTimeout(resolve, 28));

    try {
      const automaticReconstruction = state.mode === "auto" && state.detectedGridCols > 0 && state.detectedGridRows > 0;
      let output = automaticReconstruction
        ? resampleNearest(state.originalData, state.detectedGridCols, state.detectedGridRows)
        : cloneImageData(state.originalData);
      if ($("#quantizeToggle").checked) output = mergeNearColors(output, Number($("#deltaRange").value));
      if ($("#regionToggle").checked) output = cleanRegions(output, Number($("#regionRange").value));
      if ($("#colorsToggle").checked) output = limitColors(output, COLOR_OPTIONS[Number($("#colorsRange").value)]);
      if (automaticReconstruction) {
        state.logicalResultData = cloneImageData(output);
        output = reconstructLogical(output, state.detectedCellWidth, state.detectedCellHeight);
      } else {
        state.logicalResultData = null;
        if (state.mode === "manual" && $("#reconstructToggle").checked) output = reconstructPixels(output, currentCellSize());
      }

      state.resultData = output;
      resultCanvas.width = output.width; resultCanvas.height = output.height;
      resultContext.putImageData(output, 0, 0);
      $("#resultDot").classList.add("ready");
      setView("result");
      setStatus(automaticReconstruction ? `流程完成 · ${state.detectedGridCols}×${state.detectedGridRows} @ ${state.detectedCellWidth}px` : "流程完成", "ready");
      showToast("像素优化完成");
    } catch (error) {
      console.error(error);
      setStatus("处理失败");
      showToast("处理失败：图片可能过大", "error");
    } finally {
      state.processing = false;
      $("#runPipelineButton").disabled = !state.originalData;
    }
  }

  function scheduleProcessing() {
    if (!state.originalData) return;
    clearTimeout(state.processTimer);
    if (state.mode === "auto") state.processTimer = setTimeout(processImage, 220);
    else setStatus("参数已更新，等待执行", "ready");
  }

  function calculateFitScale(width, height) {
    const viewport = $("#dropZone").getBoundingClientRect();
    const availableWidth = Math.max(120, viewport.width - 70);
    const availableHeight = Math.max(120, viewport.height - 110);
    return Math.min(1, availableWidth / width, availableHeight / height);
  }

  function setZoom(nextZoom, clientX, clientY) {
    if (!state.originalData) return;
    const previousZoom = state.zoom;
    const zoom = clamp(nextZoom, .2, 32);
    if (zoom === previousZoom) return;

    const viewportRect = dropZone.getBoundingClientRect();
    const sceneCenterX = viewportRect.left + canvasScene.offsetLeft + canvasScene.clientWidth / 2;
    const sceneCenterY = viewportRect.top + canvasScene.offsetTop + canvasScene.clientHeight / 2;
    const anchorX = Number.isFinite(clientX) ? clientX : sceneCenterX;
    const anchorY = Number.isFinite(clientY) ? clientY : sceneCenterY;
    const ratio = zoom / previousZoom;
    const oldCanvasCenterX = sceneCenterX + state.panX;
    const oldCanvasCenterY = sceneCenterY + state.panY;

    // Move the canvas while scaling so the pixel under the pointer stays put.
    state.panX = anchorX - sceneCenterX - (anchorX - oldCanvasCenterX) * ratio;
    state.panY = anchorY - sceneCenterY - (anchorY - oldCanvasCenterY) * ratio;
    state.zoom = zoom;
    renderDisplay();
  }

  function resetZoom() {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    renderDisplay();
  }

  function applyPanTransform() {
    $("#canvasBackdrop").style.transform = `translate3d(${state.panX}px, ${state.panY}px, 0)`;
  }

  function renderDisplay() {
    const data = currentData();
    if (!data) return;
    displayCanvas.width = data.width; displayCanvas.height = data.height;
    displayContext.clearRect(0, 0, data.width, data.height);
    displayContext.putImageData(data, 0, 0);
    state.fitScale = calculateFitScale(data.width, data.height);
    const scale = state.fitScale * state.zoom;
    const cssWidth = Math.max(1, Math.round(data.width * scale));
    const cssHeight = Math.max(1, Math.round(data.height * scale));
    displayCanvas.style.width = `${cssWidth}px`;
    displayCanvas.style.height = `${cssHeight}px`;
    gridOverlay.setAttribute("viewBox", `0 0 ${data.width} ${data.height}`);
    $("#canvasBackdrop").style.width = `${cssWidth}px`;
    $("#canvasBackdrop").style.height = `${cssHeight}px`;
    applyPanTransform();
    $("#zoomLabel").textContent = `${Math.round(scale * 100)}%`;
    renderGrid();
  }

  function renderGrid() {
    gridPath.setAttribute("d", "");
    if (!state.originalData || !$("#gridToggle").checked) return;
    const data = currentData();
    if (!data) return;
    const manualCell = Math.max(1, currentCellSize());
    const cols = state.mode === "auto"
      ? Math.max(1, state.detectedGridCols)
      : Math.max(1, Math.ceil(data.width / manualCell));
    const rows = state.mode === "auto"
      ? Math.max(1, state.detectedGridRows)
      : Math.max(1, Math.ceil(data.height / manualCell));
    const xStep = data.width / cols;
    const yStep = data.height / rows;
    const coordinate = value => Number(value.toFixed(4));
    const commands = [];
    for (let col = 0; col <= cols; col++) {
      const x = coordinate(col === cols ? data.width : col * xStep);
      commands.push(`M${x} 0V${data.height}`);
    }
    for (let row = 0; row <= rows; row++) {
      const y = coordinate(row === rows ? data.height : row * yStep);
      commands.push(`M0 ${y}H${data.width}`);
    }
    gridPath.setAttribute("d", commands.join(""));
    gridPath.setAttribute("stroke", $("#gridColor").value);
    gridPath.setAttribute("stroke-width", $("#gridWidth").value);
  }

  function countColors(imageData, topLimit = 100) {
    const counts = new Map();
    let visible = 0;
    const pixels = imageData.width * imageData.height;
    const sampleStep = Math.max(1, Math.ceil(pixels / 1_200_000));
    for (let i = 0; i < imageData.data.length; i += 4 * sampleStep) {
      if (!imageData.data[i + 3]) continue;
      visible += sampleStep;
      const key = imageData.data[i] << 16 | imageData.data[i + 1] << 8 | imageData.data[i + 2];
      counts.set(key, (counts.get(key) || 0) + sampleStep);
    }
    const palette = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topLimit)
      .map(([key, count]) => ({
        r: key >> 16 & 255, g: key >> 8 & 255, b: key & 255,
        hex: rgbToHex(key >> 16 & 255, key >> 8 & 255, key & 255), count,
        percent: visible ? count / visible * 100 : 0
      }));
    return { total: counts.size, visible, palette };
  }

  function updateAnalysis() {
    const displayData = currentData();
    const data = state.view === "result" && state.logicalResultData ? state.logicalResultData : displayData;
    if (!data) return;
    const analysis = countColors(data);
    state.palette = analysis.palette;
    $("#totalColors").textContent = analysis.total.toLocaleString();
    const difference = state.sourcePaletteSize - analysis.total;
    $("#paletteDelta").textContent = state.view === "result" && difference > 0
      ? `较原图减少 ${difference.toLocaleString()} 色`
      : `${analysis.visible.toLocaleString()} 个可见像素`;
    $("#paletteList").innerHTML = analysis.palette.length
      ? analysis.palette.map(color => `<div class="palette-chip" title="${color.hex} · ${color.count.toLocaleString()} px"><i style="background:${color.hex}"></i><span>${color.hex.toUpperCase()}</span><small>${color.percent.toFixed(color.percent < 1 ? 1 : 0)}%</small></div>`).join("")
      : '<div class="empty-analysis">无颜色数据</div>';
    updateGridInfo();
    updateBlockStats(displayData);
  }

  function updateAtlasSummary() {
    const enabled = $("#atlasToggle").checked;
    $("#atlasControls").hidden = !enabled;
    const cols = clamp(Number($("#atlasCols").value) || 1, 1, 64);
    const rows = clamp(Number($("#atlasRows").value) || 1, 1, 64);
    $("#atlasSummary").textContent = enabled ? `${cols} × ${rows}` : "单张图片";
    if (state.originalData) {
      const cellWidth = Math.floor(state.originalData.width / cols);
      const cellHeight = Math.floor(state.originalData.height / rows);
      $("#atlasCellInfo").textContent = `每格 ${cellWidth} × ${cellHeight} px · 共 ${cols * rows} 格`;
    } else {
      $("#atlasCellInfo").textContent = `每格 ? × ? px · 共 ${cols * rows} 格`;
    }
    updateGridInfo();
    if (state.originalData) updateBlockStats(currentData());
  }

  function updateGridInfo() {
    if (!state.originalData) return;
    const cell = currentCellSize();
    const atlas = $("#atlasToggle").checked;
    const cols = atlas
      ? Number($("#atlasCols").value)
      : state.mode === "auto" ? state.detectedGridCols : Math.ceil(state.originalData.width / cell);
    const rows = atlas
      ? Number($("#atlasRows").value)
      : state.mode === "auto" ? state.detectedGridRows : Math.ceil(state.originalData.height / cell);
    $("#gridCols").textContent = cols;
    $("#gridRows").textContent = rows;
    const cellLabel = state.mode === "auto" && state.detectedCellWidth !== state.detectedCellHeight
      ? `${state.detectedCellWidth}×${state.detectedCellHeight}px`
      : `${cell}px`;
    $("#gridCellSize").textContent = cellLabel;
    $("#cellSizeBadge").textContent = state.mode === "auto" ? `AUTO · ${cellLabel}` : `MANUAL · ${cellLabel}`;
    renderGrid();
  }

  function updateBlockStats(imageData) {
    if (!imageData) return;
    const atlas = $("#atlasToggle").checked;
    const cols = atlas ? clamp(Number($("#atlasCols").value), 1, 64) : 1;
    const rows = atlas ? clamp(Number($("#atlasRows").value), 1, 64) : 1;
    const total = cols * rows;
    $("#blockCount").textContent = `${total} 格`;
    const cellW = Math.floor(imageData.width / cols);
    const cellH = Math.floor(imageData.height / rows);
    const blocks = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        let visible = 0;
        for (let y = row * cellH; y < Math.min((row + 1) * cellH, imageData.height); y++) {
          for (let x = col * cellW; x < Math.min((col + 1) * cellW, imageData.width); x++) {
            if (imageData.data[(y * imageData.width + x) * 4 + 3]) visible++;
          }
        }
        const capacity = Math.max(1, cellW * cellH);
        blocks.push({ index: row * cols + col + 1, fill: visible / capacity * 100 });
      }
    }
    $("#blockStats").innerHTML = blocks.slice(0, 64).map(block => `<div class="block-row"><strong>#${String(block.index).padStart(2, "0")}</strong><div class="block-spark"><i style="width:${block.fill.toFixed(1)}%"></i></div><span>${block.fill.toFixed(0)}%</span></div>`).join("");
  }

  function applyBackgroundChoice() {
    const value = $('input[name="previewBg"]:checked').value;
    $("#canvasBackdrop").className = `canvas-backdrop ${value}`;
    $("#previewColorRow").style.opacity = value === "solid" ? "1" : ".4";
    if (value === "solid") $("#canvasBackdrop").style.backgroundColor = $("#previewColor").value;
  }

  function removeSampledColor(x, y) {
    if (!state.resultData) return;
    const output = cloneImageData(state.resultData);
    const index = (y * output.width + x) * 4;
    const target = [output.data[index], output.data[index + 1], output.data[index + 2]];
    const tolerance = Math.max(12, Number($("#deltaRange").value) * 4);
    const limit = tolerance * tolerance;
    let removed = 0;
    for (let i = 0; i < output.data.length; i += 4) {
      if (!output.data[i + 3]) continue;
      const dr = output.data[i] - target[0], dg = output.data[i + 1] - target[1], db = output.data[i + 2] - target[2];
      if (dr * dr + dg * dg + db * db <= limit) { output.data[i + 3] = 0; removed++; }
    }
    state.resultData = output;
    state.logicalResultData = null;
    resultContext.putImageData(output, 0, 0);
    state.eyedropper = false;
    $("#eyedropperButton").classList.remove("active");
    displayCanvas.style.cursor = "default";
    renderDisplay(); updateAnalysis();
    showToast(`已抠除 ${removed.toLocaleString()} 个背景像素`);
  }

  function addOutline() {
    if (!state.resultData) return;
    const source = cloneImageData(state.resultData);
    const output = cloneImageData(state.resultData);
    const { width, height } = source;
    const radius = Number($("#outlineSizeRange").value);
    const mode = $('input[name="outlineMode"]:checked').value;
    const color = hexToRgb($("#outlineColor").value);
    const outer = mode === "outer" || mode === "center";
    const inner = mode === "inner" || mode === "center";

    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const opaque = source.data[index + 3] > 0;
      let touchesOpposite = false;
      for (let oy = -radius; oy <= radius && !touchesOpposite; oy++) for (let ox = -radius; ox <= radius; ox++) {
        if (!ox && !oy || Math.abs(ox) + Math.abs(oy) > radius) continue;
        const nx = x + ox, ny = y + oy;
        const neighborOpaque = nx >= 0 && ny >= 0 && nx < width && ny < height && source.data[(ny * width + nx) * 4 + 3] > 0;
        if (neighborOpaque !== opaque) { touchesOpposite = true; break; }
      }
      if ((opaque && inner && touchesOpposite) || (!opaque && outer && touchesOpposite)) {
        output.data[index] = color.r; output.data[index + 1] = color.g; output.data[index + 2] = color.b; output.data[index + 3] = 255;
      }
    }
    state.resultData = output;
    state.logicalResultData = null;
    resultContext.putImageData(output, 0, 0);
    setView("result");
    showToast(`已添加${mode === "outer" ? "外" : mode === "inner" ? "内" : "居中"}描边`);
  }

  function dataToCanvas(imageData) {
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width; canvas.height = imageData.height;
    canvas.getContext("2d").putImageData(imageData, 0, 0);
    return canvas;
  }

  function onePixelCanvas() {
    if (state.logicalResultData) return dataToCanvas(state.logicalResultData);
    const source = state.resultData || state.originalData;
    const cell = currentCellSize();
    if (cell <= 1) return dataToCanvas(source);
    const reconstructed = reconstructPixels(source, cell);
    const from = dataToCanvas(reconstructed);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(source.width / cell);
    canvas.height = Math.ceil(source.height / cell);
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = false;
    context.drawImage(from, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function canvasToBlob(canvas, type = "image/png") {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("导出失败")), type));
  }

  async function saveBlob(blob, name) {
    if (state.dirHandle) {
      try {
        const handle = await state.dirHandle.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        showToast(`已保存到工作文件夹：${name}`);
        return;
      } catch (error) {
        console.warn("Folder write failed, falling back to download", error);
      }
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function exportImage(onePixel = false) {
    if (!state.originalData) return;
    try {
      const canvas = onePixel ? onePixelCanvas() : dataToCanvas(state.resultData || state.originalData);
      const suffix = onePixel ? "-1px" : "-optimized";
      await saveBlob(await canvasToBlob(canvas), `${baseName(state.fileName)}${suffix}.png`);
    } catch (error) { showToast(error.message, "error"); }
  }

  async function exportPaletteFiles() {
    if (!state.palette.length) return;
    const name = baseName(state.fileName);
    const json = JSON.stringify({ name, colors: state.palette.map(({ hex, count, percent }) => ({ hex, count, percent: Number(percent.toFixed(3)) })) }, null, 2);
    const gpl = [`GIMP Palette`, `Name: ${name}`, `Columns: 8`, `# Exported by PIXEL FORGE`, ...state.palette.map(color => `${color.r} ${color.g} ${color.b}\t${color.hex}`)].join("\n");
    await saveBlob(new Blob([json], { type: "application/json" }), `${name}-palette.json`);
    setTimeout(() => saveBlob(new Blob([gpl], { type: "text/plain" }), `${name}-palette.gpl`), 180);
  }

  async function exportPaletteImage() {
    if (!state.palette.length) return;
    const columns = Math.min(10, state.palette.length);
    const rows = Math.ceil(state.palette.length / columns);
    const size = 48;
    const canvas = document.createElement("canvas");
    canvas.width = columns * size; canvas.height = rows * size;
    const context = canvas.getContext("2d");
    state.palette.forEach((color, index) => {
      const x = index % columns * size, y = Math.floor(index / columns) * size;
      context.fillStyle = color.hex; context.fillRect(x, y, size, size);
      context.fillStyle = (color.r * .299 + color.g * .587 + color.b * .114) > 145 ? "#071315" : "#f3ffff";
      context.font = "9px monospace"; context.fillText(color.hex.toUpperCase(), x + 4, y + size - 6);
    });
    await saveBlob(await canvasToBlob(canvas), `${baseName(state.fileName)}-palette.png`);
  }

  async function pickFolder() {
    if (!("showDirectoryPicker" in window)) {
      showToast("当前浏览器不支持文件夹写入，将使用普通下载", "error");
      return;
    }
    try {
      state.dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      $("#folderStatus").classList.add("ready");
      $("#folderStatus").innerHTML = `<span>●</span> ${state.dirHandle.name}`;
      showToast(`工作文件夹：${state.dirHandle.name}`);
    } catch (error) {
      if (error.name !== "AbortError") showToast("无法访问这个文件夹", "error");
    }
  }

  function openHistoryDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
      const request = indexedDB.open("pixel-forge-history", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("images", { keyPath: "id", autoIncrement: true });
      request.onsuccess = () => { state.db = request.result; resolve(state.db); };
      request.onerror = () => reject(request.error);
    });
  }

  async function addHistory(blob, name, width, height) {
    if (!state.db) return;
    const record = { blob, name, width, height, createdAt: Date.now() };
    await new Promise((resolve, reject) => {
      const request = state.db.transaction("images", "readwrite").objectStore("images").add(record);
      request.onsuccess = resolve; request.onerror = () => reject(request.error);
    });
    const records = await getHistory();
    if (records.length > 16) {
      await new Promise(resolve => {
        const request = state.db.transaction("images", "readwrite").objectStore("images").delete(records[records.length - 1].id);
        request.onsuccess = request.onerror = resolve;
      });
    }
    renderHistory();
  }

  function getHistory() {
    return new Promise((resolve, reject) => {
      if (!state.db) return resolve([]);
      const request = state.db.transaction("images", "readonly").objectStore("images").getAll();
      request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
      request.onerror = () => reject(request.error);
    });
  }

  async function renderHistory() {
    const records = await getHistory();
    state.historyObjectUrls.forEach(URL.revokeObjectURL);
    state.historyObjectUrls = [];
    const list = $("#historyList");
    if (!records.length) {
      list.innerHTML = '<div class="empty-rail"><span>◇</span><p>暂无本地记录</p></div>';
      return;
    }
    list.innerHTML = records.map(record => {
      const url = URL.createObjectURL(record.blob);
      state.historyObjectUrls.push(url);
      return `<button class="history-card" type="button" data-history-id="${record.id}"><img src="${url}" alt=""><span><strong>${record.name}</strong><span>${record.width}×${record.height} · ${new Date(record.createdAt).toLocaleDateString()}</span></span></button>`;
    }).join("");
    list.querySelectorAll("[data-history-id]").forEach(button => button.addEventListener("click", async () => {
      const id = Number(button.dataset.historyId);
      const record = records.find(item => item.id === id);
      if (record) await loadFile(record.blob, record.name, true);
    }));
  }

  async function clearHistory() {
    if (!state.db || !confirm("清空所有本地图片记录？此操作不会删除你磁盘上的原文件。")) return;
    await new Promise(resolve => {
      const request = state.db.transaction("images", "readwrite").objectStore("images").clear();
      request.onsuccess = request.onerror = resolve;
    });
    await renderHistory();
    showToast("本地记录已清空");
  }

  function syncTextColor(colorInput, textInput, callback) {
    colorInput.addEventListener("input", () => { textInput.value = colorInput.value; callback?.(); });
    textInput.addEventListener("change", () => {
      if (/^#[0-9a-f]{6}$/i.test(textInput.value)) colorInput.value = textInput.value;
      else textInput.value = colorInput.value;
      callback?.();
    });
  }

  function bindEvents() {
    const fileInput = $("#fileInput");
    const openFile = () => fileInput.click();
    ["#uploadButton", "#emptyUploadButton", "#openUploadFromRail"].forEach(selector => $(selector).addEventListener("click", openFile));
    fileInput.addEventListener("change", () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); fileInput.value = ""; });
    $("#demoButton").addEventListener("click", async () => {
      try {
        const response = await fetch("reference-test.svg");
        const blob = await response.blob();
        await loadFile(new File([blob], "pixel-forge-demo.svg", { type: "image/svg+xml" }));
      } catch (_) {
        showToast("示例图片加载失败", "error");
      }
    });

    ["dragenter", "dragover"].forEach(type => dropZone.addEventListener(type, event => {
      event.preventDefault(); $("#dropOverlay").hidden = false;
    }));
    ["dragleave", "drop"].forEach(type => dropZone.addEventListener(type, event => {
      event.preventDefault(); $("#dropOverlay").hidden = true;
      if (type === "drop" && event.dataTransfer.files[0]) loadFile(event.dataTransfer.files[0]);
    }));

    $("#autoModeButton").addEventListener("click", () => setMode("auto"));
    $("#manualModeButton").addEventListener("click", () => setMode("manual"));
    $("#originalTab").addEventListener("click", () => setView("original"));
    $("#resultTab").addEventListener("click", () => setView("result"));
    $("#runPipelineButton").addEventListener("click", processImage);

    $("#atlasToggle").addEventListener("change", updateAtlasSummary);
    ["#atlasCols", "#atlasRows"].forEach(selector => $(selector).addEventListener("change", updateAtlasSummary));
    $$('[data-atlas]').forEach(button => button.addEventListener("click", () => {
      const [cols, rows] = button.dataset.atlas.split("x").map(Number);
      $("#atlasCols").value = cols; $("#atlasRows").value = rows; updateAtlasSummary();
    }));

    $("#cellSizeRange").addEventListener("input", event => {
      $("#cellSizeOutput").textContent = event.target.value;
      $$('[data-cell-size]').forEach(button => button.classList.toggle("active", button.dataset.cellSize === event.target.value));
      updateGridInfo(); scheduleProcessing();
    });
    $$('[data-cell-size]').forEach(button => button.addEventListener("click", () => {
      $("#cellSizeRange").value = button.dataset.cellSize;
      $("#cellSizeRange").dispatchEvent(new Event("input"));
    }));

    const refreshParamLabels = () => {
      $("#deltaOutput").textContent = `ΔE ${$("#deltaRange").value}`;
      $("#regionOutput").textContent = Number($("#regionRange").value).toFixed(1);
      const colors = COLOR_OPTIONS[Number($("#colorsRange").value)];
      $("#colorsOutput").textContent = colors;
      $$('[data-color-count]').forEach(button => button.classList.toggle("active", Number(button.dataset.colorCount) === colors));
    };
    ["#deltaRange", "#regionRange", "#colorsRange"].forEach(selector => $(selector).addEventListener("input", () => { refreshParamLabels(); scheduleProcessing(); }));
    ["#quantizeToggle", "#regionToggle", "#colorsToggle", "#reconstructToggle"].forEach(selector => $(selector).addEventListener("change", scheduleProcessing));
    $$('[data-step-target]').forEach(button => button.addEventListener("click", () => {
      const target = $(`#${button.dataset.stepTarget}`);
      target.value = clamp(Number(target.value) + Number(button.dataset.step), Number(target.min), Number(target.max));
      target.dispatchEvent(new Event("input"));
    }));
    $$('[data-color-count]').forEach(button => button.addEventListener("click", () => {
      $("#colorsRange").value = COLOR_OPTIONS.indexOf(Number(button.dataset.colorCount));
      $("#colorsRange").dispatchEvent(new Event("input"));
    }));

    $("#eyedropperButton").addEventListener("click", () => {
      if (!state.resultData) return;
      state.eyedropper = !state.eyedropper;
      displayCanvas.style.cursor = state.eyedropper ? "crosshair" : "default";
      showToast(state.eyedropper ? "点击画布选择要抠除的背景色" : "已退出吸管模式");
    });
    displayCanvas.addEventListener("click", event => {
      if (!state.eyedropper || !currentData()) return;
      const rect = displayCanvas.getBoundingClientRect();
      const x = clamp(Math.floor((event.clientX - rect.left) / rect.width * displayCanvas.width), 0, displayCanvas.width - 1);
      const y = clamp(Math.floor((event.clientY - rect.top) / rect.height * displayCanvas.height), 0, displayCanvas.height - 1);
      if (state.view === "original") setView("result");
      removeSampledColor(x, y);
    });
    displayCanvas.addEventListener("mousemove", event => {
      if (!currentData() || state.fitScale * state.zoom < 3) { $("#pixelTooltip").hidden = true; return; }
      const rect = displayCanvas.getBoundingClientRect();
      const x = clamp(Math.floor((event.clientX - rect.left) / rect.width * displayCanvas.width), 0, displayCanvas.width - 1);
      const y = clamp(Math.floor((event.clientY - rect.top) / rect.height * displayCanvas.height), 0, displayCanvas.height - 1);
      const data = currentData().data, index = (y * currentData().width + x) * 4;
      const tip = $("#pixelTooltip");
      tip.hidden = false; tip.textContent = `${x},${y} · ${rgbToHex(data[index], data[index + 1], data[index + 2])} · A${data[index + 3]}`;
      tip.style.left = `${event.clientX - $("#stage").getBoundingClientRect().left + 12}px`;
      tip.style.top = `${event.clientY - $("#stage").getBoundingClientRect().top + 12}px`;
    });
    displayCanvas.addEventListener("mouseleave", () => $("#pixelTooltip").hidden = true);

    $("#outlineSizeRange").addEventListener("input", event => $("#outlineSizeOutput").textContent = event.target.value);
    $("#outlineButton").addEventListener("click", addOutline);

    $$('input[name="previewBg"]').forEach(input => input.addEventListener("change", applyBackgroundChoice));
    syncTextColor($("#previewColor"), $("#previewColorText"), applyBackgroundChoice);
    syncTextColor($("#outlineColor"), $("#outlineColorText"));

    ["#gridToggle", "#gridColor", "#gridWidth"].forEach(selector => $(selector).addEventListener("input", renderGrid));
    $("#zoomIn").addEventListener("click", () => setZoom(state.zoom * 1.35));
    $("#zoomOut").addEventListener("click", () => setZoom(state.zoom / 1.35));
    $("#zoomReset").addEventListener("click", resetZoom);
    dropZone.addEventListener("wheel", event => {
      if (!state.originalData || event.deltaY === 0) return;
      event.preventDefault();
      const deltaPixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? dropZone.clientHeight : 1);
      const factor = Math.exp(-clamp(deltaPixels, -240, 240) * .0015);
      setZoom(state.zoom * factor, event.clientX, event.clientY);
    }, { passive: false });

    const stopMiddlePan = event => {
      if (!state.panning || event?.pointerId != null && event.pointerId !== state.panPointerId) return;
      const pointerId = state.panPointerId;
      state.panning = false;
      state.panPointerId = null;
      dropZone.classList.remove("is-panning");
      if (pointerId != null && dropZone.hasPointerCapture?.(pointerId)) dropZone.releasePointerCapture(pointerId);
    };
    dropZone.addEventListener("pointerdown", event => {
      if (!state.originalData || event.button !== 1) return;
      event.preventDefault();
      state.panning = true;
      state.panPointerId = event.pointerId;
      state.panLastX = event.clientX;
      state.panLastY = event.clientY;
      dropZone.classList.add("is-panning");
      $("#pixelTooltip").hidden = true;
      dropZone.setPointerCapture?.(event.pointerId);
    });
    dropZone.addEventListener("pointermove", event => {
      if (!state.panning || event.pointerId !== state.panPointerId) return;
      if ((event.buttons & 4) === 0) { stopMiddlePan(event); return; }
      event.preventDefault();
      state.panX += event.clientX - state.panLastX;
      state.panY += event.clientY - state.panLastY;
      state.panLastX = event.clientX;
      state.panLastY = event.clientY;
      applyPanTransform();
    });
    dropZone.addEventListener("pointerup", stopMiddlePan);
    dropZone.addEventListener("pointercancel", stopMiddlePan);
    dropZone.addEventListener("lostpointercapture", stopMiddlePan);
    dropZone.addEventListener("mousedown", event => { if (event.button === 1) event.preventDefault(); });
    dropZone.addEventListener("auxclick", event => { if (event.button === 1) event.preventDefault(); });
    window.addEventListener("blur", stopMiddlePan);

    $("#exportButton").addEventListener("click", () => exportImage(false));
    $("#exportOnePxButton").addEventListener("click", () => exportImage(true));
    $("#downloadPaletteButton").addEventListener("click", exportPaletteFiles);
    $("#exportPaletteImageButton").addEventListener("click", exportPaletteImage);
    $("#copyPaletteButton").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(state.palette.map(color => color.hex).join("\n")); showToast("HEX 色值已复制"); }
      catch (_) { showToast("无法访问剪贴板", "error"); }
    });

    $("#pickFolderButton").addEventListener("click", pickFolder);
    $("#refreshHistory").addEventListener("click", renderHistory);
    $("#clearHistoryButton").addEventListener("click", clearHistory);
    $("#collapseControl").addEventListener("click", () => {
      $("#controlPanel").classList.toggle("collapsed");
      $("#collapseControl").textContent = $("#controlPanel").classList.contains("collapsed") ? "›" : "‹";
      setTimeout(renderDisplay, 260);
    });
    $("#collapseAnalysis").addEventListener("click", () => {
      $("#analysisPanel").classList.toggle("collapsed");
      $("#collapseAnalysis").textContent = $("#analysisPanel").classList.contains("collapsed") ? "‹" : "›";
      setTimeout(renderDisplay, 260);
    });
    $("#themeButton").addEventListener("click", () => {
      document.body.classList.toggle("graphite");
      $("#themeButton span").textContent = document.body.classList.contains("graphite") ? "石墨" : "赛博";
    });

    $('[data-action="focus-atlas"]').addEventListener("click", () => {
      $("#atlasToggle").checked = true; updateAtlasSummary(); $("#atlasToggle").scrollIntoView({ behavior: "smooth", block: "center" });
    });
    $('[data-action="focus-palette"]').addEventListener("click", () => $("#paletteSection").scrollIntoView({ behavior: "smooth", block: "start" }));
    $('[data-action="open-help"]').addEventListener("click", () => $("#helpDialog").showModal());
    $('[data-close-dialog]').addEventListener("click", () => $("#helpDialog").close());

    window.addEventListener("resize", () => { if (state.originalData) renderDisplay(); });
  }

  async function initialize() {
    bindEvents();
    applyBackgroundChoice();
    setEnabled(false);
    try { await openHistoryDb(); await renderHistory(); } catch (_) { /* private mode or file:// */ }
  }

  initialize();
})();
