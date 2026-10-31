/* ==========================================================================
   PicsConvert - Everyday Tools: shared helpers + image tools (tools.js)
   Image Compressor and Image Resizer. PDF tools live in pdf-tools.js and
   pdf-editor.js. Loaded after app.js, which provides the theme controller,
   cookie banner and escapeHTML(). Each tool only runs on its own page.
   ========================================================================== */

// ==========================================================================
// 1. SHARED HELPERS
// ==========================================================================

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function stripExtension(name) {
    return name.replace(/\.[^/.]+$/, "");
}

function clampValue(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function newId() {
    return Math.random().toString(36).slice(2, 11);
}

function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Decode a File into an <img>; resolves with the element and its object URL
function loadImageFile(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            if (!img.naturalWidth || !img.naturalHeight) {
                URL.revokeObjectURL(url);
                reject(new Error("Image has no readable dimensions"));
                return;
            }
            resolve({ img, url });
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Unsupported or corrupt image"));
        };
        img.src = url;
    });
}

function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Image too large for this browser")), mime, quality);
    });
}

// Safari before 17 silently falls back to PNG when asked for WebP
let webpSupportPromise = null;
function supportsWebpEncoding() {
    if (!webpSupportPromise) {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        webpSupportPromise = canvasToBlob(c, 'image/webp', 0.8).then(b => b.type === 'image/webp').catch(() => false);
    }
    return webpSupportPromise;
}

const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Map an output format choice ("original" | "jpeg" | "png" | "webp") to a MIME type
async function resolveOutputMime(choice, file) {
    const mimes = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
    let mime = choice === 'original'
        ? (MIME_EXT[file.type] ? file.type : 'image/png')
        : mimes[choice];
    if (mime === 'image/webp' && !(await supportsWebpEncoding())) mime = 'image/jpeg';
    return mime;
}

// Draw a source onto a new canvas, halving large rasters step by step so downscales stay sharp
function drawResized(source, width, height, background) {
    let current = source;
    let cw = source.naturalWidth || source.width;
    let ch = source.naturalHeight || source.height;
    while (cw / 2 >= width && ch / 2 >= height) {
        const step = document.createElement('canvas');
        step.width = Math.round(cw / 2);
        step.height = Math.round(ch / 2);
        const sctx = step.getContext('2d');
        sctx.imageSmoothingQuality = 'high';
        sctx.drawImage(current, 0, 0, step.width, step.height);
        current = step;
        cw = step.width;
        ch = step.height;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(current, 0, 0, width, height);
    return canvas;
}

// Wire a drop zone + hidden file input. onFiles receives the accepted Files.
function bindToolDropZone(zone, input, onFiles, accept = f => f.type.startsWith('image/')) {
    if (!zone || !input) return;

    const handle = (fileList) => {
        const files = Array.from(fileList).filter(accept);
        if (files.length) onFiles(files);
    };

    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            input.click();
        }
    });
    ['dragenter', 'dragover'].forEach(type => {
        zone.addEventListener(type, (e) => {
            e.preventDefault();
            zone.classList.add('drag-over');
        });
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        handle(e.dataTransfer.files);
    });
    input.addEventListener('change', () => {
        handle(input.files);
        input.value = "";
    });
}

function bindRangeText(slider, textEl, format = v => Math.round(v * 100) + "%") {
    if (!slider || !textEl) return;
    const update = () => { textEl.innerText = format(parseFloat(slider.value)); };
    slider.addEventListener('input', update);
    update();
}

// Segmented chip group: calls onSelect(value) with the chosen button's data-value
function bindChipGroup(group, onSelect) {
    if (!group) return;
    const buttons = group.querySelectorAll('[data-value]');
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            buttons.forEach(b => {
                b.classList.toggle('active', b === btn);
                b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
            });
            onSelect(btn.dataset.value);
        });
    });
}

function requireJSZip() {
    if (typeof JSZip !== 'undefined') return true;
    alert("The ZIP download feature requires the JSZip library, which failed to load. This can happen if you are offline or if the CDN is blocked by your browser/network.");
    return false;
}

