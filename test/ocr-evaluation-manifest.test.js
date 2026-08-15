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

import Ajv from 'ajv';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {parseJson} from '../dev/json.js';
import {getPolygonArea, isPointInPolygon, normalizeOcrText} from './ocr-evaluation-util.js';

const dataDirectory = join(dirname(fileURLToPath(import.meta.url)), 'data', 'ocr-evaluation');
const schema = /** @type {import('ajv').AnySchema} */ (parseJson(readFileSync(join(dataDirectory, 'schema.json'), {encoding: 'utf8'})));
const manifest = /** @type {import('test/ocr-evaluation').OcrEvaluationManifest} */ (parseJson(readFileSync(join(dataDirectory, 'manifest.json'), {encoding: 'utf8'})));

describe('OCR evaluation manifest', () => {
    test('conforms to the versioned schema', () => {
        const validate = new Ajv({strict: false}).compile(schema);
        expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    });

    test('has a unique fixture ID and explicit pending natural-photo coverage', () => {
        const ids = manifest.fixtures.map(({id}) => id);
        expect(new Set(ids).size).toBe(ids.length);
        const pendingCategories = manifest.fixtures.filter(({status}) => status === 'pending').map(({category}) => category);
        expect(pendingCategories).toContain('natural-photo');
        expect(pendingCategories).toContain('manga-game');
    });

    test('keeps every ready fixture local, hash-locked, dimension-locked, and CC0 licensed', () => {
        for (const fixture of manifest.fixtures) {
            if (fixture.status !== 'ready') { continue; }
            expect(fixture.license).toBe('CC0-1.0');
            expect(fixture.provenance.kind).toBe('generated-in-repository');
            expect(fixture.file).toMatch(/^fixtures\/[a-z0-9-]+\.svg$/u);

            const source = readFileSync(join(dataDirectory, fixture.file));
            const sourceText = source.toString('utf8');
            const hash = createHash('sha256').update(source).digest('hex');
            const width = Number(/<svg[^>]*\bwidth="(\d+)"/u.exec(sourceText)?.[1]);
            const height = Number(/<svg[^>]*\bheight="(\d+)"/u.exec(sourceText)?.[1]);
            expect(hash).toBe(fixture.sha256);
            expect({width, height}).toStrictEqual(fixture.dimensions);
            expect(sourceText).not.toMatch(/<(?:image|script)\b|\bhref\s*=|\burl\s*\(/iu);

            const orders = fixture.expectedLines.map(({order}) => order);
            expect(new Set(orders).size).toBe(orders.length);
            expect(fixture.frameCase).toBeNull();
            for (const line of fixture.expectedLines) {
                expect(line.text).toBe(normalizeOcrText(line.text));
                expect(getPolygonArea(line.polygon)).toBeGreaterThan(0);
                const indexes = line.characterHitPoints.map(({index}) => index);
                expect(new Set(indexes).size).toBe(indexes.length);
                for (const {character, index, point} of line.characterHitPoints) {
                    expect(line.text).toContain(character);
                    expect(isPointInPolygon(point, line.polygon)).toBe(true);
                    expect(point[0]).toBeGreaterThanOrEqual(0);
                    expect(point[0]).toBeLessThanOrEqual(fixture.dimensions.width);
                    expect(point[1]).toBeGreaterThanOrEqual(0);
                    expect(point[1]).toBeLessThanOrEqual(fixture.dimensions.height);
                    expect([...character]).toHaveLength(1);
                    expect([...line.text][index]).toBe(character);
                }
            }

            for (const target of fixture.lookupTargets) {
                const line = fixture.expectedLines.find(({order}) => order === target.lineOrder);
                expect(line).toBeDefined();
                if (typeof line === 'undefined') { continue; }
                expect(target.expectedTerm).toBe(normalizeOcrText(target.expectedTerm));
                expect(line.text).toContain(target.expectedTerm);
                expect(isPointInPolygon(target.point, line.polygon)).toBe(true);
                expect(target.point[0]).toBeGreaterThanOrEqual(0);
                expect(target.point[0]).toBeLessThanOrEqual(fixture.dimensions.width);
                expect(target.point[1]).toBeGreaterThanOrEqual(0);
                expect(target.point[1]).toBeLessThanOrEqual(fixture.dimensions.height);
                if (typeof target.reading === 'string') {
                    expect(target.reading).toBe(normalizeOcrText(target.reading));
                }
                if (typeof target.dictionaryTerm === 'string') {
                    expect(target.dictionaryTerm).toBe(normalizeOcrText(target.dictionaryTerm));
                }
            }
        }
    });

    test('declares no expected text for the no-text fixture', () => {
        const fixture = manifest.fixtures.find(({id}) => id === 'no-text-shapes');
        expect(fixture).toBeDefined();
        expect(fixture?.status).toBe('ready');
        if (fixture?.status !== 'ready') { return; }
        expect(fixture.expectedLines).toStrictEqual([]);
    });
});
