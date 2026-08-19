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

/** Error raised when an OCR engine returns data unsafe for DOM/scanner use. */
export class OcrEngineResultError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        /** @type {string} */
        this.name = 'OcrEngineResultError';
    }
}

export const MAX_OCR_ITEMS = 256;

export const MAX_OCR_TEXT_CODE_POINTS = 512;

export const OCR_COORDINATE_LIMIT = 1_000_000;

export const OCR_BOUNDS_TOLERANCE = 1;

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {unknown} value
 * @returns {value is import('ocr-engine').OcrPoint}
 */
function isPoint(value) {
    return Array.isArray(value) && value.length === 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1]);
}

/**
 * @param {import('ocr-engine').OcrPoint[]} polygon
 * @returns {boolean}
 */
export function isFiniteConvexPolygon(polygon) {
    if (polygon.length !== 4 || !polygon.every(isPoint)) { return false; }
    let direction = 0;
    for (let index = 0; index < polygon.length; ++index) {
        const [firstX, firstY] = polygon[index];
        const [secondX, secondY] = polygon[(index + 1) % polygon.length];
        const [thirdX, thirdY] = polygon[(index + 2) % polygon.length];
        const cross = (secondX - firstX) * (thirdY - secondY) - (secondY - firstY) * (thirdX - secondX);
        if (!Number.isFinite(cross) || Math.abs(cross) <= Number.EPSILON) { return false; }
        const nextDirection = Math.sign(cross);
        if (direction !== 0 && direction !== nextDirection) { return false; }
        direction = nextDirection;
    }
    return true;
}

/**
 * @param {unknown} value
 * @param {number} index
 * @param {{width: number, height: number}} sourceDimensions
 * @returns {import('ocr-engine').OcrLine}
 * @throws {OcrEngineResultError}
 */
function normalizeOcrLine(value, index, sourceDimensions) {
    if (typeof value !== 'object' || value === null) {
        throw new OcrEngineResultError(`OCR item ${index} must be an object`);
    }
    const item = /** @type {{text?: unknown, score?: unknown, poly?: unknown, polygon?: unknown, writingMode?: unknown, order?: unknown}} */ (value);
    if (typeof item.text !== 'string') {
        throw new OcrEngineResultError(`OCR item ${index} text must be a string`);
    }
    const text = item.text.normalize('NFC').trim();
    if (text.length === 0 || [...text].length > MAX_OCR_TEXT_CODE_POINTS) {
        throw new OcrEngineResultError(`OCR item ${index} text must not be empty`);
    }
    const score = item.score;
    if (!isFiniteNumber(score) || score < 0 || score > 1) {
        throw new OcrEngineResultError(`OCR item ${index} score must be between zero and one`);
    }
    const sourcePolygon = item.poly ?? item.polygon;
    if (!Array.isArray(sourcePolygon) || !sourcePolygon.every(isPoint)) {
        throw new OcrEngineResultError(`OCR item ${index} polygon must be finite and strictly convex`);
    }
    const polygon = /** @type {import('ocr-engine').OcrPoint[]} */ (sourcePolygon);
    if (!isFiniteConvexPolygon(polygon)) {
        throw new OcrEngineResultError(`OCR item ${index} polygon must be finite and strictly convex`);
    }
    for (const [x, y] of polygon) {
        if (Math.abs(x) > OCR_COORDINATE_LIMIT || Math.abs(y) > OCR_COORDINATE_LIMIT || x < -OCR_BOUNDS_TOLERANCE || y < -OCR_BOUNDS_TOLERANCE || x > sourceDimensions.width + OCR_BOUNDS_TOLERANCE || y > sourceDimensions.height + OCR_BOUNDS_TOLERANCE) {
            throw new OcrEngineResultError(`OCR item ${index} polygon is outside the source bounds`);
        }
    }
    const writingMode = item.writingMode === 'vertical-rl' || item.writingMode === 'vertical-lr' ? item.writingMode : 'horizontal-tb';
    /** @type {import('ocr-engine').OcrLine} */
    const line = {
        text,
        score,
        polygon: polygon.map(([x, y]) => /** @type {import('ocr-engine').OcrPoint} */ ([x, y])),
        writingMode,
    };
    const order = item.order;
    if (typeof order === 'number' && Number.isSafeInteger(order) && order >= 0) { line.order = order; }
    return line;
}

/**
 * Normalizes the minimal geometry contract common to OCR engines. The caller
 * must add reading order and character subdivisions separately; those are not
 * inferred from a detector polygon here.
 * @param {unknown} value
 * @param {unknown} sourceDimensions
 * @returns {import('ocr-engine').OcrResult}
 * @throws {OcrEngineResultError}
 */
export function normalizeOcrResult(value, sourceDimensions) {
    if (typeof value !== 'object' || value === null || !Array.isArray(/** @type {{items?: unknown}} */ (value).items)) {
        throw new OcrEngineResultError('OCR result must contain an items array');
    }
    if (typeof sourceDimensions !== 'object' || sourceDimensions === null || !isFiniteNumber(/** @type {{width?: unknown}} */ (sourceDimensions).width) || !isFiniteNumber(/** @type {{height?: unknown}} */ (sourceDimensions).height) || /** @type {{width: number}} */ (sourceDimensions).width <= 0 || /** @type {{height: number}} */ (sourceDimensions).height <= 0) {
        throw new OcrEngineResultError('OCR result must include finite source image dimensions');
    }
    const items = /** @type {unknown[]} */ (/** @type {{items: unknown[]}} */ (value).items);
    if (items.length > MAX_OCR_ITEMS) { throw new OcrEngineResultError('OCR result has too many items'); }
    const dimensions = /** @type {{width: number, height: number}} */ (sourceDimensions);
    return {lines: items.map((item, index) => normalizeOcrLine(item, index, dimensions))};
}

/**
 * @param {unknown} value
 * @returns {asserts value is import('ocr-engine').OcrResult}
 * @throws {OcrEngineResultError}
 */
export function assertOcrResult(value) {
    if (typeof value !== 'object' || value === null || !Array.isArray(/** @type {{lines?: unknown}} */ (value).lines)) {
        throw new OcrEngineResultError('OCR result must contain lines');
    }
    const lines = /** @type {unknown[]} */ (/** @type {{lines: unknown[]}} */ (value).lines);
    if (lines.length > MAX_OCR_ITEMS) {
        throw new OcrEngineResultError('OCR result has too many items');
    }
    for (const [index, line] of lines.entries()) {
        if (typeof line !== 'object' || line === null) {
            throw new OcrEngineResultError(`OCR line ${index} must be an object`);
        }
        const record = /** @type {{polygon?: unknown}} */ (line);
        normalizeOcrLine({
            ...(line),
            poly: record.polygon,
        }, index, {width: OCR_COORDINATE_LIMIT, height: OCR_COORDINATE_LIMIT});
    }
}
