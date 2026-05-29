/* ==========================================================================
   PicsConvert - Advanced Bulk Image Converter Engine (app.js)
   100% Local, Safe, and Optimized Browser Execution
   ========================================================================== */

// --- Global App State ---
let filesQueue = [];          // Queue array holding details of files to convert
let activeConversions = 0;    // Tracks count of active conversions in the pipeline
const CONCURRENT_LIMIT = 4;   // Max parallel image conversions to optimize CPU/Memory
let activeZip = typeof JSZip !== 'undefined' ? new JSZip() : null;  // JSZip instance for current batch
let aspectLocked = true;      // Lock aspect ratio flag for custom sizing

// --- UI Elements Cache (Main Tool Page) ---
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const previewsGrid = document.getElementById('previewsGrid');
const statsPanel = document.getElementById('statsPanel');
const statTotal = document.getElementById('stat-total');
const statProcessed = document.getElementById('stat-processed');
const statSavings = document.getElementById('stat-savings');
const downloadAllBtn = document.getElementById('downloadAllBtn');
const clearBtn = document.getElementById('clearBtn');
const queueStatus = document.getElementById('queue-status');
const aspectLockBtn = document.getElementById('aspectLock');
const widthInput = document.getElementById('width');
const heightInput = document.getElementById('height');
const formatSelect = document.getElementById('format');
const qualitySlider = document.getElementById('quality');
const qualityText = document.getElementById('qText');

// --- Modal Elements Cache ---
const sliderModal = document.getElementById('sliderModal');
const modalFilename = document.getElementById('modalFilename');
const imgOriginal = document.getElementById('imgOriginal');
const imgCompressed = document.getElementById('imgCompressed');
const afterContainer = document.getElementById('afterContainer');
const comparisonSlider = document.getElementById('comparisonSlider');
const sliderHandle = document.getElementById('sliderHandle');
const compOriginalSize = document.getElementById('compOriginalSize');
const compCompressedSize = document.getElementById('compCompressedSize');
const sliderContainer = document.getElementById('sliderContainer');

// ==========================================================================
// 1. THEME CONTROLLER (Shared Across All Pages)
// ==========================================================================

function setThemeMode(mode) {
    localStorage.setItem("themeMode", mode);
    applyActiveTheme();
    highlightThemeButtons();
}

function applyActiveTheme() {
    const mode = localStorage.getItem("themeMode") || "system";
    if (mode === "dark") {
        document.documentElement.classList.add("dark");
    } else if (mode === "light") {
        document.documentElement.classList.remove("dark");
    } else {
        // System Theme Matching
        if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
            document.documentElement.classList.add("dark");
        } else {
            document.documentElement.classList.remove("dark");
        }
    }
}

function highlightThemeButtons() {
    const mode = localStorage.getItem("themeMode") || "system";
    const systemBtn = document.getElementById('systemBtn');
    const lightBtn = document.getElementById('lightBtn');
    const darkBtn = document.getElementById('darkBtn');

    if (!systemBtn || !lightBtn || !darkBtn) return; // Guard for pages without toggles

    [systemBtn, lightBtn, darkBtn].forEach(btn => btn.classList.remove('active'));

    if (mode === "dark") darkBtn.classList.add("active");
    else if (mode === "light") lightBtn.classList.add("active");
    else systemBtn.classList.add("active");
}

// Watch system theme changes in real-time
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (localStorage.getItem("themeMode") === "system") {
        applyActiveTheme();
    }
});

// Initialize Theme
applyActiveTheme();
highlightThemeButtons();

// ==========================================================================
// 2. COMPLIANCE & ACCORDION EVENTS (Shared & Safe)
// ==========================================================================

function toggleFaq(button) {
    const faqItem = button.parentElement;
    const content = faqItem.querySelector('.faq-content');
    
    // Toggle active status
    const isActive = faqItem.classList.contains('active');
    
    // Close all FAQs first (Accordion effect)
    document.querySelectorAll('.faq-item').forEach(item => {
        item.classList.remove('active');
        item.querySelector('.faq-content').style.maxHeight = null;
    });

    if (!isActive) {
        faqItem.classList.add('active');
        content.style.maxHeight = content.scrollHeight + "px";
    }
}

