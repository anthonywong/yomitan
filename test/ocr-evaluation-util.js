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

/**
 * Normalizes OCR text only for evaluation. Production OCR must retain its
 * original text separately so that scanner behavior is not changed by scoring.
 * @param {string} text
 * @returns {string}
 */
export function normalizeOcrText(text) {
    return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function toCodePoints(text) {
    return [...text];
}

/**
 * @param {string} expected
 * @param {string} actual
 * @returns {number}
 */
export function getLevenshteinDistance(expected, actual) {
    const expectedCharacters = toCodePoints(expected);
    const actualCharacters = toCodePoints(actual);
    if (expectedCharacters.length === 0) { return actualCharacters.length; }
    if (actualCharacters.length === 0) { return expectedCharacters.length; }

    let previous = Array.from({length: actualCharacters.length + 1}, (_value, index) => index);
    for (let expectedIndex = 1; expectedIndex <= expectedCharacters.length; ++expectedIndex) {
        const current = [expectedIndex];
        for (let actualIndex = 1; actualIndex <= actualCharacters.length; ++actualIndex) {
            const substitutionCost = expectedCharacters[expectedIndex - 1] === actualCharacters[actualIndex - 1] ? 0 : 1;
            current.push(Math.min(
                previous[actualIndex] + 1,
                current[actualIndex - 1] + 1,
                previous[actualIndex - 1] + substitutionCost,
            ));
        }
        previous = current;
    }
    return previous[actualCharacters.length];
}

/**
 * @param {string} expected
 * @param {string} actual
 * @returns {number}
 */
export function getCharacterErrorRate(expected, actual) {
    const expectedLength = toCodePoints(expected).length;
    if (expectedLength === 0) {
        return actual.length === 0 ? 0 : 1;
    }
    return getLevenshteinDistance(expected, actual) / expectedLength;
}

/**
 * @param {import('test/ocr-evaluation').Point} point
 * @param {import('test/ocr-evaluation').Point} start
 * @param {import('test/ocr-evaluation').Point} end
 * @returns {boolean}
 */
function isPointOnSegment(point, start, end) {
    const [x, y] = point;
    const [startX, startY] = start;
    const [endX, endY] = end;
    const cross = (x - startX) * (endY - startY) - (y - startY) * (endX - startX);
    if (Math.abs(cross) > Number.EPSILON) { return false; }
    return x >= Math.min(startX, endX) && x <= Math.max(startX, endX) && y >= Math.min(startY, endY) && y <= Math.max(startY, endY);
}

/**
 * @param {import('test/ocr-evaluation').Point} point
 * @param {import('test/ocr-evaluation').Point[]} polygon
 * @returns {boolean}
 */
export function isPointInPolygon(point, polygon) {
    if (polygon.length < 3) { return false; }
    let inside = false;
    const [x, y] = point;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const start = polygon[j];
        const end = polygon[i];
        if (isPointOnSegment(point, start, end)) { return true; }
        const [startX, startY] = start;
        const [endX, endY] = end;
        const intersects = ((startY > y) !== (endY > y)) && (x < ((endX - startX) * (y - startY)) / (endY - startY) + startX);
        if (intersects) { inside = !inside; }
    }
    return inside;
}

/**
 * @param {import('test/ocr-evaluation').Point[]} polygon
 * @returns {number}
 */
export function getPolygonArea(polygon) {
    if (polygon.length < 3) { return 0; }
    let result = 0;
    for (let i = 0; i < polygon.length; ++i) {
        const [x1, y1] = polygon[i];
        const [x2, y2] = polygon[(i + 1) % polygon.length];
        result += x1 * y2 - x2 * y1;
    }
    return Math.abs(result) / 2;
}

/**
 * @param {import('test/ocr-evaluation').Point[]} polygon
 * @returns {import('test/ocr-evaluation').Bounds}
 */
export function getPolygonBounds(polygon) {
    if (polygon.length === 0) {
        return {left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0};
    }
    const xs = polygon.map(([x]) => x);
    const ys = polygon.map(([, y]) => y);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const right = Math.max(...xs);
    const bottom = Math.max(...ys);
    return {left, top, right, bottom, width: right - left, height: bottom - top};
}

/**
 * @param {import('test/ocr-evaluation').Point[]} polygon
 * @returns {import('test/ocr-evaluation').Point[]}
 */
function toCounterClockwise(polygon) {
    let signedArea = 0;
    for (let i = 0; i < polygon.length; ++i) {
        const [x1, y1] = polygon[i];
        const [x2, y2] = polygon[(i + 1) % polygon.length];
        signedArea += x1 * y2 - x2 * y1;
    }
    return signedArea >= 0 ? polygon : [...polygon].reverse();
}

/**
 * Clips a convex polygon using the Sutherland-Hodgman algorithm.
 * @param {import('test/ocr-evaluation').Point[]} subject
 * @param {import('test/ocr-evaluation').Point[]} clip
 * @returns {import('test/ocr-evaluation').Point[]}
 */
function getConvexPolygonIntersection(subject, clip) {
    let output = toCounterClockwise(subject);
    const clipPolygon = toCounterClockwise(clip);
    for (let i = 0; i < clipPolygon.length; ++i) {
        const start = clipPolygon[i];
        const end = clipPolygon[(i + 1) % clipPolygon.length];
        const input = output;
        output = [];
        if (input.length === 0) { break; }
        let previous = input.at(-1);
        for (const current of input) {
            const currentInside = isInsideClipEdge(current, start, end);
            const previousInside = isInsideClipEdge(/** @type {import('test/ocr-evaluation').Point} */ (previous), start, end);
            if (currentInside !== previousInside) {
                output.push(getLineIntersection(/** @type {import('test/ocr-evaluation').Point} */ (previous), current, start, end));
            }
            if (currentInside) { output.push(current); }
            previous = current;
        }
    }
    return output;
}

