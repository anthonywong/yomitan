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

import {assertOcrResult} from './ocr-engine.js';
import {safePerformance} from '../core/safe-performance.js';

/**
 * Runs an engine-neutral fixture set. It deliberately records raw normalized
 * output and elapsed time only; scoring belongs to the evaluation harness so
 * this boundary never manufactures accuracy claims.
 * @param {import('ocr-engine').OcrEngine} engine
 * @param {Iterable<import('ocr-engine').OcrBenchmarkCase>} cases
 * @param {{signal?: AbortSignal, now?: () => number}} [options]
 * @returns {Promise<import('ocr-engine').OcrBenchmarkRun>}
 */
export async function runOcrBenchmark(engine, cases, {signal, now = () => safePerformance.now()} = {}) {
    /** @type {import('ocr-engine').OcrBenchmarkCaseResult[]} */
    const results = [];
    for (const benchmarkCase of cases) {
        if (signal?.aborted) { throw signal.reason ?? new DOMException('OCR benchmark aborted', 'AbortError'); }
        const startedAt = now();
        const result = await engine.recognize(benchmarkCase.input, {signal});
        assertOcrResult(result);
        const elapsedMs = now() - startedAt;
        if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
            throw new TypeError('OCR benchmark clock returned an invalid duration');
        }
        results.push({id: benchmarkCase.id, elapsedMs, result});
    }
    return {engineId: engine.id, results};
}
