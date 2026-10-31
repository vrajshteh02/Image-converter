/* ==========================================================================
   PicsConvert - PDF Editor (pdf-editor.js)
   Add text, drawings, highlights, shapes, whiteout, images and signatures to
   a PDF, rotate or delete pages, and save a new PDF. Requires tools.js and
   pdf-tools.js (helpers), PDF.js for rendering and pdf-lib for writing.

   Edits are stored in "view units": the page's PDF.js viewport at scale 1
   (1 unit = 1 PDF point, origin top-left, page's own /Rotate applied).
   On export, viewport.convertToPdfPoint maps them back to PDF user space.
   ========================================================================== */

(function initPdfEditor() {
    const root = document.getElementById('editorTool');
    if (!root) return;

    const $ = id => document.getElementById(id);
    const dropZoneEl = $('editorDropZone');
    const inputEl = $('editorFileInput');
    const shellEl = $('editorShell');
    const pagesEl = $('editorPages');
    const statusEl = $('editorStatus');
    const colorEl = $('editorColor');
    const sizeEl = $('editorSize');
    const sizeLabel = $('editorSizeLabel');
    const fontEl = $('editorFont');
    const boldBtn = $('editorBold');
    const undoBtn = $('editorUndo');
    const deleteBtn = $('editorDelete');
    const downloadBtn = $('editorDownload');
    const imageInput = $('editorImageInput');
    const toolButtons = root.querySelectorAll('[data-tool]');
    const swatches = root.querySelectorAll('[data-color]');

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const FONT_CSS = {
        helvetica: 'Helvetica, Arial, sans-serif',
        times: '"Times New Roman", Times, serif',
        courier: '"Courier New", Courier, monospace'
    };
    // Distance from the top of a 1.2 line box to the baseline, in em, for each CSS stack
    const BASELINE = { helvetica: 0.947, times: 0.938, courier: 0.867 };
    const PDF_FONTS = {
        helvetica: ['Helvetica', 'HelveticaBold'],
        times: ['TimesRoman', 'TimesRomanBold'],
        courier: ['Courier', 'CourierBold']
    };
    const DEFAULT_BOX = { highlight: [140, 16], whiteout: [140, 22], rect: [140, 80] };
    const HIGHLIGHT_YELLOW = '#ffd400';
    const ICON_ROTATE_LEFT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
    const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';

    const ed = {
        file: null, bytes: null, doc: null, pages: [],
        tool: 'text', color: '#16150f', fontSize: 14, stroke: 2, font: 'helvetica', bold: false,
        selected: null, images: {}, history: [], dirty: false, lastPush: { key: null, time: 0 }
    };

    // --------------------------------------------------------------------
    // History (undo)
    // --------------------------------------------------------------------

    function snapshot() {
        return JSON.stringify(ed.pages.map(p => ({ r: p.rotation, d: p.deleted, a: p.annotations })));
    }

    function pushSnapshot(snap) {
        ed.history.push(snap);
        if (ed.history.length > 80) ed.history.shift();
        ed.dirty = true;
        undoBtn.disabled = false;
    }

    // coalesceKey groups rapid property tweaks (e.g. dragging the color picker) into one undo step
    function pushHistory(coalesceKey) {
        const now = Date.now();
        if (coalesceKey && ed.lastPush.key === coalesceKey && now - ed.lastPush.time < 1200) {
            ed.lastPush.time = now;
            return;
        }
        ed.lastPush = { key: coalesceKey || null, time: now };
        pushSnapshot(snapshot());
    }

    function undo() {
        const snap = ed.history.pop();
        if (!snap) return;
        deselect();
        JSON.parse(snap).forEach((s, i) => {
            const p = ed.pages[i];
            p.rotation = s.r;
            p.deleted = s.d;
            p.annotations = s.a;
        });
        ed.pages.forEach(p => {
            renderLayer(p);
            syncPageState(p);
        });
        layoutPages();
        undoBtn.disabled = !ed.history.length;
    }

    // --------------------------------------------------------------------
    // Geometry
    // --------------------------------------------------------------------

    // Client coordinates -> view units, undoing the CSS rotation applied to the page
    function eventToPoint(e, p) {
        const rect = p.pageEl.getBoundingClientRect();
        const dx = e.clientX - (rect.left + rect.width / 2);
        const dy = e.clientY - (rect.top + rect.height / 2);
        const t = -p.rotation * Math.PI / 180;
        const lx = dx * Math.cos(t) - dy * Math.sin(t);
        const ly = dx * Math.sin(t) + dy * Math.cos(t);
        return { x: lx / p.scale + p.width / 2, y: ly / p.scale + p.height / 2 };
    }

    function layoutPages() {
        const avail = Math.max(240, Math.min(pagesEl.clientWidth - 24, 920));
        ed.pages.forEach(p => {
            const sideways = p.rotation % 180 !== 0;
            const s = Math.min(avail / (sideways ? p.height : p.width), 2.5);
            const w = p.width * s, h = p.height * s;
            const slotW = sideways ? h : w, slotH = sideways ? w : h;
            p.scale = s;
            p.slot.style.width = `${slotW}px`;
            p.slot.style.height = `${slotH}px`;
            Object.assign(p.pageEl.style, {
                width: `${w}px`,
                height: `${h}px`,
                left: `${(slotW - w) / 2}px`,
                top: `${(slotH - h) / 2}px`,
                transform: p.rotation ? `rotate(${p.rotation}deg)` : ''
            });
            p.pageEl.style.setProperty('--s', s);
            if (p.rendered && s * DPR > p.renderedScale * 1.25) p.rendered = false;
        });
        renderVisiblePages();
    }

    // --------------------------------------------------------------------
    // Page rendering (lazy, one at a time)
    // --------------------------------------------------------------------

    let renderChain = Promise.resolve();

    function queueRender(p) {
        if (p.rendered || p.rendering) return;
        p.rendering = true;
        renderChain = renderChain.then(async () => {
            const scale = p.scale * DPR;
            const viewport = p.pdfPage.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await p.pdfPage.render({ canvasContext: ctx, viewport }).promise;
            canvas.className = 'editor-canvas';
            p.canvas.replaceWith(canvas);
            p.canvas = canvas;
            p.rendered = true;
            p.renderedScale = scale;
        }).catch(() => {}).then(() => { p.rendering = false; });
    }

    function renderVisiblePages() {
        const margin = window.innerHeight * 1.5;
        ed.pages.forEach(p => {
            const r = p.slot.getBoundingClientRect();
            if (r.bottom > -margin && r.top < window.innerHeight + margin) queueRender(p);
        });
    }

    // Page nearest the middle of the viewport, used to place images and signatures
    function currentPage() {
        let best = ed.pages.find(p => !p.deleted) || ed.pages[0];
        let bestDistance = Infinity;
        ed.pages.forEach(p => {
            if (p.deleted) return;
            const r = p.slot.getBoundingClientRect();
            const d = Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2);
            if (d < bestDistance) {
                bestDistance = d;
                best = p;
            }
        });
        return best;
    }

    // --------------------------------------------------------------------
    // Annotation elements
    // --------------------------------------------------------------------

    const plaintextOnly = (() => {
        const d = document.createElement('div');
        d.contentEditable = 'plaintext-only';
        return d.contentEditable === 'plaintext-only';
    })();

    function readText(input) {
        return input.innerText.replace(/ /g, ' ').replace(/\n+$/, '');
    }

    function positionBox(el, p, a) {
        el.style.left = `${(a.x / p.width) * 100}%`;
        el.style.top = `${(a.y / p.height) * 100}%`;
        if (a.type !== 'text') {
            el.style.width = `${(a.w / p.width) * 100}%`;
            el.style.height = `${(a.h / p.height) * 100}%`;
        }
    }

    function drawPathData(a) {
        return a.points.map((pt, i) => `${i ? 'L' : 'M'}${pt[0].toFixed(2)} ${pt[1].toFixed(2)}`).join(' ');
    }

    function updateAnnEl(el, p, a) {
        if (a.type === 'draw') {
            const d = drawPathData(a);
            el.querySelectorAll('path').forEach(path => path.setAttribute('d', d));
        } else {
            positionBox(el, p, a);
        }
    }

    function buildAnnEl(p, a) {
        let el;
        if (a.type === 'draw') {
            el = document.createElementNS(SVG_NS, 'svg');
            el.setAttribute('class', 'ann ann-draw');
            el.setAttribute('viewBox', `0 0 ${p.width} ${p.height}`);
            el.setAttribute('preserveAspectRatio', 'none');
            const hit = document.createElementNS(SVG_NS, 'path');
            hit.setAttribute('class', 'ann-draw-hit');
            hit.setAttribute('stroke-width', a.width + 10);
            const line = document.createElementNS(SVG_NS, 'path');
            line.setAttribute('class', 'ann-draw-line');
            line.setAttribute('stroke', a.color);
            line.setAttribute('stroke-width', a.width);
            el.append(hit, line);
            hit.addEventListener('pointerdown', e => onAnnPointerDown(e, p, a, el));
        } else {
            el = document.createElement('div');
            el.className = `ann ann-${a.type}`;

            if (a.type === 'text') {
                const input = document.createElement('div');
                input.className = 'ann-text-input';
                input.contentEditable = plaintextOnly ? 'plaintext-only' : 'true';
                input.spellcheck = false;
                input.textContent = a.text;
                input.style.setProperty('--fs', a.size);
                input.style.color = a.color;
                input.style.fontFamily = FONT_CSS[a.font];
                input.style.fontWeight = a.bold ? '700' : '400';
                input.setAttribute('aria-label', 'Text box');

                let pending = null;
                input.addEventListener('focus', () => { pending = snapshot(); });
                input.addEventListener('input', () => {
                    if (pending) {
                        pushSnapshot(pending);
                        pending = null;
                    }
                    a.text = readText(input);
                });
                input.addEventListener('blur', () => {
                    a.text = readText(input);
                    if (!a.text.trim()) removeAnnotation(p, a, false);
                });
                input.addEventListener('keydown', e => {
                    if (e.key === 'Escape') input.blur();
                });
                if (!plaintextOnly) {
                    input.addEventListener('paste', e => {
                        e.preventDefault();
                        document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
                    });
                }
                el.appendChild(input);
            } else if (a.type === 'image') {
                const img = document.createElement('img');
                img.src = ed.images[a.imageId].url;
                img.alt = '';
                img.draggable = false;
                el.appendChild(img);
            } else if (a.type === 'rect') {
                el.style.setProperty('--bw', a.width);
                el.style.borderColor = a.color;
            } else if (a.type === 'highlight') {
                el.style.setProperty('--hl', a.color);
            }

            if (a.type !== 'text') {
                const handle = document.createElement('span');
                handle.className = 'ann-handle';
                el.appendChild(handle);
            }
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'ann-remove';
            remove.title = 'Delete';
            remove.setAttribute('aria-label', 'Delete');
            remove.innerHTML = ICON_CLOSE;
            remove.addEventListener('pointerdown', e => e.stopPropagation());
            remove.addEventListener('click', () => removeAnnotation(p, a, true));
            el.appendChild(remove);

            positionBox(el, p, a);
            el.addEventListener('pointerdown', e => onAnnPointerDown(e, p, a, el));
        }

        el.dataset.id = a.id;
        if (ed.selected && ed.selected.ann === a) el.classList.add('is-selected');
        updateAnnEl(el, p, a);
        return el;
    }

    function annElement(p, a) {
        return p.layer.querySelector(`[data-id="${a.id}"]`);
    }

    function renderLayer(p) {
        p.layer.innerHTML = '';
        p.annotations.forEach(a => p.layer.appendChild(buildAnnEl(p, a)));
    }

    function addAnnotation(p, a) {
        p.annotations.push(a);
        const el = buildAnnEl(p, a);
        p.layer.appendChild(el);
        return el;
    }

    function removeAnnotation(p, a, recordHistory) {
        if (!p.annotations.includes(a)) return;
        if (recordHistory) pushHistory();
        p.annotations = p.annotations.filter(x => x !== a);
        const el = annElement(p, a);
        if (el) el.remove();
        if (ed.selected && ed.selected.ann === a) deselect();
    }

    // --------------------------------------------------------------------
    // Selection & properties
    // --------------------------------------------------------------------

    function select(p, a) {
        if (ed.selected && ed.selected.ann === a) return;
        deselect();
        ed.selected = { page: p, ann: a };
        const el = annElement(p, a);
        if (el) el.classList.add('is-selected');
        if (a.color) colorEl.value = a.color;
        if (a.type === 'text') {
            fontEl.value = a.font;
            setBold(a.bold);
        }
        deleteBtn.disabled = false;
        syncControls();
    }

    function deselect() {
        if (ed.selected) {
            const el = annElement(ed.selected.page, ed.selected.ann);
            if (el) el.classList.remove('is-selected');
        }
        ed.selected = null;
        deleteBtn.disabled = true;
        syncControls();
    }

    function sizeTarget() {
        const a = ed.selected && ed.selected.ann;
        if (a) return a.type === 'text' ? 'size' : (a.type === 'draw' || a.type === 'rect') ? 'width' : null;
        return (ed.tool === 'draw' || ed.tool === 'rect') ? 'width' : 'size';
    }

    function syncControls() {
        const target = sizeTarget();
        const a = ed.selected && ed.selected.ann;
        sizeEl.disabled = !target;
        sizeLabel.innerText = target === 'width' ? 'Stroke' : 'Size';
        if (target === 'size') sizeEl.value = a ? a.size : ed.fontSize;
        if (target === 'width') sizeEl.value = a ? a.width : ed.stroke;
        const textContext = a ? a.type === 'text' : (ed.tool === 'text' || ed.tool === 'select');
        fontEl.disabled = !textContext;
        boldBtn.disabled = !textContext;
    }

    function setBold(value) {
        ed.bold = value;
        boldBtn.classList.toggle('active', value);
        boldBtn.setAttribute('aria-pressed', value ? 'true' : 'false');
    }

    function applyProperty(key, value) {
        if (key === 'color') ed.color = value;
        if (key === 'size') ed.fontSize = value;
        if (key === 'width') ed.stroke = value;
        if (key === 'font') ed.font = value;
        if (key === 'bold') setBold(value);

        const sel = ed.selected;
        if (!sel || !sel.page.annotations.includes(sel.ann)) return;
        const a = sel.ann;
        const applies = key === 'color' ? ['text', 'draw', 'rect', 'highlight'].includes(a.type)
            : key === 'width' ? (a.type === 'draw' || a.type === 'rect')
            : a.type === 'text';
        if (!applies) return;

        pushHistory(`${a.id}:${key}`);
        a[key] = value;
        const old = annElement(sel.page, a);
        if (old) old.replaceWith(buildAnnEl(sel.page, a));
    }

    // --------------------------------------------------------------------
    // Tools
    // --------------------------------------------------------------------

    function setTool(tool) {
        ed.tool = tool;
        shellEl.dataset.tool = tool;
        toolButtons.forEach(b => {
            b.classList.toggle('active', b.dataset.tool === tool);
            b.setAttribute('aria-pressed', b.dataset.tool === tool ? 'true' : 'false');
        });
        // Highlighting in black ink is never what anyone wants
        if (tool === 'highlight' && !ed.selected && ed.color === '#16150f') {
            ed.color = HIGHLIGHT_YELLOW;
            colorEl.value = HIGHLIGHT_YELLOW;
        } else if (tool !== 'highlight' && ed.color === HIGHLIGHT_YELLOW) {
            ed.color = '#16150f';
            colorEl.value = '#16150f';
        }
        if (tool !== 'select') deselect();
        syncControls();
    }

    function trackPointer(onMove, onUp) {
        const move = ev => onMove(ev);
        const up = ev => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            if (onUp) onUp(ev);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    }

    function onLayerPointerDown(e, p) {
        if (e.button !== 0 || e.target !== p.layer || p.deleted) return;
        const pt = eventToPoint(e, p);

        if (ed.tool === 'select') {
            deselect();
            return;
        }
        e.preventDefault();

        if (ed.tool === 'text') {
            pushHistory();
            const a = { id: newId(), type: 'text', x: pt.x, y: pt.y - ed.fontSize * 0.6, text: '', size: ed.fontSize, color: ed.color, font: ed.font, bold: ed.bold };
            const el = addAnnotation(p, a);
            setTool('select');
            select(p, a);
            requestAnimationFrame(() => el.querySelector('.ann-text-input').focus());
            return;
        }

        if (ed.tool === 'draw') {
            pushHistory();
            const a = { id: newId(), type: 'draw', points: [[pt.x, pt.y]], color: ed.color, width: ed.stroke };
            const el = addAnnotation(p, a);
            trackPointer(ev => {
                const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
                (events.length ? events : [ev]).forEach(ce => {
                    const q = eventToPoint(ce, p);
                    const last = a.points[a.points.length - 1];
                    if (Math.hypot(q.x - last[0], q.y - last[1]) * p.scale < 1.5) return;
                    a.points.push([q.x, q.y]);
                });
                updateAnnEl(el, p, a);
            }, () => {
                if (a.points.length === 1) a.points.push([a.points[0][0] + 0.1, a.points[0][1]]);
                updateAnnEl(el, p, a);
            });
            return;
        }

        // Box tools: drag out a rectangle, or click for a default-sized one
        pushHistory();
        const a = { id: newId(), type: ed.tool, x: pt.x, y: pt.y, w: 0, h: 0, color: ed.color, width: ed.stroke };
        const el = addAnnotation(p, a);
        trackPointer(ev => {
            const q = eventToPoint(ev, p);
            a.x = clampValue(Math.min(pt.x, q.x), 0, p.width);
            a.y = clampValue(Math.min(pt.y, q.y), 0, p.height);
            a.w = Math.min(Math.abs(q.x - pt.x), p.width - a.x);
            a.h = Math.min(Math.abs(q.y - pt.y), p.height - a.y);
            updateAnnEl(el, p, a);
        }, () => {
            if (a.w * p.scale < 6 || a.h * p.scale < 6) {
                const [dw, dh] = DEFAULT_BOX[a.type];
                a.w = dw;
                a.h = dh;
                a.x = clampValue(pt.x - (a.type === 'highlight' ? 0 : dw / 2), 0, p.width - dw);
                a.y = clampValue(pt.y - dh / 2, 0, p.height - dh);
                updateAnnEl(el, p, a);
            }
        });
    }

    function onAnnPointerDown(e, p, a, el) {
        const interactive = ed.tool === 'select' || (ed.tool === 'text' && a.type === 'text');
        if (!interactive || e.button !== 0) return;
        e.stopPropagation();

        const isHandle = e.target.classList.contains('ann-handle');
        const input = a.type === 'text' ? el.querySelector('.ann-text-input') : null;
        const editing = input && document.activeElement === input;
        if (ed.tool === 'text') setTool('select');
        select(p, a);
        if (editing && !isHandle) return; // let the user place the caret / select text
        if (!input || isHandle) e.preventDefault();

        const start = eventToPoint(e, p);
        const orig = JSON.parse(JSON.stringify(a));
        let moved = false;

        trackPointer(ev => {
            const q = eventToPoint(ev, p);
            const dx = q.x - start.x, dy = q.y - start.y;
            if (!moved) {
                if (Math.hypot(dx, dy) * p.scale < 4) return;
                moved = true;
                pushHistory();
                if (input) {
                    input.blur();
                    window.getSelection().removeAllRanges();
                }
                el.classList.add('is-dragging');
            }
            if (isHandle) {
                a.w = Math.max(6, orig.w + dx);
                a.h = a.type === 'image' ? a.w * (orig.h / orig.w) : Math.max(6, orig.h + dy);
            } else if (a.type === 'draw') {
                a.points = orig.points.map(([x, y]) => [x + dx, y + dy]);
            } else {
                a.x = orig.x + dx;
                a.y = orig.y + dy;
            }
            updateAnnEl(el, p, a);
        }, () => {
            el.classList.remove('is-dragging');
            if (!moved && input) input.focus();
        });
    }

    // --------------------------------------------------------------------
    // Images & signatures
    // --------------------------------------------------------------------

    async function storeImage(canvas, asJpeg) {
        const blob = await canvasToBlob(canvas, asJpeg ? 'image/jpeg' : 'image/png', 0.9);
        const id = newId();
        ed.images[id] = { url: URL.createObjectURL(blob), bytes: new Uint8Array(await blob.arrayBuffer()), kind: asJpeg ? 'jpg' : 'png' };
        return id;
    }

    function placeImage(imageId, pxWidth, pxHeight, defaultWidth) {
        const p = currentPage();
        const w = Math.min(defaultWidth, p.width * 0.6);
        const h = w * (pxHeight / pxWidth);
        pushHistory();
        const a = { id: newId(), type: 'image', imageId, x: (p.width - w) / 2, y: Math.max(0, (p.height - h) / 2), w, h };
        addAnnotation(p, a);
        setTool('select');
        select(p, a);
        statusEl.innerText = `Added to page ${p.number}. Drag to move, drag the corner to resize.`;
    }

    imageInput.addEventListener('change', async () => {
        const file = imageInput.files[0];
        imageInput.value = '';
        if (!file) return;
        try {
            const { img, url } = await loadImageFile(file);
            const factor = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
            const w = Math.round(img.naturalWidth * factor), h = Math.round(img.naturalHeight * factor);
            const isJpeg = file.type === 'image/jpeg';
            const canvas = drawResized(img, w, h, isJpeg ? '#ffffff' : null);
            URL.revokeObjectURL(url);
            placeImage(await storeImage(canvas, isJpeg), w, h, 200);
        } catch (err) {
            statusEl.innerText = err.message;
        }
    });

    const sigModal = $('signatureModal');
    const sigCanvas = $('signatureCanvas');
    const sigCtx = sigCanvas.getContext('2d');
    let sigHasInk = false;

    function openSignaturePad() {
        sigModal.classList.add('active');
        const rect = sigCanvas.getBoundingClientRect();
        sigCanvas.width = Math.round(rect.width * DPR);
        sigCanvas.height = Math.round(rect.height * DPR);
        sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
        sigHasInk = false;
    }

    function closeSignaturePad() {
        sigModal.classList.remove('active');
    }

    sigCanvas.addEventListener('pointerdown', e => {
        e.preventDefault();
        const rect = sigCanvas.getBoundingClientRect();
        const point = ev => [(ev.clientX - rect.left) * DPR, (ev.clientY - rect.top) * DPR];
        const ink = ['#ffd400', '#ffffff'].includes(ed.color) ? '#16150f' : ed.color;
        sigCtx.strokeStyle = ink;
        sigCtx.fillStyle = ink;
        sigCtx.lineWidth = 2.6 * DPR;
        sigCtx.lineCap = 'round';
        sigCtx.lineJoin = 'round';
        let [lx, ly] = point(e);
        sigCtx.beginPath();
        sigCtx.arc(lx, ly, sigCtx.lineWidth / 2, 0, Math.PI * 2);
        sigCtx.fill();
        sigHasInk = true;
        trackPointer(ev => {
            const [x, y] = point(ev);
            sigCtx.beginPath();
            sigCtx.moveTo(lx, ly);
            sigCtx.lineTo(x, y);
            sigCtx.stroke();
            [lx, ly] = [x, y];
        });
    });

    // Crop the signature canvas to the inked area
    function trimmedSignature() {
        const { width, height } = sigCanvas;
        const data = sigCtx.getImageData(0, 0, width, height).data;
        let minX = width, minY = height, maxX = -1, maxY = -1;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (data[(y * width + x) * 4 + 3] > 0) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) return null;
        const pad = 6;
        const out = document.createElement('canvas');
        out.width = maxX - minX + pad * 2;
        out.height = maxY - minY + pad * 2;
        out.getContext('2d').drawImage(sigCanvas, minX - pad, minY - pad, out.width, out.height, 0, 0, out.width, out.height);
        return out;
    }

    $('signatureClear').addEventListener('click', () => {
        sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
        sigHasInk = false;
    });
    $('signatureCancel').addEventListener('click', closeSignaturePad);
    $('signatureClose').addEventListener('click', closeSignaturePad);
    $('signatureAdd').addEventListener('click', async () => {
        const trimmed = sigHasInk && trimmedSignature();
        if (!trimmed) return;
        closeSignaturePad();
        placeImage(await storeImage(trimmed, false), trimmed.width, trimmed.height, 160);
    });

    // --------------------------------------------------------------------
    // Pages
    // --------------------------------------------------------------------

    function syncPageState(p) {
        p.block.classList.toggle('is-deleted', p.deleted);
        const del = p.block.querySelector('[data-act="delete"]');
        del.title = p.deleted ? 'Restore page' : 'Delete page';
        del.setAttribute('aria-label', del.title);
    }

    function buildPageDom(p) {
        const block = document.createElement('section');
        block.className = 'editor-page-block';
        block.setAttribute('aria-label', `Page ${p.number}`);
        block.innerHTML = `
            <div class="editor-page-bar">
                <span class="editor-page-label">Page ${p.number}</span>
                <div class="editor-page-actions">
                    <button type="button" class="thumb-btn" data-act="rotl" title="Rotate left" aria-label="Rotate page ${p.number} left">${ICON_ROTATE_LEFT}</button>
                    <button type="button" class="thumb-btn" data-act="rotr" title="Rotate right" aria-label="Rotate page ${p.number} right">${ICON_ROTATE}</button>
                    <button type="button" class="thumb-btn" data-act="delete" title="Delete page" aria-label="Delete page">${ICON_TRASH}</button>
                </div>
            </div>
            <div class="editor-page-slot">
                <div class="editor-page"><canvas class="editor-canvas"></canvas><div class="editor-layer"></div></div>
                <div class="editor-deleted-note"><span>This page will be removed</span><button type="button" class="btn btn-secondary" data-act="restore">Restore</button></div>
            </div>
        `;
        p.block = block;
        p.slot = block.querySelector('.editor-page-slot');
        p.pageEl = block.querySelector('.editor-page');
        p.canvas = block.querySelector('canvas');
        p.layer = block.querySelector('.editor-layer');

        block.querySelectorAll('[data-act]').forEach(btn => {
            btn.addEventListener('click', () => {
                pushHistory();
                const act = btn.dataset.act;
                if (act === 'rotl') p.rotation = (p.rotation + 270) % 360;
                if (act === 'rotr') p.rotation = (p.rotation + 90) % 360;
                if (act === 'delete') p.deleted = !p.deleted;
                if (act === 'restore') p.deleted = false;
                if (p.deleted && ed.selected && ed.selected.page === p) deselect();
                syncPageState(p);
                layoutPages();
            });
        });
        p.layer.addEventListener('pointerdown', e => onLayerPointerDown(e, p));
        pagesEl.appendChild(block);
    }

    async function openFile(file) {
        if (ed.dirty && !confirm("Discard your edits to the current PDF?")) return;
        statusEl.innerText = "Opening PDF...";
        try {
            const { bytes, doc } = await openPdf(file);
            if (ed.doc) ed.doc.destroy();
            Object.values(ed.images).forEach(img => URL.revokeObjectURL(img.url));
            Object.assign(ed, { file, bytes, doc, pages: [], selected: null, images: {}, history: [], dirty: false });
            undoBtn.disabled = true;
            deleteBtn.disabled = true;

            for (let n = 1; n <= doc.numPages; n++) {
                const pdfPage = await doc.getPage(n);
                const viewport = pdfPage.getViewport({ scale: 1 });
                ed.pages.push({ number: n, pdfPage, viewport, width: viewport.width, height: viewport.height, rotation: 0, deleted: false, annotations: [], scale: 1, rendered: false });
            }

            pagesEl.innerHTML = '';
            ed.pages.forEach(buildPageDom);
            dropZoneEl.hidden = true;
            shellEl.hidden = false;
            setTool('text');
            layoutPages();
            statusEl.innerText = `${file.name} · ${doc.numPages} page${doc.numPages > 1 ? 's' : ''} · Click a page to add text`;
        } catch (err) {
            statusEl.innerText = err.message;
        }
    }

    // --------------------------------------------------------------------
    // Export
    // --------------------------------------------------------------------

    function hexToRgb(hex) {
        const n = parseInt(hex.slice(1), 16);
        return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
    }

    async function exportPdf() {
        const pdf = await loadPdfForEditing(ed.bytes);
        const { degrees, StandardFonts, BlendMode, LineCapStyle } = PDFLib;
        const fonts = {};
        const embeddedImages = {};
        let replacedChars = false;

        const getFont = async (family, bold) => {
            const name = PDF_FONTS[family][bold ? 1 : 0];
            if (!fonts[name]) fonts[name] = await pdf.embedFont(StandardFonts[name]);
            return fonts[name];
        };
        // Standard PDF fonts only cover Latin-1 (WinAnsi); swap anything else for "?"
        const encodable = (font, text) => {
            let out = '';
            for (const ch of text) {
                try {
                    font.encodeText(ch);
                    out += ch;
                } catch (e) {
                    out += '?';
                    replacedChars = true;
                }
            }
            return out;
        };

        const pdfPages = pdf.getPages();
        for (const p of ed.pages) {
            const page = pdfPages[p.number - 1];
            const toPdf = (x, y) => {
                const [ux, uy] = p.viewport.convertToPdfPoint(x, y);
                return { x: ux, y: uy };
            };
            const origin = toPdf(0, 0), axis = toPdf(1, 0);
            const rotate = degrees(Math.atan2(axis.y - origin.y, axis.x - origin.x) * 180 / Math.PI);

            for (const a of p.annotations) {
                if (a.type === 'text') {
                    if (!a.text.trim()) continue;
                    const font = await getFont(a.font, a.bold);
                    const lineHeight = a.size * 1.2;
                    a.text.split('\n').forEach((line, i) => {
                        if (!line) return;
                        const base = toPdf(a.x, a.y + i * lineHeight + a.size * BASELINE[a.font]);
                        page.drawText(encodable(font, line), { x: base.x, y: base.y, size: a.size, font, color: hexToRgb(a.color), rotate });
                    });
                } else if (a.type === 'draw') {
                    const path = a.points.map((pt, i) => {
                        const q = toPdf(pt[0], pt[1]);
                        return `${i ? 'L' : 'M'}${q.x.toFixed(2)} ${(-q.y).toFixed(2)}`;
                    }).join(' ');
                    page.drawSvgPath(path, { x: 0, y: 0, borderColor: hexToRgb(a.color), borderWidth: a.width, borderLineCap: LineCapStyle.Round });
                } else {
                    const corner = toPdf(a.x, a.y + a.h); // bottom-left corner in view space
                    const box = { x: corner.x, y: corner.y, width: a.w, height: a.h, rotate };
                    if (a.type === 'image') {
                        const img = ed.images[a.imageId];
                        if (!embeddedImages[a.imageId]) {
                            embeddedImages[a.imageId] = img.kind === 'jpg' ? await pdf.embedJpg(img.bytes) : await pdf.embedPng(img.bytes);
                        }
                        page.drawImage(embeddedImages[a.imageId], box);
                    } else if (a.type === 'whiteout') {
                        page.drawRectangle({ ...box, color: PDFLib.rgb(1, 1, 1) });
                    } else if (a.type === 'highlight') {
                        page.drawRectangle({ ...box, color: hexToRgb(a.color), opacity: 0.4, blendMode: BlendMode.Multiply });
                    } else if (a.type === 'rect') {
                        page.drawRectangle({ ...box, borderColor: hexToRgb(a.color), borderWidth: a.width });
                    }
                }
            }

            if (p.rotation) page.setRotation(degrees((page.getRotation().angle + p.rotation) % 360));
        }

        const deleted = ed.pages.filter(p => p.deleted).map(p => p.number - 1);
        if (deleted.length === ed.pages.length) throw new Error("You can't delete every page");
        deleted.sort((x, y) => y - x).forEach(i => pdf.removePage(i));

        pdf.setProducer('PicsConvert (pdf-lib)');
        return { blob: pdfBlob(await pdf.save()), replacedChars, pageCount: pdf.getPageCount() };
    }

    downloadBtn.addEventListener('click', async () => {
        if (!ed.doc || !requirePdfLib()) return;
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        downloadBtn.disabled = true;
        statusEl.innerText = "Saving PDF...";
        try {
            const { blob, replacedChars, pageCount } = await exportPdf();
            triggerDownload(blob, `${stripExtension(ed.file.name)}-edited.pdf`);
            ed.dirty = false;
            statusEl.innerText = `Saved · ${pageCount} page${pageCount > 1 ? 's' : ''} · ${formatBytes(blob.size)}`
                + (replacedChars ? ' · Some characters aren\'t supported by standard PDF fonts and were replaced with "?"' : '');
        } catch (err) {
            statusEl.innerText = err.message;
        } finally {
            downloadBtn.disabled = false;
        }
    });

    // --------------------------------------------------------------------
    // Toolbar & global events
    // --------------------------------------------------------------------

    toolButtons.forEach(btn => btn.addEventListener('click', () => setTool(btn.dataset.tool)));
    $('editorAddImage').addEventListener('click', () => imageInput.click());
    $('editorAddSignature').addEventListener('click', openSignaturePad);

    swatches.forEach(sw => sw.addEventListener('click', () => {
        colorEl.value = sw.dataset.color;
        applyProperty('color', sw.dataset.color);
    }));
    colorEl.addEventListener('input', () => applyProperty('color', colorEl.value));
    sizeEl.addEventListener('input', () => {
        const target = sizeTarget();
        const value = parseFloat(sizeEl.value);
        if (!target || !value) return;
        applyProperty(target, target === 'size' ? clampValue(value, 4, 144) : clampValue(value, 0.5, 30));
    });
    fontEl.addEventListener('change', () => applyProperty('font', fontEl.value));
    boldBtn.addEventListener('click', () => applyProperty('bold', !ed.bold));
    undoBtn.addEventListener('click', undo);
    deleteBtn.addEventListener('click', () => {
        if (ed.selected) removeAnnotation(ed.selected.page, ed.selected.ann, true);
    });
    $('editorNewFile').addEventListener('click', () => inputEl.click());

    document.addEventListener('keydown', e => {
        if (!ed.doc || shellEl.hidden || sigModal.classList.contains('active')) return;
        const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
        if (typing) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            undo();
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && ed.selected) {
            e.preventDefault();
            removeAnnotation(ed.selected.page, ed.selected.ann, true);
        } else if (e.key === 'Escape') {
            deselect();
        }
    });

    // Keep the sticky toolbar just below the (wrapping) site header
    const header = document.querySelector('.site-header');
    const syncHeaderOffset = () => {
        if (header) document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
    };
    syncHeaderOffset();

    window.addEventListener('resize', debounce(() => {
        syncHeaderOffset();
        if (ed.doc) layoutPages();
    }, 200));
    let scrollQueued = false;
    window.addEventListener('scroll', () => {
        if (scrollQueued || !ed.doc) return;
        scrollQueued = true;
        requestAnimationFrame(() => {
            scrollQueued = false;
            renderVisiblePages();
        });
    }, { passive: true });
    window.addEventListener('beforeunload', e => {
        if (ed.dirty) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    bindToolDropZone(dropZoneEl, inputEl, files => openFile(files[0]), isPdfFile);
})();
