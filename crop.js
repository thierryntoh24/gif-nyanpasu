/**
 * GIF Nyanpasu! — crop.js
 *
 * Architecture:
 *   ImageEntry    — data model for one image file
 *   VideoEntry    — data model for one video file
 *   MediaCropper  — main application class
 *
 * Depends on shared.js (clamp, saveSetting) and JSZip (loaded via CDN).
 *
 * Key design decisions:
 *   - The crop overlay is sized and positioned to sit exactly over the
 *     preview element (canvas or video) using getBoundingClientRect(),
 *     not the full wrapper. Critical for centered/portrait media.
 *   - Video preview uses a <video> element directly; no canvas needed
 *     until the actual crop runs.
 *   - Video cropping uses MediaRecorder + captureStream() on an
 *     off-screen canvas that draws cropped frames in real time.
 *   - previewUrl is stored per-entry and never revoked by the overlay
 *     close handler, preventing broken card thumbnails on re-open.
 *   - "Download All" zips everything via JSZip into one file.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Compute the fitted display size for a media element inside a wrapper,
 * respecting both the wrapper width and a max-height cap.
 * @param {number} naturalW
 * @param {number} naturalH
 * @param {number} wrapW   - wrapper client width in px
 * @param {number} maxH    - max display height in px
 * @returns {{ w: number, h: number }}
 */
function fitSize(naturalW, naturalH, wrapW, maxH) {
    const byWidth = { w: wrapW, h: Math.round(naturalH * (wrapW / naturalW)) };
    const byHeight = { h: maxH, w: Math.round(naturalW * (maxH / naturalH)) };
    return byWidth.h <= maxH ? byWidth : byHeight;
}

/** Map a MIME type to a file extension. */
function mimeToExt(mime) {
    return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mime] ?? 'png';
}


/* ═══════════════════════════════════════════════════════════════════
   IMAGE ENTRY
   ═══════════════════════════════════════════════════════════════════ */
class ImageEntry {
    constructor(file, objectUrl, naturalW, naturalH) {
        this.file = file;
        this.objectUrl = objectUrl;
        this.naturalW = naturalW;
        this.naturalH = naturalH;
        this.isVideo = false;
        /** Normalised crop region (0-1 ratios). Persists across selection changes. */
        this.region = { x: 0, y: 0, w: 1, h: 1 };
        /** Cropped result Blob, set after _cropEntry() runs. */
        this.cropped = null;
        /**
         * Object URL for the cropped preview card.
         * Stored here so the overlay can reuse it without revoking it.
         */
        this.previewUrl = null;
        this.thumbUrl = null;
        /** Stable id used to key output card DOM nodes. */
        this.id = crypto.randomUUID();
    }

    /**
     * The crop region expressed in source image pixels.
     * @returns {{ x: number, y: number, w: number, h: number }}
     */
    get pixelRegion() {
        return {
            x: Math.round(this.region.x * this.naturalW),
            y: Math.round(this.region.y * this.naturalH),
            w: Math.max(1, Math.round(this.region.w * this.naturalW)),
            h: Math.max(1, Math.round(this.region.h * this.naturalH)),
        };
    }
}


/* ═══════════════════════════════════════════════════════════════════
   VIDEO ENTRY
   ═══════════════════════════════════════════════════════════════════ */
class VideoEntry {
    constructor(file, objectUrl, naturalW, naturalH, duration) {
        this.file = file;
        this.objectUrl = objectUrl;
        this.naturalW = naturalW;
        this.naturalH = naturalH;
        this.duration = duration;
        this.isVideo = true;
        this.region = { x: 0, y: 0, w: 1, h: 1 };
        this.cropped = null;
        this.previewUrl = null;
        this.thumbUrl = null;
        this.id = crypto.randomUUID();
    }

    get pixelRegion() {
        return {
            x: Math.round(this.region.x * this.naturalW),
            y: Math.round(this.region.y * this.naturalH),
            w: Math.max(2, Math.round(this.region.w * this.naturalW)),
            h: Math.max(2, Math.round(this.region.h * this.naturalH)),
        };
    }
}


/* ═══════════════════════════════════════════════════════════════════
   MEDIA CROPPER
   ═══════════════════════════════════════════════════════════════════ */
class MediaCropper {
    constructor() {
        /** @type {ImageEntry[]} */
        this.entries = [];
        this.activeIndex = -1;
        /** null = free, or a number (w/h ratio) */
        this.aspectRatio = null;

        // Drag state
        this._dragging = false;
        this._handle = '';
        this._startX = 0;
        this._startY = 0;
        this._startRegion = null;
        this._resizeObs = null;

        this._bindElements();
        this._buildCropOverlay();
        this._bindEvents();
        this._updateVideoFormatNote();
    }