// ==========================================================================
// 3. TOOL INTERACTIONS & CONFIGURATIONS
// ==========================================================================

if (qualitySlider && qualityText) {
    qualitySlider.addEventListener('input', () => {
        qualityText.innerText = Math.round(qualitySlider.value * 100) + "%";
    });
    // Re-process on quality change release
    qualitySlider.addEventListener('change', reprocessAllImages);
}

// Show/Hide compression slider based on output format and re-process queue
if (formatSelect) {
    formatSelect.addEventListener('change', () => {
        const compressionWrap = document.getElementById('compression-control-wrap');
        if (compressionWrap) {
            if (formatSelect.value === 'png') {
                compressionWrap.style.opacity = '0.4';
                compressionWrap.style.pointerEvents = 'none';
            } else {
                compressionWrap.style.opacity = '1';
                compressionWrap.style.pointerEvents = 'auto';
            }
        }
        reprocessAllImages();
    });
}

if (aspectLockBtn) {
    aspectLockBtn.addEventListener('click', () => {
        aspectLocked = !aspectLocked;
        if (aspectLocked) {
            aspectLockBtn.classList.add('locked');
            aspectLockBtn.innerText = '🔒';
            aspectLockBtn.title = 'Lock Aspect Ratio (Proportional)';
        } else {
            aspectLockBtn.classList.remove('locked');
            aspectLockBtn.innerText = '🔓';
            aspectLockBtn.title = 'Unlock Aspect Ratio (Free Resizing)';
        }
        
        // If dimensions are set, reprocess under the new lock setting
        if ((widthInput && widthInput.value) || (heightInput && heightInput.value)) {
            reprocessAllImages();
        }
    });
}

// Re-process when sizing inputs change
if (widthInput) {
    widthInput.addEventListener('change', reprocessAllImages);
}
if (heightInput) {
    heightInput.addEventListener('change', reprocessAllImages);
}

// ==========================================================================
// 4. BATCH PROCESSING PIPELINE (DRAG & DROP + INPUT)
// ==========================================================================

if (dropZone && fileInput) {
    // Click triggers hidden input
    dropZone.addEventListener('click', () => fileInput.click());

    // Drag-and-drop animations
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        
        const items = e.dataTransfer.items;
        if (items) {
            handleDirectoryAndFilesDrop(items);
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            addFilesToQueue(e.target.files);
        }
    });
}

// Queue Traversal Counter to handle async directory parsing securely
let loadingFilesCount = 0;

function handleDirectoryAndFilesDrop(items) {
    loadingFilesCount = 0;
    queueStatus.innerText = "Scanning dropped files...";
    
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
            const entry = item.webkitGetAsEntry();
            if (entry) {
                loadingFilesCount++;
                traverseEntry(entry);
            }
        }
    }
    
    // Safety fallback if loadingFilesCount stays 0
    if (loadingFilesCount === 0) {
        queueStatus.innerText = "No files found";
    }
}

function traverseEntry(entry, path = "") {
    if (entry.isFile) {
        entry.file(file => {
            file.fullPath = path + file.name;
            addFilesToQueue([file]);
            loadingFilesCount--;
            checkScanningFinished();
        }, () => {
            loadingFilesCount--;
            checkScanningFinished();
        });
    } else if (entry.isDirectory) {
        const dirReader = entry.createReader();
        loadingFilesCount++; // Increment for children scans
        
        readAllDirectoryEntries(dirReader, (entries) => {
            loadingFilesCount += entries.length;
            entries.forEach(childEntry => {
                traverseEntry(childEntry, path + entry.name + "/");
            });
            loadingFilesCount--; // Finished this directory
            checkScanningFinished();
        });
    }
}

function readAllDirectoryEntries(dirReader, callback) {
    let entries = [];
    function readEntriesBatch() {
        dirReader.readEntries(results => {
            if (!results.length) {
                callback(entries);
            } else {
                entries = entries.concat(Array.from(results));
                readEntriesBatch();
            }
        });
    }
    readEntriesBatch();
}

function checkScanningFinished() {
    if (loadingFilesCount <= 0) {
        queueStatus.innerText = "Scanning complete. Processing images...";
    }
}

