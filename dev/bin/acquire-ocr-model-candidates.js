/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {acquireOcrModelCandidates} from '../ocr-model-acquisition.js';

const directory = dirname(fileURLToPath(import.meta.url));
const {values, positionals} = parseArgs({options: {'confirm-download': {type: 'boolean'}, cache: {type: 'string'}}, strict: true, allowPositionals: true});
if (values['confirm-download'] !== true || typeof values.cache !== 'string' || positionals.length !== 0) {
    throw new Error('Usage: node dev/bin/acquire-ocr-model-candidates.js --confirm-download --cache .cache/ocr-models');
}
const candidates = JSON.parse(readFileSync(join(directory, '..', 'data', 'ocr-model-candidates.json'), 'utf8'));
const report = await acquireOcrModelCandidates({candidates, cacheDirectory: resolve(values.cache)});
process.stdout.write(`${JSON.stringify({cacheDirectory: resolve(values.cache), retrieval: report.retrieval}, null, 4)}\n`);