// Give every entry a unique file name inside a ZIP ("photo.jpg", "photo (2).jpg", ...)
function uniqueFileName(used, name) {
    const count = used[name] || 0;
    used[name] = count + 1;
    if (!count) return name;
    const stem = stripExtension(name);
    return `${stem} (${count + 1})${name.slice(stem.length)}`;
}

async function downloadZip(entries, zipName, statusEl) {
    if (!entries.length || !requireJSZip()) return;
    const zip = new JSZip();
    const used = {};
    entries.forEach(e => zip.file(uniqueFileName(used, e.name), e.blob));
    if (statusEl) statusEl.innerText = "Creating ZIP bundle...";
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, zipName);
    if (statusEl) statusEl.innerText = "ZIP downloaded";
}

const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

// Result row in the same style as the converter's queue (thumbnail, name, sizes, savings, actions)
function createResultCard(listEl, item, onRemove) {
    const card = document.createElement('div');
    card.className = 'preview-card';
    card.dataset.state = 'pending';
    card.innerHTML = `
        <div class="preview-card-image-wrap">
            <div class="card-loader"><div class="spinner"></div></div>
            <img src="${item.thumbUrl}" alt="">
        </div>
        <div class="preview-card-details">
            <div class="preview-card-header">
                <span class="file-name" title="${escapeHTML(item.file.name)}">${escapeHTML(item.file.name)}</span>
                <span class="format-pill">Queued</span>
            </div>
            <div class="size-comparison"><span>Waiting in queue...</span></div>
        </div>
        <div class="savings-value" aria-label="Size change"></div>
        <div class="card-actions">
            <button class="card-btn card-btn-download" disabled title="Download file">${ICON_DOWNLOAD}<span>Download</span></button>
            <button class="card-btn card-btn-delete" title="Remove file" aria-label="Remove file">${ICON_CLOSE}</button>
        </div>
    `;
    card.querySelector('.card-btn-delete').onclick = () => {
        card.remove();
        onRemove(item);
    };
    listEl.appendChild(card);
    return card;
}

function setCardPending(card) {
    card.dataset.state = 'pending';
    card.querySelector('.card-loader').style.display = 'flex';
    card.querySelector('.format-pill').innerText = 'Working';
    card.querySelector('.size-comparison').innerHTML = '<span>Processing...</span>';
    card.querySelector('.savings-value').innerText = '';
    card.querySelector('.card-btn-download').disabled = true;
}

function setCardResult(card, { pill, beforeSize, afterSize, detail, onDownload }) {
    const savings = Math.round((1 - afterSize / beforeSize) * 100);
    const barWidth = Math.min(100, Math.max(2, (afterSize / beforeSize) * 100));
    card.dataset.state = 'done';
    card.querySelector('.card-loader').style.display = 'none';
    card.querySelector('.format-pill').innerText = pill;
    card.querySelector('.size-comparison').innerHTML = `
        <div class="size-line"><span>${formatBytes(beforeSize)}</span><span class="size-arrow">→</span><strong>${formatBytes(afterSize)}</strong>${detail ? `<span class="size-detail">${escapeHTML(detail)}</span>` : ''}</div>
        <div class="size-bar${savings < 0 ? ' is-larger' : ''}"><span style="width: ${barWidth}%"></span></div>
    `;
    const savingsEl = card.querySelector('.savings-value');
    savingsEl.className = 'savings-value' + (savings > 0 ? ' is-positive' : savings < 0 ? ' is-negative' : '');
    savingsEl.innerText = savings > 0 ? `−${savings}%` : savings < 0 ? `+${Math.abs(savings)}%` : '0%';
    const dlBtn = card.querySelector('.card-btn-download');
    dlBtn.disabled = false;
    dlBtn.onclick = onDownload;
}

function setCardError(card, message) {
    card.dataset.state = 'error';
    card.querySelector('.card-loader').style.display = 'none';
    card.querySelector('.format-pill').innerText = 'Failed';
    card.querySelector('.size-comparison').innerText = message;
    card.querySelector('.card-btn-download').disabled = true;
}

