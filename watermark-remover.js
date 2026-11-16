/* ==========================================================================
   PicsConvert - Image Watermark Remover (watermark-remover.js)
   The user paints over a watermark (brush, box or eraser) and the marked area
   is rebuilt from the rest of the photo with a content-aware fill
   (multi-scale PatchMatch inpainting). It runs in a Web Worker so the page
   stays responsive. Nothing is uploaded.
   Loaded after app.js and tools.js (loadImageFile, canvasToBlob,
   resolveOutputMime, drawResized, bindToolDropZone, bindChipGroup, ...).
   ========================================================================== */

// ==========================================================================
// 1. INPAINTING ENGINE
// Self-contained (no outside variables) so its source can also run in a Worker.
// ==========================================================================

function inpaintEngine() {
    const R = 3; // patch radius -> 7x7 patches
    let seed = 0x2545f491;
    function rand() {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        return (seed >>> 0) / 4294967296;
    }

    // Half-size level. A coarse pixel is a hole if any of its children is.
    function downsample(L) {
        const w = Math.ceil(L.w / 2), h = Math.ceil(L.h / 2);
        const img = new Float32Array(w * h * 3);
        const mask = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let r = 0, g = 0, b = 0, n = 0, hole = 0;
                for (let dy = 0; dy < 2; dy++) {
                    const sy = 2 * y + dy;
                    if (sy >= L.h) continue;
                    for (let dx = 0; dx < 2; dx++) {
                        const sx = 2 * x + dx;
                        if (sx >= L.w) continue;
                        const i = sy * L.w + sx;
                        if (L.mask[i]) { hole = 1; continue; }
                        r += L.img[i * 3]; g += L.img[i * 3 + 1]; b += L.img[i * 3 + 2]; n++;
                    }
                }
                const o = y * w + x;
                mask[o] = hole;
                if (n) { img[o * 3] = r / n; img[o * 3 + 1] = g / n; img[o * 3 + 2] = b / n; }
            }
        }
        return { w, h, img, mask };
    }

    // How far the deepest hole pixel is from known pixels (chamfer distance)
    function holeDepth(L) {
        return distanceField(L).max;
    }

    function distanceField(L) {
        const { w, h, mask } = L;
        const d = new Float32Array(w * h);
        const INF = 1e9;
        let any = false;
        for (let i = 0; i < w * h; i++) { d[i] = mask[i] ? INF : 0; if (!mask[i]) any = true; }
        if (!any) return { d, max: Infinity };
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                if (!d[i]) continue;
                let v = d[i];
                if (x > 0) v = Math.min(v, d[i - 1] + 1);
                if (y > 0) {
                    v = Math.min(v, d[i - w] + 1);
                    if (x > 0) v = Math.min(v, d[i - w - 1] + 1.4);
                    if (x < w - 1) v = Math.min(v, d[i - w + 1] + 1.4);
                }
                d[i] = v;
            }
        }
        let max = 0;
        for (let y = h - 1; y >= 0; y--) {
            for (let x = w - 1; x >= 0; x--) {
                const i = y * w + x;
                if (!d[i]) continue;
                let v = d[i];
                if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
                if (y < h - 1) {
                    v = Math.min(v, d[i + w] + 1);
                    if (x < w - 1) v = Math.min(v, d[i + w + 1] + 1.4);
                    if (x > 0) v = Math.min(v, d[i + w - 1] + 1.4);
                }
                d[i] = v;
                if (v > max) max = v;
            }
        }
        return { d, max };
    }

    // Starting guess for the coarsest level: fill the hole from its edge inwards
    function diffuseFill(L) {
        diffuse(L.w, L.h, L.img, L.mask, null);
    }

    // Fill pixels marked in `todo` from their edge inwards by averaging already-filled
    // neighbours. With `region`, only neighbours inside the region are used.
    function diffuse(w, h, img, todo, region) {
        const filled = new Uint8Array(w * h);
        const queued = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) if (!todo[i] && (!region || region[i])) filled[i] = 1;
        const neighbours = (i, fn) => {
            const x = i % w, y = (i - x) / w;
            for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    if ((dx || dy) && nx >= 0 && nx < w) fn(ny * w + nx);
                }
            }
        };
        const mask = todo;
        let frontier = [];
        for (let i = 0; i < w * h; i++) {
            if (!mask[i]) continue;
            let edge = false;
            neighbours(i, j => { if (filled[j]) edge = true; });
            if (edge) { frontier.push(i); queued[i] = 1; }
        }
        while (frontier.length) {
            const vals = new Float32Array(frontier.length * 3);
            frontier.forEach((i, k) => {
                let r = 0, g = 0, b = 0, n = 0;
                neighbours(i, j => {
                    if (!filled[j]) return;
                    r += img[j * 3]; g += img[j * 3 + 1]; b += img[j * 3 + 2]; n++;
                });
                if (n) { vals[k * 3] = r / n; vals[k * 3 + 1] = g / n; vals[k * 3 + 2] = b / n; }
            });
            frontier.forEach((i, k) => {
                img[i * 3] = vals[k * 3]; img[i * 3 + 1] = vals[k * 3 + 1]; img[i * 3 + 2] = vals[k * 3 + 2];
                filled[i] = 1;
            });
            const next = [];
            frontier.forEach(i => neighbours(i, j => {
                if (mask[j] && !filled[j] && !queued[j]) { queued[j] = 1; next.push(j); }
            }));
            frontier = next;
        }
    }

    // Patch copies can come from a slightly lighter or darker spot, which shows as a ghost
    // of the watermark. Measure the colour step along the edge of the filled area and spread
    // that correction smoothly across it, keeping the copied texture.
    function correctColour(L) {
        const { w, h, img, mask, holeList, targets, nnf } = L;
        // How far off each matched patch is on the real pixels it overlaps.
        // A good texture match scores ~0, a match from a lighter/darker spot does not.
        const off = new Float32Array(w * h * 3);
        const hasOff = new Uint8Array(w * h);
        for (let k = 0; k < targets.length; k++) {
            const p = targets[k];
            const px = p % w, py = (p - px) / w;
            const s = nnf[p], sx = s % w, sy = (s - sx) / w;
            let r = 0, g = 0, b = 0, n = 0;
            for (let dy = -R; dy <= R; dy++) {
                const ty = py + dy;
                if (ty < 0 || ty >= h) continue;
                for (let dx = -R; dx <= R; dx++) {
                    const tx = px + dx;
                    if (tx < 0 || tx >= w) continue;
                    const t = ty * w + tx;
                    if (mask[t]) continue;
                    const t3 = t * 3, s3 = ((sy + dy) * w + sx + dx) * 3;
                    r += img[t3] - img[s3]; g += img[t3 + 1] - img[s3 + 1]; b += img[t3 + 2] - img[s3 + 2]; n++;
                }
            }
            if (!n) continue;
            hasOff[p] = 1;
            off[p * 3] = r / n; off[p * 3 + 1] = g / n; off[p * 3 + 2] = b / n;
        }
        // Hole pixels next to real pixels get the average offset of the patches covering them
        const isEdge = new Uint8Array(w * h);
        const corr = new Float32Array(w * h * 3);
        for (let k = 0; k < holeList.length; k++) {
            const q = holeList[k];
            const x = q % w, y = (q - x) / w;
            let r = 0, g = 0, b = 0, n = 0;
            for (let dy = -R; dy <= R; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= h) continue;
                for (let dx = -R; dx <= R; dx++) {
                    const xx = x + dx;
                    if (xx < 0 || xx >= w) continue;
                    const p = yy * w + xx;
                    if (!hasOff[p]) continue;
                    r += off[p * 3]; g += off[p * 3 + 1]; b += off[p * 3 + 2]; n++;
                }
            }
            if (!n) continue;
            isEdge[q] = 1;
            corr[q * 3] = r / n; corr[q * 3 + 1] = g / n; corr[q * 3 + 2] = b / n;
        }
        const todo = new Uint8Array(w * h);
        for (let k = 0; k < holeList.length; k++) if (!isEdge[holeList[k]]) todo[holeList[k]] = 1;
        diffuse(w, h, corr, todo, mask);
        // Smooth the correction inside the hole (edge values stay fixed)
        const tmp = new Float32Array(corr.length);
        for (let it = 0; it < 40; it++) {
            for (let k = 0; k < holeList.length; k++) {
                const q = holeList[k];
                if (isEdge[q]) continue;
                const x = q % w;
                let r = 0, g = 0, b = 0, n = 0;
                const add = j => { r += corr[j * 3]; g += corr[j * 3 + 1]; b += corr[j * 3 + 2]; n++; };
                if (x > 0 && mask[q - 1]) add(q - 1);
                if (x < w - 1 && mask[q + 1]) add(q + 1);
                if (q >= w && mask[q - w]) add(q - w);
                if (q + w < w * h && mask[q + w]) add(q + w);
                if (n) { tmp[q * 3] = r / n; tmp[q * 3 + 1] = g / n; tmp[q * 3 + 2] = b / n; }
            }
            for (let k = 0; k < holeList.length; k++) {
                const q = holeList[k];
                if (isEdge[q]) continue;
                corr[q * 3] = tmp[q * 3]; corr[q * 3 + 1] = tmp[q * 3 + 1]; corr[q * 3 + 2] = tmp[q * 3 + 2];
            }
        }
        for (let k = 0; k < holeList.length; k++) {
            const q3 = holeList[k] * 3;
            img[q3] += corr[q3]; img[q3 + 1] += corr[q3 + 1]; img[q3 + 2] += corr[q3 + 2];
        }
    }

    // Valid source patches (fully known, fully inside) and target patches (touching the hole)
    function prepareLevel(L) {
        const { w, h, mask } = L;
        const W1 = w + 1;
        const S = new Int32Array(W1 * (h + 1));
        for (let y = 0; y < h; y++) {
            let row = 0;
            for (let x = 0; x < w; x++) {
                row += mask[y * w + x];
                S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + row;
            }
        }
        const boxSum = (x0, y0, x1, y1) => S[(y1 + 1) * W1 + x1 + 1] - S[y0 * W1 + x1 + 1] - S[(y1 + 1) * W1 + x0] + S[y0 * W1 + x0];
        const valid = new Uint8Array(w * h);
        const isTarget = new Uint8Array(w * h);
        const validList = [], targets = [], holeList = [];
        const holeIdx = new Int32Array(w * h).fill(-1);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                if (mask[i]) { holeIdx[i] = holeList.length; holeList.push(i); }
                const sum = boxSum(Math.max(0, x - R), Math.max(0, y - R), Math.min(w - 1, x + R), Math.min(h - 1, y + R));
                if (sum > 0) { isTarget[i] = 1; targets.push(i); }
                else if (x >= R && y >= R && x < w - R && y < h - R) { valid[i] = 1; validList.push(i); }
            }
        }
        L.valid = valid;
        L.validList = Int32Array.from(validList);
        L.isTarget = isTarget;
        L.targets = Int32Array.from(targets);
        L.holeList = Int32Array.from(holeList);
        L.holeIdx = holeIdx;
        L.nnf = new Int32Array(w * h);
        L.nnd = new Float32Array(w * h);
        // Trust real pixels fully and guessed ones less the deeper they sit in the hole,
        // so matches are driven by the picture around the watermark
        const { d } = distanceField(L);
        const conf = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) conf[i] = mask[i] ? Math.pow(1.3, -d[i]) : 1;
        L.conf = conf;
    }

    // Sum of squared colour differences between the patch at p and the source patch at s
    function dist(L, p, s, best) {
        const { w, h, img, conf } = L;
        const px = p % w, py = (p - px) / w;
        const sx = s % w, sy = (s - sx) / w;
        let d = 0;
        for (let dy = -R; dy <= R; dy++) {
            const ty = py + dy;
            if (ty < 0 || ty >= h) continue;
            const trow = ty * w, srow = (sy + dy) * w + sx;
            for (let dx = -R; dx <= R; dx++) {
                const tx = px + dx;
                if (tx < 0 || tx >= w) continue;
                const t = trow + tx, ti = t * 3, si = (srow + dx) * 3;
                const a = img[ti] - img[si], b = img[ti + 1] - img[si + 1], c = img[ti + 2] - img[si + 2];
                d += conf[t] * (a * a + b * b + c * c);
            }
            if (d >= best) return d;
        }
        return d;
    }

    function randomSource(L) {
        return L.validList[(rand() * L.validList.length) | 0];
    }

    function randomInit(L) {
        for (let k = 0; k < L.targets.length; k++) {
            const p = L.targets[k];
            const s = randomSource(L);
            L.nnf[p] = s;
            L.nnd[p] = dist(L, p, s, Infinity);
        }
    }

    function patchMatch(L, passes) {
        const { w, h, targets, valid, isTarget, nnf, nnd } = L;
        const n = targets.length;
        const maxRad = Math.max(w, h);
        // The hole changed since the last vote, so stored match scores are out of date
        for (let k = 0; k < n; k++) nnd[targets[k]] = dist(L, targets[k], nnf[targets[k]], Infinity);
        for (let it = 0; it < passes; it++) {
            const step = it % 2 === 0 ? 1 : -1;
            for (let k = 0; k < n; k++) {
                const p = targets[step > 0 ? k : n - 1 - k];
                const px = p % w, py = (p - px) / w;
                let best = nnd[p], bs = nnf[p];

                // Propagation: shift the neighbour's match by one pixel
                const qx = px - step;
                if (qx >= 0 && qx < w && isTarget[p - step]) {
                    const s = nnf[p - step];
                    const sx = (s % w) + step;
                    if (sx >= R && sx < w - R) {
                        const c = s + step;
                        if (c !== bs && valid[c]) {
                            const d = dist(L, p, c, best);
                            if (d < best) { best = d; bs = c; }
                        }
                    }
                }
                const qy = py - step;
                if (qy >= 0 && qy < h && isTarget[p - step * w]) {
                    const s = nnf[p - step * w];
                    const sy = ((s / w) | 0) + step;
                    if (sy >= R && sy < h - R) {
                        const c = s + step * w;
                        if (c !== bs && valid[c]) {
                            const d = dist(L, p, c, best);
                            if (d < best) { best = d; bs = c; }
                        }
                    }
                }

                // Random search in shrinking windows around the best match
                const bx = bs % w, by = (bs - bx) / w;
                for (let rad = maxRad; rad >= 1; rad >>= 1) {
                    const cx = Math.min(w - 1 - R, Math.max(R, bx + Math.round((rand() * 2 - 1) * rad)));
                    const cy = Math.min(h - 1 - R, Math.max(R, by + Math.round((rand() * 2 - 1) * rad)));
                    const c = cy * w + cx;
                    if (c === bs || !valid[c]) continue;
                    const d = dist(L, p, c, best);
                    if (d < best) { best = d; bs = c; }
                }
                nnf[p] = bs;
                nnd[p] = best;
            }
        }
    }

    // Each hole pixel becomes a weighted average of what the overlapping matches say it should be
    function vote(L, sharp) {
        const { w, h, img, targets, nnf, nnd, holeList, holeIdx } = L;
        const sample = [];
        const stride = Math.max(1, Math.floor(targets.length / 2000));
        for (let k = 0; k < targets.length; k += stride) sample.push(nnd[targets[k]]);
        sample.sort((a, b) => a - b);
        const sigma2 = Math.max(1, sample[Math.floor(sample.length * (sharp ? 0.3 : 0.75))] || 1);
        const acc = new Float64Array(holeList.length * 4);
        for (let k = 0; k < targets.length; k++) {
            const p = targets[k];
            const wt = Math.exp(-nnd[p] / (2 * sigma2)) + 1e-12;
            const px = p % w, py = (p - px) / w;
            const s = nnf[p], sx = s % w, sy = (s - sx) / w;
            for (let dy = -R; dy <= R; dy++) {
                const ty = py + dy;
                if (ty < 0 || ty >= h) continue;
                for (let dx = -R; dx <= R; dx++) {
                    const tx = px + dx;
                    if (tx < 0 || tx >= w) continue;
                    const hi = holeIdx[ty * w + tx];
                    if (hi < 0) continue;
                    const si = ((sy + dy) * w + sx + dx) * 3;
                    acc[hi * 4] += wt * img[si];
                    acc[hi * 4 + 1] += wt * img[si + 1];
                    acc[hi * 4 + 2] += wt * img[si + 2];
                    acc[hi * 4 + 3] += wt;
                }
            }
        }
        for (let hi = 0; hi < holeList.length; hi++) {
            const sum = acc[hi * 4 + 3];
            if (!(sum > 0)) continue;
            const q = holeList[hi] * 3;
            img[q] = acc[hi * 4] / sum;
            img[q + 1] = acc[hi * 4 + 1] / sum;
            img[q + 2] = acc[hi * 4 + 2] / sum;
        }
    }

    function upsampleImage(F, C) {
        for (let k = 0; k < F.holeList.length; k++) {
            const q = F.holeList[k];
            const qx = q % F.w, qy = (q - qx) / F.w;
            const c = ((qy >> 1) * C.w + (qx >> 1)) * 3;
            F.img[q * 3] = C.img[c]; F.img[q * 3 + 1] = C.img[c + 1]; F.img[q * 3 + 2] = C.img[c + 2];
        }
    }

    function upsampleField(F, C) {
        const coarseOK = C.validList.length > 0;
        for (let k = 0; k < F.targets.length; k++) {
            const p = F.targets[k];
            const px = p % F.w, py = (p - px) / F.w;
            const cp = (py >> 1) * C.w + (px >> 1);
            let s = -1;
            if (coarseOK && C.isTarget[cp]) {
                const cs = C.nnf[cp];
                const csx = cs % C.w, csy = (cs - csx) / C.w;
                const sx = Math.min(F.w - 1 - R, Math.max(R, 2 * csx + (px & 1)));
                const sy = Math.min(F.h - 1 - R, Math.max(R, 2 * csy + (py & 1)));
                const c = sy * F.w + sx;
                if (F.valid[c]) s = c;
            }
            if (s < 0) s = randomSource(F);
            F.nnf[p] = s;
            F.nnd[p] = dist(F, p, s, Infinity);
        }
    }

    // rgba: Uint8ClampedArray (w*h*4), mask: Uint8Array (w*h, 1 = remove)
    function inpaint(rgba, w, h, maskIn, onProgress) {
        const N = w * h;
        const img = new Float32Array(N * 3);
        const mask = new Uint8Array(N);
        let holes = 0;
        for (let i = 0; i < N; i++) {
            img[i * 3] = rgba[i * 4]; img[i * 3 + 1] = rgba[i * 4 + 1]; img[i * 3 + 2] = rgba[i * 4 + 2];
            if (maskIn[i]) { mask[i] = 1; holes++; }
        }
        const out = new Uint8ClampedArray(rgba);
        if (!holes) return out;
        if (holes === N) throw new Error('The selection covers the whole image. Select only the watermark.');

        const levels = [{ w, h, img, mask }];
        while (levels.length < 10) {
            const L = levels[levels.length - 1];
            if (holeDepth(L) <= 1.5) break;
            if (Math.min(L.w, L.h) / 2 < 4 * (2 * R + 1)) break;
            const next = downsample(L);
            if (!isFinite(holeDepth(next))) break;
            levels.push(next);
        }
        const n = levels.length;
        levels.forEach(prepareLevel);

        const plan = levels.map((L, i) => ({
            em: n === 1 ? 5 : i === n - 1 ? 10 : i === 0 ? 3 : 5,
            passes: i === 0 && n > 1 ? 1 : 2
        }));
        const cost = levels.map((L, i) => plan[i].em * (plan[i].passes + 1) * Math.max(1, L.targets.length));
        const total = cost.reduce((a, b) => a + b, 0);
        let done = 0;

        for (let i = n - 1; i >= 0; i--) {
            const L = levels[i];
            if (i === n - 1) diffuseFill(L);
            else upsampleImage(L, levels[i + 1]);

            if (L.validList.length) {
                if (i === n - 1) {
                    randomInit(L);
                } else {
                    // Rebuild this level from real full-detail patches before refining,
                    // instead of starting from a blurry upscale of the coarse result
                    upsampleField(L, levels[i + 1]);
                    vote(L, false);
                }
                const { em, passes } = plan[i];
                for (let e = 0; e < em; e++) {
                    patchMatch(L, passes);
                    vote(L, i === 0 && e === em - 1);
                    done += cost[i] / em;
                    if (onProgress) onProgress(Math.min(0.99, done / total));
                }
            } else {
                done += cost[i];
            }
            if (i < n - 1) levels[i + 1] = null; // free the coarser level
        }

        const L0 = levels[0];
        correctColour(L0);
        for (let k = 0; k < L0.holeList.length; k++) {
            const q = L0.holeList[k];
            out[q * 4] = L0.img[q * 3];
            out[q * 4 + 1] = L0.img[q * 3 + 1];
            out[q * 4 + 2] = L0.img[q * 3 + 2];
        }
        return out;
    }

    return { inpaint };
}

