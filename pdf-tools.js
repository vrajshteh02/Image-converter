/* ==========================================================================
   PicsConvert - PDF Tools (pdf-tools.js)
   Image to PDF, PDF to Image, Merge PDF and Split PDF.
   Requires tools.js (shared helpers), pdf-lib (PDFLib) for writing PDFs and
   PDF.js (pdfjsLib) for rendering pages. Everything runs in the browser.
   ========================================================================== */

// ==========================================================================
// 1. PDF HELPERS
// ==========================================================================

const PDFJS_WORKER_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

function isPdfFile(file) {
    return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function requirePdfLib() {
    if (typeof PDFLib !== 'undefined') return true;
    alert("The PDF engine (pdf-lib) failed to load. This can happen if you are offline or if the CDN is blocked by your browser/network.");
    return false;
}

function getPdfJs() {
    if (typeof pdfjsLib === 'undefined') {
        alert("The PDF viewer (PDF.js) failed to load. This can happen if you are offline or if the CDN is blocked by your browser/network.");
        return null;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
    return pdfjsLib;
}

// Read a PDF File for rendering; keeps the raw bytes for pdf-lib as well
async function openPdf(file) {
    const lib = getPdfJs();
    if (!lib) throw new Error("PDF viewer failed to load");
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
        // PDF.js detaches the buffer it receives, so hand it a copy
        const doc = await lib.getDocument({ data: bytes.slice() }).promise;
        return { bytes, doc };
    } catch (err) {
        if (err && err.name === 'PasswordException') throw new Error("Password-protected PDFs are not supported");
        throw new Error("Not a valid PDF file");
    }
}

async function loadPdfForEditing(bytes) {
    try {
        return await PDFLib.PDFDocument.load(bytes);
    } catch (err) {
        if (/encrypt/i.test(err.message)) throw new Error("This PDF is protected. Remove its password or restrictions first.");
        throw new Error("Could not read this PDF");
    }
}

// Render one page to a canvas. Pass width for a fixed pixel width, or scale (1 = 72 DPI).
async function renderPdfPage(doc, pageNumber, { scale = 1, width, extraRotation = 0, background = '#ffffff', maxPixels = 40e6 } = {}) {
    const page = await doc.getPage(pageNumber);
    const rotation = (page.rotate + extraRotation) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    if (width) scale = width / base.width;
    // Keep huge pages at high DPI within browser canvas limits
    scale = Math.min(scale, Math.sqrt(maxPixels / (base.width * base.height)));
    const viewport = page.getViewport({ scale, rotation });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d');
    if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup();
    return canvas;
}

function pdfBlob(bytes) {
    return new Blob([bytes], { type: 'application/pdf' });
}

const THUMB_WIDTH = 150 * Math.min(window.devicePixelRatio || 1, 2);

const ICON_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
const ICON_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
const ICON_ROTATE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>';

// Thumbnail grid with drag-and-drop (and arrow-button) reordering.
// describe(item, index) -> { thumb: Element, title, meta, badge, selected, actions: [{ icon, label, onClick }] }
function renderThumbGrid(container, items, { describe, onChange, onRemove, onToggle, reorderable = true }) {
    container.innerHTML = "";

    const move = (from, to) => {
        if (from === to || to < 0 || to >= items.length) return;
        const [moved] = items.splice(from, 1);
        items.splice(to, 0, moved);
        onChange();
    };

    items.forEach((item, index) => {
        const info = describe(item, index);
        const card = document.createElement('div');
        card.className = 'thumb-card' + (info.selected ? ' is-selected' : '');
        card.draggable = reorderable;
        card.innerHTML = `
            <div class="thumb-frame">${info.badge ? `<span class="thumb-badge">${escapeHTML(info.badge)}</span>` : ''}</div>
            <div class="thumb-meta">
                <span class="thumb-title" title="${escapeHTML(info.title)}">${escapeHTML(info.title)}</span>
                ${info.meta ? `<span class="thumb-sub">${escapeHTML(info.meta)}</span>` : ''}
            </div>
            <div class="thumb-actions"></div>
        `;
        if (info.thumb) card.querySelector('.thumb-frame').appendChild(info.thumb);

        const actions = card.querySelector('.thumb-actions');
        const addAction = (icon, label, onClick) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'thumb-btn';
            btn.title = label;
            btn.setAttribute('aria-label', label);
            btn.innerHTML = icon;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                onClick();
            });
            actions.appendChild(btn);
        };
        if (reorderable) {
            if (index > 0) addAction(ICON_LEFT, 'Move earlier', () => move(index, index - 1));
            if (index < items.length - 1) addAction(ICON_RIGHT, 'Move later', () => move(index, index + 1));
        }
        (info.actions || []).forEach(a => addAction(a.icon, a.label, a.onClick));
        if (onRemove) addAction(ICON_CLOSE, 'Remove', () => onRemove(item));

        if (onToggle) {
            card.tabIndex = 0;
            card.setAttribute('role', 'checkbox');
            card.setAttribute('aria-checked', info.selected ? 'true' : 'false');
            card.addEventListener('click', () => onToggle(item));
            card.addEventListener('keydown', (e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    onToggle(item);
                }
            });
        }

        if (reorderable) {
            card.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('application/x-thumb-index', String(index));
                e.dataTransfer.effectAllowed = 'move';
                card.classList.add('is-dragging');
            });
            card.addEventListener('dragend', () => card.classList.remove('is-dragging'));
            card.addEventListener('dragover', (e) => {
                if (!e.dataTransfer.types.includes('application/x-thumb-index')) return;
                e.preventDefault();
                card.classList.add('is-drop-target');
            });
            card.addEventListener('dragleave', () => card.classList.remove('is-drop-target'));
            card.addEventListener('drop', (e) => {
                const from = parseInt(e.dataTransfer.getData('application/x-thumb-index'), 10);
                card.classList.remove('is-drop-target');
                if (Number.isNaN(from)) return;
                e.preventDefault();
                move(from, index);
            });
        }

        container.appendChild(card);
    });
}