// Add scanned files to Queue securely
function addFilesToQueue(files) {
    if (files.length === 0) return;

    // Show Stats Panel & Buttons
    if (statsPanel) statsPanel.style.display = 'flex';
    if (clearBtn) clearBtn.disabled = false;

    Array.from(files).forEach(file => {
        // Double security check to filter non-images
        if (!file.type.startsWith('image/')) return;

        const id = 'img_' + Math.random().toString(36).substr(2, 9);
        const originalPath = file.fullPath || file.webkitRelativePath || file.name;
        const cleanName = file.name.replace(/\.[^/.]+$/, "");
        
        const queueItem = {
            id: id,
            file: file,
            originalPath: originalPath,
            cleanName: cleanName,
            status: 'pending',
            originalSize: file.size,
            compressedSize: 0,
            previewUrl: null,
            blob: null
        };

        filesQueue.push(queueItem);
        createPreviewCardElement(queueItem);
    });

    updateQueueOverviewStats();
    processConversionQueue();
}

// ==========================================================================
// 5. RENDER UTILITIES & PREVIEW CARDS
// ==========================================================================

// Escape HTML strings to protect against XSS injections from malicious file names
function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
}

function createPreviewCardElement(item) {
    if (!previewsGrid) return;

    const col = document.createElement('div');
    col.className = 'preview-card';
    col.id = `card_${item.id}`;

    col.innerHTML = `
        <div class="preview-card-image-wrap">
            <div class="card-loader" id="loader_${item.id}">
                <div class="spinner"></div>
                <span class="drop-subtitle">Optimizing...</span>
            </div>
            <img id="img_${item.id}" src="" style="display: none;" alt="Preview image">
        </div>
        <div class="preview-card-details">
            <div class="preview-card-header">
                <span class="file-name" title="${escapeHTML(item.file.name)}">${escapeHTML(item.cleanName)}</span>
                <span class="format-pill" id="badge_${item.id}">Pending</span>
            </div>
            <div class="size-comparison" id="sizes_${item.id}">
                <span>Waiting in queue...</span>
            </div>
            <div class="card-actions">
                <button class="card-btn card-btn-download" id="dl_${item.id}" disabled>
                    <span>Download</span>
                </button>
                <button class="card-btn card-btn-compare" id="comp_${item.id}" style="display: none;">
                    <span>Compare</span>
                </button>
                <button class="card-btn card-btn-delete" onclick="removeItemFromQueue('${item.id}')" title="Remove File">
                    &times;
                </button>
            </div>
        </div>
    `;

    previewsGrid.appendChild(col);
}

// Updates aggregate statistics (Total, Processed, Percentage Saved)
function updateQueueOverviewStats() {
    if (!statTotal || !statProcessed || !statSavings) return;

    const total = filesQueue.length;
    const processed = filesQueue.filter(f => f.status === 'done' || f.status === 'error').length;
    
    statTotal.innerText = total;
    statProcessed.innerText = processed;

    // Calculate aggregate savings
    let totalOriginalSize = 0;
    let totalCompressedSize = 0;
    
    filesQueue.forEach(item => {
        if (item.status === 'done' && item.compressedSize > 0) {
            totalOriginalSize += item.originalSize;
            totalCompressedSize += item.compressedSize;
        }
    });

    if (totalOriginalSize > 0) {
        const savings = Math.max(0, Math.round((1 - (totalCompressedSize / totalOriginalSize)) * 100));
        statSavings.innerText = `${savings}%`;
    } else {
        statSavings.innerText = "0%";
    }
}

// ==========================================================================
// 6. PIPELINE WORKER LOOP & CANVAS COMPRESSION
// ==========================================================================

function processConversionQueue() {
    if (filesQueue.length === 0) return;

    // Trigger parallel operations up to limit
    while (activeConversions < CONCURRENT_LIMIT) {
        const nextItem = filesQueue.find(item => item.status === 'pending');
        if (!nextItem) break; // No pending items left

        activeConversions++;
        nextItem.status = 'processing';
        convertImageCore(nextItem);
    }
}

