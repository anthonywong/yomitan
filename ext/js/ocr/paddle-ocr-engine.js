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

import {normalizeOcrResult} from './ocr-engine.js';

/** Raised when a result belongs to a disposed/replaced local OCR session. */
export class OcrEngineStaleSessionError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        /** @type {string} */
        this.name = 'OcrEngineStaleSessionError';
    }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {URL} expectedExtensionOrigin
 * @param {string} allowedPathPrefix
 * @param {string} extension
 * @returns {string}
 * @throws {TypeError}
 */
function assertLocalExtensionUrl(value, name, expectedExtensionOrigin, allowedPathPrefix, extension) {
    if (typeof value !== 'string') {
        throw new TypeError(`${name} must be a local extension URL`);
    }
    let url;
    try {
        url = new URL(value);
    } catch (error) {
        throw new TypeError(`${name} must be a local extension URL`, {cause: error});
    }
    if (url.protocol !== expectedExtensionOrigin.protocol || url.host !== expectedExtensionOrigin.host || url.search.length > 0 || url.hash.length > 0 || !url.pathname.startsWith(allowedPathPrefix) || !url.pathname.endsWith(extension) || /%2f|%5c|%2e/iu.test(url.pathname)) {
        throw new TypeError(`${name} must be a local extension URL`);
    }
    return url.href;
}

/**
 * Rejects HTTP(S), data, blob, and page-origin asset locations. The caller must
 * obtain these values from browser.runtime.getURL; no SDK default URL is used.
 * @param {unknown} value
 * @param {string} expectedExtensionOrigin
 * @returns {import('ocr-engine').PaddleOcrAssetUrls}
 * @throws {TypeError}
 */
export function validatePaddleOcrAssetUrls(value, expectedExtensionOrigin) {
    if (typeof value !== 'object' || value === null) {
        throw new TypeError('Paddle OCR assets must be an object');
    }
    /** @type {URL} */
    let origin;
    try {
        origin = new URL(expectedExtensionOrigin);
    } catch (error) {
        throw new TypeError('expectedExtensionOrigin must be an extension origin', {cause: error});
    }
    if (!['chrome-extension:', 'moz-extension:'].includes(origin.protocol) || (origin.pathname !== '' && origin.pathname !== '/') || origin.search.length > 0 || origin.hash.length > 0) {
        throw new TypeError('expectedExtensionOrigin must be an extension origin');
    }
    const urls = /** @type {Record<string, unknown>} */ (value);
    return {
        detectorModel: assertLocalExtensionUrl(urls.detectorModel, 'detectorModel', origin, '/lib/paddleocr/models/', '.tar'),
        recognizerModel: assertLocalExtensionUrl(urls.recognizerModel, 'recognizerModel', origin, '/lib/paddleocr/models/', '.tar'),
        ortWasm: assertLocalExtensionUrl(urls.ortWasm, 'ortWasm', origin, '/lib/paddleocr/ort/', '.wasm'),
        opencv: assertLocalExtensionUrl(urls.opencv, 'opencv', origin, '/lib/paddleocr/opencv/', '.js'),
    };
}

/**
 * @param {AbortSignal|undefined} signal
 * @throws {DOMException}
 */
function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw signal.reason ?? new DOMException('OCR request aborted', 'AbortError');
    }
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<T>}
 */