    /* ── DOM references ────────────────────────────────────────────── */
    _bindElements() {
        const $ = id => document.getElementById(id);
        this.el = {
            fileInput: $('fileInput'),
            dropZone: $('dropZone'),
            imageQueue: $('imageQueue'),
            canvasWrapper: $('canvasWrapper'),
            emptyPreview: $('emptyPreview'),
            sourceCanvas: $('sourceCanvas'),
            sourceVideo: $('sourceVideo'),
            aspectPresets: $('aspectPresets'),
            imageFormatGroup: $('imageFormatGroup'),
            formatSelect: $('formatSelect'),
            qualityInput: $('qualityInput'),
            qualityLabel: $('qualityLabel'),
            qualityGroup: $('qualityGroup'),
            cropReadout: $('cropReadout'),
            inX: $('inX'), inY: $('inY'), inW: $('inW'), inH: $('inH'),
            resetCropBtn: $('resetCropBtn'),
            cropBtn: $('cropBtn'),
            cropAllBtn: $('cropAllBtn'),
            clearAllBtn: $('clearAllBtn'),
            outputGrid: $('outputGrid'),
            emptyOutput: $('emptyOutput'),
            downloadAllBtn: $('downloadAllBtn'),
            previewOverlay: $('previewOverlay'),
            overlayImg: $('overlayImg'),
            processingBadge: $('processingBadge'),
            videoFormatGroup: $('videoFormatGroup'),
            videoFormatSelect: $('videoFormatSelect'),
            videoFormatNote: $('videoFormatNote'),
            cropProgressOverlay: $('cropProgressOverlay'),
            cropProgressStatus: $('cropProgressStatus'),
            cropProgressDetail: $('cropProgressDetail'),
            overlayVid: $('overlayVid'),
        };
    }