// Core client-side browser image encoding
function convertImageCore(item) {
    const reader = new FileReader();

    reader.onerror = () => {
        markItemAsFailed(item, "Failed reading file");
    };

    reader.onload = (e) => {
        const img = new Image();

        img.onerror = () => {
            markItemAsFailed(item, "Corrupt image format");
        };

        img.onload = () => {
            try {
                // 1. Calculate sizing based on custom inputs and Aspect Lock rules
                let targetW = widthInput.value ? parseInt(widthInput.value) : null;
                let targetH = heightInput.value ? parseInt(heightInput.value) : null;

                if (aspectLocked) {
                    if (targetW && !targetH) {
                        targetH = Math.round((img.height / img.width) * targetW);
                    } else if (targetH && !targetW) {
                        targetW = Math.round((img.width / img.height) * targetH);
                    } else if (targetW && targetH) {
                        // Fit inside custom box maintaining original aspect ratio
                        const ratio = Math.min(targetW / img.width, targetH / img.height);
                        targetW = Math.round(img.width * ratio);
                        targetH = Math.round(img.height * ratio);
                    } else {
                        targetW = img.width;
                        targetH = img.height;
                    }
                } else {
                    targetW = targetW || img.width;
                    targetH = targetH || img.height;
                }

                // Create offscreen canvas for resizing & conversion
                const canvas = document.createElement("canvas");
                canvas.width = targetW;
                canvas.height = targetH;

                const ctx = canvas.getContext("2d");
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = "high";

                // Handle transparency drawing for JPEGs (which turn black on blank alpha)
                const targetFormat = formatSelect.value;
                if (targetFormat === 'jpeg') {
                    ctx.fillStyle = "#ffffff";
                    ctx.fillRect(0, 0, targetW, targetH);
                }

                ctx.drawImage(img, 0, 0, targetW, targetH);

                // Set MIME conversion types
                let mime = "image/webp";
                if (targetFormat === 'png') mime = "image/png";
                if (targetFormat === 'jpeg') mime = "image/jpeg";

                // Intelligent compression Quality levels (Quality is overridden for big files)
                let quality = parseFloat(qualitySlider.value);
                if (item.file.size > 3000000) quality = Math.max(0.65, quality - 0.15); // >3MB: drop quality slightly
                if (item.file.size > 8000000) quality = Math.max(0.5, quality - 0.25);  // >8MB: drop quality further
                
                // canvas.toBlob yields real-time compression blob natively
                canvas.toBlob((blob) => {
                    if (!blob) {
                        markItemAsFailed(item, "Encoding failed");
                        return;
                    }

                    // Store results
                    item.status = 'done';
                    item.compressedSize = blob.size;
                    item.blob = blob;
                    item.previewUrl = URL.createObjectURL(blob);

                    // Add converted file directly to active Zip archive preserving paths
                    const ext = targetFormat;
                    const pathParts = item.originalPath.split('/');
                    const originalBaseName = pathParts[pathParts.length - 1];
                    const cleanBaseName = originalBaseName.replace(/\.[^/.]+$/, "");
                    
                    // Reassemble nested relative directory path inside ZIP
                    pathParts[pathParts.length - 1] = `${cleanBaseName}.${ext}`;
                    const targetZipPath = pathParts.join('/');

                    if (activeZip) activeZip.file(targetZipPath, blob);

                    // Update Card Graphics in UI
                    renderConversionSuccessUI(item);
                    finalizeLoopStep();
                }, mime, quality);

            } catch (err) {
                markItemAsFailed(item, "Canvas crash");
            }
        };

        img.src = e.target.result;
    };

    reader.readAsDataURL(item.file);
}

function markItemAsFailed(item, errorText) {
    item.status = 'error';
    const card = document.getElementById(`card_${item.id}`);
    const loader = document.getElementById(`loader_${item.id}`);
    const sizes = document.getElementById(`sizes_${item.id}`);
    const badge = document.getElementById(`badge_${item.id}`);

    if (loader) loader.style.opacity = '0';
    setTimeout(() => { if (loader) loader.style.display = 'none'; }, 200);

    if (badge) {
        badge.innerText = "FAILED";
        badge.style.backgroundColor = "var(--danger-light)";
        badge.style.color = "var(--danger)";
    }
    if (sizes) sizes.innerText = errorText;
    if (card) card.style.borderColor = "var(--danger)";

    finalizeLoopStep();
}

