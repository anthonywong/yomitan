/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {createApiMap, invokeApiMapHandler} from '../core/api-map.js';
import {log} from '../core/log.js';
import {computeObjectFitLayout, getPageSegmentationModes, getRecognitionMode, getTextOffsetFromPoint, isPointInRect, parseTsvLines, parseTsvSingleCharacter} from '../dom/ocr-util.js';
import {TextSourceRange} from '../dom/text-source-range.js';

const MAX_IMAGE_PIXELS = 50_000_000;
const MINIMUM_REGION_SIZE = 8;
const MINIMUM_CONFIDENCE = 5;

export class OcrController {
    /**
     * @param {import('ocr-controller').ConstructorDetails} details
     */
    constructor({application, textSourceGenerator}) {
        /** @type {import('../application.js').Application} */
        this._application = application;
        /** @type {import('../dom/text-source-generator.js').TextSourceGenerator} */
        this._textSourceGenerator = textSourceGenerator;
        /** @type {boolean} */
        this._enabled = false;
        /** @type {?HTMLImageElement} */
        this._lastContextImage = null;
        /** @type {?import('ocr-controller').LastRequest} */
        this._lastRequest = null;
        /** @type {?object} */
        this._jobToken = null;
        /** @type {Map<import('ocr-util').Mode, Promise<import('ocr-controller').Worker>>} */
        this._workerPromises = new Map();
        /** @type {?import('ocr-controller').OverlayState} */
        this._overlay = null;
        /** @type {?(() => void)} */
        this._cancelRegionSelection = null;
        /** @type {?import('core').Timeout} */
        this._toastTimer = null;
        /** @type {?Promise<{default: {createWorker: import('ocr-controller').CreateWorker}}>} */
        this._tesseractModulePromise = null;

        /* eslint-disable @stylistic/no-multi-spaces */
        /** @type {import('application').ApiMap} */
        this._runtimeApiMap = createApiMap([
            ['ocrRecognizeImage', this._onApiRecognizeImage.bind(this)],
            ['ocrSelectRegion',   this._onApiSelectRegion.bind(this)],
            ['ocrRefresh',        this._onApiRefresh.bind(this)],
            ['ocrClear',          this._onApiClear.bind(this)],
        ]);
        /* eslint-enable @stylistic/no-multi-spaces */
    }

    /**
     * Prepares OCR interaction for a normal webpage content script.
     */
    async prepare() {
        await this._updateOptions();
        this._textSourceGenerator.registerGetRangeFromPointHandler(this._getRangeFromPoint.bind(this));
        document.addEventListener('contextmenu', this._onContextMenu.bind(this), true);
        document.addEventListener('keydown', this._onKeyDown.bind(this), true);
        chrome.runtime.onMessage.addListener(this._onRuntimeMessage.bind(this));
        this._application.on('optionsUpdated', this._updateOptions.bind(this));
    }

    // API handlers

    /** @type {import('application').ApiHandler<'ocrRecognizeImage'>} */
    async _onApiRecognizeImage({mode, srcUrl}) {
        await this._recognizeImage(mode, srcUrl);
    }

    /** @type {import('application').ApiHandler<'ocrSelectRegion'>} */
    async _onApiSelectRegion({mode}) {
        await this._recognizeSelectedRegion(mode);
    }

    /** @type {import('application').ApiHandler<'ocrRefresh'>} */
    async _onApiRefresh() {
        await this._refresh();
    }

    /** @type {import('application').ApiHandler<'ocrClear'>} */
    _onApiClear() {
        this._clear(true);
    }

    // Event handlers

    /**
     * @param {MouseEvent} event
     */
    _onContextMenu(event) {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
        const image = path.find((node) => node instanceof HTMLImageElement);
        this._lastContextImage = image instanceof HTMLImageElement ? image : null;
    }