// "1-3, 5, 8-" -> [[1,3],[5,5],[8,max]]
function parsePageRanges(text, max) {
    const ranges = [];
    text.split(/[,;]+/).map(s => s.trim()).filter(Boolean).forEach(part => {
        const m = part.match(/^(\d*)\s*-\s*(\d*)$/) || part.match(/^(\d+)$/);
        if (!m) throw new Error(`"${part}" isn't a page or range`);
        const start = m[1] ? parseInt(m[1], 10) : 1;
        const end = m.length > 2 ? (m[2] ? parseInt(m[2], 10) : max) : start;
        if (start < 1 || end > max || start > end) throw new Error(`"${part}" is outside pages 1–${max}`);
        ranges.push([start, end]);
    });
    return ranges;
}

// [1,2,3,5] -> "1-3, 5"
function formatPageList(pages) {
    const sorted = [...pages].sort((a, b) => a - b);
    const parts = [];
    for (let i = 0; i < sorted.length; i++) {
        const start = sorted[i];
        while (sorted[i + 1] === sorted[i] + 1) i++;
        parts.push(start === sorted[i] ? `${start}` : `${start}-${sorted[i]}`);
    }
    return parts.join(', ');
}

// Copy the given zero-based page indices of a pdf-lib document into a new PDF
async function copyPagesToNewPdf(source, indices) {
    const out = await PDFLib.PDFDocument.create();
    const pages = await out.copyPages(source, indices);
    pages.forEach(p => out.addPage(p));
    out.setProducer('PicsConvert (pdf-lib)');
    return pdfBlob(await out.save());
}

// Render thumbnails one at a time so large PDFs don't freeze the page
async function renderThumbnailsSequentially(doc, pages, onEach, isCancelled) {
    for (const p of pages) {
        if (isCancelled()) return;
        try {
            p.thumb = await renderPdfPage(doc, p.number, { width: THUMB_WIDTH });
        } catch (e) {
            p.thumb = null;
        }
        if (isCancelled()) return;
        onEach(p);
    }
}

// ==========================================================================
// 2. IMAGE TO PDF
// ==========================================================================