    /* ── Build drag-resize crop overlay ────────────────────────────── */
    _buildCropOverlay() {
        this._overlayEl = document.createElement('div');
        this._overlayEl.className = 'crop-overlay';

        this._regionEl = document.createElement('div');
        this._regionEl.className = 'crop-region';

        // Eight handles: corners + edge midpoints
        ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'].forEach(pos => {
            const h = document.createElement('div');
            h.className = `crop-handle ${pos}`;
            this._regionEl.appendChild(h);
        });

        this._overlayEl.appendChild(this._regionEl);

        // Move drag (clicking directly on the region body)
        this._regionEl.addEventListener('mousedown', e => {
            if (e.target === this._regionEl) {
                this._dragStart(e.clientX, e.clientY, 'move');
                e.preventDefault();
            }
        });
        this._regionEl.addEventListener('touchstart', e => {
            if (e.target === this._regionEl) {
                this._dragStart(e.touches[0].clientX, e.touches[0].clientY, 'move');
                e.preventDefault();
            }
        }, { passive: false });

        this._regionEl.querySelectorAll('.crop-handle').forEach(h => {
            const kind = h.className.split(' ')[1];
            h.addEventListener('mousedown', e => {
                this._dragStart(e.clientX, e.clientY, kind);
                e.stopPropagation(); e.preventDefault();
            });
            h.addEventListener('touchstart', e => {
                this._dragStart(e.touches[0].clientX, e.touches[0].clientY, kind);
                e.stopPropagation(); e.preventDefault();
            }, { passive: false });
        });

        document.addEventListener('mousemove', e => this._dragMove(e.clientX, e.clientY));
        document.addEventListener('mouseup', () => this._dragEnd());
        document.addEventListener('touchmove', e => {
            if (this._dragging) {
                this._dragMove(e.touches[0].clientX, e.touches[0].clientY);
                e.preventDefault();
            }
        }, { passive: false });
        document.addEventListener('touchend', () => this._dragEnd());
    }

    /* ── Event wiring ──────────────────────────────────────────────── */
    _bindEvents() {
        this.el.fileInput.addEventListener('change', e => this._addFiles(e.target.files));
        this.el.dropZone.addEventListener('click', () => this.el.fileInput.click());
        this.el.dropZone.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') this.el.fileInput.click();
        });
        this.el.dropZone.addEventListener('dragover', e => {
            e.preventDefault();
            this.el.dropZone.classList.add('drag-over');
        });
        this.el.dropZone.addEventListener('dragleave', () => {
            this.el.dropZone.classList.remove('drag-over');
        });
        this.el.dropZone.addEventListener('drop', e => {
            e.preventDefault();
            this.el.dropZone.classList.remove('drag-over');
            this._addFiles(e.dataTransfer.files);
        });

        this.el.aspectPresets.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.el.aspectPresets.querySelectorAll('.preset-btn')
                    .forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const r = btn.dataset.ratio;
                this.aspectRatio = r === 'free' ? null : (() => {
                    const [w, h] = r.split(':').map(Number); return w / h;
                })();
                if (this.activeIndex >= 0) {
                    // Always reset to full frame first so ratios don't compound
                    this.entries[this.activeIndex].region = { x: 0, y: 0, w: 1, h: 1 };
                    this._applyAspectConstraint();
                    this._renderCropRegion();
                    this._syncInputsFromRegion();
                    this._updateReadout();
                }
            });
        });

        this.el.formatSelect.addEventListener('change', () => {
            this.el.qualityGroup.style.display =
                this.el.formatSelect.value === 'image/png' ? 'none' : '';
        });
        this.el.videoFormatSelect.addEventListener('change', () => {
            this._updateVideoFormatNote();
        });
        this.el.qualityInput.addEventListener('input', () => {
            this.el.qualityLabel.textContent = `${this.el.qualityInput.value}%`;
        });

        [this.el.inX, this.el.inY, this.el.inW, this.el.inH].forEach(inp => {
            inp.addEventListener('input', () => this._applyManualInputs());
        });

        this.el.resetCropBtn.addEventListener('click', () => this._resetCrop());
        this.el.cropBtn.addEventListener('click', () => this._cropActive());
        this.el.cropAllBtn.addEventListener('click', () => this._cropAll());
        this.el.clearAllBtn.addEventListener('click', () => this._clearAll());
        this.el.downloadAllBtn.addEventListener('click', () => this._downloadAll());

        this.el.previewOverlay.addEventListener('click', () => {
            this.el.previewOverlay.hidden = true;
            document.body.style.overflow = '';
            this.el.overlayVid.pause();
            this.el.overlayVid.src = '';
            this.el.overlayVid.style.display = 'none';
            this.el.overlayImg.src = '';
            this.el.overlayImg.style.display = 'none';
        });

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && !this.el.previewOverlay.hidden)
                this.el.previewOverlay.click();
        });
    }

    /** Check which video output formats MediaRecorder supports and annotate the selector. */
    _updateVideoFormatNote() {
        const chosen = this.el.videoFormatSelect.value;
        const mp4Supported = MediaRecorder.isTypeSupported('video/mp4') ||
            MediaRecorder.isTypeSupported('video/mp4;codecs=avc1');
        const webmSupported = MediaRecorder.isTypeSupported('video/webm');

        // Update MP4 option label
        const mp4Opt = this.el.videoFormatSelect.querySelector('option[value="mp4"]');
        mp4Opt.textContent = mp4Supported ? 'MP4 — supported' : 'MP4 — not supported in this browser';
        mp4Opt.disabled = !mp4Supported;

        // If user chose MP4 but it's not supported, fall back
        if (chosen === 'mp4' && !mp4Supported) {
            this.el.videoFormatSelect.value = 'webm';
        }

        this.el.videoFormatNote.textContent = !mp4Supported
            ? 'MP4 recording is only supported in Safari. Chrome/Firefox output WebM.'
            : '';
    }

    /* ═══ File loading ════════════════════════════════════════════════ */

    _addFiles(files) {
        [...files].forEach(file => {
            const url = URL.createObjectURL(file);

            if (file.type.startsWith('image/')) {
                const img = new Image();
                img.onload = () => this._pushEntry(
                    new ImageEntry(file, url, img.naturalWidth, img.naturalHeight)
                );
                img.onerror = () => URL.revokeObjectURL(url);
                img.src = url;

            } else if (file.type.startsWith('video/')) {
                const probe = document.createElement('video');
                probe.preload = 'metadata';
                probe.onloadedmetadata = () => {
                    this._pushEntry(new VideoEntry(
                        file, url,
                        probe.videoWidth, probe.videoHeight, probe.duration
                    ));
                    probe.src = '';
                };
                probe.onerror = () => URL.revokeObjectURL(url);
                probe.src = url;
            }
        });
    }

    _pushEntry(entry) {
        this.entries.push(entry);
        this._renderQueue();
        if (this.entries.length === 1) this._selectEntry(0);
        this._updateQueueControls();
    }

    _updateQueueControls() {
        this.el.cropAllBtn.disabled = this.entries.length < 2;
        this.el.clearAllBtn.disabled = this.entries.length === 0;
    }

    /* ═══ Queue rendering ═════════════════════════════════════════════ */

    _renderQueue() {
        this.el.imageQueue.innerHTML = '';
        this.entries.forEach((entry, idx) => {
            const item = document.createElement('div');
            item.className = 'queue-item' + (idx === this.activeIndex ? ' active' : '');

            const thumb = document.createElement('img');
            thumb.className = 'queue-thumb';
            thumb.alt = entry.file.name;
            if (entry.isVideo) {
                thumb.src = entry.thumbUrl ||
                    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 24 24' fill='none' stroke='%239e8fbb' stroke-width='1.5'%3E%3Crect x='2' y='2' width='20' height='20' rx='2'/%3E%3Cpath d='M7 2v20M17 2v20M2 12h20M2 7h5M17 7h5M17 17h5M2 17h5'/%3E%3C/svg%3E";
            } else {
                thumb.src = entry.objectUrl;
            }

            const info = document.createElement('div');
            info.className = 'queue-info';
            const typeTag = entry.isVideo
                ? `<span style="color:var(--orange);font-size:0.58rem;font-weight:700;letter-spacing:0.06em">VIDEO</span> `
                : '';
            info.innerHTML =
                `<div class="queue-name">${typeTag}${entry.file.name}</div>` +
                `<div class="queue-dims">${entry.naturalW} × ${entry.naturalH}px</div>`;

            const status = document.createElement('span');
            status.className = 'queue-status' +
                (entry.cropped ? ' done' : (idx === this.activeIndex ? ' active' : ''));
            status.textContent = entry.cropped
                ? '✓ Done'
                : (idx === this.activeIndex ? '● Active' : '');

            const rmBtn = document.createElement('button');
            rmBtn.className = 'queue-remove';
            rmBtn.title = 'Remove';
            rmBtn.setAttribute('aria-label', 'Remove file');
            rmBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
                stroke-linejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
            rmBtn.addEventListener('click', e => { e.stopPropagation(); this._removeEntry(idx); });

            item.appendChild(thumb);
            item.appendChild(info);
            item.appendChild(status);
            item.appendChild(rmBtn);
            item.addEventListener('click', () => this._selectEntry(idx));
            this.el.imageQueue.appendChild(item);
        });
    }

    _removeEntry(idx) {
        const entry = this.entries[idx];
        URL.revokeObjectURL(entry.objectUrl);
        if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
        if (entry.thumbUrl && entry.thumbUrl !== entry.previewUrl)
            URL.revokeObjectURL(entry.thumbUrl);
        this.entries.splice(idx, 1);

        if (this.activeIndex === idx) {
            this.activeIndex = -1;
            this._clearPreview();
        } else if (this.activeIndex > idx) {
            this.activeIndex--;
        }

        this._updateQueueControls();
        this._renderQueue();
        if (this.entries.length > 0 && this.activeIndex < 0) this._selectEntry(0);
    }

    /* ═══ Entry selection ═════════════════════════════════════════════ */

    _selectEntry(idx) {
        if (idx < 0 || idx >= this.entries.length) return;
        this.activeIndex = idx;
        const entry = this.entries[idx];

        this.el.sourceCanvas.hidden = true;
        this.el.sourceVideo.hidden = true;
        this.el.emptyPreview.style.display = 'none';

        // Show/hide image-only controls
        // Show/hide format controls based on file type
        this.el.imageFormatGroup.style.display = entry.isVideo ? 'none' : '';
        this.el.videoFormatGroup.hidden = !entry.isVideo;
        this.el.qualityGroup.style.display =
            entry.isVideo || this.el.formatSelect.value === 'image/png' ? 'none' : '';

        if (entry.isVideo) {
            this._setupVideoPreview(entry);
        } else {
            this._setupImagePreview(entry);
        }

        this._renderQueue();
    }

    _setupImagePreview(entry) {
        const canvas = this.el.sourceCanvas;
        const ctx = canvas.getContext('2d');
        const img = new Image();

        img.onload = () => {
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            ctx.drawImage(img, 0, 0);

            const wrapW = this.el.canvasWrapper.clientWidth;
            const maxH = Math.floor(window.innerHeight * 0.62);
            const fitted = fitSize(img.naturalWidth, img.naturalHeight, wrapW, maxH);
            canvas.style.width = `${fitted.w}px`;
            canvas.style.height = `${fitted.h}px`;
            canvas.hidden = false;

            this._attachOverlay();
            this._setupResizeObserver(entry, canvas);

            requestAnimationFrame(() => {
                this._positionOverlay();
                this._renderCropRegion();
                this._syncInputsFromRegion();
                this._updateReadout();
                this._enableCropControls();
            });
        };
        img.src = entry.objectUrl;
    }

    _setupVideoPreview(entry) {
        const vid = this.el.sourceVideo;

        // Reset to avoid stale src
        vid.pause();
        vid.removeAttribute('src');
        vid.load();

        vid.onloadedmetadata = () => {
            const wrapW = this.el.canvasWrapper.clientWidth;
            const maxH = Math.floor(window.innerHeight * 0.62);
            const fitted = fitSize(entry.naturalW, entry.naturalH, wrapW, maxH);
            vid.style.width = `${fitted.w}px`;
            vid.style.height = `${fitted.h}px`;
            vid.hidden = false;
            vid.play().catch(() => { });

            this._attachOverlay();
            this._setupResizeObserver(entry, vid);

            requestAnimationFrame(() => {
                this._positionOverlay();
                this._renderCropRegion();
                this._syncInputsFromRegion();
                this._updateReadout();
                this._enableCropControls();
            });
        };

        vid.src = entry.objectUrl;
        vid.load();
    }

    _attachOverlay() {
        if (!this._overlayEl.parentElement) {
            this.el.canvasWrapper.appendChild(this._overlayEl);
        }
    }

    _setupResizeObserver(entry, previewEl) {
        if (this._resizeObs) this._resizeObs.disconnect();
        this._resizeObs = new ResizeObserver(() => {
            if (this.activeIndex < 0) return;
            const wrapW = this.el.canvasWrapper.clientWidth;
            const maxH = Math.floor(window.innerHeight * 0.62);
            const fitted = fitSize(entry.naturalW, entry.naturalH, wrapW, maxH);
            previewEl.style.width = `${fitted.w}px`;
            previewEl.style.height = `${fitted.h}px`;
            requestAnimationFrame(() => {
                this._positionOverlay();
                this._renderCropRegion();
            });
        });
        this._resizeObs.observe(this.el.canvasWrapper);
    }

    /**
     * Position the overlay div to sit exactly over the active preview element,
     * using getBoundingClientRect so centering/letterboxing is accounted for.
     */
    _positionOverlay() {
        if (this.activeIndex < 0) return;
        const isVideo = this.entries[this.activeIndex].isVideo;
        const previewEl = isVideo ? this.el.sourceVideo : this.el.sourceCanvas;
        const wrapRect = this.el.canvasWrapper.getBoundingClientRect();
        const prevRect = previewEl.getBoundingClientRect();

        Object.assign(this._overlayEl.style, {
            position: 'absolute',
            inset: 'unset',
            left: `${prevRect.left - wrapRect.left}px`,
            top: `${prevRect.top - wrapRect.top}px`,
            width: `${prevRect.width}px`,
            height: `${prevRect.height}px`,
        });
    }

    _enableCropControls() {
        this.el.cropReadout.hidden = false;
        this.el.resetCropBtn.disabled = false;
        this.el.cropBtn.disabled = false;
        this.el.cropAllBtn.disabled = this.entries.length < 2;
    }

    _clearPreview() {
        this.el.sourceCanvas.hidden = true;
        this.el.sourceVideo.hidden = true;
        this.el.sourceVideo.pause();
        this.el.sourceVideo.src = '';
        this.el.emptyPreview.style.display = '';
        if (this._overlayEl.parentElement) {
            this._overlayEl.parentElement.removeChild(this._overlayEl);
        }
        if (this._resizeObs) { this._resizeObs.disconnect(); this._resizeObs = null; }
        this.el.cropReadout.hidden = true;
        this.el.resetCropBtn.disabled = true;
        this.el.cropBtn.disabled = true;
        this.el.cropAllBtn.disabled = true;
    }

    /* ═══ Crop region rendering ═══════════════════════════════════════ */

    _renderCropRegion() {
        if (this.activeIndex < 0 || !this._overlayEl.parentElement) return;
        const entry = this.entries[this.activeIndex];
        const dW = this._overlayEl.offsetWidth;
        const dH = this._overlayEl.offsetHeight;

        Object.assign(this._regionEl.style, {
            left: `${entry.region.x * dW}px`,
            top: `${entry.region.y * dH}px`,
            width: `${entry.region.w * dW}px`,
            height: `${entry.region.h * dH}px`,
        });
    }

    _syncInputsFromRegion() {
        if (this.activeIndex < 0) return;
        const entry = this.entries[this.activeIndex];
        const px = entry.pixelRegion;

        this.el.inX.max = entry.naturalW - 1;
        this.el.inY.max = entry.naturalH - 1;
        this.el.inW.max = entry.naturalW;
        this.el.inH.max = entry.naturalH;

        this.el.inX.value = px.x;
        this.el.inY.value = px.y;
        this.el.inW.value = px.w;
        this.el.inH.value = px.h;
    }

    _updateReadout() {
        if (this.activeIndex < 0) return;
        const px = this.entries[this.activeIndex].pixelRegion;
        this.el.cropReadout.innerHTML =
            `Crop: <span style="color:var(--accent)">${px.w}&thinsp;&times;&thinsp;${px.h}px</span>` +
            `&ensp;at&ensp;<span style="color:var(--text2)">(${px.x}, ${px.y})</span>`;
    }

    /* ═══ Aspect ratio constraint ═════════════════════════════════════ */

    _applyAspectConstraint() {
        if (!this.aspectRatio || this.activeIndex < 0) return;
        const r = this.entries[this.activeIndex].region;
        let w = r.w, h = r.h;
        if (w / h > this.aspectRatio) w = h * this.aspectRatio;
        else h = w / this.aspectRatio;
        w = Math.min(w, 1 - r.x);
        h = Math.min(h, 1 - r.y);
        if (w / h > this.aspectRatio) w = h * this.aspectRatio;
        else h = w / this.aspectRatio;
        r.w = Math.max(0.01, w);
        r.h = Math.max(0.01, h);
    }

    /* ═══ Manual pixel inputs ═════════════════════════════════════════ */

    _applyManualInputs() {
        if (this.activeIndex < 0) return;
        const entry = this.entries[this.activeIndex];
        const vw = entry.naturalW, vh = entry.naturalH;

        let x = clamp(parseInt(this.el.inX.value) || 0, 0, vw - 1);
        let y = clamp(parseInt(this.el.inY.value) || 0, 0, vh - 1);
        let w = clamp(parseInt(this.el.inW.value) || vw, 1, vw - x);
        let h = clamp(parseInt(this.el.inH.value) || vh, 1, vh - y);

        if (this.aspectRatio) {
            h = Math.round(w / this.aspectRatio);
            h = clamp(h, 1, vh - y);
            w = Math.round(h * this.aspectRatio);
            w = clamp(w, 1, vw - x);
        }

        entry.region = { x: x / vw, y: y / vh, w: w / vw, h: h / vh };
        this._renderCropRegion();
        this._syncInputsFromRegion();
        this._updateReadout();
    }

    _resetCrop() {
        if (this.activeIndex < 0) return;
        this.entries[this.activeIndex].region = { x: 0, y: 0, w: 1, h: 1 };
        this._renderCropRegion();
        this._syncInputsFromRegion();
        this._updateReadout();
    }

    /* ═══ Drag logic ══════════════════════════════════════════════════ */

    _dragStart(clientX, clientY, handle) {
        if (this.activeIndex < 0) return;
        this._dragging = true;
        this._handle = handle;
        this._startX = clientX;
        this._startY = clientY;
        this._startRegion = { ...this.entries[this.activeIndex].region };
        this._regionEl.style.transition = 'none';
        document.body.classList.add('dragging-active');
    }

    _dragMove(clientX, clientY) {
        if (!this._dragging || this.activeIndex < 0) return;

        // Deltas are relative to the overlay, which matches the preview element exactly
        const rect = this._overlayEl.getBoundingClientRect();
        const dx = (clientX - this._startX) / rect.width;
        const dy = (clientY - this._startY) / rect.height;
        const MIN = 0.02;
        const sr = this._startRegion;
        const r = { ...this.entries[this.activeIndex].region };

        if (this._handle === 'move') {
            r.x = clamp(sr.x + dx, 0, 1 - sr.w);
            r.y = clamp(sr.y + dy, 0, 1 - sr.h);
        } else {
            const isL = this._handle.includes('w');
            const isR = this._handle === 'e' || (!this._handle.includes('w') && this._handle.includes('e'));
            const isT = this._handle.includes('n');
            const isB = this._handle === 's' || (!this._handle.includes('n') && this._handle.includes('s'));

            if (isL) {
                const nx = clamp(sr.x + dx, 0, 1);
                const nw = sr.w - dx;
                if (nw >= MIN) { r.x = nx; r.w = Math.min(1 - nx, nw); }
            } else if (isR) {
                const nw = sr.w + dx;
                if (nw >= MIN) r.w = Math.min(1 - r.x, nw);
            }
            if (isT) {
                const ny = clamp(sr.y + dy, 0, 1);
                const nh = sr.h - dy;
                if (nh >= MIN) { r.y = ny; r.h = Math.min(1 - ny, nh); }
            } else if (isB) {
                const nh = sr.h + dy;
                if (nh >= MIN) r.h = Math.min(1 - r.y, nh);
            }
        }

        if (r.x + r.w > 1) r.w = 1 - r.x;
        if (r.y + r.h > 1) r.h = 1 - r.y;

        if (this.aspectRatio && this._handle !== 'move') {
            if (r.w / r.h > this.aspectRatio) r.h = r.w / this.aspectRatio;
            else r.w = r.h * this.aspectRatio;
            if (r.x + r.w > 1) { r.w = 1 - r.x; r.h = r.w / this.aspectRatio; }
            if (r.y + r.h > 1) { r.h = 1 - r.y; r.w = r.h * this.aspectRatio; }
        }

        this.entries[this.activeIndex].region = r;
        this._renderCropRegion();
        this._syncInputsFromRegion();
        this._updateReadout();
    }

    _dragEnd() {
        if (!this._dragging) return;
        this._dragging = false;
        this._handle = '';
        this._regionEl.style.transition = '';
        document.body.classList.remove('dragging-active');
    }

    /* ═══ Cropping ════════════════════════════════════════════════════ */

    async _cropImageEntry(entry, mime, quality) {
        const px = entry.pixelRegion;
        const out = document.createElement('canvas');
        out.width = px.w;
        out.height = px.h;
        const ctx = out.getContext('2d');

        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = entry.objectUrl; });
        ctx.drawImage(img, px.x, px.y, px.w, px.h, 0, 0, px.w, px.h);

        const blob = await new Promise(res => out.toBlob(res, mime, quality));
        entry.cropped = blob;

        if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
        entry.previewUrl = URL.createObjectURL(blob);
        entry.thumbUrl = entry.previewUrl;

        this._addOutputCard(entry, mimeToExt(mime));
        this._afterCrop();
    }

    async _cropVideoEntry(entry) {
        const px = entry.pixelRegion;
        const wantExt = this.el.videoFormatSelect.value; // 'webm' or 'mp4'

        // Resolve actual MIME based on what MediaRecorder supports
        const mp4Candidates = ['video/mp4;codecs=avc1', 'video/mp4'];
        const webmCandidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
        const candidates = wantExt === 'mp4'
            ? [...mp4Candidates, ...webmCandidates]
            : [...webmCandidates, ...mp4Candidates];
        const mime = candidates.find(m => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
        const ext = mime.includes('mp4') ? 'mp4' : 'webm';

        // Show progress overlay
        this.el.cropProgressOverlay.hidden = false;
        this.el.cropProgressStatus.textContent = 'Recording…';
        this.el.cropProgressDetail.textContent =
            `${px.w}×${px.h}px · ${ext.toUpperCase()} · ${entry.duration.toFixed(1)}s`;

        const out = document.createElement('canvas');
        out.width = px.w;
        out.height = px.h;
        const ctx = out.getContext('2d');

        const vid = this.el.sourceVideo;
        vid.pause();
        vid.loop = false;
        vid.currentTime = 0;
        await new Promise(res => { vid.onseeked = res; });
        vid.onseeked = null;

        const stream = out.captureStream(30);
        const recorder = new MediaRecorder(stream, { mimeType: mime });
        const chunks = [];
        recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

        const startTime = performance.now();
        recorder.start(100);

        let rafId;
        const draw = () => {
            ctx.drawImage(vid, px.x, px.y, px.w, px.h, 0, 0, px.w, px.h);
            // Update elapsed time in the overlay
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
            this.el.cropProgressDetail.textContent =
                `${px.w}×${px.h}px · ${ext.toUpperCase()} · ${elapsed}s / ${entry.duration.toFixed(1)}s`;
            if (!vid.ended && !vid.paused) rafId = requestAnimationFrame(draw);
        };

        await new Promise((resolve, reject) => {
            vid.onended = () => {
                cancelAnimationFrame(rafId);
                ctx.drawImage(vid, px.x, px.y, px.w, px.h, 0, 0, px.w, px.h);
                recorder.stop();
            };
            recorder.onstop = resolve;
            recorder.onerror = e => reject(e.error ?? e);
            vid.play()
                .then(() => { rafId = requestAnimationFrame(draw); })
                .catch(reject);
        });

        // Restore preview video
        vid.onended = null;
        vid.loop = true;
        vid.currentTime = 0;
        vid.play().catch(() => { });

        // Hide progress overlay, show elapsed
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
        this.el.cropProgressOverlay.hidden = true;

        const blob = new Blob(chunks, { type: mime });
        entry.cropped = blob;
        entry.croppedExt = ext; // store resolved ext for download naming
        entry.elapsed = elapsed;

        if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
        entry.previewUrl = URL.createObjectURL(blob);

        // Poster thumbnail
        const thumb = document.createElement('canvas');
        const tW = Math.min(200, px.w);
        const tH = Math.round(px.h * (tW / px.w));
        thumb.width = tW;
        thumb.height = tH;
        thumb.getContext('2d').drawImage(out, 0, 0, px.w, px.h, 0, 0, tW, tH);
        if (entry.thumbUrl) URL.revokeObjectURL(entry.thumbUrl);
        entry.thumbUrl = await new Promise(res =>
            thumb.toBlob(b => res(URL.createObjectURL(b)), 'image/jpeg', 0.8)
        );

        this._addOutputCard(entry, ext);
        this._afterCrop();
    }

    _afterCrop() {
        this.el.emptyOutput.style.display = 'none';
        this.el.downloadAllBtn.disabled = false;
    }

    /** Crop the currently active image. */
    async _cropActive() {
        if (this.activeIndex < 0) return;
        const entry = this.entries[this.activeIndex];

        this.el.cropBtn.disabled = true;
        this.el.cropAllBtn.disabled = true;
        if (entry.isVideo) this.el.processingBadge.hidden = false;

        try {
            if (entry.isVideo) {
                await this._cropVideoEntry(entry);
            } else {
                await this._cropImageEntry(
                    entry,
                    this.el.formatSelect.value,
                    parseInt(this.el.qualityInput.value) / 100
                );
            }
        } finally {
            this.el.processingBadge.hidden = true;
            this.el.cropBtn.disabled = false;
            this.el.cropAllBtn.disabled = this.entries.length < 2;
            this._renderQueue();
        }

        const next = this.entries.findIndex((e, i) => i > this.activeIndex && !e.cropped);
        if (next >= 0) this._selectEntry(next);
    }

    async _cropAll() {
        if (this.activeIndex < 0 || this.entries.length < 2) return;
        const templateRegion = { ...this.entries[this.activeIndex].region };
        const mime = this.el.formatSelect.value;
        const quality = parseInt(this.el.qualityInput.value) / 100;

        this.el.cropBtn.disabled = true;
        this.el.cropAllBtn.disabled = true;
        this.el.processingBadge.hidden = false;

        try {
            for (const entry of this.entries) {
                entry.region = { ...templateRegion };
                if (entry.isVideo) {
                    await this._cropVideoEntry(entry);
                } else {
                    await this._cropImageEntry(entry, mime, quality);
                }
            }
        } finally {
            this.el.processingBadge.hidden = true;
            this.el.cropBtn.disabled = false;
            this.el.cropAllBtn.disabled = this.entries.length < 2;
            this._renderQueue();
        }
    }

    /* ═══ Output cards ════════════════════════════════════════════════ */

    _addOutputCard(entry, ext) {
        const existing = document.getElementById(`out-${entry.id}`);
        if (existing) existing.remove();

        // ext param is correct for images; for video use the stored resolved ext
        const resolvedExt = entry.isVideo ? (entry.croppedExt ?? ext) : ext;
        const name = entry.file.name.replace(/\.[^.]+$/, '') + `_crop.${resolvedExt}`;

        const px = entry.pixelRegion;
        const sizeKb = entry.cropped.size / 1024;
        const sizeStr = sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(2)} MB` : `${sizeKb.toFixed(1)} KB`;
        const timeStr = entry.elapsed ? ` · ⏱ ${entry.elapsed}s` : '';

        const info = document.createElement('div');
        info.className = 'output-card-info';
        info.innerHTML =
            `<div class="output-card-name">${name}</div>` +
            `<div>${px.w} × ${px.h}px · ${sizeStr}${timeStr}</div>`;

        const card = document.createElement('div');
        card.className = 'output-card';
        card.id = `out-${entry.id}`;

        const img = document.createElement('img');
        img.src = entry.thumbUrl || entry.previewUrl;
        img.alt = name;
        // img.addEventListener('click', () => {
        //     if (entry.isVideo) {
        //         // Can't show video in the img overlay — download instead
        //         this._downloadBlob(entry.cropped, name);
        //     } else {
        //         this.el.overlayImg.src = entry.previewUrl;
        //         this.el.previewOverlay.hidden = false;
        //         document.body.style.overflow = 'hidden';
        //     }
        // });
        // if (!entry.isVideo) img.style.cursor = 'zoom-in';

        img.addEventListener('click', () => {
            if (entry.isVideo) {
                // Show video in overlay
                this.el.overlayImg.style.display = 'none';
                this.el.overlayVid.style.display = 'block';
                this.el.overlayVid.src = entry.previewUrl;
                this.el.overlayVid.play().catch(() => { });
            } else {
                this.el.overlayVid.style.display = 'none';
                this.el.overlayImg.style.display = 'block';
                this.el.overlayImg.src = entry.previewUrl;
            }
            this.el.previewOverlay.hidden = false;
            document.body.style.overflow = 'hidden';
        });
        img.style.cursor = 'zoom-in'; // same for both — thumbnail is always an image

        const dlBtn = document.createElement('button');
        dlBtn.className = 'output-card-btn';
        dlBtn.innerHTML =
            `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line></svg> Download`;
        dlBtn.addEventListener('click', () => this._downloadBlob(entry.cropped, name));

        card.appendChild(img);
        card.appendChild(info);
        card.appendChild(dlBtn);
        this.el.outputGrid.insertBefore(card, this.el.emptyOutput);
    }

    /* ═══ Clear All ═══════════════════════════════════════════════════ */

    _clearAll() {
        this.entries.forEach(e => {
            URL.revokeObjectURL(e.objectUrl);
            if (e.previewUrl) URL.revokeObjectURL(e.previewUrl);
            if (e.thumbUrl && e.thumbUrl !== e.previewUrl) URL.revokeObjectURL(e.thumbUrl);
        });
        this.entries = [];
        this.activeIndex = -1;

        this._clearPreview();
        this.el.imageQueue.innerHTML = '';
        this.el.fileInput.value = '';

        this.el.outputGrid.innerHTML = '';
        const placeholder = document.createElement('div');
        placeholder.className = 'empty-state';
        placeholder.id = 'emptyOutput';
        placeholder.style.gridColumn = '1 / -1';
        placeholder.innerHTML =
            `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line></svg>
            <p>Cropped files will appear here</p>`;
        this.el.outputGrid.appendChild(placeholder);
        this.el.emptyOutput = placeholder;

        this.el.clearAllBtn.disabled = true;
        this.el.downloadAllBtn.disabled = true;
        this.el.cropAllBtn.disabled = true;
    }

    /* ═══ Download helpers ════════════════════════════════════════════ */

    _downloadBlob(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 100);
    }

    async _downloadAll() {
        const cropped = this.entries.filter(e => e.cropped);
        if (cropped.length === 0) return;

        // If any video entries are present, skip zip — download individually
        const hasVideo = cropped.some(e => e.isVideo);
        if (hasVideo) {
            const imgExt = mimeToExt(this.el.formatSelect.value);
            cropped.forEach(e => {
                const ext = e.isVideo ? (e.croppedExt ?? 'webm') : imgExt;
                const name = e.file.name.replace(/\.[^.]+$/, '') + `_crop.${ext}`;
                this._downloadBlob(e.cropped, name);
            });
            return;
        }

        // Images only — zip them
        if (cropped.length === 1) {
            const e = cropped[0];
            const ext = mimeToExt(this.el.formatSelect.value);
            this._downloadBlob(e.cropped, e.file.name.replace(/\.[^.]+$/, '') + `_crop.${ext}`);
            return;
        }

        if (typeof JSZip !== 'undefined') {
            this.el.downloadAllBtn.disabled = true;
            try {
                const zip = new JSZip();
                const imgExt = mimeToExt(this.el.formatSelect.value);
                cropped.forEach(e => {
                    const name = e.file.name.replace(/\.[^.]+$/, '') + `_crop.${imgExt}`;
                    zip.file(name, e.cropped);
                });
                const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
                this._downloadBlob(blob, 'nyanpasu-crops.zip');
            } finally {
                this.el.downloadAllBtn.disabled = false;
            }
        } else {
            const imgExt = mimeToExt(this.el.formatSelect.value);
            cropped.forEach(e => {
                this._downloadBlob(e.cropped, e.file.name.replace(/\.[^.]+$/, '') + `_crop.${imgExt}`);
            });
        }
    }
}


/* ═══════════════════════════════════════════════════════════════════
   BOOTSTRAP
   ═══════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    new MediaCropper();
});