    /**
     * @param {KeyboardEvent} event
     */
    _onKeyDown(event) {
        if (event.key !== 'Escape') { return; }
        if (this._cancelRegionSelection !== null) {
            this._cancelRegionSelection();
            return;
        }
        this._clear(false);
        this._hideToast();
    }

    /** @type {import('extension').ChromeRuntimeOnMessageCallback<import('application').ApiMessageAny>} */
    _onRuntimeMessage({action, params}, _sender, callback) {
        return invokeApiMapHandler(this._runtimeApiMap, action, params, [], callback);
    }

    /**
     * @returns {Promise<void>}
     */
    async _updateOptions() {
        try {
            const options = await this._application.api.optionsGet({current: true});
            this._enabled = options.ocr.enabled && options.general.enable;
            if (!this._enabled) {
                this._clear(false);
            }
        } catch (error) {
            if (!this._application.webExtension.unloaded) {
                log.error(error);
            }
        }
    }

    /**
     * @param {import('ocr-util').Mode} mode
     * @param {?string} srcUrl
     * @returns {Promise<void>}
     */
    async _recognizeImage(mode, srcUrl) {
        if (!this._checkCanStart()) { return; }
        const image = this._resolveTargetImage(srcUrl);
        if (image === null) {
            this._showToast('Could not find the selected image. Right-click it and try again.', true, 6000);
            return;
        }
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
            this._showToast('The selected image has not finished loading.', true, 5000);
            return;
        }
        await this._recognize({type: 'image', image}, mode);
    }

    /**
     * @param {import('ocr-util').Mode} mode
     * @returns {Promise<void>}
     */
    async _recognizeSelectedRegion(mode) {
        if (!this._checkCanStart()) { return; }
        const rect = await this._selectRegion();
        if (rect === null) { return; }
        const source = {
            type: /** @type {'region'} */ ('region'),
            documentRect: {
                left: rect.left + window.scrollX,
                top: rect.top + window.scrollY,
                width: rect.width,
                height: rect.height,
            },
        };
        await this._recognize(source, mode);
    }

    /**
     * @returns {Promise<void>}
     */
    async _refresh() {
        if (!this._checkCanStart()) { return; }
        if (this._lastRequest === null) {
            this._showToast('There are no OCR results to refresh.', true, 4000);
            return;
        }
        const {source, mode} = this._lastRequest;
        if (source.type === 'image' && !source.image.isConnected) {
            this._showToast('The source image is no longer on this page.', true, 5000);
            return;
        }
        await this._recognize(source, mode);
    }

    /**
     * @returns {boolean}
     */
    _checkCanStart() {
        if (!this._enabled) {
            this._showToast('Enable local image OCR in Yomitan settings first.', true, 5000);
            return false;
        }
        if (this._jobToken !== null) {
            this._showToast('OCR is already running. Press Escape to discard its result.', false, 4500);
            return false;
        }
        return true;
    }

    /**
     * @param {import('ocr-controller').Source} source
     * @param {import('ocr-util').Mode} mode
     * @returns {Promise<void>}
     */
    async _recognize(source, mode) {
        this._clearOverlay();
        this._lastRequest = {source, mode};
        const token = {};
        this._jobToken = token;
        try {
            this._showToast('Preparing local OCR…');
            const input = source.type === 'image' ?
                await this._getImageInput(source.image) :
                await this._getRegionInput(source.documentRect);
            if (this._jobToken !== token) { return; }

            const worker = await this._getWorker(mode);
            if (this._jobToken !== token) { return; }
            const pageSegmentationModes = getPageSegmentationModes(source.type, mode);
            /** @type {import('ocr-util').Line[]} */
            let lines = [];
            for (const [index, pageSegmentationMode] of pageSegmentationModes.entries()) {
                if (index > 0) {
                    this._showToast(
                        pageSegmentationMode === '10' ?
                            'Retrying local OCR as a single character…' :
                        'Retrying local OCR as a single text block…',
                    );
                }
                const recognitionMode = getRecognitionMode(mode, pageSegmentationMode);
                const recognitionWorker = recognitionMode === mode ? worker : await this._getWorker(recognitionMode);
                if (this._jobToken !== token) { return; }
                await recognitionWorker.setParameters({
                    tessedit_pageseg_mode: pageSegmentationMode,
                    preserve_interword_spaces: '1',
                });
                const result = await recognitionWorker.recognize(input.dataUrl, {}, {tsv: true});
                if (this._jobToken !== token) { return; }
                lines = pageSegmentationMode === '10' ?
                    parseTsvSingleCharacter(result.data.tsv ?? '') :
                    parseTsvLines(result.data.tsv ?? '', {
                        vertical: mode === 'vertical',
                        minimumConfidence: MINIMUM_CONFIDENCE,
                    });
                if (lines.length > 0) { break; }
            }
            if (lines.length === 0) {
                this._showToast('OCR completed, but no usable Japanese text was found.', true, 6000);
                return;
            }

            this._createOverlay(source, input.width, input.height, lines, mode);
            this._showToast(
                `OCR text layer added (${lines.length} line${lines.length === 1 ? '' : 's'}). Hold Shift and move over a highlighted region.`,
                false,
                7000,
            );
        } catch (error) {
            log.error(error);
            this._showToast(`OCR failed: ${error instanceof Error ? error.message : `${error}`}`, true, 8000);
        } finally {
            if (this._jobToken === token) {
                this._jobToken = null;
            }
        }
    }

    /**
     * @param {?string} srcUrl
     * @returns {?HTMLImageElement}
     */
    _resolveTargetImage(srcUrl) {
        if (this._lastContextImage !== null && this._lastContextImage.isConnected) {
            return this._lastContextImage;
        }
        if (typeof srcUrl !== 'string' || srcUrl.length === 0) { return null; }
        for (const image of document.images) {
            if (image.currentSrc === srcUrl || image.src === srcUrl) {
                return image;
            }
        }
        return null;
    }

    /**
     * @param {HTMLImageElement} image
     * @returns {Promise<import('ocr-controller').Input>}
     */
    async _getImageInput(image) {
        const {naturalWidth: width, naturalHeight: height} = image;
        this._validatePixelCount(width, height);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (context === null) { throw new Error('Canvas is unavailable.'); }
        try {
            context.drawImage(image, 0, 0, width, height);
            return {dataUrl: canvas.toDataURL('image/png'), width, height};
        } catch (error) {
            // Cross-origin images can taint a page canvas. The background fetch below
            // uses Yomitan's host access without sending pixels to an OCR service.
        }

        const url = image.currentSrc || image.src;
        const dataUrl = await this._application.api.ocrFetchImage(url);
        const decoded = await this._loadImage(dataUrl);
        this._validatePixelCount(decoded.naturalWidth, decoded.naturalHeight);
        return {dataUrl, width: decoded.naturalWidth, height: decoded.naturalHeight};
    }

    /**
     * @param {import('ocr-util').Rect} documentRect
     * @returns {Promise<import('ocr-controller').Input>}
     */
    async _getRegionInput(documentRect) {
        const rect = {
            left: documentRect.left - window.scrollX,
            top: documentRect.top - window.scrollY,
            width: documentRect.width,
            height: documentRect.height,
        };
        if (
            rect.left < 0 ||
            rect.top < 0 ||
            rect.left + rect.width > window.innerWidth ||
            rect.top + rect.height > window.innerHeight
        ) {
            throw new Error('The selected region must remain fully visible to refresh it.');
        }

        this._hideToast();
        await new Promise((resolve) => {
            requestAnimationFrame(() => resolve(void 0));
        });
        const screenshot = await this._application.api.ocrCaptureVisibleTab();
        const image = await this._loadImage(screenshot);
        const scaleX = image.naturalWidth / window.innerWidth;
        const scaleY = image.naturalHeight / window.innerHeight;
        const sourceLeft = Math.max(0, Math.round(rect.left * scaleX));
        const sourceTop = Math.max(0, Math.round(rect.top * scaleY));
        const width = Math.min(image.naturalWidth - sourceLeft, Math.max(1, Math.round(rect.width * scaleX)));
        const height = Math.min(image.naturalHeight - sourceTop, Math.max(1, Math.round(rect.height * scaleY)));
        this._validatePixelCount(width, height);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (context === null) { throw new Error('Canvas is unavailable.'); }
        context.drawImage(image, sourceLeft, sourceTop, width, height, 0, 0, width, height);
        return {dataUrl: canvas.toDataURL('image/png'), width, height};
    }

    /**
     * @param {number} width
     * @param {number} height
     * @throws {Error} The image dimensions exceed the prototype limit.
     */
    _validatePixelCount(width, height) {
        if (width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS) {
            throw new Error('The OCR image is empty or larger than the 50 megapixel limit.');
        }
    }

    /**
     * @param {import('ocr-util').Mode} mode
     * @returns {Promise<import('ocr-controller').Worker>}
     */
    async _getWorker(mode) {
        let promise = this._workerPromises.get(mode);
        if (typeof promise === 'undefined') {
            promise = this._createWorker(mode);
            this._workerPromises.set(mode, promise);
            promise.catch(() => this._workerPromises.delete(mode));
        }
        return await promise;
    }

    /**
     * @param {import('ocr-util').Mode} mode
     * @returns {Promise<import('ocr-controller').Worker>}
     */
    async _createWorker(mode) {
        this._tesseractModulePromise ??= /** @type {Promise<{default: {createWorker: import('ocr-controller').CreateWorker}}>} */ (
            // eslint-disable-next-line no-unsanitized/method
            import(chrome.runtime.getURL('lib/tesseract/tesseract.esm.min.js'))
        );
        const {default: {createWorker}} = await this._tesseractModulePromise;
        return await createWorker(mode === 'vertical' ? 'jpn_vert' : 'jpn', 1, {
            workerPath: chrome.runtime.getURL('lib/tesseract/worker.min.js'),
            corePath: chrome.runtime.getURL('lib/tesseract/core'),
            langPath: chrome.runtime.getURL('lib/tesseract/lang'),
            // Content scripts execute with the web page's origin, so Chrome
            // rejects constructing a Worker directly from a chrome-extension:
            // URL. Tesseract's blob bootstrap imports this packaged worker URL
            // without fetching or executing any remote code.
            workerBlobURL: true,
            logger: ({status, progress}) => {
                if (this._jobToken === null) { return; }
                const percentage = typeof progress === 'number' && Number.isFinite(progress) ? ` ${Math.round(progress * 100)}%` : '';
                this._showToast(`${this._humanizeStatus(status ?? null)}${percentage}`);
            },
        });
    }

    /**
     * @param {import('ocr-controller').Source} source
     * @param {number} sourceWidth
     * @param {number} sourceHeight
     * @param {import('ocr-util').Line[]} lines
     * @param {import('ocr-util').Mode} mode
     */
    _createOverlay(source, sourceWidth, sourceHeight, lines, mode) {
        const root = document.createElement('div');
        root.className = 'yomitan-ocr-overlay';
        root.dataset.mode = mode;
        root.setAttribute('aria-label', 'Local OCR text layer');

        const imageSpace = document.createElement('div');
        imageSpace.className = 'yomitan-ocr-image-space';
        root.appendChild(imageSpace);

        const summary = lines.map(({text}) => text).join(' / ');
        const hint = document.createElement('div');
        hint.className = 'yomitan-ocr-hint scan-disable';
        hint.textContent = `OCR: ${summary.length > 80 ? `${summary.slice(0, 79)}…` : summary} — Hold Shift and move over a blue box`;
        root.appendChild(hint);

        const lineNodes = [];
        for (const line of lines) {
            const node = document.createElement('span');
            node.className = 'yomitan-ocr-line';
            node.textContent = line.text;
            node.title = `Local OCR ${Math.round(line.confidence)}%: ${line.text}`;
            node.style.left = `${line.left}px`;
            node.style.top = `${line.top}px`;
            node.style.width = `${line.width}px`;
            node.style.height = `${line.height}px`;
            if (mode === 'vertical') {
                node.style.writingMode = 'vertical-rl';
                node.style.textOrientation = 'mixed';
                node.style.fontSize = `${Math.max(8, line.width * 0.88)}px`;
                node.style.lineHeight = `${line.width}px`;
            } else {
                node.style.fontSize = `${Math.max(8, line.height * 0.88)}px`;
                node.style.lineHeight = `${line.height}px`;
            }
            imageSpace.appendChild(node);
            lineNodes.push(node);
        }

        document.documentElement.appendChild(root);
        /** @type {import('ocr-controller').OverlayState} */
        const state = {
            root,
            imageSpace,
            lineNodes,
            source,
            sourceWidth,
            sourceHeight,
            resizeObserver: null,
            updateQueued: false,
        };
        this._overlay = state;
        const update = () => this._queueOverlayUpdate(state);
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update, true);
        if (source.type === 'image') {
            state.resizeObserver = new ResizeObserver(update);
            state.resizeObserver.observe(source.image);
        }
        root.addEventListener('yomitan-ocr-disconnect', () => {
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update, true);
        }, {once: true});
        this._updateOverlay(state);
    }

    /**
     * @param {import('ocr-controller').OverlayState} state
     */
    _queueOverlayUpdate(state) {
        if (state.updateQueued) { return; }
        state.updateQueued = true;
        requestAnimationFrame(() => {
            state.updateQueued = false;
            this._updateOverlay(state);
        });
    }

    /**
     * @param {import('ocr-controller').OverlayState} state
     */
    _updateOverlay(state) {
        if (!state.root.isConnected) { return; }
        if (state.source.type === 'image') {
            const {image} = state.source;
            if (!image.isConnected) {
                this._clearOverlay();
                return;
            }
            const rect = image.getBoundingClientRect();
            const style = getComputedStyle(image);
            const borderLeft = this._cssPixels(style.borderLeftWidth);
            const borderTop = this._cssPixels(style.borderTopWidth);
            const borderRight = this._cssPixels(style.borderRightWidth);
            const borderBottom = this._cssPixels(style.borderBottomWidth);
            const paddingLeft = this._cssPixels(style.paddingLeft);
            const paddingTop = this._cssPixels(style.paddingTop);
            const paddingRight = this._cssPixels(style.paddingRight);
            const paddingBottom = this._cssPixels(style.paddingBottom);
            const width = Math.max(0, rect.width - borderLeft - borderRight - paddingLeft - paddingRight);
            const height = Math.max(0, rect.height - borderTop - borderBottom - paddingTop - paddingBottom);
            const [positionX, positionY] = this._parseObjectPosition(style.objectPosition);
            const fitted = computeObjectFitLayout({
                boxWidth: width,
                boxHeight: height,
                naturalWidth: state.sourceWidth,
                naturalHeight: state.sourceHeight,
                objectFit: style.objectFit,
                positionX,
                positionY,
            });
            this._setOverlayGeometry(
                state,
                rect.left + borderLeft + paddingLeft,
                rect.top + borderTop + paddingTop,
                width,
                height,
                fitted.left,
                fitted.top,
                fitted.width,
                fitted.height,
            );
        } else {
            const {documentRect} = state.source;
            this._setOverlayGeometry(
                state,
                documentRect.left - window.scrollX,
                documentRect.top - window.scrollY,
                documentRect.width,
                documentRect.height,
                0,
                0,
                documentRect.width,
                documentRect.height,
            );
        }
    }

    /**
     * @param {import('ocr-controller').OverlayState} state
     * @param {number} left
     * @param {number} top
     * @param {number} width
     * @param {number} height
     * @param {number} imageLeft
     * @param {number} imageTop
     * @param {number} imageWidth
     * @param {number} imageHeight
     */
    _setOverlayGeometry(state, left, top, width, height, imageLeft, imageTop, imageWidth, imageHeight) {
        Object.assign(state.root.style, {
            left: `${left}px`,
            top: `${top}px`,
            width: `${width}px`,
            height: `${height}px`,
            display: width > 0 && height > 0 ? 'block' : 'none',
        });
        Object.assign(state.imageSpace.style, {
            left: `${imageLeft}px`,
            top: `${imageTop}px`,
            width: `${state.sourceWidth}px`,
            height: `${state.sourceHeight}px`,
            transform: `scale(${imageWidth / state.sourceWidth}, ${imageHeight / state.sourceHeight})`,
        });
    }

    /**
     * @param {number} x
     * @param {number} y
     * @returns {?import('text-source').TextSource}
     */
    _getRangeFromPoint(x, y) {
        const state = this._overlay;
        if (!this._enabled || state === null) { return null; }
        const vertical = state.root.dataset.mode === 'vertical';
        for (const node of state.lineNodes) {
            const textNode = node.firstChild;
            if (!(textNode instanceof Text)) { continue; }
            const rect = node.getBoundingClientRect();
            if (!isPointInRect(rect, x, y)) { continue; }
            const offset = getTextOffsetFromPoint(x, y, rect, textNode.data, vertical);
            const range = document.createRange();
            range.setStart(textNode, offset);
            range.setEnd(textNode, Math.min(textNode.length, offset + this._getCodePointLength(textNode.data, offset)));
            return TextSourceRange.create(range);
        }
        return null;
    }

    /**
     * @param {string} text
     * @param {number} offset
     * @returns {number}
     */
    _getCodePointLength(text, offset) {
        const codePoint = text.codePointAt(offset);
        return typeof codePoint === 'number' && codePoint > 0xffff ? 2 : 1;
    }

    /**
     * @returns {Promise<?import('ocr-util').Rect>}
     */
    _selectRegion() {
        if (this._cancelRegionSelection !== null) {
            this._cancelRegionSelection();
        }
        return new Promise((resolve) => {
            const root = document.createElement('div');
            root.className = 'yomitan-ocr-region-selector scan-disable';
            const box = document.createElement('div');
            box.className = 'yomitan-ocr-region-box';
            root.appendChild(box);
            document.documentElement.appendChild(root);
            this._showToast('Drag over a screen region. Press Escape to cancel.');

            let startX = 0;
            let startY = 0;
            let pointerId = -1;
            let finished = false;
            /**
             * @param {?import('ocr-util').Rect} rect
             */
            const finish = (rect) => {
                if (finished) { return; }
                finished = true;
                root.remove();
                this._cancelRegionSelection = null;
                if (rect === null) {
                    this._hideToast();
                }
                resolve(rect);
            };
            this._cancelRegionSelection = () => finish(null);

            root.addEventListener('pointerdown', (event) => {
                if (event.button !== 0 || pointerId >= 0) { return; }
                pointerId = event.pointerId;
                startX = event.clientX;
                startY = event.clientY;
                root.setPointerCapture(pointerId);
                this._updateRegionBox(box, startX, startY, startX, startY);
            });
            root.addEventListener('pointermove', (event) => {
                if (event.pointerId !== pointerId) { return; }
                this._updateRegionBox(box, startX, startY, event.clientX, event.clientY);
            });
            root.addEventListener('pointerup', (event) => {
                if (event.pointerId !== pointerId) { return; }
                const left = Math.min(startX, event.clientX);
                const top = Math.min(startY, event.clientY);
                const width = Math.abs(event.clientX - startX);
                const height = Math.abs(event.clientY - startY);
                if (width < MINIMUM_REGION_SIZE || height < MINIMUM_REGION_SIZE) {
                    this._showToast('The selected OCR region is too small.', true, 4000);
                    finish(null);
                    return;
                }
                finish({left, top, width, height});
            });
        });
    }

    /**
     * @param {HTMLDivElement} box
     * @param {number} x1
     * @param {number} y1
     * @param {number} x2
     * @param {number} y2
     */
    _updateRegionBox(box, x1, y1, x2, y2) {
        Object.assign(box.style, {
            left: `${Math.min(x1, x2)}px`,
            top: `${Math.min(y1, y2)}px`,
            width: `${Math.abs(x2 - x1)}px`,
            height: `${Math.abs(y2 - y1)}px`,
        });
    }

    /**
     * @param {string} dataUrl
     * @returns {Promise<HTMLImageElement>}
     */
    async _loadImage(dataUrl) {
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        return image;
    }

    /**
     * @param {string} value
     * @returns {[number, number]}
     */
    _parseObjectPosition(value) {
        const parts = value.trim().split(/\s+/u);
        return [
            this._parseObjectPositionPart(parts[0] ?? '50%'),
            this._parseObjectPositionPart(parts[1] ?? '50%'),
        ];
    }

    /**
     * @param {string} value
     * @returns {number}
     */
    _parseObjectPositionPart(value) {
        switch (value) {
            case 'left':
            case 'top':
                return 0;
            case 'right':
            case 'bottom':
                return 1;
            case 'center':
                return 0.5;
            default: {
                const match = /^(-?\d+(?:\.\d+)?)%$/u.exec(value);
                return match !== null ? Number(match[1]) / 100 : 0.5;
            }
        }
    }

    /**
     * @param {string} value
     * @returns {number}
     */
    _cssPixels(value) {
        const number = Number.parseFloat(value);
        return Number.isFinite(number) ? number : 0;
    }

    /**
     * @param {boolean} showMessage
     */
    _clear(showMessage) {
        this._jobToken = null;
        if (this._cancelRegionSelection !== null) {
            this._cancelRegionSelection();
        }
        const hadOverlay = this._overlay !== null;
        this._clearOverlay();
        if (showMessage) {
            this._showToast(hadOverlay ? 'OCR results removed.' : 'There are no OCR results to remove.', !hadOverlay, 3500);
        }
    }

    /**
     * Removes the current mapped text layer.
     */
    _clearOverlay() {
        const state = this._overlay;
        if (state === null) { return; }
        state.resizeObserver?.disconnect();
        state.root.dispatchEvent(new CustomEvent('yomitan-ocr-disconnect'));
        state.root.remove();
        this._overlay = null;
    }

    /**
     * @param {?string} status
     * @returns {string}
     */
    _humanizeStatus(status) {
        if (typeof status !== 'string' || status.length === 0) { return 'Running local OCR…'; }
        return `${status.charAt(0).toUpperCase()}${status.slice(1).replaceAll('_', ' ')}…`;
    }

    /**
     * @param {string} message
     * @param {boolean} [error]
     * @param {number} [duration]
     */
    _showToast(message, error = false, duration = 0) {
        const existingToast = document.querySelector('.yomitan-ocr-toast');
        /** @type {HTMLElement} */
        let toast;
        if (existingToast instanceof HTMLElement) {
            toast = existingToast;
        } else {
            toast = document.createElement('div');
            toast.className = 'yomitan-ocr-toast scan-disable';
            toast.setAttribute('role', 'status');
            toast.setAttribute('aria-live', 'polite');
            document.documentElement.appendChild(toast);
        }
        toast.textContent = message;
        toast.dataset.error = `${error}`;
        if (this._toastTimer !== null) {
            clearTimeout(this._toastTimer);
            this._toastTimer = null;
        }
        if (duration > 0) {
            this._toastTimer = setTimeout(() => this._hideToast(), duration);
        }
    }

    /**
     * Removes the OCR status notification.
     */
    _hideToast() {
        document.querySelector('.yomitan-ocr-toast')?.remove();
        if (this._toastTimer !== null) {
            clearTimeout(this._toastTimer);
            this._toastTimer = null;
        }
    }
}