(function initImageToPdfTool() {
    const root = document.getElementById('img2pdfTool');
    if (!root) return;

    const dropZoneEl = document.getElementById('img2pdfDropZone');
    const inputEl = document.getElementById('img2pdfFileInput');
    const workspaceEl = document.getElementById('img2pdfWorkspace');
    const gridEl = document.getElementById('img2pdfGrid');
    const statusEl = document.getElementById('img2pdfStatus');
    const sizeEl = document.getElementById('img2pdfPageSize');
    const marginEl = document.getElementById('img2pdfMargin');
    const qualityEl = document.getElementById('img2pdfQuality');
    const orientationWrap = document.getElementById('img2pdfOrientationWrap');
    const createBtn = document.getElementById('img2pdfCreate');
    let orientation = 'auto';
    let items = [];

    const QUALITY = {
        high: { maxSide: 4000, quality: 0.92 },
        medium: { maxSide: 2000, quality: 0.8 },
        low: { maxSide: 1400, quality: 0.65 }
    };

    function render() {
        workspaceEl.hidden = !items.length;
        createBtn.disabled = !items.length;
        statusEl.innerText = items.length ? `${items.length} image${items.length > 1 ? 's' : ''} · ${items.length} page${items.length > 1 ? 's' : ''}` : "Ready for upload";
        renderThumbGrid(gridEl, items, {
            describe: (item, index) => {
                item.img.style.transform = `rotate(${item.rotation}deg)`;
                return {
                    thumb: item.img,
                    title: item.file.name,
                    meta: formatBytes(item.file.size),
                    badge: `${index + 1}`,
                    actions: [{ icon: ICON_ROTATE, label: 'Rotate 90°', onClick: () => { item.rotation = (item.rotation + 90) % 360; render(); } }]
                };
            },
            onChange: render,
            onRemove: (item) => {
                URL.revokeObjectURL(item.url);
                items = items.filter(i => i !== item);
                render();
            }
        });
    }

    function addFiles(files) {
        files.forEach(file => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.src = url;
            img.alt = "";
            items.push({ id: newId(), file, url, img, rotation: 0 });
        });
        render();
    }

    // Draw the image (applying EXIF orientation and the user's rotation) and encode it for embedding
    async function rasterize(item, preset) {
        const { img, url } = await loadImageFile(item.file);
        try {
            const iw = img.naturalWidth, ih = img.naturalHeight;
            const factor = Math.min(1, preset.maxSide / Math.max(iw, ih));
            const dw = Math.max(1, Math.round(iw * factor)), dh = Math.max(1, Math.round(ih * factor));
            // Keep PNG screenshots and graphics lossless at high quality; everything else becomes JPEG
            const usePng = item.file.type === 'image/png' && preset === QUALITY.high;
            let canvas = drawResized(img, dw, dh, usePng ? null : '#ffffff');

            const sideways = item.rotation % 180 !== 0;
            if (item.rotation) {
                const rotated = document.createElement('canvas');
                rotated.width = sideways ? dh : dw;
                rotated.height = sideways ? dw : dh;
                const ctx = rotated.getContext('2d');
                ctx.translate(rotated.width / 2, rotated.height / 2);
                ctx.rotate(item.rotation * Math.PI / 180);
                ctx.drawImage(canvas, -dw / 2, -dh / 2);
                canvas = rotated;
            }

            const blob = await canvasToBlob(canvas, usePng ? 'image/png' : 'image/jpeg', preset.quality);
            return {
                bytes: new Uint8Array(await blob.arrayBuffer()),
                isPng: usePng,
                width: sideways ? ih : iw,   // natural pixel size decides the physical page size
                height: sideways ? iw : ih
            };
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    createBtn.addEventListener('click', async () => {
        if (!items.length || !requirePdfLib()) return;
        createBtn.disabled = true;
        try {
            const pdf = await PDFLib.PDFDocument.create();
            const preset = QUALITY[qualityEl.value];
            const margin = parseFloat(marginEl.value);

            for (let i = 0; i < items.length; i++) {
                statusEl.innerText = `Adding image ${i + 1} of ${items.length}...`;
                const r = await rasterize(items[i], preset);
                const embedded = r.isPng ? await pdf.embedPng(r.bytes) : await pdf.embedJpg(r.bytes);

                let pw, ph, dw, dh;
                if (sizeEl.value === 'fit') {
                    dw = r.width * 0.75;  // 96 px per inch -> 72 pt per inch
                    dh = r.height * 0.75;
                    pw = dw + margin * 2;
                    ph = dh + margin * 2;
                } else {
                    [pw, ph] = PAGE_SIZES[sizeEl.value];
                    const landscape = orientation === 'landscape' || (orientation === 'auto' && r.width > r.height);
                    if (landscape) [pw, ph] = [ph, pw];
                    const s = Math.min((pw - margin * 2) / r.width, (ph - margin * 2) / r.height);
                    dw = r.width * s;
                    dh = r.height * s;
                }
                const page = pdf.addPage([pw, ph]);
                page.drawImage(embedded, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
            }

            pdf.setCreator('PicsConvert');
            pdf.setProducer('PicsConvert (pdf-lib)');
            statusEl.innerText = "Saving PDF...";
            const blob = pdfBlob(await pdf.save());
            const name = items.length === 1 ? `${stripExtension(items[0].file.name)}.pdf` : 'PicsConvert-images.pdf';
            triggerDownload(blob, name);
            statusEl.innerText = `PDF ready · ${items.length} page${items.length > 1 ? 's' : ''} · ${formatBytes(blob.size)}`;
        } catch (err) {
            statusEl.innerText = err.message;
        } finally {
            createBtn.disabled = !items.length;
        }
    });

    bindChipGroup(document.getElementById('img2pdfOrientation'), value => { orientation = value; });
    sizeEl.addEventListener('change', () => { orientationWrap.hidden = sizeEl.value === 'fit'; });
    document.getElementById('img2pdfAddMore').addEventListener('click', () => inputEl.click());
    document.getElementById('img2pdfClear').addEventListener('click', () => {
        items.forEach(i => URL.revokeObjectURL(i.url));
        items = [];
        render();
    });

    bindToolDropZone(dropZoneEl, inputEl, addFiles);
})();

// ==========================================================================
// 3. PDF TO IMAGE
// ==========================================================================

(function initPdfToImageTool() {
    const root = document.getElementById('pdf2imgTool');
    if (!root) return;

    const dropZoneEl = document.getElementById('pdf2imgDropZone');
    const inputEl = document.getElementById('pdf2imgFileInput');
    const workspaceEl = document.getElementById('pdf2imgWorkspace');
    const gridEl = document.getElementById('pdf2imgGrid');
    const statusEl = document.getElementById('pdf2imgStatus');
    const formatEl = document.getElementById('pdf2imgFormat');
    const qualityEl = document.getElementById('pdf2imgQuality');
    const qualityWrap = document.getElementById('pdf2imgQualityWrap');
    const downloadAllBtn = document.getElementById('pdf2imgDownloadAll');
    let dpi = 150;
    let state = null; // { file, doc, pages: [{ number, thumb }] }
    let loadToken = 0;

    async function exportPage(number) {
        const mime = formatEl.value === 'png' ? 'image/png' : 'image/jpeg';
        const canvas = await renderPdfPage(state.doc, number, { scale: dpi / 72 });
        const blob = await canvasToBlob(canvas, mime, parseFloat(qualityEl.value));
        return { blob, name: `${stripExtension(state.file.name)}-page-${number}.${MIME_EXT[mime]}` };
    }

    function render() {
        renderThumbGrid(gridEl, state.pages, {
            reorderable: false,
            describe: p => ({
                thumb: p.thumb,
                title: `Page ${p.number}`,
                actions: [{
                    icon: ICON_DOWNLOAD,
                    label: `Download page ${p.number}`,
                    onClick: async () => {
                        statusEl.innerText = `Rendering page ${p.number}...`;
                        const { blob, name } = await exportPage(p.number);
                        triggerDownload(blob, name);
                        statusEl.innerText = `Page ${p.number} saved · ${formatBytes(blob.size)}`;
                    }
                }]
            })
        });
    }

    async function openFile(file) {
        const token = ++loadToken;
        statusEl.innerText = "Opening PDF...";
        try {
            const { doc } = await openPdf(file);
            if (state) state.doc.destroy();
            state = { file, doc, pages: Array.from({ length: doc.numPages }, (_, i) => ({ number: i + 1, thumb: null })) };
            dropZoneEl.hidden = true;
            workspaceEl.hidden = false;
            downloadAllBtn.disabled = false;
            statusEl.innerText = `${file.name} · ${doc.numPages} page${doc.numPages > 1 ? 's' : ''}`;
            render();
            await renderThumbnailsSequentially(doc, state.pages, render, () => token !== loadToken);
        } catch (err) {
            statusEl.innerText = err.message;
        }
    }

    downloadAllBtn.addEventListener('click', async () => {
        if (!state) return;
        downloadAllBtn.disabled = true;
        try {
            const entries = [];
            for (const p of state.pages) {
                statusEl.innerText = `Rendering page ${p.number} of ${state.pages.length}...`;
                entries.push(await exportPage(p.number));
            }
            if (entries.length === 1) {
                triggerDownload(entries[0].blob, entries[0].name);
                statusEl.innerText = "Image downloaded";
            } else {
                await downloadZip(entries, `${stripExtension(state.file.name)}-images.zip`, statusEl);
            }
        } catch (err) {
            statusEl.innerText = err.message;
        } finally {
            downloadAllBtn.disabled = false;
        }
    });

    bindChipGroup(document.getElementById('pdf2imgDpi'), value => { dpi = parseInt(value, 10); });
    bindRangeText(qualityEl, document.getElementById('pdf2imgQualityText'));
    formatEl.addEventListener('change', () => {
        qualityWrap.style.opacity = formatEl.value === 'png' ? '0.4' : '1';
        qualityWrap.style.pointerEvents = formatEl.value === 'png' ? 'none' : 'auto';
    });
    document.getElementById('pdf2imgNew').addEventListener('click', () => inputEl.click());

    bindToolDropZone(dropZoneEl, inputEl, files => openFile(files[0]), isPdfFile);
})();

// ==========================================================================
// 4. MERGE PDF
// ==========================================================================

(function initMergeTool() {
    const root = document.getElementById('mergeTool');
    if (!root) return;

    const dropZoneEl = document.getElementById('mergeDropZone');
    const inputEl = document.getElementById('mergeFileInput');
    const workspaceEl = document.getElementById('mergeWorkspace');
    const gridEl = document.getElementById('mergeGrid');
    const statusEl = document.getElementById('mergeStatus');
    const runBtn = document.getElementById('mergeRun');
    let items = [];

    function render() {
        const ready = items.filter(i => i.bytes);
        const pageTotal = ready.reduce((s, i) => s + i.pageCount, 0);
        workspaceEl.hidden = !items.length;
        runBtn.disabled = ready.length < 2 || ready.length !== items.length;
        statusEl.innerText = !items.length ? "Ready for upload"
            : items.length < 2 ? "Add at least one more PDF to merge"
            : `${items.length} files · ${pageTotal} pages`;

        renderThumbGrid(gridEl, items, {
            describe: (item, index) => ({
                thumb: item.thumb,
                title: item.file.name,
                meta: item.error || (item.bytes ? `${item.pageCount} page${item.pageCount > 1 ? 's' : ''} · ${formatBytes(item.file.size)}` : 'Reading...'),
                badge: `${index + 1}`
            }),
            onChange: render,
            onRemove: (item) => {
                items = items.filter(i => i !== item);
                render();
            }
        });
    }

    async function addFiles(files) {
        const added = files.map(file => ({ id: newId(), file, bytes: null, pageCount: 0, thumb: null, error: null }));
        items.push(...added);
        render();
        for (const item of added) {
            try {
                const { bytes, doc } = await openPdf(item.file);
                item.bytes = bytes;
                item.pageCount = doc.numPages;
                item.thumb = await renderPdfPage(doc, 1, { width: THUMB_WIDTH });
                doc.destroy();
            } catch (err) {
                item.error = err.message;
            }
            render();
        }
        // Drop unreadable files so they don't block merging
        if (added.some(i => i.error)) {
            setTimeout(() => {
                items = items.filter(i => !i.error);
                render();
            }, 2500);
        }
    }

    runBtn.addEventListener('click', async () => {
        if (!requirePdfLib()) return;
        runBtn.disabled = true;
        try {
            const out = await PDFLib.PDFDocument.create();
            for (let i = 0; i < items.length; i++) {
                statusEl.innerText = `Merging file ${i + 1} of ${items.length}...`;
                const src = await loadPdfForEditing(items[i].bytes);
                const pages = await out.copyPages(src, src.getPageIndices());
                pages.forEach(p => out.addPage(p));
            }
            out.setProducer('PicsConvert (pdf-lib)');
            statusEl.innerText = "Saving merged PDF...";
            const blob = pdfBlob(await out.save());
            triggerDownload(blob, 'PicsConvert-merged.pdf');
            statusEl.innerText = `Merged ${items.length} files · ${out.getPageCount()} pages · ${formatBytes(blob.size)}`;
        } catch (err) {
            statusEl.innerText = err.message;
        } finally {
            runBtn.disabled = false;
        }
    });

    document.getElementById('mergeAddMore').addEventListener('click', () => inputEl.click());
    document.getElementById('mergeClear').addEventListener('click', () => {
        items = [];
        render();
    });

    bindToolDropZone(dropZoneEl, inputEl, addFiles, isPdfFile);
})();

// ==========================================================================
// 5. SPLIT PDF (extract, delete, split by ranges, split every page)
// ==========================================================================

(function initSplitTool() {
    const root = document.getElementById('splitTool');
    if (!root) return;

    const dropZoneEl = document.getElementById('splitDropZone');
    const inputEl = document.getElementById('splitFileInput');
    const workspaceEl = document.getElementById('splitWorkspace');
    const gridEl = document.getElementById('splitGrid');
    const statusEl = document.getElementById('splitStatus');
    const rangesEl = document.getElementById('splitRanges');
    const rangesWrap = document.getElementById('splitRangesWrap');
    const rangesLabel = document.getElementById('splitRangesLabel');
    const selectWrap = document.getElementById('splitSelectWrap');
    const hintEl = document.getElementById('splitHint');
    const runBtn = document.getElementById('splitRun');
    const runLabel = runBtn.querySelector('span');
    let mode = 'extract';
    let state = null; // { file, bytes, doc, pages: [{ number, thumb }] }
    let selected = new Set();
    let loadToken = 0;

    const MODES = {
        extract: { label: 'Pages to extract', hint: 'Click pages or type ranges. They are saved as one new PDF.', button: 'Extract pages', selects: true },
        remove: { label: 'Pages to delete', hint: 'Click pages or type ranges. Everything else is kept.', button: 'Delete pages', selects: true },
        ranges: { label: 'Ranges, one file each', hint: 'Example: 1-3, 4-6, 7-. Each range becomes its own PDF.', button: 'Split PDF', selects: false },
        every: { label: '', hint: 'Every page is saved as a separate PDF in a ZIP.', button: 'Split every page', selects: false }
    };

    function render() {
        const m = MODES[mode];
        rangesWrap.hidden = mode === 'every';
        selectWrap.hidden = !m.selects;
        rangesLabel.innerText = m.label;
        hintEl.innerText = m.hint;
        runLabel.innerText = m.button;
        if (!state) return;

        renderThumbGrid(gridEl, state.pages, {
            reorderable: false,
            describe: p => ({
                thumb: p.thumb,
                title: `Page ${p.number}`,
                selected: m.selects && selected.has(p.number),
                badge: m.selects && selected.has(p.number) ? (mode === 'remove' ? 'Delete' : 'Keep') : ''
            }),
            onToggle: m.selects ? (p) => {
                if (selected.has(p.number)) selected.delete(p.number); else selected.add(p.number);
                rangesEl.value = formatPageList(selected);
                render();
            } : null
        });
        gridEl.classList.toggle('is-removing', mode === 'remove');
    }

    function syncSelectionFromText() {
        if (!state || !MODES[mode].selects) return;
        try {
            selected = new Set();
            parsePageRanges(rangesEl.value, state.pages.length).forEach(([a, b]) => {
                for (let n = a; n <= b; n++) selected.add(n);
            });
            statusEl.innerText = `${selected.size} of ${state.pages.length} pages selected`;
        } catch (err) {
            statusEl.innerText = err.message;
        }
        render();
    }

    async function openFile(file) {
        const token = ++loadToken;
        statusEl.innerText = "Opening PDF...";
        try {
            const { bytes, doc } = await openPdf(file);
            if (state) state.doc.destroy();
            state = { file, bytes, doc, pages: Array.from({ length: doc.numPages }, (_, i) => ({ number: i + 1, thumb: null })) };
            selected = new Set();
            rangesEl.value = "";
            dropZoneEl.hidden = true;
            workspaceEl.hidden = false;
            runBtn.disabled = false;
            statusEl.innerText = `${file.name} · ${doc.numPages} page${doc.numPages > 1 ? 's' : ''}`;
            render();
            await renderThumbnailsSequentially(doc, state.pages, render, () => token !== loadToken);
        } catch (err) {
            statusEl.innerText = err.message;
        }
    }

    runBtn.addEventListener('click', async () => {
        if (!state || !requirePdfLib()) return;
        const total = state.pages.length;
        const stem = stripExtension(state.file.name);
        runBtn.disabled = true;
        try {
            const src = await loadPdfForEditing(state.bytes);
            const all = src.getPageIndices();

            if (mode === 'extract' || mode === 'remove') {
                if (!selected.size) throw new Error("Select at least one page first");
                const keep = mode === 'extract'
                    ? all.filter(i => selected.has(i + 1))
                    : all.filter(i => !selected.has(i + 1));
                if (!keep.length) throw new Error("You can't delete every page");
                const blob = await copyPagesToNewPdf(src, keep);
                triggerDownload(blob, `${stem}-${mode === 'extract' ? 'extracted' : 'edited'}.pdf`);
                statusEl.innerText = `Saved ${keep.length} page${keep.length > 1 ? 's' : ''} · ${formatBytes(blob.size)}`;
                return;
            }

            const ranges = mode === 'every'
                ? all.map(i => [i + 1, i + 1])
                : parsePageRanges(rangesEl.value, total);
            if (!ranges.length) throw new Error("Type at least one range, e.g. 1-3, 4-6");

            const entries = [];
            for (let r = 0; r < ranges.length; r++) {
                const [a, b] = ranges[r];
                statusEl.innerText = `Creating file ${r + 1} of ${ranges.length}...`;
                const indices = [];
                for (let n = a; n <= b; n++) indices.push(n - 1);
                entries.push({ name: a === b ? `${stem}-page-${a}.pdf` : `${stem}-pages-${a}-${b}.pdf`, blob: await copyPagesToNewPdf(src, indices) });
            }
            if (entries.length === 1) {
                triggerDownload(entries[0].blob, entries[0].name);
                statusEl.innerText = "PDF downloaded";
            } else {
                await downloadZip(entries, `${stem}-split.zip`, statusEl);
            }
        } catch (err) {
            statusEl.innerText = err.message;
        } finally {
            runBtn.disabled = false;
        }
    });

    bindChipGroup(document.getElementById('splitMode'), value => {
        mode = value;
        if (MODES[mode].selects) rangesEl.value = formatPageList(selected);
        else if (mode === 'ranges') rangesEl.value = "";
        render();
    });
    rangesEl.addEventListener('input', debounce(syncSelectionFromText, 300));
    document.getElementById('splitSelectAll').addEventListener('click', () => {
        if (!state) return;
        selected = new Set(state.pages.map(p => p.number));
        rangesEl.value = formatPageList(selected);
        render();
    });
    document.getElementById('splitSelectNone').addEventListener('click', () => {
        selected = new Set();
        rangesEl.value = "";
        render();
    });
    document.getElementById('splitNew').addEventListener('click', () => inputEl.click());

    render();
    bindToolDropZone(dropZoneEl, inputEl, files => openFile(files[0]), isPdfFile);
})();
