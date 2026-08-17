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

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {parseJson} from '../dev/json.js';

const directory = dirname(fileURLToPath(import.meta.url));
const candidates = /** @type {{schemaVersion: unknown, purpose: unknown, upstream: {sdkPackage: unknown, sdkVersion: unknown, sdkSourceUrl: unknown}, publicRelease: {status: unknown, gate: unknown}, models: Array<{id: string, role: string, url: string, sha256: string, bytes: number, archiveRoot: string}>}} */ (parseJson(readFileSync(join(directory, '..', 'dev', 'data', 'ocr-model-candidates.json'), {encoding: 'utf8'})));

const expectedHashes = new Map([
    ['PP-OCRv5_mobile_det_onnx_infer', '781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30'],
    ['PP-OCRv5_mobile_rec_onnx_infer', 'f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c'],
    ['PP-OCRv6_small_det_onnx_infer', 'd218f6fbf0f1c23d2161bd6ac7f5eaa6104fa89955c09290497e31008e2618e4'],
    ['PP-OCRv6_small_rec_onnx_infer', 'd267ab077a44a0eedb1ea8f8c542d263f211de8e9d7a029bf9fcfff7e5a88fb1'],
    ['PP-OCRv6_tiny_det_onnx_infer', 'ff6ab415b0a6e0c488550f2fb5d5046f1719848df220b2dc21b56402a65bc05d'],
    ['PP-OCRv6_tiny_rec_onnx_infer', '1e13b22717b1edd89d4cde4fda272b6c17d5b505c97c2baea99da1a3a2d54b29'],
]);

describe('OCR model candidate provenance', () => {
    test('pins official sources and hashes without authorizing a public release', () => {
        expect(candidates.schemaVersion).toBe(1);
        expect(candidates.purpose).toContain('does not authorize');
        expect(candidates.upstream).toStrictEqual({
            sdkPackage: '@paddleocr/paddleocr-js',
            sdkVersion: '0.4.2',
            sdkSourceUrl: 'https://github.com/PaddlePaddle/PaddleOCR/tree/main/paddleocr-js/packages/core',
        });
        expect(candidates.publicRelease).toStrictEqual({
            status: 'legal-review-required',
            gate: 'Do not package or redistribute until model provenance and license review are approved.',
        });
        expect(candidates.models).toHaveLength(expectedHashes.size);
        for (const candidate of candidates.models) {
            expect(candidate.url).toBe(`https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/${candidate.id}.tar`);
            expect(candidate.sha256).toBe(expectedHashes.get(candidate.id));
            expect(candidate.bytes).toBeGreaterThan(0);
            expect(candidate.archiveRoot).toBe(candidate.id);
            expect(['detector', 'recognizer']).toContain(candidate.role);
        }
    });
});
