/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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
import standaloneCode from 'ajv/dist/standalone/index.js';
import esbuild from 'esbuild';
import fs from 'fs';
import {createRequire} from 'module';
import path from 'path';
import {fileURLToPath} from 'url';
import {parseJson} from './json.js';

const require = createRequire(import.meta.url);

const dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.join(dirname, '..', 'ext');

/**
 * @param {string} out
 */
async function copyWasm(out) {
    // copy from node modules '@resvg/resvg-wasm/index_bg.wasm' to out
    const resvgWasmPath = path.dirname(require.resolve('@resvg/resvg-wasm'));
    const wasmPath = path.join(resvgWasmPath, 'index_bg.wasm');
    fs.copyFileSync(wasmPath, path.join(out, 'resvg.wasm'));
}

/**
 * Copies the local OCR runtime and Japanese language data into the generated
 * extension library directory. No runtime or build-time CDN fetch is used.
 * @param {string} out
 */
async function copyTesseract(out) {
    const tesseractPath = path.dirname(require.resolve('tesseract.js/package.json'));
    const corePath = path.dirname(require.resolve('tesseract.js-core/package.json'));
    const japaneseDataPath = path.dirname(require.resolve('@tesseract.js-data/jpn/package.json'));
    const verticalJapaneseDataPath = path.dirname(require.resolve('@tesseract.js-data/jpn_vert/package.json'));
    const coreOutputPath = path.join(out, 'core');
    const languageOutputPath = path.join(out, 'lang');

    fs.rmSync(out, {recursive: true, force: true});
    fs.mkdirSync(coreOutputPath, {recursive: true});
    fs.mkdirSync(languageOutputPath, {recursive: true});
    fs.copyFileSync(path.join(tesseractPath, 'dist', 'tesseract.esm.min.js'), path.join(out, 'tesseract.esm.min.js'));
    fs.copyFileSync(path.join(tesseractPath, 'dist', 'worker.min.js'), path.join(out, 'worker.min.js'));

    for (const variant of ['lstm', 'simd-lstm', 'relaxedsimd-lstm']) {
        for (const suffix of ['wasm', 'wasm.js']) {
            const fileName = `tesseract-core-${variant}.${suffix}`;
            fs.copyFileSync(path.join(corePath, fileName), path.join(coreOutputPath, fileName));
        }
    }

    fs.copyFileSync(
        path.join(japaneseDataPath, '4.0.0_best_int', 'jpn.traineddata.gz'),
        path.join(languageOutputPath, 'jpn.traineddata.gz'),
    );
    fs.copyFileSync(
        path.join(verticalJapaneseDataPath, '4.0.0_best_int', 'jpn_vert.traineddata.gz'),
        path.join(languageOutputPath, 'jpn_vert.traineddata.gz'),
    );
    fs.copyFileSync(path.join(corePath, 'LICENSE'), path.join(out, 'TESSERACT-CORE-LICENSE'));
}


/**
 * @param {string} scriptPath
 */
async function buildLib(scriptPath) {
    await esbuild.build({
        entryPoints: [scriptPath],
        bundle: true,
        minify: false,
        sourcemap: true,
        target: 'es2020',
        format: 'esm',
        outfile: path.join(extDir, 'lib', path.basename(scriptPath)),
        external: ['fs'],
        banner: {
            js: '// @ts-nocheck',
        },
    });
}

/**
 * Bundles libraries.
 */
export async function buildLibs() {
    const devLibPath = path.join(dirname, 'lib');
    const files = await fs.promises.readdir(devLibPath, {
        withFileTypes: true,
    });
    for (const f of files) {
        if (f.isFile()) {
            await buildLib(path.join(devLibPath, f.name));
        }
    }

    const schemaDir = path.join(extDir, 'data/schemas/');
    const schemaFileNames = fs.readdirSync(schemaDir);
    const schemas = schemaFileNames.map((schemaFileName) => {
        /** @type {import('ajv').AnySchema} */
        // eslint-disable-next-line sonarjs/prefer-immediate-return
        const result = parseJson(fs.readFileSync(path.join(schemaDir, schemaFileName), {encoding: 'utf8'}));
        return result;
    });
    const ajv = new Ajv({
        schemas,
        code: {source: true, esm: true},
        allowUnionTypes: true,
    });
    const moduleCode = standaloneCode(ajv);

    // https://github.com/ajv-validator/ajv/issues/2209
    const patchedModuleCode = "// @ts-nocheck\nimport {ucs2length} from './ucs2length.js';" + moduleCode.replaceAll('require("ajv/dist/runtime/ucs2length").default', 'ucs2length');

    fs.writeFileSync(path.join(extDir, 'lib/validate-schemas.js'), patchedModuleCode);

    await copyWasm(path.join(extDir, 'lib'));
    await copyTesseract(path.join(extDir, 'lib', 'tesseract'));
}
