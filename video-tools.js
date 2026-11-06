/* ==========================================================================
   PicsConvert - Video tools (video-tools.js)
   Compress Video, Video Converter, Video to MP3, Video to GIF and Trim Video.
   Everything runs on ffmpeg.wasm inside the browser tab; nothing is uploaded.
   Loaded after app.js (escapeHTML, theme) and tools.js (shared helpers), plus
   vendor/ffmpeg/ffmpeg.js, which must be served from this origin because it
   starts a Web Worker from its own URL. The ~31 MB ffmpeg core is fetched from
   unpkg only once a video is chosen, then cached by the browser.
   ========================================================================== */

(function initVideoTool() {
    const root = document.getElementById('videoTool');
    if (!root) return;

    // ======================================================================
    // 1. ENGINE: load ffmpeg.wasm, run commands, read video info
    // ======================================================================

    const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/';
    const WASM_SIZE = 32129114; // used when the CDN sends a compressed length

    let ffmpeg = null;
    let enginePromise = null;
    let coreURLs = null;
    let logHook = null;
    let onEngineProgress = null;

    async function fetchToBlobURL(url, type, knownSize) {
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) throw new Error('Could not download the video engine. Check your connection and try again.');
        if (!res.body || !res.body.getReader) {
            return URL.createObjectURL(new Blob([await res.blob()], { type }));
        }
        const total = Math.max(Number(res.headers.get('content-length')) || 0, knownSize || 0);
        const reader = res.body.getReader();
        const chunks = [];
        let loaded = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            if (knownSize && onEngineProgress) onEngineProgress(loaded, total);
        }
        return URL.createObjectURL(new Blob(chunks, { type }));
    }

    function loadEngine() {
        if (ffmpeg) return Promise.resolve(ffmpeg);
        if (enginePromise) return enginePromise;
        enginePromise = (async () => {
            if (!window.FFmpegWASM) {
                throw new Error('The video engine failed to load. Disable any script blocker for this site and refresh.');
            }
            if (!coreURLs) {
                const coreURL = await fetchToBlobURL(CORE_BASE + 'ffmpeg-core.js', 'text/javascript');
                const wasmURL = await fetchToBlobURL(CORE_BASE + 'ffmpeg-core.wasm', 'application/wasm', WASM_SIZE);
                coreURLs = { coreURL, wasmURL };
            }
            const instance = new window.FFmpegWASM.FFmpeg();
            instance.on('log', ({ message }) => { if (logHook) logHook(message); });
            await instance.load(coreURLs);
            ffmpeg = instance;
            return instance;
        })();
        enginePromise.catch(() => {}).then(() => { enginePromise = null; });
        return enginePromise;
    }

    // Stop whatever ffmpeg is doing; the next job starts a fresh worker
    function killEngine() {
        if (ffmpeg) {
            try { ffmpeg.terminate(); } catch (e) { /* already gone */ }
        }
        ffmpeg = null;
    }

    function parseClock(h, m, s) {
        return Number(h) * 3600 + Number(m) * 60 + Number(s);
    }

    function friendlyError(logs) {
        const text = logs.join('\n');
        if (/does not contain any stream|matches no streams|Output file is empty/i.test(text)) {
            return 'This file has nothing to export for that option (for example, a video with no sound track).';
        }
        if (/Invalid data found|could not find codec|Unknown format|moov atom not found/i.test(text)) {
            return 'This file could not be read. It may be damaged or use a format the browser engine does not support.';
        }
        if (/memory|OOM|Aborted\(\)/i.test(text)) {
            return 'Your browser ran out of memory. Try a shorter video or a lower resolution.';
        }
        const last = logs.filter(l => /error|invalid|failed/i.test(l)).pop();
        return last ? `Processing failed: ${last.trim()}` : 'Processing failed. Try another output option.';
    }

    // Run one ffmpeg command. Progress is read from the "time=" lines ffmpeg logs.
    async function runFFmpeg(args, duration, onProgress) {
        const logs = [];
        logHook = (msg) => {
            logs.push(msg);
            if (logs.length > 300) logs.shift();
            const m = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(msg);
            if (m && duration > 0 && onProgress) onProgress(clampValue(parseClock(m[1], m[2], m[3]) / duration, 0, 1));
        };
        try {
            const code = await ffmpeg.exec(args);
            if (code !== 0) throw new Error(friendlyError(logs));
        } finally {
            logHook = null;
        }
    }

    // Read duration, codecs and display size from ffmpeg's "-i" banner
    async function probe(path) {
        const logs = [];
        logHook = msg => logs.push(msg);
        try {
            await ffmpeg.exec(['-hide_banner', '-i', path]);
        } finally {
            logHook = null;
        }
        const text = logs.join('\n');
        const info = { duration: 0, vcodec: null, acodec: null, width: 0, height: 0, fps: 0 };
        const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
        if (d) info.duration = parseClock(d[1], d[2], d[3]);
        const v = /Stream #\d+:\d+[^\n]*?: Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(text);
        if (v) {
            info.vcodec = v[1];
            info.width = Number(v[2]);
            info.height = Number(v[3]);
            const fps = /, (\d+(?:\.\d+)?) fps/.exec(text);
            if (fps) info.fps = Number(fps[1]);
            const rot = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(text) || /rotate\s*:\s*(-?\d+)/.exec(text);
            if (rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90) {
                [info.width, info.height] = [info.height, info.width];
            }
        }
        const a = /Stream #\d+:\d+[^\n]*?: Audio: (\w+)/.exec(text);
        if (a) info.acodec = a[1];
        if (!info.vcodec && !info.acodec) {
            throw new Error('This file could not be read. It may be damaged or not a video.');
        }
        return info;
    }

    // Expose the file to ffmpeg without copying it into memory when possible
    let mountCount = 0;
    async function mountInput(file) {
        const ext = (/\.([a-z0-9]{2,5})$/i.exec(file.name) || [, 'mp4'])[1].toLowerCase();
        const named = new File([file], `input.${ext}`, { type: file.type });
        const dir = `/in${++mountCount}`;
        try {
            await ffmpeg.createDir(dir);
            await ffmpeg.mount('WORKERFS', { files: [named] }, dir);
            return { path: `${dir}/input.${ext}`, ext, release: () => (ffmpeg ? ffmpeg.unmount(dir).catch(() => {}) : null) };
        } catch (e) {
            const path = `input${mountCount}.${ext}`;
            await ffmpeg.writeFile(path, new Uint8Array(await file.arrayBuffer()));
            return { path, ext, release: () => (ffmpeg ? ffmpeg.deleteFile(path).catch(() => {}) : null) };
        }
    }

    // ======================================================================
    // 2. SMALL HELPERS
    // ======================================================================

    function formatClock(sec, decimals = 0) {
        if (!isFinite(sec) || sec < 0) sec = 0;
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const ss = decimals ? s.toFixed(decimals).padStart(3 + decimals, '0') : String(Math.floor(s)).padStart(2, '0');
        return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
    }

    const even = n => Math.max(2, Math.round(n / 2) * 2);

    // Fit the short side to maxShort (never upscale) and keep both sides even for H.264
    function scaleFilter(info, maxShort) {
        if (!info.width || !info.height) return 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
        const short = Math.min(info.width, info.height);
        const factor = maxShort && short > maxShort ? maxShort / short : 1;
        return `scale=${even(info.width * factor)}:${even(info.height * factor)}`;
    }

    const $ = id => document.getElementById(id);
    const valueOf = (id, fallback) => ($(id) ? $(id).value : fallback);
    const checked = id => !!($(id) && $(id).checked);

    function chipValue(groupId, fallback) {
        const active = $(groupId) && $(groupId).querySelector('.chip-btn.active');
        return active ? active.dataset.value : fallback;
    }

    const H264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
    const FASTSTART = ['-movflags', '+faststart'];

    // ======================================================================
    // 3. TOOLS: each returns the ffmpeg jobs to try, in order
    // ======================================================================

    const TOOLS = {
        // ---------------- Compress Video ----------------
        compress: {
            verb: 'Compressing',
            jobs({ input, info, file }) {
                const maxShort = Number(valueOf('vcRes', '720')) || 0;
                const mute = checked('vcMute') || !info.acodec;
                const audio = mute ? ['-an'] : ['-c:a', 'aac', '-b:a', '128k'];
                const vf = ['-vf', scaleFilter(info, maxShort)];
                const out = 'output.mp4';
                const base = { out, mime: 'video/mp4', ext: 'mp4', duration: info.duration };

                if (chipValue('vcMode', 'quality') === 'target') {
                    if (!info.duration) throw new Error('The length of this video could not be read. Use "Quality" mode instead.');
                    const targetBytes = Math.max(1, parseFloat(valueOf('vcTarget', '25')) || 25) * 1024 * 1024;
                    const audioBits = mute ? 0 : 128000;
                    const makeArgs = (ratio) => {
                        const vbit = Math.max(80000, Math.floor((targetBytes * 8 * ratio) / Math.max(1, info.duration) - audioBits));
                        return ['-i', input.path, ...vf, ...H264, '-b:v', String(vbit), '-maxrate', String(Math.floor(vbit * 1.25)), '-bufsize', String(vbit * 2), ...audio, ...FASTSTART, out];
                    };
                    // Second pass only runs if the first one overshoots the limit
                    return [
                        { ...base, args: makeArgs(0.92), maxBytes: targetBytes },
                        { ...base, args: makeArgs(0.75), maxBytes: targetBytes, label: 'Retrying with a lower bitrate' },
                        { ...base, args: makeArgs(0.55) }
                    ];
                }
                const crf = { small: '32', balanced: '28', high: '23' }[chipValue('vcLevel', 'balanced')] || '28';
                return [{ ...base, args: ['-i', input.path, ...vf, ...H264, '-crf', crf, ...audio, ...FASTSTART, out] }];
            },
            // Never hand back a bigger MP4 than the one that went in
            keepOriginal(blob, file) {
                return blob.size >= file.size && (file.type === 'video/mp4' || /\.mp4$/i.test(file.name));
            },
            note(result, file) {
                if (result.blob === file) return 'Your video was already well compressed, so the original is kept. Try a lower resolution or "Smaller file" to shrink it further.';
                if (result.blob.size >= file.size) return 'This video was already well compressed. Try a lower resolution or "Smaller file".';
                return '';
            }
        },

        // ---------------- Video Converter ----------------
        convert: {
            verb: 'Converting',
            jobs({ input, info }) {
                const target = valueOf('vfFormat', 'mp4');
                if (target === 'mp3') return TOOLS.audio.jobs({ input, info }, 'mp3', '192');
                if (!info.vcodec) throw new Error('This file has no video track. Use Video to MP3 for audio files.');

                const out = `output.${target}`;
                const mime = { mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo' }[target];
                const base = { out, mime, ext: target, duration: info.duration };
                const ac = info.acodec;
                const vf = ['-vf', scaleFilter(info, 0)];
                const jobs = [];

                // Copy streams that already fit the new container: near-instant and lossless
                const canCopyV = {
                    mp4: ['h264'], mov: ['h264'], mkv: ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4'], webm: ['vp8', 'vp9', 'av1'], avi: []
                }[target].includes(info.vcodec);
                const canCopyA = !ac || {
                    mp4: ['aac', 'mp3'], mov: ['aac', 'mp3'], mkv: [ac], webm: ['opus', 'vorbis'], avi: ['mp3']
                }[target].includes(ac);

                if (target === 'webm') {
                    const vp8 = ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-crf', '10', '-b:v', '2500k', '-qmin', '4', '-qmax', '42'];
                    if (canCopyV) jobs.push({ ...base, args: ['-i', input.path, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', ...(canCopyA ? ['-c:a', 'copy'] : ['-c:a', 'libopus', '-b:a', '128k']), out] });
                    jobs.push({ ...base, args: ['-i', input.path, '-map', '0:v:0', '-map', '0:a:0?', ...vf, ...vp8, '-c:a', 'libopus', '-b:a', '128k', out] });
                    jobs.push({ ...base, args: ['-i', input.path, '-map', '0:v:0', '-map', '0:a:0?', ...vf, ...vp8, '-c:a', 'libvorbis', '-q:a', '4', out] });
                    return jobs;
                }
                if (target === 'avi') {
                    return [{ ...base, args: ['-i', input.path, '-map', '0:v:0', '-map', '0:a:0?', ...vf, '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'libmp3lame', '-b:a', '192k', out] }];
                }
                const extra = target === 'mkv' ? [] : FASTSTART;
                if (canCopyV) {
                    jobs.push({ ...base, args: ['-i', input.path, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', ...(canCopyA ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k']), ...extra, out] });
                }
                jobs.push({ ...base, args: ['-i', input.path, '-map', '0:v:0', '-map', '0:a:0?', ...vf, ...H264, '-crf', '23', '-c:a', 'aac', '-b:a', '160k', ...extra, out] });
                return jobs;
            }
        },

        // ---------------- Video to MP3 / audio ----------------
        audio: {
            verb: 'Extracting audio',
            jobs({ input, info }, forceFormat, forceBitrate) {
                if (!info.acodec) throw new Error('This video has no sound track, so there is no audio to extract.');
                const format = forceFormat || valueOf('vaFormat', 'mp3');
                const kbps = (forceBitrate || valueOf('vaBitrate', '192')) + 'k';
                const out = `output.${format}`;
                const base = {
                    out, ext: format, duration: info.duration,
                    mime: { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav' }[format]
                };
                const pre = ['-i', input.path, '-vn', '-map', '0:a:0'];
                if (format === 'wav') return [{ ...base, args: [...pre, '-c:a', 'pcm_s16le', out] }];
                if (format === 'm4a') {
                    const jobs = [];
                    if (info.acodec === 'aac') jobs.push({ ...base, args: [...pre, '-c:a', 'copy', ...FASTSTART, out] });
                    jobs.push({ ...base, args: [...pre, '-c:a', 'aac', '-b:a', kbps, ...FASTSTART, out] });
                    return jobs;
                }
                return [{ ...base, args: [...pre, '-c:a', 'libmp3lame', '-b:a', kbps, out] }];
            }
        },

        // ---------------- Video to GIF ----------------
        gif: {
            verb: 'Making GIF',
            usesTimeline: true,
            jobs({ input, info }) {
                if (!info.vcodec) throw new Error('This file has no video track.');
                const start = Number($('vgStart').value) || 0;
                const length = Math.min(Number($('vgLength').value) || 5, Math.max(0.1, info.duration - start));
                const fps = valueOf('vgFps', '12');
                const width = Number(valueOf('vgWidth', '480')) || 0;
                const scale = width && info.width && info.width > width ? `,scale=${width}:-1:flags=lanczos` : '';
                const filter = `fps=${fps}${scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
                return [{
                    out: 'output.gif', mime: 'image/gif', ext: 'gif', duration: length,
                    args: ['-ss', start.toFixed(2), '-t', length.toFixed(2), '-i', input.path, '-filter_complex', filter, '-loop', '0', 'output.gif']
                }];
            }
        },

        // ---------------- Trim Video ----------------
        trim: {
            verb: 'Trimming',
            usesTimeline: true,
            jobs({ input, info }) {
                const start = Number($('vtStart').value) || 0;
                const end = Number($('vtEnd').value) || info.duration;
                const length = end - start;
                if (length < 0.1) throw new Error('The end time must be after the start time.');
                const mute = checked('vtMute') || !info.acodec;
                const maps = ['-map', '0:v:0?', ...(mute ? ['-an'] : ['-map', '0:a:0?'])];
                const seek = ['-ss', start.toFixed(3), '-i', input.path, '-t', length.toFixed(3)];
                const precise = {
                    out: 'output.mp4', mime: 'video/mp4', ext: 'mp4', duration: length,
                    args: [...seek, ...maps, '-vf', scaleFilter(info, 0), ...H264, '-crf', '20', ...(mute ? [] : ['-c:a', 'aac', '-b:a', '160k']), ...FASTSTART, 'output.mp4']
                };
                if (chipValue('vtMode', 'fast') === 'precise') return [precise];
                const ext = ['mp4', 'mov', 'm4v', 'mkv', 'webm'].includes(input.ext) ? input.ext : 'mp4';
                const mime = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm' }[ext];
                return [
                    {
                        out: `output.${ext}`, mime, ext, duration: length,
                        args: [...seek, ...maps, '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...(ext === 'mp4' || ext === 'mov' || ext === 'm4v' ? FASTSTART : []), `output.${ext}`]
                    },
                    { ...precise, label: 'Re-encoding for an exact cut' }
                ];
            }
        }
    };

    const tool = TOOLS[root.dataset.tool];
    if (!tool) return;

    // ======================================================================
    // 4. PAGE UI: one video at a time
    // ======================================================================

    const dropZone = $('videoDropZone');
    const fileInput = $('videoFileInput');
    const workspace = $('videoWorkspace');
    const preview = $('videoPreview');
    const previewNote = $('videoPreviewNote');
    const metaEl = $('videoMeta');
    const runBtn = $('videoRun');
    const progressWrap = $('videoProgress');
    const progressBar = $('videoProgressBar');
    const progressText = $('videoProgressText');
    const cancelBtn = $('videoCancel');
    const resultWrap = $('videoResult');
    const resultMedia = $('videoResultMedia');
    const resultSizes = $('videoResultSizes');
    const resultNote = $('videoResultNote');
    const downloadBtn = $('videoDownload');
    const statusEl = $('videoStatus');

    const MAX_BYTES = 2 * 1024 * 1024 * 1024;
    let current = null;       // { file, url, info, input }
    let result = null;        // { blob, name, url }
    let busy = false;
    let cancelled = false;

    function setStatus(text) {
        if (statusEl) statusEl.innerText = text;
    }

    function setProgress(fraction, text) {
        progressWrap.hidden = false;
        progressBar.style.width = `${Math.round(clampValue(fraction, 0, 1) * 100)}%`;
        progressText.innerText = text;
    }

    function clearResult() {
        if (result) URL.revokeObjectURL(result.url);
        result = null;
        resultWrap.hidden = true;
        resultMedia.innerHTML = '';
    }

    function renderMeta() {
        if (!current) return;
        const info = current.info;
        const parts = [escapeHTML(current.file.name), formatBytes(current.file.size)];
        const duration = (info && info.duration) || current.previewDuration;
        if (duration) parts.push(formatClock(duration));
        const w = (info && info.width) || preview.videoWidth;
        const h = (info && info.height) || preview.videoHeight;
        if (w && h) parts.push(`${w}×${h}`);
        metaEl.innerHTML = parts.map((p, i) => i ? `<span>${p}</span>` : `<strong>${p}</strong>`).join('');
    }

    function updateRunState() {
        runBtn.disabled = !current || busy;
    }

    // Duration known (from the <video> tag or ffmpeg) -> set up trim / GIF sliders
    function applyDuration(duration) {
        if (!current || !(duration > 0) || current.timelineReady) return;
        current.timelineReady = true;
        if (tool.usesTimeline && typeof window.videoTimelineInit === 'function') {
            window.videoTimelineInit(duration, preview);
        }
    }

    // Load the engine, mount the file and read its info. Shared by the background
    // warm-up and the Run button so the two never probe the same file at once.
    function prepareInput() {
        const target = current;
        if (target.preparing) return target.preparing;
        target.preparing = (async () => {
            await loadEngine();
            if (!target.input) target.input = await mountInput(target.file);
            if (!target.info) {
                target.info = await probe(target.input.path);
                if (!target.info.duration && target.previewDuration) target.info.duration = target.previewDuration;
                if (target === current) {
                    renderMeta();
                    applyDuration(target.info.duration);
                }
            }
            return target;
        })();
        target.preparing.catch(() => {}).then(() => { target.preparing = null; });
        return target.preparing;
    }

    function engineStatusText(loaded, total) {
        return `Downloading the video engine (first time only): ${formatBytes(loaded)} of ${formatBytes(total)}`;
    }

    async function releaseCurrent() {
        if (current) {
            URL.revokeObjectURL(current.url);
            if (current.input) await current.input.release();
        }
        current = null;
    }

    async function openFile(file) {
        if (busy) return;
        if (file.size > MAX_BYTES) {
            setStatus('That file is larger than 2 GB, which is too big to process inside a browser tab.');
            return;
        }
        clearResult();
        await releaseCurrent();
        current = { file, url: URL.createObjectURL(file), info: null, input: null, previewDuration: 0, timelineReady: false };
        dropZone.hidden = true;
        workspace.hidden = false;
        progressWrap.hidden = true;
        previewNote.hidden = true;
        preview.hidden = false;
        preview.src = current.url;
        renderMeta();
        updateRunState();
        setStatus('Ready. Choose your settings and press the button.');

        // Start downloading the engine and reading the file in the background
        const mine = current;
        onEngineProgress = (loaded, total) => { if (!busy) setStatus(engineStatusText(loaded, total)); };
        prepareInput()
            .then(() => { if (current === mine && !busy) setStatus('Ready. Choose your settings and press the button.'); })
            .catch(err => { if (current === mine && !busy) setStatus(err.message); });
    }

    preview.addEventListener('loadedmetadata', () => {
        if (!current) return;
        if (isFinite(preview.duration) && preview.duration > 0) current.previewDuration = preview.duration;
        renderMeta();
        applyDuration(current.previewDuration);
    });
    preview.addEventListener('error', () => {
        if (!current || !preview.getAttribute('src')) return;
        preview.hidden = true;
        previewNote.hidden = false;
    });

    async function run() {
        if (!current || busy) return;
        busy = true;
        cancelled = false;
        updateRunState();
        clearResult();
        const started = Date.now();
        const file = current.file;
        let outPath = null;

        try {
            onEngineProgress = (loaded, total) => setProgress(loaded / total * 0.98, engineStatusText(loaded, total));
            setProgress(0, ffmpeg ? 'Reading video...' : 'Starting the video engine...');
            setStatus(`${tool.verb}...`);
            await prepareInput();
            if (cancelled) throw new Error('cancelled');

            const jobs = tool.jobs({ input: current.input, info: current.info, file });
            let blob = null, job = null, lastError = null;
            for (let i = 0; i < jobs.length && !blob; i++) {
                job = jobs[i];
                outPath = job.out;
                const label = job.label || tool.verb;
                setProgress(0, `${label}... 0%`);
                const jobStart = Date.now();
                try {
                    await runFFmpeg(job.args, job.duration, fraction => {
                        const elapsed = (Date.now() - jobStart) / 1000;
                        const left = fraction > 0.03 ? elapsed / fraction - elapsed : 0;
                        setProgress(fraction, `${label}... ${Math.round(fraction * 100)}%${left > 2 ? ` · about ${formatClock(left)} left` : ''}`);
                    });
                    const data = await ffmpeg.readFile(job.out);
                    await ffmpeg.deleteFile(job.out).catch(() => {});
                    if (!data || !data.length) throw new Error('The output came out empty. Try a different option.');
                    const candidate = new Blob([data], { type: job.mime });
                    if (job.maxBytes && candidate.size > job.maxBytes && i < jobs.length - 1) continue;
                    blob = candidate;
                } catch (err) {
                    if (cancelled) throw new Error('cancelled');
                    lastError = err;
                    if (/memory/i.test(err.message)) break; // a retry would run out of memory too
                }
            }
            if (!blob) throw lastError || new Error('Processing failed.');
            if (tool.keepOriginal && tool.keepOriginal(blob, file)) blob = file;

            const name = `${stripExtension(file.name)}-${root.dataset.suffix || 'edited'}.${job.ext}`;
            result = { blob, name, url: URL.createObjectURL(blob) };
            showResult(file, job);
            const took = Math.round((Date.now() - started) / 1000);
            setStatus(`Done in ${formatClock(took)}. Your file is ready to download.`);
        } catch (err) {
            if (err.message === 'cancelled' || cancelled) {
                setStatus('Cancelled.');
            } else {
                setStatus(err.message || 'Something went wrong.');
                if (/memory/i.test(err.message || '')) {
                    // The wasm heap is unusable after running out of memory: start fresh next time
                    killEngine();
                    if (current) current.input = null;
                }
            }
        } finally {
            busy = false;
            progressWrap.hidden = true;
            updateRunState();
        }
    }

    function showResult(file, job) {
        const savings = Math.round((1 - result.blob.size / file.size) * 100);
        resultSizes.innerHTML = `
            <span>${formatBytes(file.size)}</span><span class="size-arrow">→</span><strong>${formatBytes(result.blob.size)}</strong>
            <span class="savings-value ${savings > 0 ? 'is-positive' : savings < 0 ? 'is-negative' : ''}">${savings > 0 ? `−${savings}%` : savings < 0 ? `+${Math.abs(savings)}%` : '0%'}</span>`;
        if (job.mime.startsWith('video/')) {
            resultMedia.innerHTML = `<video src="${result.url}" controls playsinline preload="metadata"></video>`;
            const v = resultMedia.querySelector('video');
            v.addEventListener('error', () => { resultMedia.innerHTML = '<p class="setting-hint">Preview is not available for this format in your browser, but the file is ready.</p>'; });
        } else if (job.mime.startsWith('audio/')) {
            resultMedia.innerHTML = `<audio src="${result.url}" controls preload="metadata"></audio>`;
        } else {
            resultMedia.innerHTML = `<img src="${result.url}" alt="Your GIF">`;
        }
        $('videoResultName').innerText = result.name;
        const note = tool.note ? tool.note(result, file) : '';
        resultNote.hidden = !note;
        resultNote.innerText = note;
        resultWrap.hidden = false;
        resultWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    runBtn.addEventListener('click', run);
    cancelBtn.addEventListener('click', () => {
        if (!busy) return;
        cancelled = true;
        killEngine();
        if (current) current.input = null;
    });
    downloadBtn.addEventListener('click', () => { if (result) triggerDownload(result.blob, result.name); });
    $('videoChange').addEventListener('click', () => { if (!busy) fileInput.click(); });
    $('videoAgain').addEventListener('click', () => {
        clearResult();
        workspace.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    // Changing a setting after a run hides the old result so it is never mistaken for the new one
    root.querySelector('.settings-section').addEventListener('change', () => { if (!busy) clearResult(); });
    // Settings marked data-show-when="controlId:value1,value2" only appear for those values
    function updateConditional() {
        root.querySelectorAll('[data-show-when]').forEach(el => {
            const [id, values] = el.dataset.showWhen.split(':');
            const control = $(id);
            const value = control && control.classList.contains('chip-group') ? chipValue(id, '') : valueOf(id, '');
            el.hidden = !values.split(',').includes(value);
        });
    }
    root.querySelectorAll('.settings-section .chip-group').forEach(group => {
        bindChipGroup(group, () => { if (!busy) clearResult(); updateConditional(); });
    });
    root.querySelector('.settings-section').addEventListener('change', updateConditional);
    updateConditional();

    // Preset chips that fill a number input (e.g. target size)
    root.querySelectorAll('[data-fill]').forEach(group => {
        const input = $(group.dataset.fill);
        group.querySelectorAll('[data-value]').forEach(btn => btn.addEventListener('click', () => {
            input.value = btn.dataset.value;
            if (!busy) clearResult();
        }));
    });

    window.addEventListener('beforeunload', (e) => {
        if (busy) { e.preventDefault(); e.returnValue = ''; }
    });

    const accepts = root.dataset.accept === 'audio'
        ? f => f.type.startsWith('video/') || f.type.startsWith('audio/') || /\.(mkv|avi|mov|flv|wmv|3gp|ts|m4a|mp3|wav|ogg|flac)$/i.test(f.name)
        : f => f.type.startsWith('video/') || /\.(mkv|avi|mov|flv|wmv|3gp|ts|m4v)$/i.test(f.name);
    bindToolDropZone(dropZone, fileInput, files => openFile(files[0]), accepts);

    // Expose the formatter for the page's timeline script
    window.videoFormatClock = formatClock;
})();

// ==========================================================================
// 5. TIMELINE CONTROLS (Trim Video and Video to GIF)
// ==========================================================================

(function initVideoTimeline() {
    const root = document.getElementById('videoTool');
    if (!root || !['trim', 'gif'].includes(root.dataset.tool)) return;
    const $ = id => document.getElementById(id);
    const fmt = (s) => (window.videoFormatClock ? window.videoFormatClock(s, 1) : s.toFixed(1));
    const isTrim = root.dataset.tool === 'trim';
    const startEl = $(isTrim ? 'vtStart' : 'vgStart');
    const endEl = isTrim ? $('vtEnd') : $('vgLength');
    const startText = $(isTrim ? 'vtStartText' : 'vgStartText');
    const endText = $(isTrim ? 'vtEndText' : 'vgLengthText');
    const summary = $(isTrim ? 'vtSummary' : 'vgSummary');
    const GIF_MAX = 30;
    let duration = 0;
    let video = null;

    function sync(changed) {
        let start = Number(startEl.value);
        let end = Number(endEl.value);
        if (isTrim) {
            if (end <= start + 0.1) {
                if (changed === startEl) end = Math.min(duration, start + 0.1);
                else start = Math.max(0, end - 0.1);
            }
            startEl.value = start;
            endEl.value = end;
            startText.innerText = fmt(start);
            endText.innerText = fmt(end);
            summary.innerText = `New length: ${fmt(end - start)} of ${fmt(duration)}`;
        } else {
            const length = Math.min(end, Math.max(0.1, duration - start));
            startText.innerText = fmt(start);
            endText.innerText = `${length.toFixed(1)} s`;
            summary.innerText = `GIF covers ${fmt(start)} to ${fmt(start + length)}`;
        }
    }

    function seek(time) {
        if (video && !video.hidden && isFinite(time)) {
            try { video.currentTime = time; } catch (e) { /* not seekable yet */ }
        }
    }

    window.videoTimelineInit = (dur, videoEl) => {
        duration = dur;
        video = videoEl;
        startEl.max = dur;
        startEl.value = 0;
        if (isTrim) {
            endEl.max = dur;
            endEl.value = dur;
        } else {
            endEl.max = Math.min(GIF_MAX, Math.max(1, Math.ceil(dur)));
            endEl.value = Math.min(5, Number(endEl.max));
        }
        [startEl, endEl].forEach(el => { el.disabled = false; });
        root.querySelectorAll('[data-playhead]').forEach(btn => { btn.disabled = false; });
        sync();
    };

    startEl.addEventListener('input', () => { sync(startEl); seek(Number(startEl.value)); });
    endEl.addEventListener('input', () => {
        sync(endEl);
        seek(isTrim ? Number(endEl.value) : Number(startEl.value) + Number(endEl.value));
    });

    // "Use current frame" buttons
    root.querySelectorAll('[data-playhead]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!video || !duration) return;
            const t = Math.round(video.currentTime * 10) / 10;
            if (btn.dataset.playhead === 'start') {
                startEl.value = t;
                sync(startEl);
            } else {
                endEl.value = isTrim ? t : Math.max(0.5, t - Number(startEl.value));
                sync(endEl);
            }
            startEl.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });
})();
