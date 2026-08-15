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
import {
    compareReadingOrder,
    countNoTextFalsePositives,
    getCharacterErrorRate,
    getConvexPolygonIntersectionOverUnion,
    getCoordinateHitResult,
    getLevenshteinDistance,
    getPolygonArea,
    getPolygonBounds,
    isPointInPolygon,
    normalizeOcrText,
} from './ocr-evaluation-util.js';

/**
 * @param {number} x
 * @param {number} y
 * @returns {import('test/ocr-evaluation').Point}
 */
function point(x, y) {
    return [x, y];
}

describe('OCR evaluation utilities', () => {
    test('normalizes Unicode and whitespace without changing Japanese text', () => {
        expect(normalizeOcrText('  e\u0301\t画像\n')).toBe('é 画像');
    });

    test('calculates code-point-aware Levenshtein distance and CER', () => {
        expect(getLevenshteinDistance('画像', '映像')).toBe(1);
        expect(getLevenshteinDistance('𠮷野家', '吉野家')).toBe(1);
        expect(getCharacterErrorRate('画像', '映像')).toBe(0.5);
        expect(getCharacterErrorRate('', '')).toBe(0);
        expect(getCharacterErrorRate('', '誤')).toBe(1);
    });

    test('includes polygon boundaries and rejects points outside', () => {
        const polygon = [point(0, 0), point(10, 0), point(10, 10), point(0, 10)];
        expect(isPointInPolygon(point(5, 5), polygon)).toBe(true);
        expect(isPointInPolygon(point(0, 5), polygon)).toBe(true);
        expect(isPointInPolygon(point(12, 5), polygon)).toBe(false);
        expect(isPointInPolygon(point(5, 5), [point(0, 0), point(1, 1)])).toBe(false);
    });

    test('calculates polygon area, bounds, and convex IoU', () => {
        const first = [point(0, 0), point(10, 0), point(10, 10), point(0, 10)];
        const second = [point(5, 5), point(15, 5), point(15, 15), point(5, 15)];
        expect(getPolygonArea(first)).toBe(100);
        expect(getPolygonBounds(first)).toStrictEqual({left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10});
        expect(getConvexPolygonIntersectionOverUnion(first, second)).toBeCloseTo(1 / 7);
        expect(getConvexPolygonIntersectionOverUnion(first, [])).toBe(0);
    });

    test('sorts horizontal and vertical lines in expected reading order', () => {
        /** @type {import('test/ocr-evaluation').ScoredLine[]} */
        const horizontal = [
            {text: '後', score: 1, polygon: [point(50, 60), point(60, 60), point(60, 70), point(50, 70)], writingMode: 'horizontal-tb', order: 1, characters: []},
            {text: '前', score: 1, polygon: [point(10, 20), point(20, 20), point(20, 30), point(10, 30)], writingMode: 'horizontal-tb', order: 0, characters: []},
        ];
        /** @type {import('test/ocr-evaluation').ScoredLine[]} */
        const vertical = [
            {text: '左', score: 1, polygon: [point(20, 20), point(30, 20), point(30, 50), point(20, 50)], writingMode: 'vertical-rl', characters: []},
            {text: '右', score: 1, polygon: [point(80, 20), point(90, 20), point(90, 50), point(80, 50)], writingMode: 'vertical-rl', characters: []},
        ];
        /** @type {import('test/ocr-evaluation').ScoredLine[]} */
        const mixed = [
            {text: 'b', score: 1, polygon: [point(10, 10), point(20, 10), point(20, 20), point(10, 20)], writingMode: 'vertical-rl', characters: []},
            {text: 'a', score: 1, polygon: [point(10, 10), point(20, 10), point(20, 20), point(10, 20)], writingMode: 'horizontal-tb', characters: []},
        ];
        expect(horizontal.sort(compareReadingOrder).map(({text}) => text)).toStrictEqual(['前', '後']);
        expect(vertical.sort(compareReadingOrder).map(({text}) => text)).toStrictEqual(['右', '左']);
        expect(mixed.sort(compareReadingOrder).map(({text}) => text)).toStrictEqual(['a', 'b']);
    });

    test('counts no-text false positives using the configured confidence threshold', () => {
        const polygon = [point(0, 0), point(10, 0), point(10, 10), point(0, 10)];
        /** @type {import('test/ocr-evaluation').ScoredLine[][]} */
        const results = [
            [],
            [{text: '画像', score: 0.9, polygon, writingMode: 'horizontal-tb', characters: []}],
            [{text: ' ', score: 1, polygon, writingMode: 'horizontal-tb', characters: []}],
            [{text: '誤', score: 0.2, polygon, writingMode: 'horizontal-tb', characters: []}],
        ];
        expect(countNoTextFalsePositives(results, 0.5)).toBe(1);
    });

    test('counts coordinate hits only when the polygon and character both match', () => {
        /** @type {import('test/ocr-evaluation').CharacterHitPoint[]} */
        const expected = [
            {character: '画', index: 0, point: point(10, 10)},
            {character: '像', index: 1, point: point(30, 10)},
        ];
        /** @type {import('test/ocr-evaluation').ScoredLine[]} */
        const actual = [
            {
                text: '画像',
                score: 0.9,
                polygon: [point(0, 0), point(40, 0), point(40, 20), point(0, 20)],
                writingMode: 'horizontal-tb',
                characters: [
                    {character: '画', index: 0, polygon: [point(0, 0), point(20, 0), point(20, 20), point(0, 20)]},
                    {character: '像', index: 0, polygon: [point(20, 0), point(40, 0), point(40, 20), point(20, 20)]},
                ],
            },
            {text: '像', score: 0.9, polygon: [point(40, 0), point(60, 0), point(60, 20), point(40, 20)], writingMode: 'horizontal-tb', characters: [{character: '像', index: 1, polygon: [point(40, 0), point(60, 0), point(60, 20), point(40, 20)]}]},
        ];
        expect(getCoordinateHitResult(expected, actual)).toStrictEqual({hits: 1, total: 2, rate: 0.5});
        expect(getCoordinateHitResult([expected[1]], actual)).toStrictEqual({hits: 0, total: 1, rate: 0});
        expect(getCoordinateHitResult([], actual)).toStrictEqual({hits: 0, total: 0, rate: 1});
    });

    test('rejects character hits at a wrong code-point index or location', () => {
        /** @type {import('test/ocr-evaluation').CharacterHitPoint[]} */
        const expected = [{character: '像', index: 1, point: point(30, 10)}];
        /** @type {import('test/ocr-evaluation').ScoredLine[]} */
        const wrongIndex = [{
            text: '像画',
            score: 1,
            polygon: [point(0, 0), point(40, 0), point(40, 20), point(0, 20)],
            writingMode: 'horizontal-tb',
            characters: [{character: '像', index: 0, polygon: [point(20, 0), point(40, 0), point(40, 20), point(20, 20)]}],
        }];
        /** @type {import('test/ocr-evaluation').ScoredLine[]} */
        const wrongLocation = [{
            text: '画像',
            score: 1,
            polygon: [point(0, 0), point(60, 0), point(60, 20), point(0, 20)],
            writingMode: 'horizontal-tb',
            characters: [{character: '像', index: 1, polygon: [point(40, 0), point(60, 0), point(60, 20), point(40, 20)]}],
        }];
        expect(getCoordinateHitResult(expected, wrongIndex)).toStrictEqual({hits: 0, total: 1, rate: 0});
        expect(getCoordinateHitResult(expected, wrongLocation)).toStrictEqual({hits: 0, total: 1, rate: 0});
    });
});
