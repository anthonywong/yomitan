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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, test} from 'vitest';
import {assertOcrAssetManifest, getSha256, getUstarTarEntries, OcrAssetError, stageOcrAssets} from '../dev/ocr-asset-util.js';

/** @type {string[]} */
const temporaryDirectories = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

/**
 * @returns {string}
 */
function makeTemporaryDirectory() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yomitan-ocr-assets-'));
    temporaryDirectories.push(directory);
    return directory;
}

/**
 * @param {Array<[string, string, string?]>} records
 * @returns {Buffer}
 */
function makeUstarTarRecords(records) {
    /** @type {Buffer[]} */
    const blocks = [];
    /**
     * @param {string} name
     * @param {string} contents
     * @param {string} [type]
     */
    const writeHeader = (name, contents, type = '0') => {
        const content = Buffer.from(contents, 'utf8');
        const header = Buffer.alloc(512);
        header.write(name, 0, 'utf8');
        header.write('0000644\0', 100, 'ascii');
        header.write(`${content.byteLength.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
        header.write(type, 156, 'ascii');
        header.write('ustar\0', 257, 'ascii');
        header.fill(32, 148, 156);
        let checksum = 0;
        for (const value of header) { checksum += value; }
        header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
        blocks.push(header, content, Buffer.alloc(Math.ceil(content.byteLength / 512) * 512 - content.byteLength));
    };
    for (const [name, contents, type] of records) { writeHeader(name, contents, type); }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
}

/**
 * @param {Array<[string, string]>} entries
 * @param {{root?: string, directories?: string[]}} [options]
 * @returns {Buffer}
 */
function makeUstarTar(entries, {root = 'model', directories = []} = {}) {
    return makeUstarTarRecords([
        [`${root}/`, '', '5'],
        ...directories.map((directory) => [`${root}/${directory}/`, '', '5']),
        ...entries.map(([name, contents]) => [`${root}/${name}`, contents, '0']),
    ]);
}

/**
 * @param {Buffer} source
 * @param {{id?: string, destination?: string, approved?: boolean, archive?: boolean}} [options]
 * @returns {{source: {url: string, version: string, path: string, sha256: string, bytes: number}, destination: string, outputSha256: string, [key: string]: unknown}}
 */
function makeAsset(source, {id = 'recognizer', destination = 'models/recognizer.tar', approved = true, archive = true} = {}) {
    const hash = getSha256(source);
    return {
        id,
        role: 'recognizer-model',
        source: {
            url: 'https://publisher.example.test/releases/recognizer.tar',
            version: 'v1.0.0',
            path: 'incoming/recognizer.tar',
            sha256: hash,
            bytes: source.byteLength,
        },
        outputSha256: hash,
        outputBytes: source.byteLength,
        license: {
            spdx: 'Apache-2.0',
            evidenceUrl: 'https://publisher.example.test/licenses/recognizer',
            noticePath: 'licenses/recognizer.txt',
        },
        redistributionApproved: approved,
        transform: {type: 'copy', tool: null, inputSha256: hash, outputSha256: hash},
        destination,
        noticeAssetId: 'notice',
        ...(archive ? {archive: {format: 'tar', requiredEntries: ['inference.onnx', 'inference.yml']}} : {}),
    };
}

/**
 * @param {Array<{[key: string]: unknown}>} assets
 * @returns {{schemaVersion: number, assets: Array<{[key: string]: unknown}>}}
 */
function makeManifest(assets) {
    const notice = Buffer.from('notice');
    const hash = getSha256(notice);
    return {schemaVersion: 1, assets: [{id: 'notice', role: 'notice', source: {url: 'https://publisher.example.test/licenses/notice', version: 'v1', path: 'licenses/notice.txt', sha256: hash, bytes: notice.byteLength}, outputSha256: hash, outputBytes: notice.byteLength, license: {spdx: 'Apache-2.0', evidenceUrl: 'https://publisher.example.test/licenses'}, redistributionApproved: true, transform: {type: 'copy', tool: null, inputSha256: hash, outputSha256: hash}, destination: 'notices/notice.txt'}, ...assets]};
}

/**
 * @param {string} directory
 * @param {Buffer} source
 */
function writeSourceClosure(directory, source) {
    fs.mkdirSync(path.join(directory, 'incoming'), {recursive: true});
    fs.mkdirSync(path.join(directory, 'licenses'), {recursive: true});
    fs.writeFileSync(path.join(directory, 'incoming', 'recognizer.tar'), source);
    fs.writeFileSync(path.join(directory, 'licenses', 'notice.txt'), 'notice');
}

describe('OCR asset staging', () => {
    test('stages an approved, hash-locked local model archive', () => {
        const source = makeUstarTar([['inference.onnx', 'model'], ['inference.yml', 'config']]);
        const sourceDirectory = makeTemporaryDirectory();
        const outputDirectory = path.join(makeTemporaryDirectory(), 'output');
        writeSourceClosure(sourceDirectory, source);

        const asset = makeAsset(source);
        const staged = stageOcrAssets({manifest: makeManifest([asset]), sourceDirectory, outputDirectory});

        expect(staged).toHaveLength(2);
        expect(fs.readFileSync(path.join(outputDirectory, 'models', 'recognizer.tar'))).toStrictEqual(source);
        expect(getUstarTarEntries(source)).toStrictEqual(new Set(['model/inference.onnx', 'model/inference.yml']));
    });

    test('accepts an official Paddle-style model root and rejects ambiguous tar paths', () => {
        const root = 'PP-OCRv5_mobile_det_onnx_infer';
        const source = makeUstarTar(
            [['inference.onnx', 'model'], ['inference.yml', 'config']],
            {root, directories: ['.cache', '.cache/huggingface', '.cache/huggingface/download']},
        );
        expect(getUstarTarEntries(source)).toStrictEqual(new Set([
            `${root}/inference.onnx`,
            `${root}/inference.yml`,
        ]));

        expect(() => getUstarTarEntries(makeUstarTar([['inference.onnx', 'model']], {root: '../outside'}))).toThrow('unsafe path');
        expect(() => getUstarTarEntries(makeUstarTar([['inference.onnx', 'model']], {root: '/outside'}))).toThrow('safe relative path');
        expect(() => getUstarTarEntries(makeUstarTarRecords([
            ['first/', '', '5'],
            ['first/inference.onnx', 'model', '0'],
            ['second/inference.yml', 'config', '0'],
        ]))).toThrow('exactly one top-level root');
        expect(() => getUstarTarEntries(makeUstarTarRecords([
            ['model/', '', '5'],
            ['model/inference.onnx', 'model', '0'],
            ['model/inference.onnx', 'duplicate', '0'],
        ]))).toThrow('duplicate normalized entries');
    });

    test('rejects unapproved, missing, corrupted, and extra source assets', () => {
        const source = makeUstarTar([['inference.onnx', 'model'], ['inference.yml', 'config']]);
        const sourceDirectory = makeTemporaryDirectory();
        const outputDirectory = path.join(makeTemporaryDirectory(), 'output');
        const asset = makeAsset(source, {approved: false});
        writeSourceClosure(sourceDirectory, source);
        expect(() => stageOcrAssets({manifest: makeManifest([asset]), sourceDirectory, outputDirectory})).toThrow('not approved');

        const approvedAsset = makeAsset(source);
        fs.rmSync(path.join(sourceDirectory, 'incoming', 'recognizer.tar'));
        expect(() => stageOcrAssets({manifest: makeManifest([approvedAsset]), sourceDirectory, outputDirectory})).toThrow('does not exactly match');

        fs.writeFileSync(path.join(sourceDirectory, 'incoming', 'recognizer.tar'), Buffer.from('corrupt'));
        expect(() => stageOcrAssets({manifest: makeManifest([approvedAsset]), sourceDirectory, outputDirectory})).toThrow('hash or size');
        expect(fs.existsSync(outputDirectory)).toBe(false);

        fs.writeFileSync(path.join(sourceDirectory, 'incoming', 'recognizer.tar'), source);
        fs.writeFileSync(path.join(sourceDirectory, 'unexpected.bin'), Buffer.from('unexpected'));
        expect(() => stageOcrAssets({manifest: makeManifest([approvedAsset]), sourceDirectory, outputDirectory})).toThrow('does not exactly match');
    });

    test('rejects path traversal, remote output URLs, copy mismatches, and duplicate destinations', () => {
        const source = makeUstarTar([['inference.onnx', 'model'], ['inference.yml', 'config']]);
        const traversal = makeAsset(source);
        traversal.source.path = '../recognizer.tar';
        expect(() => assertOcrAssetManifest(makeManifest([traversal]))).toThrow(OcrAssetError);

        const remoteDestination = makeAsset(source);
        remoteDestination.destination = 'https://cdn.example.test/recognizer.tar';
        expect(() => assertOcrAssetManifest(makeManifest([remoteDestination]))).toThrow(OcrAssetError);

        const wrongOutput = makeAsset(source);
        wrongOutput.outputSha256 = '0'.repeat(64);
        expect(() => assertOcrAssetManifest(makeManifest([wrongOutput]))).toThrow('copy transform');

        const first = makeAsset(source, {id: 'detector', destination: 'models/shared.tar'});
        const second = makeAsset(source, {id: 'recognizer', destination: 'models/shared.tar'});
        second.source.path = 'incoming/detector.tar';
        expect(() => assertOcrAssetManifest(makeManifest([first, second]))).toThrow('share destination');
    });

    test('rejects compressed, malformed, linked, and incomplete model archives', () => {
        expect(() => getUstarTarEntries(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).toThrow('uncompressed ustar');
        expect(() => getUstarTarEntries(Buffer.alloc(512))).toThrow('uncompressed ustar');

        const linked = makeUstarTar([['inference.onnx', 'model'], ['inference.yml', 'config']]);
        linked[156] = '2'.charCodeAt(0);
        expect(() => getUstarTarEntries(linked)).toThrow('checksum');

        const source = makeUstarTar([['inference.onnx', 'model']]);
        const sourceDirectory = makeTemporaryDirectory();
        const outputDirectory = path.join(makeTemporaryDirectory(), 'output');
        writeSourceClosure(sourceDirectory, source);
        expect(() => stageOcrAssets({manifest: makeManifest([makeAsset(source)]), sourceDirectory, outputDirectory})).toThrow('missing inference.yml');
    });

    test('rejects symlink source and output roots without leaving partial output', () => {
        const source = makeUstarTar([['inference.onnx', 'model'], ['inference.yml', 'config']]);
        const parent = makeTemporaryDirectory();
        const realSource = path.join(parent, 'real-source');
        fs.mkdirSync(realSource);
        writeSourceClosure(realSource, source);
        const sourceLink = path.join(parent, 'source-link');
        fs.symlinkSync(realSource, sourceLink);
        expect(() => stageOcrAssets({manifest: makeManifest([makeAsset(source)]), sourceDirectory: sourceLink, outputDirectory: path.join(parent, 'output')})).toThrow('not a symlink');
        expect(fs.existsSync(path.join(parent, 'output'))).toBe(false);
    });
});