/**
 * @param {import('test/ocr-evaluation').Point} point
 * @param {import('test/ocr-evaluation').Point} start
 * @param {import('test/ocr-evaluation').Point} end
 * @returns {boolean}
 */
function isInsideClipEdge(point, start, end) {
    const [x, y] = point;
    const [startX, startY] = start;
    const [endX, endY] = end;
    return (endX - startX) * (y - startY) - (endY - startY) * (x - startX) >= -Number.EPSILON;
}

/**
 * @param {import('test/ocr-evaluation').Point} firstStart
 * @param {import('test/ocr-evaluation').Point} firstEnd
 * @param {import('test/ocr-evaluation').Point} secondStart
 * @param {import('test/ocr-evaluation').Point} secondEnd
 * @returns {import('test/ocr-evaluation').Point}
 */
function getLineIntersection(firstStart, firstEnd, secondStart, secondEnd) {
    const [x1, y1] = firstStart;
    const [x2, y2] = firstEnd;
    const [x3, y3] = secondStart;
    const [x4, y4] = secondEnd;
    const denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denominator) <= Number.EPSILON) { return firstEnd; }
    const determinant1 = x1 * y2 - y1 * x2;
    const determinant2 = x3 * y4 - y3 * x4;
    return [
        (determinant1 * (x3 - x4) - (x1 - x2) * determinant2) / denominator,
        (determinant1 * (y3 - y4) - (y1 - y2) * determinant2) / denominator,
    ];
}

/**
 * Returns IoU for convex polygons. OCR detector output is expected to be a
 * convex quadrilateral; callers must use another matcher for arbitrary shapes.
 * @param {import('test/ocr-evaluation').Point[]} first
 * @param {import('test/ocr-evaluation').Point[]} second
 * @returns {number}
 */
export function getConvexPolygonIntersectionOverUnion(first, second) {
    const firstArea = getPolygonArea(first);
    const secondArea = getPolygonArea(second);
    if (firstArea === 0 || secondArea === 0) { return 0; }
    const intersectionArea = getPolygonArea(getConvexPolygonIntersection(first, second));
    return intersectionArea / (firstArea + secondArea - intersectionArea);
}

/**
 * @param {import('test/ocr-evaluation').ScoredLine} first
 * @param {import('test/ocr-evaluation').ScoredLine} second
 * @returns {number}
 */
export function compareReadingOrder(first, second) {
    if (typeof first.order === 'number' && typeof second.order === 'number' && first.order !== second.order) {
        return first.order - second.order;
    }
    const firstBounds = getPolygonBounds(first.polygon);
    const secondBounds = getPolygonBounds(second.polygon);
    if (first.writingMode !== second.writingMode) {
        return (firstBounds.top - secondBounds.top) || (firstBounds.left - secondBounds.left) || compareText(first.text, second.text);
    }
    switch (first.writingMode) {
        case 'vertical-rl':
            return (secondBounds.left - firstBounds.left) || (firstBounds.top - secondBounds.top) || compareText(first.text, second.text);
        case 'vertical-lr':
            return (firstBounds.left - secondBounds.left) || (firstBounds.top - secondBounds.top) || compareText(first.text, second.text);
        default:
            return (firstBounds.top - secondBounds.top) || (firstBounds.left - secondBounds.left) || compareText(first.text, second.text);
    }
}

/**
 * @param {string} first
 * @param {string} second
 * @returns {number}
 */
function compareText(first, second) {
    return first < second ? -1 : (first > second ? 1 : 0);
}

/**
 * @param {import('test/ocr-evaluation').ScoredLine} line
 * @param {number} minimumScore
 * @returns {boolean}
 */
export function isAcceptedOcrLine(line, minimumScore) {
    return Number.isFinite(line.score) && line.score >= minimumScore && normalizeOcrText(line.text).length > 0;
}

/**
 * @param {import('test/ocr-evaluation').ScoredLine[][]} results
 * @param {number} minimumScore
 * @returns {number}
 */
export function countNoTextFalsePositives(results, minimumScore) {
    return results.filter((lines) => lines.some((line) => isAcceptedOcrLine(line, minimumScore))).length;
}

/**
 * @param {import('test/ocr-evaluation').CharacterHitPoint[]} expected
 * @param {import('test/ocr-evaluation').ScoredLine[]} actual
 * @returns {import('test/ocr-evaluation').CoordinateHitResult}
 */
export function getCoordinateHitResult(expected, actual) {
    let hits = 0;
    for (const {character, index, point} of expected) {
        if (actual.some((line) => {
            const lineCharacters = [...normalizeOcrText(line.text)];
            return line.characters.some((actualCharacter) => (
                actualCharacter.index === index &&
                actualCharacter.character === character &&
                lineCharacters[actualCharacter.index] === actualCharacter.character &&
                isPointInPolygon(point, actualCharacter.polygon)
            ));
        })) {
            ++hits;
        }
    }
    return {hits, total: expected.length, rate: expected.length === 0 ? 1 : hits / expected.length};
}
