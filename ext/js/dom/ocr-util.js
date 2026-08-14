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

const CJK_OR_KANA_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々〆〄ヶ]/u;
const LATIN_OR_NUMBER_PATTERN = /[\p{Script=Latin}\p{Number}]/u;

/**
 * Returns Tesseract page segmentation modes from general to specific.
 * Screen regions add single-character mode because users commonly crop one
 * glyph too tightly for automatic layout detection.
 * @param {'image'|'region'} sourceType
 * @param {import('ocr-util').Mode} mode
 * @returns {string[]}
 */
export function getPageSegmentationModes(sourceType, mode) {
    const result = mode === 'vertical' ? ['5'] : ['3', '6'];
    if (sourceType === 'region') {
        result.push('10');
    }
    return result;
}

/**
 * Isolated Japanese glyphs use the normal language model even when they were
 * selected through vertical OCR. The vertical model is tuned for column
 * context and performs poorly on a single upright character.
 * @param {import('ocr-util').Mode} mode
 * @param {string} pageSegmentationMode
 * @returns {import('ocr-util').Mode}
 */
export function getRecognitionMode(mode, pageSegmentationMode) {
    return pageSegmentationMode === '10' ? 'horizontal' : mode;
}

/**
 * Selects the strongest Japanese character from Tesseract's single-character
 * result. This deliberately ignores punctuation and Latin artifacts which can
 * otherwise accompany a tightly cropped glyph.
 * @param {string} tsv
 * @returns {import('ocr-util').Line[]}
 */
export function parseTsvSingleCharacter(tsv) {
    if (typeof tsv !== 'string' || tsv.trim().length === 0) {
        return [];
    }

    /** @type {?import('ocr-util').Line} */
    let best = null;
    const rows = tsv.split(/\r?\n/u);
    for (let i = 1; i < rows.length; ++i) {
        const fields = rows[i].split('\t');
        if (fields.length < 12 || fields[0] !== '5') { continue; }

        const text = fields.slice(11).join('\t').trim();
        const match = CJK_OR_KANA_PATTERN.exec(text);
        const confidence = Number(fields[10]);
        const left = Number(fields[6]);
        const top = Number(fields[7]);
        const width = Number(fields[8]);
        const height = Number(fields[9]);
        if (
            match === null ||
            !Number.isFinite(confidence) ||
            confidence < 0 ||
            ![left, top, width, height].every(Number.isFinite) ||
            width <= 0 ||
            height <= 0
        ) {
            continue;
        }

        if (best === null || confidence > best.confidence) {
            best = {text: match[0], confidence, left, top, width, height};
        }
    }
    return best === null ? [] : [best];
}

/**
 * Converts Tesseract TSV word records into ordered line-level OCR records.
 * @param {string} tsv
 * @param {import('ocr-util').ParseTsvOptions} [options]
 * @returns {import('ocr-util').Line[]}
 */
export function parseTsvLines(tsv, {vertical = false, minimumConfidence = 0} = {}) {
    if (typeof tsv !== 'string' || tsv.trim().length === 0) {
        return [];
    }

    /** @type {Map<string, import('ocr-util').Word[]>} */
    const groups = new Map();
    const rows = tsv.split(/\r?\n/u);
    for (let i = 1; i < rows.length; ++i) {
        const fields = rows[i].split('\t');
        if (fields.length < 12 || fields[0] !== '5') { continue; }

        const text = fields.slice(11).join('\t').trim();
        const confidence = Number(fields[10]);
        if (text.length === 0 || !Number.isFinite(confidence) || confidence < minimumConfidence) { continue; }

        const left = Number(fields[6]);
        const top = Number(fields[7]);
        const width = Number(fields[8]);
        const height = Number(fields[9]);
        if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) { continue; }

        const key = `${fields[1]}:${fields[2]}:${fields[3]}:${fields[4]}`;
        let group = groups.get(key);
        if (typeof group === 'undefined') {
            group = [];
            groups.set(key, group);
        }
        group.push({text, confidence, left, top, width, height});
    }

    /** @type {import('ocr-util').Line[]} */
    const result = [];
    for (const words of groups.values()) {
        words.sort(vertical ? compareVertical : compareHorizontal);
        const left = Math.min(...words.map(({left: value}) => value));
        const top = Math.min(...words.map(({top: value}) => value));
        const right = Math.max(...words.map(({left: value, width}) => value + width));
        const bottom = Math.max(...words.map(({top: value, height}) => value + height));
        const text = joinOcrWords(words.map(({text: value}) => value));
        if (text.length === 0) { continue; }
        result.push({
            text,
            left,
            top,
            width: right - left,
            height: bottom - top,
            confidence: words.reduce((sum, {confidence}) => sum + confidence, 0) / words.length,
        });
    }

    result.sort(vertical ? compareVertical : compareHorizontal);
    return result;
}