function renderConversionSuccessUI(item) {
    const card = document.getElementById(`card_${item.id}`);
    const loader = document.getElementById(`loader_${item.id}`);
    const imgEl = document.getElementById(`img_${item.id}`);
    const badge = document.getElementById(`badge_${item.id}`);
    const sizes = document.getElementById(`sizes_${item.id}`);
    const dlBtn = document.getElementById(`dl_${item.id}`);
    const compBtn = document.getElementById(`comp_${item.id}`);

    // Hide loader
    if (loader) {
        loader.style.opacity = '0';
        setTimeout(() => { loader.style.display = 'none'; }, 200);
    }

    // Bind Preview source
    if (imgEl) {
        imgEl.src = item.previewUrl;
        imgEl.style.display = 'block';
    }

    // Set Format Badge
    const currentExt = formatSelect.value.toUpperCase();
    if (badge) {
        badge.innerText = currentExt;
        badge.style.backgroundColor = "var(--success-light)";
        badge.style.color = "var(--success)";
    }

    // Display Exact Binary size comparison
    const sizeBeforeKB = (item.originalSize / 1024).toFixed(1);
    const sizeAfterKB = (item.compressedSize / 1024).toFixed(1);
    const savings = Math.round((1 - (item.compressedSize / item.originalSize)) * 100);

    if (sizes) {
        let savingsBadgeHTML = '';
        if (savings > 0) {
            savingsBadgeHTML = `<span class="savings-badge">Saved ${savings}%</span>`;
        } else if (savings < 0) {
            savingsBadgeHTML = `<span class="savings-badge negative">Bloat +${Math.abs(savings)}%</span>`;
        } else {
            savingsBadgeHTML = `<span class="savings-badge" style="background-color: var(--border); color: var(--text-secondary);">0% Change</span>`;
        }

        sizes.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:0.25rem; width:100%;">
                <div>${sizeBeforeKB} KB → <strong>${sizeAfterKB} KB</strong></div>
                <div>${savingsBadgeHTML}</div>
            </div>
        `;
    }

    // Bind individual actions
    if (dlBtn) {
        dlBtn.disabled = false;
        dlBtn.onclick = () => {
            const tempA = document.createElement('a');
            tempA.href = item.previewUrl;
            tempA.download = `${item.cleanName}.${formatSelect.value}`;
            tempA.click();
        };
    }

    if (compBtn) {
        compBtn.style.display = 'flex';
        compBtn.onclick = () => openComparisonModal(item);
    }
}

// Finalizes thread increment and updates aggregate status
function finalizeLoopStep() {
    activeConversions--;
    updateQueueOverviewStats();

    const pendingCount = filesQueue.filter(f => f.status === 'pending').length;
    const processingCount = filesQueue.filter(f => f.status === 'processing').length;

    if (pendingCount > 0 || processingCount > 0) {
        queueStatus.innerText = `Optimizing... (${pendingCount} remaining)`;
        processConversionQueue();
    } else {
        queueStatus.innerText = "All images processed successfully!";
        if (downloadAllBtn) downloadAllBtn.disabled = false;
    }
}

// Remove single preview element & clean files
function removeItemFromQueue(id) {
    const card = document.getElementById(`card_${id}`);
    if (card) {
        card.style.opacity = '0';
        card.style.transform = 'scale(0.9)';
        setTimeout(() => card.remove(), 250);
    }

    const itemIndex = filesQueue.findIndex(f => f.id === id);
    if (itemIndex > -1) {
        const item = filesQueue[itemIndex];
        
        // Clean memory object URLs
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        
        // Remove from Zip
        const ext = formatSelect.value;
        const pathParts = item.originalPath.split('/');
        const originalBaseName = pathParts[pathParts.length - 1];
        const cleanBaseName = originalBaseName.replace(/\.[^/.]+$/, "");
        pathParts[pathParts.length - 1] = `${cleanBaseName}.${ext}`;
        const targetZipPath = pathParts.join('/');
        
        if (activeZip) activeZip.remove(targetZipPath);
        
        // Remove from memory queue
        filesQueue.splice(itemIndex, 1);
    }

    updateQueueOverviewStats();

    if (filesQueue.length === 0) {
        clearConverterAll();
    }
}

// ==========================================================================
// 7. COMPRESSION ZIP ARCHIVER
// ==========================================================================

function downloadAllZip() {
    if (filesQueue.length === 0) return;

    // Dynamically initialize activeZip if JSZip has loaded after the page initialization
    if (!activeZip && typeof JSZip !== 'undefined') {
        activeZip = new JSZip();
        // Re-populate the zip from already converted files in queue
        filesQueue.forEach(item => {
            if (item.status === 'done' && item.blob) {
                const ext = formatSelect.value;
                const pathParts = item.originalPath.split('/');
                const originalBaseName = pathParts[pathParts.length - 1];
                const cleanBaseName = originalBaseName.replace(/\.[^/.]+$/, "");
                
                pathParts[pathParts.length - 1] = `${cleanBaseName}.${ext}`;
                const targetZipPath = pathParts.join('/');
                activeZip.file(targetZipPath, item.blob);
            }
        });
    }

    if (!activeZip) {
        queueStatus.innerText = "ZIP library failed to load. Please check your network connection.";
        console.error("PicsConvert Error: JSZip is not loaded or blocked by browser SRI.");
        alert("The ZIP download feature requires the JSZip library, which failed to load. This can happen if you are offline or if the CDN is blocked by your browser/network.");
        return;
    }
    
    queueStatus.innerText = "Creating compressed ZIP bundle...";
    downloadAllBtn.disabled = true;

    activeZip.generateAsync({ type: "blob" })
        .then(zipBlob => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(zipBlob);
            a.download = `PicsConvert_Optimized_${formatSelect.value}.zip`;
            a.click();
            
            queueStatus.innerText = "ZIP Archive downloaded successfully!";
            downloadAllBtn.disabled = false;
        })
        .catch(() => {
            queueStatus.innerText = "Zipping failed";
            downloadAllBtn.disabled = false;
        });
}

function clearConverterAll() {
    // Revoke memory allocations
    filesQueue.forEach(item => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });

    filesQueue = [];
    activeConversions = 0;
    activeZip = typeof JSZip !== 'undefined' ? new JSZip() : null;

    if (previewsGrid) previewsGrid.innerHTML = "";
    if (statsPanel) statsPanel.style.display = 'none';
    if (downloadAllBtn) downloadAllBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    if (fileInput) fileInput.value = "";
    if (queueStatus) queueStatus.innerText = "Ready for upload";
}

// Re-process all images already in the queue when conversion parameters change
function reprocessAllImages() {
    if (filesQueue.length === 0) return;

    queueStatus.innerText = "Re-optimizing images with new settings...";
    if (downloadAllBtn) downloadAllBtn.disabled = true;

    // Reset ZIP since we are encoding new files
    activeZip = typeof JSZip !== 'undefined' ? new JSZip() : null;

    filesQueue.forEach(item => {
        item.status = 'pending';
        item.compressedSize = 0;
        if (item.previewUrl) {
            URL.revokeObjectURL(item.previewUrl);
            item.previewUrl = null;
        }
        item.blob = null;

        // Reset elements of card to loading state
        const loader = document.getElementById(`loader_${item.id}`);
        const imgEl = document.getElementById(`img_${item.id}`);
        const badge = document.getElementById(`badge_${item.id}`);
        const sizes = document.getElementById(`sizes_${item.id}`);
        const dlBtn = document.getElementById(`dl_${item.id}`);
        const compBtn = document.getElementById(`comp_${item.id}`);

        if (loader) {
            loader.style.display = 'flex';
            loader.style.opacity = '1';
        }
        if (imgEl) imgEl.style.display = 'none';
        if (badge) {
            badge.innerText = "Recoding...";
            badge.style.backgroundColor = "var(--bg-base)";
            badge.style.color = "var(--text-secondary)";
        }
        if (sizes) sizes.innerHTML = "<span>Queued...</span>";
        if (dlBtn) dlBtn.disabled = true;
        if (compBtn) compBtn.style.display = 'none';
    });

    activeConversions = 0;
    updateQueueOverviewStats();
    processConversionQueue();
}

// ==========================================================================
// 8. INTERACTIVE BEFORE/AFTER SLIDER LIGHTBOX CONTROLS
// ==========================================================================

let activeOriginalUrl = null;

function openComparisonModal(item) {
    if (!sliderModal) return;

    modalFilename.innerText = `${item.file.name} — Compression Check`;
    
    // Revoke previous comparison image URL to avoid memory leaks
    if (activeOriginalUrl) {
        URL.revokeObjectURL(activeOriginalUrl);
    }

    // Allocate temporary object URL for raw comparison
    activeOriginalUrl = URL.createObjectURL(item.file);
    imgOriginal.src = activeOriginalUrl;
    imgCompressed.src = item.previewUrl;

    // Sizes
    compOriginalSize.innerText = (item.originalSize / 1024).toFixed(1) + " KB";
    compCompressedSize.innerText = (item.compressedSize / 1024).toFixed(1) + " KB";

    // Set initial 50% slider split
    afterContainer.style.clipPath = `polygon(0 0, 50% 0, 50% 100%, 0% 100%)`;
    comparisonSlider.style.left = `50%`;

    // Open Lighbox
    sliderModal.classList.add('active');

    // Bind slider mouse & touch events
    setupVisualSliderEvents();
}

function closeComparisonModal() {
    if (!sliderModal) return;
    sliderModal.classList.remove('active');
    
    if (activeOriginalUrl) {
        URL.revokeObjectURL(activeOriginalUrl);
        activeOriginalUrl = null;
    }
}

function setupVisualSliderEvents() {
    let isDragging = false;

    // Common position parsing
    function moveSlider(clientX) {
        const rect = sliderContainer.getBoundingClientRect();
        const relativeX = clientX - rect.left;
        let percentage = (relativeX / rect.width) * 100;

        // Constraints
        percentage = Math.max(0, Math.min(100, percentage));

        // Adjust clip path dynamically
        afterContainer.style.clipPath = `polygon(0 0, ${percentage}% 0, ${percentage}% 100%, 0% 100%)`;
        comparisonSlider.style.left = `${percentage}%`;
    }

    // Desktop Mouse Drag
    sliderContainer.onmousedown = (e) => {
        isDragging = true;
        moveSlider(e.clientX);
    };

    window.onmousemove = (e) => {
        if (!isDragging) return;
        moveSlider(e.clientX);
    };

    window.onmouseup = () => {
        isDragging = false;
    };

    // Mobile Touch Drag
    sliderContainer.ontouchstart = (e) => {
        isDragging = true;
        moveSlider(e.touches[0].clientX);
    };

    window.ontouchmove = (e) => {
        if (!isDragging) return;
        moveSlider(e.touches[0].clientX);
    };

    window.ontouchend = () => {
        isDragging = false;
    };
}

// ==========================================================================
// 9. DYNAMIC COOKIE CONSENT BANNER CONTROLLER
// ==========================================================================

function initCookieConsent() {
    // If choice already made, don't show the banner
    if (localStorage.getItem("cookieConsent")) return;

    // Create container
    const banner = document.createElement("div");
    banner.className = "cookie-banner";
    banner.id = "cookieBanner";

    banner.innerHTML = `
        <div class="cookie-header">
            <span class="cookie-icon">🍪</span>
            <div class="cookie-title">Cookie Preference</div>
        </div>
        <p class="cookie-text">
            We use cookies to analyze site traffic, personalize content, and serve relevant advertisements through Google AdSense. By clicking "Accept All", you consent to our use of these cookies. Learn more in our <a href="privacy.html" style="text-decoration: underline; font-weight: 600; color: var(--primary);">Privacy Policy</a>.
        </p>
        <div class="cookie-actions">
            <button class="cookie-btn cookie-btn-reject" onclick="handleCookieChoice('rejected')">Reject</button>
            <button class="cookie-btn cookie-btn-accept" onclick="handleCookieChoice('accepted')">Accept All</button>
        </div>
    `;

    document.body.appendChild(banner);

    // Slide up animation after a slight delay
    setTimeout(() => {
        banner.classList.add("show");
    }, 1000);
}

function handleCookieChoice(choice) {
    localStorage.setItem("cookieConsent", choice);
    const banner = document.getElementById("cookieBanner");
    if (banner) {
        banner.classList.remove("show");
        // Remove from DOM after transition finishes
        setTimeout(() => {
            banner.remove();
        }, 500);
    }
}

// Auto-run cookie consent check
initCookieConsent();