function waitForResultOrAbort(promise, signal) {
    if (signal === void 0) { return promise; }
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        /** @param {Event} _event */
        const onAbort = (_event) => {
            signal.removeEventListener('abort', onAbort);
            reject(signal.reason ?? new DOMException('OCR request aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, {once: true});
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

/**
 * Adapter boundary for the official browser SDK. The factory is injected so
 * this source neither imports PaddleOCR nor permits its remote model defaults.
 */
export class PaddleOcrEngine {
    /**
     * Contract skeleton, not a verified SDK integration. The option names below
     * follow PaddleOCR.js' documented custom-model and worker configuration.
     * @param {{createPaddleOcr: import('ocr-engine').CreatePaddleOcr, assetUrls: import('ocr-engine').PaddleOcrAssetUrls, expectedExtensionOrigin: string}} options
     */
    constructor({createPaddleOcr, assetUrls, expectedExtensionOrigin}) {
        if (typeof createPaddleOcr !== 'function') {
            throw new TypeError('createPaddleOcr must be a function');
        }
        /**
         *
         */
        this.id = 'paddleocr-local';
        /**
         *
         */
        this._createPaddleOcr = createPaddleOcr;
        /**
         *
         */
        this._assetUrls = validatePaddleOcrAssetUrls(assetUrls, expectedExtensionOrigin);
        /**
         *
         */
        this._generation = 0;
        /** @type {?import('ocr-engine').PaddleOcrSession} */
        this._session = null;
        /** @type {?{generation: number, promise: Promise<import('ocr-engine').PaddleOcrSession>}} */
        this._initialization = null;
    }

    /**
     * @returns {import('ocr-engine').PaddleOcrCreateOptions}
     */
    _getCreateOptions() {
        const {detectorModel, recognizerModel, ortWasm} = this._assetUrls;
        return {
            textDetectionModelName: 'yomitan-local-detector',
            textDetectionModelAsset: {url: detectorModel},
            textRecognitionModelName: 'yomitan-local-recognizer',
            textRecognitionModelAsset: {url: recognizerModel},
            worker: true,
            ortOptions: {
                backend: 'wasm',
                wasmPaths: new URL('.', ortWasm).href,
                numThreads: 1,
            },
        };
    }

    /**
     * @returns {Promise<import('ocr-engine').PaddleOcrSession>}
     */
    async _getSession() {
        const generation = this._generation;
        if (this._session !== null) { return this._session; }
        if (this._initialization === null || this._initialization.generation !== generation) {
            this._initialization = {
                generation,
                promise: Promise.resolve(this._createPaddleOcr(this._getCreateOptions())),
            };
        }
        /** @type {import('ocr-engine').PaddleOcrSession} */
        let session;
        try {
            session = await this._initialization.promise;
        } catch (error) {
            if (this._initialization?.generation === generation) { this._initialization = null; }
            throw error;
        }
        if (generation !== this._generation) {
            await Promise.resolve(session.dispose?.());
            throw new OcrEngineStaleSessionError('OCR session was replaced during initialization');
        }
        this._session = session;
        return session;
    }

    /**
     * @param {unknown} input
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<import('ocr-engine').OcrResult>}
     */
    async recognize(input, {signal} = {}) {
        throwIfAborted(signal);
        const generation = this._generation;
        /** @type {import('ocr-engine').PaddleOcrSession} */
        let session;
        try {
            session = await waitForResultOrAbort(this._getSession(), signal);
        } catch (error) {
            if (signal?.aborted) { await this.dispose(); }
            throw error;
        }
        if (generation !== this._generation) {
            throw new OcrEngineStaleSessionError('OCR session was replaced before prediction');
        }
        /** @type {unknown} */
        let value;
        try {
            value = await waitForResultOrAbort(Promise.resolve(session.predict(input)), signal);
        } catch (error) {
            if (signal?.aborted) { await this.dispose(); }
            throw error;
        }
        if (generation !== this._generation) {
            throw new OcrEngineStaleSessionError('OCR result belongs to a stale session');
        }
        const result = Array.isArray(value) ? /** @type {unknown[]} */ (value)[0] ?? null : value;
        const record = typeof result === 'object' && result !== null ? /** @type {Record<string, unknown>} */ (result) : {};
        const dimensions = record.image ?? null;
        return normalizeOcrResult(result, dimensions);
    }

    /**
     * @returns {Promise<void>}
     */
    async dispose() {
        this._generation += 1;
        const session = this._session;
        this._session = null;
        this._initialization = null;
        if (session !== null) {
            await Promise.resolve(session.dispose?.());
        }
    }
}