// Sequential batch queue shared by the image tools: one image in memory at a time
function createImageBatch({ listEl, statusEl, statsEl, downloadAllBtn, clearBtn, process, onStats }) {
    let items = [];
    let running = false;
    let generation = 0;

    function refresh() {
        const done = items.filter(i => i.result);
        if (statsEl) statsEl.style.display = items.length ? 'grid' : 'none';
        if (downloadAllBtn) downloadAllBtn.disabled = !done.length || running;
        if (clearBtn) clearBtn.disabled = !items.length;
        if (onStats) onStats(items, done);
        if (!items.length) statusEl.innerText = "Ready for upload";
        else if (running) statusEl.innerText = `Processing... (${items.filter(i => !i.result && !i.error).length} remaining)`;
        else statusEl.innerText = `${done.length} of ${items.length} images ready`;
    }

    async function run() {
        if (running) return;
        running = true;
        const gen = generation;
        refresh();
        let next;
        while ((next = items.find(i => !i.result && !i.error))) {
            const item = next;
            setCardPending(item.card);
            try {
                const result = await process(item);
                if (gen !== generation) break; // settings changed mid-run
                item.result = result;
                setCardResult(item.card, {
                    ...result.display,
                    onDownload: () => triggerDownload(result.blob, result.name)
                });
            } catch (err) {
                if (gen !== generation) break;
                item.error = err.message;
                setCardError(item.card, err.message);
            }
            refresh();
        }
        running = false;
        if (gen !== generation) run();
        refresh();
    }

    function add(files) {
        files.forEach(file => {
            const item = { id: newId(), file, thumbUrl: URL.createObjectURL(file), result: null, error: null };
            item.card = createResultCard(listEl, item, removed => {
                URL.revokeObjectURL(removed.thumbUrl);
                items = items.filter(i => i !== removed);
                refresh();
            });
            items.push(item);
        });
        run();
    }

    // Re-process every image with new settings
    function reset() {
        generation++;
        items.forEach(i => { i.result = null; i.error = null; });
        if (items.length) run();
    }

    function clear() {
        generation++;
        items.forEach(i => URL.revokeObjectURL(i.thumbUrl));
        items = [];
        listEl.innerHTML = "";
        refresh();
    }

    if (clearBtn) clearBtn.addEventListener('click', clear);
    if (downloadAllBtn) {
        downloadAllBtn.addEventListener('click', () => {
            downloadZip(items.filter(i => i.result).map(i => ({ name: i.result.name, blob: i.result.blob })), downloadAllBtn.dataset.zipName || 'PicsConvert.zip', statusEl);
        });
    }

    return { add, reset };
}

function debounce(fn, wait) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
}

// ==========================================================================
// 2. IMAGE COMPRESSOR
// ==========================================================================