// ==========================================================================
// 2. PAGE UI
// ==========================================================================

(function initWatermarkRemover() {
    const root = document.getElementById('wmTool');
    if (!root) return;
    const $ = id => document.getElementById(id);

    const dropZone = $('wmDropZone');
    const fileInput = $('wmFileInput');
    const editor = $('wmEditor');
    const area = $('wmArea');
    const wrap = $('wmCanvasWrap');
    const imgCanvas = $('wmCanvas');
    const maskCanvas = $('wmMask');
    const compareImg = $('wmCompare');
    const cursor = $('wmCursor');
    const boxPreview = $('wmBoxPreview');
    const statusEl = $('wmStatus');
    const runBtn = $('wmRun');
    const undoBtn = $('wmUndo');
    const clearBtn = $('wmClear');
    const compareBtn = $('wmCompareBtn');
    const downloadBtn = $('wmDownload');
    const metaEl = $('wmMeta');
    const sizeEl = $('wmBrush');
    const formatEl = $('wmFormat');
    const progressWrap = $('wmProgress');
    const progressBar = $('wmProgressBar');
    const progressText = $('wmProgressText');

    const imgCtx = imgCanvas.getContext('2d', { willReadFrequently: true });
    const maskCtx = maskCanvas.getContext('2d');
    const MASK_COLOR = '#ff3b30';
    const MAX_WORK_PIXELS = 2500000;   // bigger areas are filled at a lower resolution
    const MAX_IMAGE_PIXELS = 40000000;

    let file = null, originalURL = null, W = 0, H = 0;
    let strokes = [];   // the current selection: { mode, r, pts } or { mode: 'box', x, y, w, h }
    let history = [];   // undo stack
    let edits = 0;
    let unsaved = false;
    let busy = false;
    let tool = 'brush';
    let drawing = null;

    function setStatus(text) { statusEl.innerText = text; }

    function hasSelection() { return strokes.some(s => s.mode !== 'erase'); }

    function updateButtons() {
        runBtn.disabled = busy || !file || !hasSelection();
        undoBtn.disabled = busy || !history.length;
        clearBtn.disabled = busy || !strokes.length;
        compareBtn.disabled = busy || !edits;
        downloadBtn.disabled = busy || !edits;
        wrap.classList.toggle('is-busy', busy);
    }

    // ---------------- Selection drawing ----------------

    function renderStrokes(ctx, list, extra, color) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        list.forEach(s => {
            if (s.mode === 'box') {
                ctx.globalCompositeOperation = 'source-over';
                ctx.fillStyle = color;
                ctx.fillRect(s.x - extra, s.y - extra, s.w + extra * 2, s.h + extra * 2);
                return;
            }
            ctx.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : 'source-over';
            ctx.strokeStyle = color;
            ctx.lineWidth = 2 * (s.mode === 'erase' ? Math.max(0.5, s.r - extra) : s.r + extra);
            ctx.beginPath();
            ctx.moveTo(s.pts[0], s.pts[1]);
            if (s.pts.length === 2) ctx.lineTo(s.pts[0] + 0.01, s.pts[1]);
            for (let i = 2; i < s.pts.length; i += 2) ctx.lineTo(s.pts[i], s.pts[i + 1]);
            ctx.stroke();
        });
        ctx.globalCompositeOperation = 'source-over';
    }

    function redrawMask() {
        maskCtx.clearRect(0, 0, W, H);
        renderStrokes(maskCtx, strokes, 0, MASK_COLOR);
    }

    function toImage(e) {
        const r = maskCanvas.getBoundingClientRect();
        return {
            x: clampValue((e.clientX - r.left) * W / r.width, 0, W),
            y: clampValue((e.clientY - r.top) * H / r.height, 0, H),
            scale: W / r.width
        };
    }

    function moveCursor(e) {
        if (tool === 'box' || busy) { cursor.hidden = true; return; }
        const r = wrap.getBoundingClientRect();
        const size = Number(sizeEl.value);
        cursor.hidden = false;
        cursor.style.width = cursor.style.height = `${size}px`;
        cursor.style.left = `${e.clientX - r.left - size / 2}px`;
        cursor.style.top = `${e.clientY - r.top - size / 2}px`;
        cursor.classList.toggle('is-erase', tool === 'erase');
    }

    maskCanvas.addEventListener('pointerdown', (e) => {
        if (busy || !file || e.button !== 0) return;
        e.preventDefault();
        maskCanvas.setPointerCapture(e.pointerId);
        const p = toImage(e);
        if (tool === 'box') {
            drawing = { box: true, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
            showBoxPreview();
            return;
        }
        const stroke = { mode: tool, r: Number(sizeEl.value) / 2 * p.scale, pts: [p.x, p.y] };
        strokes.push(stroke);
        drawing = { stroke };
        renderStrokes(maskCtx, [stroke], 0, MASK_COLOR);
    });

    maskCanvas.addEventListener('pointermove', (e) => {
        moveCursor(e);
        if (!drawing) return;
        const p = toImage(e);
        if (drawing.box) {
            drawing.x1 = p.x;
            drawing.y1 = p.y;
            showBoxPreview();
            return;
        }
        const s = drawing.stroke;
        const lx = s.pts[s.pts.length - 2], ly = s.pts[s.pts.length - 1];
        s.pts.push(p.x, p.y);
        renderStrokes(maskCtx, [{ mode: s.mode, r: s.r, pts: [lx, ly, p.x, p.y] }], 0, MASK_COLOR);
    });

    function endDraw() {
        if (!drawing) return;
        if (drawing.box) {
            boxPreview.hidden = true;
            const x = Math.min(drawing.x0, drawing.x1), y = Math.min(drawing.y0, drawing.y1);
            const w = Math.abs(drawing.x1 - drawing.x0), h = Math.abs(drawing.y1 - drawing.y0);
            if (w >= 2 && h >= 2) {
                strokes.push({ mode: 'box', x, y, w, h });
                history.push({ kind: 'stroke' });
                redrawMask();
            }
        } else {
            history.push({ kind: 'stroke' });
        }
        drawing = null;
        updateButtons();
        if (hasSelection()) setStatus('Press "Remove watermark" when the whole watermark is covered.');
    }
    maskCanvas.addEventListener('pointerup', endDraw);
    maskCanvas.addEventListener('pointercancel', endDraw);
    maskCanvas.addEventListener('pointerleave', () => { cursor.hidden = true; });

    function showBoxPreview() {
        const r = maskCanvas.getBoundingClientRect();
        const k = r.width / W;
        boxPreview.hidden = false;
        boxPreview.style.left = `${Math.min(drawing.x0, drawing.x1) * k}px`;
        boxPreview.style.top = `${Math.min(drawing.y0, drawing.y1) * k}px`;
        boxPreview.style.width = `${Math.abs(drawing.x1 - drawing.x0) * k}px`;
        boxPreview.style.height = `${Math.abs(drawing.y1 - drawing.y0) * k}px`;
    }

    // ---------------- Undo / clear ----------------

    function undo() {
        if (busy || !history.length) return;
        const last = history.pop();
        if (last.kind === 'stroke') {
            strokes.pop();
        } else if (last.kind === 'clear') {
            strokes = last.strokes;
        } else if (last.kind === 'fill') {
            imgCtx.putImageData(last.before, last.x, last.y);
            strokes = last.strokes;
            edits--;
        }
        redrawMask();
        updateButtons();
        setStatus('Undone.');
    }

    function clearSelection() {
        if (busy || !strokes.length) return;
        history.push({ kind: 'clear', strokes });
        strokes = [];
        redrawMask();
        updateButtons();
    }

    // ---------------- Canvas sizing ----------------

    function fitCanvas() {
        if (!W) return;
        const availW = area.clientWidth - 2 * parseFloat(getComputedStyle(area).paddingLeft || 0);
        const maxH = Math.min(window.innerHeight * 0.7, 640);
        const k = Math.min(1, availW / W, maxH / H);
        const cw = `${Math.max(1, Math.floor(W * k))}px`;
        const ch = `${Math.max(1, Math.floor(H * k))}px`;
        imgCanvas.style.width = cw;
        imgCanvas.style.height = ch;
    }
    if (window.ResizeObserver) new ResizeObserver(fitCanvas).observe(area);
    window.addEventListener('resize', fitCanvas);

    // ---------------- Open an image ----------------

    async function openFile(f) {
        if (busy) return;
        let loaded;
        try {
            loaded = await loadImageFile(f);
        } catch (e) {
            setStatus('This image could not be opened. Try a JPG, PNG or WebP file.');
            return;
        }
        const { img, url } = loaded;
        if (img.naturalWidth * img.naturalHeight > MAX_IMAGE_PIXELS) {
            URL.revokeObjectURL(url);
            setStatus('This image is too large to edit in the browser (over 40 megapixels). Resize it first.');
            return;
        }
        if (originalURL) URL.revokeObjectURL(originalURL);
        file = f;
        originalURL = url;
        W = img.naturalWidth;
        H = img.naturalHeight;
        imgCanvas.width = maskCanvas.width = W;
        imgCanvas.height = maskCanvas.height = H;
        imgCtx.clearRect(0, 0, W, H);
        imgCtx.drawImage(img, 0, 0);
        compareImg.src = url;
        strokes = [];
        history = [];
        edits = 0;
        unsaved = false;
        redrawMask();
        dropZone.hidden = true;
        editor.hidden = false;
        metaEl.innerHTML = `<strong>${escapeHTML(f.name)}</strong><span>${formatBytes(f.size)}</span><span>${W}×${H}</span>`;
        fitCanvas();
        updateButtons();
        setStatus('Paint over the watermark, then press "Remove watermark".');
    }

    // ---------------- Remove ----------------

    let worker = null;
    let workerFailed = false;
    function getWorker() {
        if (worker || workerFailed) return worker;
        try {
            const src = `const ENGINE=(${inpaintEngine.toString()})();
self.onmessage=function(e){var d=e.data;try{var out=ENGINE.inpaint(d.rgba,d.w,d.h,d.mask,function(p){self.postMessage({progress:p});});self.postMessage({done:true,rgba:out},[out.buffer]);}catch(err){self.postMessage({error:(err&&err.message)||String(err)});}};`;
            worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        } catch (e) {
            workerFailed = true;
            worker = null;
        }
        return worker;
    }

    function runOnMainThread(rgba, w, h, mask, onProgress) {
        return new Promise((resolve, reject) => setTimeout(() => {
            try { resolve(inpaintEngine().inpaint(rgba, w, h, mask, onProgress)); } catch (e) { reject(e); }
        }, 30));
    }

    function runInpaint(rgba, w, h, mask, onProgress) {
        const wk = getWorker();
        if (!wk) return runOnMainThread(rgba, w, h, mask, onProgress);
        return new Promise((resolve, reject) => {
            wk.onmessage = (e) => {
                const d = e.data;
                if (d.progress != null) onProgress(d.progress);
                else if (d.error) reject(new Error(d.error));
                else if (d.done) resolve(d.rgba);
            };
            wk.onerror = (e) => {
                if (e && e.preventDefault) e.preventDefault();
                wk.terminate();
                worker = null;
                workerFailed = true;
                runOnMainThread(rgba, w, h, mask, onProgress).then(resolve, reject);
            };
            wk.postMessage({ rgba, w, h, mask });
        });
    }

    function setProgress(fraction, text) {
        progressWrap.hidden = false;
        progressBar.style.width = `${Math.round(clampValue(fraction, 0, 1) * 100)}%`;
        progressText.innerText = text;
    }

    function selectionBounds(extra) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        strokes.forEach(s => {
            if (s.mode === 'erase') return;
            if (s.mode === 'box') {
                x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y);
                x1 = Math.max(x1, s.x + s.w); y1 = Math.max(y1, s.y + s.h);
                return;
            }
            for (let i = 0; i < s.pts.length; i += 2) {
                x0 = Math.min(x0, s.pts[i] - s.r); y0 = Math.min(y0, s.pts[i + 1] - s.r);
                x1 = Math.max(x1, s.pts[i] + s.r); y1 = Math.max(y1, s.pts[i + 1] + s.r);
            }
        });
        if (!isFinite(x0)) return null;
        x0 = Math.max(0, Math.floor(x0 - extra)); y0 = Math.max(0, Math.floor(y0 - extra));
        x1 = Math.min(W, Math.ceil(x1 + extra)); y1 = Math.min(H, Math.ceil(y1 + extra));
        return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    }

    function makeCanvas(w, h) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
    }

    async function run() {
        if (busy || !file) return;
        // Grow the selection a little so faint edges and shadows of the watermark go too
        const grow = Math.max(2, Math.round(Math.max(W, H) / 600));
        const sel = selectionBounds(grow);
        if (!sel) { setStatus('Paint over the watermark first.'); return; }

        busy = true;
        updateButtons();
        cursor.hidden = true;
        const started = Date.now();
        try {
            setProgress(0, 'Preparing...');
            setStatus('Removing watermark...');

            // Work on the selection plus a margin of surrounding picture to copy from
            const margin = Math.round(Math.max(48, Math.max(sel.w, sel.h) * 0.75));
            const cx = Math.max(0, sel.x - margin), cy = Math.max(0, sel.y - margin);
            const cw = Math.min(W, sel.x + sel.w + margin) - cx;
            const ch = Math.min(H, sel.y + sel.h + margin) - cy;
            const scale = Math.min(1, Math.sqrt(MAX_WORK_PIXELS / (cw * ch)));
            const sw = Math.max(1, Math.round(cw * scale));
            const sh = Math.max(1, Math.round(ch * scale));

            const crop = makeCanvas(cw, ch);
            crop.getContext('2d').drawImage(imgCanvas, cx, cy, cw, ch, 0, 0, cw, ch);
            const work = scale < 1 ? drawResized(crop, sw, sh) : crop;
            const rgba = work.getContext('2d').getImageData(0, 0, sw, sh).data;

            const maskWork = makeCanvas(sw, sh);
            const mctx = maskWork.getContext('2d');
            mctx.setTransform(sw / cw, 0, 0, sh / ch, -cx * sw / cw, -cy * sh / ch);
            renderStrokes(mctx, strokes, grow + (scale < 1 ? 1.5 / scale : 0), '#fff');
            const malpha = mctx.getImageData(0, 0, sw, sh).data;
            const mask = new Uint8Array(sw * sh);
            let holes = 0;
            for (let i = 0; i < mask.length; i++) if (malpha[i * 4 + 3] > 0) { mask[i] = 1; holes++; }
            if (!holes) throw new Error('Paint over the watermark first.');

            const filled = await runInpaint(rgba, sw, sh, mask, p => setProgress(p, `Filling in the area... ${Math.round(p * 100)}%`));

            // Bring the result back to full size and blend it in along the soft selection edge
            let full;
            if (scale < 1) {
                const small = makeCanvas(sw, sh);
                small.getContext('2d').putImageData(new ImageData(filled, sw, sh), 0, 0);
                const big = makeCanvas(cw, ch);
                const bctx = big.getContext('2d');
                bctx.imageSmoothingQuality = 'high';
                bctx.drawImage(small, 0, 0, cw, ch);
                full = bctx.getImageData(0, 0, cw, ch).data;
            } else {
                full = filled;
            }
            const soft = makeCanvas(cw, ch);
            const sctx = soft.getContext('2d');
            sctx.translate(-cx, -cy);
            renderStrokes(sctx, strokes, grow, '#fff');
            const salpha = sctx.getImageData(0, 0, cw, ch).data;

            const before = imgCtx.getImageData(cx, cy, cw, ch);
            const out = new ImageData(new Uint8ClampedArray(before.data), cw, ch);
            const o = out.data;
            for (let i = 0; i < cw * ch; i++) {
                const a = salpha[i * 4 + 3] / 255;
                if (!a) continue;
                const j = i * 4;
                o[j] = full[j] * a + o[j] * (1 - a);
                o[j + 1] = full[j + 1] * a + o[j + 1] * (1 - a);
                o[j + 2] = full[j + 2] * a + o[j + 2] * (1 - a);
            }
            imgCtx.putImageData(out, cx, cy);

            history.push({ kind: 'fill', x: cx, y: cy, before, strokes });
            strokes = [];
            redrawMask();
            edits++;
            unsaved = true;
            const took = ((Date.now() - started) / 1000).toFixed(1);
            setStatus(`Done in ${took} s. Mark anything left over and run it again, or download your image.`);
        } catch (err) {
            setStatus(err.message || 'Something went wrong. Try a smaller selection.');
        } finally {
            busy = false;
            progressWrap.hidden = true;
            updateButtons();
        }
    }

    // ---------------- Compare and download ----------------

    function setComparing(on) {
        if (!edits && on) return;
        wrap.classList.toggle('is-comparing', on);
        compareImg.hidden = !on;
    }
    compareBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); setComparing(true); });
    ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach(t => compareBtn.addEventListener(t, () => setComparing(false)));
    compareBtn.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setComparing(true); } });
    compareBtn.addEventListener('keyup', () => setComparing(false));

    async function download() {
        if (!file || !edits || busy) return;
        try {
            const mime = await resolveOutputMime(formatEl.value, file);
            let source = imgCanvas;
            if (mime === 'image/jpeg') {
                source = makeCanvas(W, H);
                const ctx = source.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, W, H);
                ctx.drawImage(imgCanvas, 0, 0);
            }
            const blob = await canvasToBlob(source, mime, 0.92);
            triggerDownload(blob, `${stripExtension(file.name)}-no-watermark.${MIME_EXT[mime] || 'png'}`);
            unsaved = false;
            setStatus(`Downloaded (${formatBytes(blob.size)}).`);
        } catch (e) {
            setStatus(e.message || 'The image could not be saved.');
        }
    }

    // ---------------- Wiring ----------------

    bindChipGroup($('wmMode'), value => {
        tool = value;
        maskCanvas.classList.toggle('is-box', value === 'box');
    });
    bindRangeText(sizeEl, $('wmBrushText'), v => `${v} px`);
    runBtn.addEventListener('click', run);
    undoBtn.addEventListener('click', undo);
    clearBtn.addEventListener('click', clearSelection);
    downloadBtn.addEventListener('click', download);
    $('wmChange').addEventListener('click', () => { if (!busy) fileInput.click(); });
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && file && !editor.hidden) {
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            e.preventDefault();
            undo();
        }
    });
    window.addEventListener('beforeunload', (e) => {
        if (busy || unsaved) { e.preventDefault(); e.returnValue = ''; }
    });
    bindToolDropZone(dropZone, fileInput, files => openFile(files[0]));
})();
