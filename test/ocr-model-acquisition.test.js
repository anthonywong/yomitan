/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {acquireOcrModelCandidates, assertOcrModelCandidates, createOcrModelVerificationLock, OCR_MODEL_FETCH_TIMEOUT_MS} from '../dev/ocr-model-acquisition.js';
import {getSha256} from '../dev/ocr-asset-util.js';

/** @type {string[]} */
const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) { fs.rmSync(directory, {recursive: true, force: true}); } });

/** @returns {Buffer} */
function makeModelArchive() {
    /** @type {Buffer[]} */ const blocks = [];
    /** @param {string} name @param {string} text @param {string} type */
    const entry = (name, text, type) => {
        const contents = Buffer.from(text);
        const header = Buffer.alloc(512);
        header.write(name); header.write(`${contents.byteLength.toString(8).padStart(11, '0')}\0`, 124); header.write(type, 156); header.write('ustar\0', 257);
        header.fill(32, 148, 156);
        let checksum = 0; for (const byte of header) { checksum += byte; }
        header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
        blocks.push(header, contents, Buffer.alloc(Math.ceil(contents.byteLength / 512) * 512 - contents.byteLength));
    };
    entry('PP-OCRv5_mobile_det_onnx_infer/', '', '5');
    entry('PP-OCRv5_mobile_det_onnx_infer/.cache/', '', '5');
    entry('PP-OCRv5_mobile_det_onnx_infer/inference.onnx', 'model', '0');
    entry('PP-OCRv5_mobile_det_onnx_infer/inference.yml', 'config', '0');
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
}

/** @param {Buffer} source */
function makeCandidates(source) {
    return {schemaVersion: 1, upstream: {sdkPackage: '@paddleocr/paddleocr-js', sdkVersion: '0.4.2', sdkCommit: 'e5046169b225bcdfbe25d45b4e809ff0f1a69c2c', sdkSourceUrl: 'https://github.com/PaddlePaddle/PaddleOCR/tree/e5046169b225bcdfbe25d45b4e809ff0f1a69c2c/paddleocr-js/packages/core'}, publicRelease: {status: 'legal-review-required', gate: 'test'}, models: [{id: 'PP-OCRv5_mobile_det_onnx_infer', role: 'detector', url: 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_onnx_infer.tar', sha256: getSha256(source), bytes: source.byteLength, archiveRoot: 'PP-OCRv5_mobile_det_onnx_infer'}]};
}

describe('OCR model acquisition', () => {
    test('writes verified artifacts plus stable and volatile reports without network access', async () => {
        const source = makeModelArchive();
        const candidates = makeCandidates(source);
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'yomitan-ocr-acquisition-')); directories.push(parent);
        const cacheDirectory = path.join(parent, 'new-cache-parent', 'cache');
        const fetchImpl = /** @type {typeof fetch} */ (async () => new Response(source, {status: 200, headers: {'content-length': String(source.byteLength)}}));
        const report = await acquireOcrModelCandidates({candidates, cacheDirectory, fetchImpl, now: () => new Date('2026-08-19T00:00:00.000Z')});
        expect(fs.readFileSync(path.join(cacheDirectory, 'PP-OCRv5_mobile_det_onnx_infer.tar'))).toStrictEqual(source);
        expect(JSON.parse(fs.readFileSync(path.join(cacheDirectory, 'verification-lock.json'), 'utf8'))).toStrictEqual(createOcrModelVerificationLock(candidates));
        expect(report.retrieval).toStrictEqual({retrievedAt: '2026-08-19T00:00:00.000Z', models: [{id: 'PP-OCRv5_mobile_det_onnx_infer', finalUrl: candidates.models[0].url, sha256: candidates.models[0].sha256, bytes: source.byteLength, archiveRoot: 'PP-OCRv5_mobile_det_onnx_infer'}]});
    });

    test('rejects candidate URLs outside the pinned official model path before fetching', () => {
        const candidates = makeCandidates(makeModelArchive());
        candidates.models[0].url = 'https://example.test/model.tar';
        expect(() => assertOcrModelCandidates(candidates)).toThrow('invalid');
    });

    test('rejects a body that exceeds the candidate limit despite a misleading content length', async () => {
        const source = makeModelArchive();
        const candidates = makeCandidates(source);
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'yomitan-ocr-acquisition-')); directories.push(parent);
        const cacheDirectory = path.join(parent, 'cache');
        const oversized = Buffer.concat([source, Buffer.from('extra')]);
        const fetchImpl = /** @type {typeof fetch} */ (async () => new Response(oversized, {status: 200, headers: {'content-length': String(source.byteLength)}}));
        await expect(acquireOcrModelCandidates({candidates, cacheDirectory, fetchImpl})).rejects.toThrow('byte limit');
        expect(fs.existsSync(cacheDirectory)).toBe(false);
    });

    test('aborts a stalled response at the fixed download timeout', async () => {
        vi.useFakeTimers();
        try {
            const source = makeModelArchive();
            const candidates = makeCandidates(source);
            const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'yomitan-ocr-acquisition-')); directories.push(parent);
            const cacheDirectory = path.join(parent, 'cache');
            const stalled = new ReadableStream({pull: () => new Promise(() => {})});
            const fetchImpl = /** @type {typeof fetch} */ (async () => new Response(stalled, {status: 200, headers: {'content-length': String(source.byteLength)}}));
            const result = acquireOcrModelCandidates({candidates, cacheDirectory, fetchImpl});
            const rejection = expect(result).rejects.toMatchObject({name: 'TimeoutError'});
            await vi.advanceTimersByTimeAsync(OCR_MODEL_FETCH_TIMEOUT_MS);
            await rejection;
            expect(fs.existsSync(cacheDirectory)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
