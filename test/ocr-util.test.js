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
import {computeObjectFitLayout, getPageSegmentationModes, getRecognitionMode, getTextOffsetFromPoint, joinOcrWords, parseTsvLines, parseTsvSingleCharacter} from '../ext/js/dom/ocr-util.js';

describe('OCR utilities', () => {
    test.each([
        ['image', 'horizontal', ['3', '6']],
        ['image', 'vertical', ['5']],
        ['region', 'horizontal', ['3', '6', '10']],
        ['region', 'vertical', ['5', '10']],
    ])('selects page segmentation fallbacks for %s %s OCR', (sourceType, mode, expected) => {
        expect(getPageSegmentationModes(
            /** @type {import('ocr-util').SourceType} */ (sourceType),
            /** @type {import('ocr-util').Mode} */ (mode),
        )).toStrictEqual(expected);
    });

    test('uses the normal Japanese model for an isolated vertical glyph', () => {
        expect(getRecognitionMode('vertical', '5')).toBe('vertical');
        expect(getRecognitionMode('vertical', '10')).toBe('horizontal');
        expect(getRecognitionMode('horizontal', '10')).toBe('horizontal');
    });

    test('joins Japanese without spaces and Latin words with spaces', () => {
        expect(joinOcrWords(['日', '本', '語', 'OCR', 'test'])).toBe('日本語OCR test');
    });

    test('aggregates horizontal TSV words into a line', () => {
        const tsv = [
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
            '5\t1\t1\t1\t1\t1\t10\t20\t30\t15\t91\t日本',
            '5\t1\t1\t1\t1\t2\t42\t20\t25\t15\t89\t語',
        ].join('\n');
        expect(parseTsvLines(tsv)).toStrictEqual([{
            text: '日本語',
            left: 10,
            top: 20,
            width: 57,
            height: 15,
            confidence: 90,
        }]);
    });

    test('orders vertical columns from right to left and filters confidence', () => {
        const tsv = [
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
            '5\t1\t1\t1\t1\t1\t10\t10\t20\t20\t90\t左',
            '5\t1\t2\t1\t1\t1\t80\t10\t20\t20\t90\t右',
            '5\t1\t2\t1\t1\t2\t80\t32\t20\t20\t2\t除外',
        ].join('\n');
        expect(parseTsvLines(tsv, {vertical: true, minimumConfidence: 5}).map(({text}) => text)).toStrictEqual(['右', '左']);
    });

    test('selects a low-confidence Japanese glyph over punctuation artifacts', () => {
        const tsv = [
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
            '5\t1\t1\t1\t1\t1\t10\t20\t80\t90\t1\t画',
            '5\t1\t1\t1\t1\t2\t90\t20\t15\t90\t95\t|',
        ].join('\n');
        expect(parseTsvSingleCharacter(tsv)).toStrictEqual([{
            text: '画',
            left: 10,
            top: 20,
            width: 80,
            height: 90,
            confidence: 1,
        }]);
    });

    test('rejects non-Japanese single-character artifacts', () => {
        const tsv = [
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
            '5\t1\t1\t1\t1\t1\t10\t20\t80\t90\t99\tA',
        ].join('\n');
        expect(parseTsvSingleCharacter(tsv)).toStrictEqual([]);
    });

    test.each([
        ['contain', {left: 0, top: 50, width: 200, height: 100}],
        ['cover', {left: -100, top: 0, width: 400, height: 200}],
        ['none', {left: -100, top: 0, width: 400, height: 200}],
        ['scale-down', {left: 0, top: 50, width: 200, height: 100}],
    ])('computes %s object fit', (objectFit, expected) => {
        expect(computeObjectFitLayout({
            boxWidth: 200,
            boxHeight: 200,
            naturalWidth: 400,
            naturalHeight: 200,
            objectFit,
        })).toStrictEqual(expected);
    });

    test('maps horizontal and vertical points to UTF-16 offsets', () => {
        const rect = {left: 10, top: 20, width: 120, height: 120};
        expect(getTextOffsetFromPoint(55, 30, rect, '画像', false)).toBe(0);
        expect(getTextOffsetFromPoint(100, 30, rect, '画像', false)).toBe(1);
        expect(getTextOffsetFromPoint(20, 100, rect, '𬵪像', true)).toBe(2);
    });
});
