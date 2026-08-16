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

import {describe, expect, test} from 'vitest';
import {runOcrBenchmark} from '../ext/js/ocr/ocr-benchmark-adapter.js';
import {assertOcrResult, isFiniteConvexPolygon, normalizeOcrResult, OcrEngineResultError} from '../ext/js/ocr/ocr-engine.js';
import {OcrEngineStaleSessionError, PaddleOcrEngine, validatePaddleOcrAssetUrls} from '../ext/js/ocr/paddle-ocr-engine.js';

const localAssets = {
    detectorModel: 'chrome-extension://test-id/lib/paddleocr/models/detector.tar',
    recognizerModel: 'chrome-extension://test-id/lib/paddleocr/models/recognizer.tar',
    ortWasm: 'chrome-extension://test-id/lib/paddleocr/ort/ort-wasm-simd.wasm',
    opencv: 'chrome-extension://test-id/lib/paddleocr/opencv/opencv.js',
};

/** @type {import('ocr-engine').OcrPoint[]} */
const polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
const sourceDimensions = {width: 20, height: 20};
const expectedExtensionOrigin = 'chrome-extension://test-id';

/**
 * @returns {{promise: Promise<unknown>, resolve: (value: unknown) => void}}
 */
function deferred() {
    /** @type {(value: unknown) => void} */
    let resolve = () => {};
    const promise = new Promise((promiseResolve) => { resolve = promiseResolve; });
    return {promise, resolve};
}

describe('OCR engine contracts', () => {
    test('normalizes Paddle-shaped output and rejects unsafe geometry', () => {
        expect(normalizeOcrResult({items: [{text: ' 画\u{50cf} ', score: 0.8, poly: polygon, writingMode: 'vertical-rl', order: 2}]}, sourceDimensions)).toStrictEqual({
            lines: [{text: '画像', score: 0.8, polygon, writingMode: 'vertical-rl', order: 2}],
        });
        expect(isFiniteConvexPolygon(polygon)).toBe(true);
        expect(isFiniteConvexPolygon([[0, 0], [10, 0], [0, 10], [10, 10]])).toBe(false);
        expect(() => normalizeOcrResult({items: [{text: '画像', score: 1.1, poly: polygon}]}, sourceDimensions)).toThrow(OcrEngineResultError);
        expect(() => normalizeOcrResult({items: [{text: '画像', score: 0.5, poly: [[0, 0], [10, 0], [10, Number.NaN], [0, 10]]}]}, sourceDimensions)).toThrow('strictly convex');
        expect(() => normalizeOcrResult({items: Array.from({length: 257}, () => ({text: '画像', score: 1, poly: polygon}))}, sourceDimensions)).toThrow('too many');
        expect(() => assertOcrResult({lines: Array.from({length: 257}, () => ({text: '画像', score: 1, polygon, writingMode: 'horizontal-tb'}))})).toThrow('too many');
        expect(() => normalizeOcrResult({items: [{text: '画'.repeat(513), score: 1, poly: polygon}]}, sourceDimensions)).toThrow('must not be empty');
        expect(() => normalizeOcrResult({items: [{text: '画像', score: 1, poly: [[0, 0], [21.1, 0], [21.1, 10], [0, 10]]}]}, sourceDimensions)).toThrow('outside');
    });

    test('requires explicit local extension asset URLs', () => {
        expect(validatePaddleOcrAssetUrls(localAssets, expectedExtensionOrigin)).toStrictEqual(localAssets);
        expect(() => validatePaddleOcrAssetUrls({...localAssets, detectorModel: 'https://cdn.example.test/detector.tar'}, expectedExtensionOrigin)).toThrow('local extension URL');
        expect(() => validatePaddleOcrAssetUrls({...localAssets, detectorModel: 'chrome-extension://foreign/lib/paddleocr/models/detector.tar'}, expectedExtensionOrigin)).toThrow('local extension URL');
        expect(() => validatePaddleOcrAssetUrls({...localAssets, ortWasm: 'chrome-extension://test-id/lib/paddleocr/models/ort.wasm'}, expectedExtensionOrigin)).toThrow('local extension URL');
    });

    test('passes only explicit local model and runtime locations into the injected Paddle factory', async () => {
        /** @type {unknown} */
        let receivedOptions;
        const engine = new PaddleOcrEngine({
            assetUrls: localAssets,
            expectedExtensionOrigin,
            createPaddleOcr: (options) => {
                receivedOptions = options;
                return {predict: () => ({image: sourceDimensions, items: [{text: '画像', score: 0.9, poly: polygon}]})};
            },
        });

        await expect(engine.recognize(new Blob(['image']))).resolves.toStrictEqual({
            lines: [{text: '画像', score: 0.9, polygon, writingMode: 'horizontal-tb'}],
        });
        expect(receivedOptions).toStrictEqual({
            textDetectionModelName: 'yomitan-local-detector',
            textDetectionModelAsset: {url: localAssets.detectorModel},
            textRecognitionModelName: 'yomitan-local-recognizer',
            textRecognitionModelAsset: {url: localAssets.recognizerModel},
            worker: true,
            ortOptions: {backend: 'wasm', wasmPaths: 'chrome-extension://test-id/lib/paddleocr/ort/', numThreads: 1},
        });
    });

    test('rejects a result when the engine is disposed while prediction is pending', async () => {
        const prediction = deferred();
        const engine = new PaddleOcrEngine({
            assetUrls: localAssets,
            expectedExtensionOrigin,
            createPaddleOcr: () => ({predict: () => prediction.promise}),
        });
        const result = engine.recognize(new Blob(['image']));
        await engine.dispose();
        prediction.resolve({items: [{text: '画像', score: 0.9, poly: polygon}]});
        await expect(result).rejects.toBeInstanceOf(OcrEngineStaleSessionError);
    });

    test('honors cancellation without inventing a remote fallback', async () => {
        const initialization = deferred();
        const controller = new AbortController();
        const engine = new PaddleOcrEngine({
            assetUrls: localAssets,
            expectedExtensionOrigin,
            createPaddleOcr: () => /** @type {Promise<import('ocr-engine').PaddleOcrSession>} */ (initialization.promise),
        });
        const result = engine.recognize(new Blob(['image']), {signal: controller.signal});
        controller.abort(new DOMException('test abort', 'AbortError'));
        await expect(result).rejects.toMatchObject({name: 'AbortError'});
        initialization.resolve({predict: () => ({items: []})});
        await engine.dispose();
    });

    test('runs an engine-neutral benchmark without calculating quality claims', async () => {
        /** @type {import('ocr-engine').OcrEngine} */
        const engine = {
            id: 'fake-local-engine',
            recognize: async () => ({lines: [{text: '画像', score: 1, polygon, writingMode: 'horizontal-tb'}]}),
        };
        const run = await runOcrBenchmark(engine, [{id: 'fixture-one', input: new Blob(['image'])}], {now: (() => {
            let value = 100;
            return () => (value += 5);
        })()});
        expect(run).toStrictEqual({
            engineId: 'fake-local-engine',
            results: [{id: 'fixture-one', elapsedMs: 5, result: {lines: [{text: '画像', score: 1, polygon, writingMode: 'horizontal-tb'}]}}],
        });
    });
});