(function initCompressTool() {
    const root = document.getElementById('compressTool');
    if (!root) return;

    const qualityEl = document.getElementById('compressQuality');
    const targetEl = document.getElementById('compressTarget');
    const formatEl = document.getElementById('compressFormat');
    const qualityWrap = document.getElementById('compressQualityWrap');
    const targetWrap = document.getElementById('compressTargetWrap');
    let mode = 'quality';

    async function compress(item) {
        const file = item.file;
        // PNG and others have no quality setting on canvas, so "auto" re-encodes them as WebP
        const choice = formatEl.value === 'auto' ? (file.type === 'image/jpeg' ? 'jpeg' : 'webp') : formatEl.value;
        const mime = await resolveOutputMime(choice, file);
        const background = mime === 'image/jpeg' ? '#ffffff' : null;
        const { img, url } = await loadImageFile(file);

        try {
            let w = img.naturalWidth, h = img.naturalHeight;
            let canvas = drawResized(img, w, h, background);
            let blob;

            if (mode === 'quality') {
                blob = await canvasToBlob(canvas, mime, parseFloat(qualityEl.value));
            } else {
                const target = Math.max(5, parseFloat(targetEl.value) || 100) * 1024;
                // Binary-search the quality; shrink dimensions only if even the lowest quality is too big
                for (let attempt = 0; attempt < 8 && !blob; attempt++) {
                    let lo = 0.05, hi = 0.92, best = null;
                    const top = await canvasToBlob(canvas, mime, hi);
                    if (top.size <= target) {
                        best = top;
                    } else {
                        for (let i = 0; i < 7; i++) {
                            const q = (lo + hi) / 2;
                            const attemptBlob = await canvasToBlob(canvas, mime, q);
                            if (attemptBlob.size <= target) { best = attemptBlob; lo = q; } else hi = q;
                        }
                    }
                    if (best) {
                        blob = best;
                    } else {
                        const floor = await canvasToBlob(canvas, mime, 0.05);
                        const factor = clampValue(Math.sqrt(target / floor.size) * 0.95, 0.4, 0.9);
                        w = Math.max(1, Math.round(w * factor));
                        h = Math.max(1, Math.round(h * factor));
                        canvas = drawResized(img, w, h, background);
                        if (attempt === 7) blob = floor;
                    }
                }
            }

            // Never hand back a bigger file in the same format
            let note = w !== img.naturalWidth ? `${w}×${h}px` : '';
            if (blob.size >= file.size && mime === file.type && w === img.naturalWidth) {
                blob = file;
                note = 'already optimized';
            }

            return {
                blob,
                name: `${stripExtension(file.name)}-compressed.${MIME_EXT[blob.type] || MIME_EXT[mime]}`,
                display: { pill: (MIME_EXT[blob.type] || 'img').toUpperCase(), beforeSize: file.size, afterSize: blob.size, detail: note }
            };
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    const batch = createImageBatch({
        listEl: document.getElementById('compressList'),
        statusEl: document.getElementById('compressStatus'),
        statsEl: document.getElementById('compressStats'),
        downloadAllBtn: document.getElementById('compressDownloadAll'),
        clearBtn: document.getElementById('compressClear'),
        process: compress,
        onStats: (items, done) => {
            const before = done.reduce((s, i) => s + i.file.size, 0);
            const after = done.reduce((s, i) => s + i.result.blob.size, 0);
            document.getElementById('compressStatFiles').innerText = items.length;
            document.getElementById('compressStatSize').innerText = done.length ? formatBytes(after) : '0 B';
            document.getElementById('compressStatSaved').innerText = before ? `${Math.max(0, Math.round((1 - after / before) * 100))}%` : '0%';
        }
    });

    bindRangeText(qualityEl, document.getElementById('compressQualityText'));
    bindChipGroup(document.getElementById('compressMode'), value => {
        mode = value;
        qualityWrap.hidden = mode !== 'quality';
        targetWrap.hidden = mode !== 'target';
        batch.reset();
    });
    bindChipGroup(document.getElementById('compressTargetPresets'), value => {
        targetEl.value = value;
        batch.reset();
    });
    qualityEl.addEventListener('change', batch.reset);
    targetEl.addEventListener('input', debounce(batch.reset, 500));
    formatEl.addEventListener('change', batch.reset);

    bindToolDropZone(document.getElementById('compressDropZone'), document.getElementById('compressFileInput'), batch.add);
})();

// ==========================================================================
// 3. IMAGE RESIZER
// ==========================================================================

(function initResizeTool() {
    const root = document.getElementById('resizeTool');
    if (!root) return;

    const widthEl = document.getElementById('resizeWidth');
    const heightEl = document.getElementById('resizeHeight');
    const percentEl = document.getElementById('resizePercent');
    const presetEl = document.getElementById('resizePreset');
    const fitEl = document.getElementById('resizeFit');
    const formatEl = document.getElementById('resizeFormat');
    const qualityEl = document.getElementById('resizeQuality');
    const pixelsWrap = document.getElementById('resizePixelsWrap');
    const percentWrap = document.getElementById('resizePercentWrap');
    const fitWrap = document.getElementById('resizeFitWrap');
    let mode = 'pixels';

    function targetSize(iw, ih) {
        if (mode === 'percent') {
            const f = parseFloat(percentEl.value) / 100;
            return { w: Math.max(1, Math.round(iw * f)), h: Math.max(1, Math.round(ih * f)), fit: 'stretch' };
        }
        const W = parseInt(widthEl.value) || 0;
        const H = parseInt(heightEl.value) || 0;
        if (!W && !H) return { w: iw, h: ih, fit: 'stretch' };
        if (W && !H) return { w: W, h: Math.max(1, Math.round(ih * W / iw)), fit: 'stretch' };
        if (H && !W) return { w: Math.max(1, Math.round(iw * H / ih)), h: H, fit: 'stretch' };
        if (fitEl.value === 'inside') {
            const r = Math.min(W / iw, H / ih);
            return { w: Math.max(1, Math.round(iw * r)), h: Math.max(1, Math.round(ih * r)), fit: 'stretch' };
        }
        return { w: W, h: H, fit: fitEl.value };
    }

    async function resize(item) {
        const file = item.file;
        const mime = await resolveOutputMime(formatEl.value, file);
        const background = mime === 'image/jpeg' ? '#ffffff' : null;
        const { img, url } = await loadImageFile(file);

        try {
            const iw = img.naturalWidth, ih = img.naturalHeight;
            const { w, h, fit } = targetSize(iw, ih);
            let canvas;

            if (fit === 'stretch') {
                canvas = drawResized(img, w, h, background);
            } else {
                // cover: scale up to fill and crop the overflow; pad: scale down to fit and fill the rest
                const scale = fit === 'cover' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
                const sw = Math.max(1, Math.round(iw * scale)), sh = Math.max(1, Math.round(ih * scale));
                const scaled = drawResized(img, sw, sh);
                canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = fit === 'pad' && !background ? 'rgba(0,0,0,0)' : '#ffffff';
                ctx.fillRect(0, 0, w, h);
                ctx.drawImage(scaled, Math.round((w - sw) / 2), Math.round((h - sh) / 2));
            }

            const blob = await canvasToBlob(canvas, mime, parseFloat(qualityEl.value));
            return {
                blob,
                name: `${stripExtension(file.name)}-${w}x${h}.${MIME_EXT[blob.type] || MIME_EXT[mime]}`,
                display: { pill: `${w}×${h}`, beforeSize: file.size, afterSize: blob.size, detail: `from ${iw}×${ih}` }
            };
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    const batch = createImageBatch({
        listEl: document.getElementById('resizeList'),
        statusEl: document.getElementById('resizeStatus'),
        downloadAllBtn: document.getElementById('resizeDownloadAll'),
        clearBtn: document.getElementById('resizeClear'),
        process: resize
    });
    const reprocess = debounce(batch.reset, 450);

    function syncFitVisibility() {
        fitWrap.hidden = !(mode === 'pixels' && widthEl.value && heightEl.value);
    }

    bindChipGroup(document.getElementById('resizeMode'), value => {
        mode = value;
        pixelsWrap.hidden = mode !== 'pixels';
        percentWrap.hidden = mode !== 'percent';
        syncFitVisibility();
        batch.reset();
    });

    presetEl.addEventListener('change', () => {
        const [w, h] = presetEl.value.split('x');
        if (!w) return;
        widthEl.value = w;
        heightEl.value = h;
        fitEl.value = 'cover';
        syncFitVisibility();
        batch.reset();
    });

    [widthEl, heightEl].forEach(el => el.addEventListener('input', () => {
        presetEl.value = '';
        syncFitVisibility();
        reprocess();
    }));
    bindRangeText(percentEl, document.getElementById('resizePercentText'), v => `${v}%`);
    bindRangeText(qualityEl, document.getElementById('resizeQualityText'));
    percentEl.addEventListener('change', batch.reset);
    qualityEl.addEventListener('change', batch.reset);
    [fitEl, formatEl].forEach(el => el.addEventListener('change', batch.reset));

    syncFitVisibility();
    bindToolDropZone(document.getElementById('resizeDropZone'), document.getElementById('resizeFileInput'), batch.add);
})();
