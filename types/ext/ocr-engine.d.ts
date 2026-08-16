/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

export type OcrPoint = [number, number];

export type OcrWritingMode = 'horizontal-tb' | 'vertical-rl' | 'vertical-lr';

export type OcrLine = {text: string, score: number, polygon: OcrPoint[], writingMode: OcrWritingMode, order?: number};

export type OcrResult = {lines: OcrLine[]};

export type OcrEngine = {id: string, recognize(input: unknown, options?: {signal?: AbortSignal}): Promise<OcrResult>, dispose?(): Promise<void>};

export type OcrBenchmarkCase = {id: string, input: unknown};

export type OcrBenchmarkCaseResult = {id: string, elapsedMs: number, result: OcrResult};

export type OcrBenchmarkRun = {engineId: string, results: OcrBenchmarkCaseResult[]};

export type PaddleOcrAssetUrls = {detectorModel: string, recognizerModel: string, ortWasm: string, opencv: string};

/** PaddleOCR.js construction contract skeleton; integration remains unproven. */
export type PaddleOcrCreateOptions = {
    textDetectionModelName: string;
    textDetectionModelAsset: {url: string};
    textRecognitionModelName: string;
    textRecognitionModelAsset: {url: string};
    worker: true;
    ortOptions: {backend: 'wasm', wasmPaths: string, numThreads: 1};
};

export type PaddleOcrSession = {predict(input: unknown): unknown, dispose?(): Promise<void> | void};

export type CreatePaddleOcr = (options: PaddleOcrCreateOptions) => Promise<PaddleOcrSession> | PaddleOcrSession;
