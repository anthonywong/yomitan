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
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {assertOcrAssetManifest} from '../dev/ocr-asset-util.js';
import {parseJson} from '../dev/json.js';

const directory = dirname(fileURLToPath(import.meta.url));
const schema = /** @type {import('ajv').AnySchema} */ (parseJson(readFileSync(join(directory, '..', 'dev', 'data', 'ocr-assets-schema.json'), {encoding: 'utf8'})));
const manifest = parseJson(readFileSync(join(directory, '..', 'dev', 'data', 'ocr-assets-manifest.json'), {encoding: 'utf8'}));

describe('OCR asset manifest', () => {
    test('uses the canonical schema and deliberately contains no unreviewed artifacts', () => {
        const validate = new Ajv({strict: false}).compile(schema);
        expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
        assertOcrAssetManifest(manifest);
        expect(manifest.assets).toStrictEqual([]);
    });
});