/**
 * Joins OCR words without adding spaces between Japanese characters.
 * @param {string[]} words
 * @returns {string}
 */
export function joinOcrWords(words) {
    let result = '';
    for (const rawWord of words) {
        const word = rawWord.trim();
        if (word.length === 0) { continue; }
        if (result.length > 0 && needsSpace(/** @type {string} */ (result.at(-1)), word[0])) {
            result += ' ';
        }
        result += word;
    }
    return result;
}

/**
 * Computes the displayed source image rectangle inside an image content box.
 * @param {import('ocr-util').ObjectFitDetails} details
 * @returns {import('ocr-util').Rect}
 */
export function computeObjectFitLayout({
    boxWidth,
    boxHeight,
    naturalWidth,
    naturalHeight,
    objectFit = 'fill',
    positionX = 0.5,
    positionY = 0.5,
}) {
    if (boxWidth <= 0 || boxHeight <= 0 || naturalWidth <= 0 || naturalHeight <= 0) {
        return {left: 0, top: 0, width: 0, height: 0};
    }

    let width = boxWidth;
    let height = boxHeight;
    const containScale = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
    const coverScale = Math.max(boxWidth / naturalWidth, boxHeight / naturalHeight);

    switch (objectFit) {
        case 'contain':
            width = naturalWidth * containScale;
            height = naturalHeight * containScale;
            break;
        case 'cover':
            width = naturalWidth * coverScale;
            height = naturalHeight * coverScale;
            break;
        case 'none':
            width = naturalWidth;
            height = naturalHeight;
            break;
        case 'scale-down': {
            const scale = Math.min(1, containScale);
            width = naturalWidth * scale;
            height = naturalHeight * scale;
            break;
        }
        default:
            break;
    }

    return {
        left: (boxWidth - width) * clamp01(positionX),
        top: (boxHeight - height) * clamp01(positionY),
        width,
        height,
    };
}

/**
 * Maps a point inside a line rectangle to a UTF-16 text offset.
 * @param {number} x
 * @param {number} y
 * @param {import('ocr-util').Rect} rect
 * @param {string} text
 * @param {boolean} vertical
 * @returns {number}
 */
export function getTextOffsetFromPoint(x, y, rect, text, vertical) {
    const codePoints = [...text];
    if (codePoints.length === 0) { return 0; }
    const extent = vertical ? rect.height : rect.width;
    const position = vertical ? y - rect.top : x - rect.left;
    const index = Math.min(codePoints.length - 1, Math.max(0, Math.floor((position / Math.max(1, extent)) * codePoints.length)));
    let offset = 0;
    for (let i = 0; i < index; ++i) {
        offset += codePoints[i].length;
    }
    return offset;
}

/**
 * @param {import('ocr-util').Rect} rect
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function isPointInRect(rect, x, y) {
    return x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height;
}

/**
 * @param {import('ocr-util').Word|import('ocr-util').Line} a
 * @param {import('ocr-util').Word|import('ocr-util').Line} b
 * @returns {number}
 */
function compareHorizontal(a, b) {
    return (a.top - b.top) || (a.left - b.left);
}

/**
 * @param {import('ocr-util').Word|import('ocr-util').Line} a
 * @param {import('ocr-util').Word|import('ocr-util').Line} b
 * @returns {number}
 */
function compareVertical(a, b) {
    return (b.left - a.left) || (a.top - b.top);
}

/**
 * @param {string} previous
 * @param {string} next
 * @returns {boolean}
 */
function needsSpace(previous, next) {
    if (CJK_OR_KANA_PATTERN.test(previous) || CJK_OR_KANA_PATTERN.test(next)) {
        return false;
    }
    return LATIN_OR_NUMBER_PATTERN.test(previous) && LATIN_OR_NUMBER_PATTERN.test(next);
}

/**
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
    return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.5));
}
