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

import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_TAR_ENTRY_COUNT = 32;

export const MAX_TAR_UNPACKED_BYTES = 64 * 1024 * 1024;

export class OcrAssetError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        /** @type {string} */
        this.name = 'OcrAssetError';
    }
}

/** @typedef {{url: string, version: string, path: string, sha256: string, bytes: number}} OcrAssetSource */
/** @typedef {{id: string, role: string, source: OcrAssetSource, outputSha256: string, outputBytes: number, license: {spdx: string, evidenceUrl: string}, redistributionApproved: boolean, transform: {type: 'copy', tool: null, inputSha256: string, outputSha256: string}, destination: string, noticeAssetId?: string, archive?: {format: 'tar', requiredEntries: string[]}}} OcrAsset */
/** @typedef {{schemaVersion: 1, assets: OcrAsset[]}} OcrAssetManifest */

/**
 * @param {Buffer} source
 * @returns {string}
 */
export function getSha256(source) {
    return createHash('sha256').update(source).digest('hex');
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 * @throws {OcrAssetError}
 */
export function assertSafeRelativePath(value, name) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || path.isAbsolute(value) || value.includes('\\')) {
        throw new OcrAssetError(`${name} must be a non-empty safe relative path`);
    }
    if (value.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) {
        throw new OcrAssetError(`${name} contains an unsafe path segment`);
    }
    return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @throws {OcrAssetError}
 */
function assertSha256(value, name) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) { throw new OcrAssetError(`${name} must be a lowercase SHA-256 hash`); }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @throws {OcrAssetError}
 */
function assertPositiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1) { throw new OcrAssetError(`${name} must be a positive integer`); }
}

/**
 * @param {unknown} value
 * @returns {asserts value is OcrAssetManifest}
 * @throws {OcrAssetError}
 */
export function assertOcrAssetManifest(value) {
    if (typeof value !== 'object' || value === null) { throw new OcrAssetError('OCR asset manifest must be an object'); }
    const manifest = /** @type {{schemaVersion?: unknown, assets?: unknown}} */ (value);
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) { throw new OcrAssetError('OCR asset manifest must use schema version 1 and an assets array'); }
    const candidates = /** @type {unknown[]} */ (manifest.assets);
    const ids = new Set();
    const sourcePaths = new Set();
    const destinations = new Set();
    /** @type {Map<string, OcrAsset>} */
    const assetsById = new Map();
    for (const candidate of candidates) {
        if (typeof candidate !== 'object' || candidate === null) { throw new OcrAssetError('OCR asset must be an object'); }
        const asset = /** @type {Partial<OcrAsset>} */ (candidate);
        if (typeof asset.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(asset.id) || ids.has(asset.id)) { throw new OcrAssetError('OCR asset IDs must be unique lowercase identifiers'); }
        ids.add(asset.id);
        if (typeof asset.role !== 'string' || !['runtime-js', 'runtime-wasm', 'opencv', 'detector-model', 'recognizer-model', 'model-data', 'notice'].includes(asset.role)) { throw new OcrAssetError(`${asset.id}.role is invalid`); }
        if (typeof asset.redistributionApproved !== 'boolean' || typeof asset.destination !== 'string') { throw new OcrAssetError(`${asset.id} approval and destination are required`); }
        assertSafeRelativePath(asset.destination, `${asset.id}.destination`);
        if (destinations.has(asset.destination)) { throw new OcrAssetError(`OCR assets must not share destination ${asset.destination}`); }
        destinations.add(asset.destination);
        if (typeof asset.source !== 'object' || asset.source === null) { throw new OcrAssetError(`${asset.id}.source is required`); }
        const source = /** @type {Partial<OcrAssetSource>} */ (asset.source);
        if (typeof source.url !== 'string' || !source.url.startsWith('https://') || typeof source.version !== 'string' || source.version.length === 0 || typeof source.path !== 'string') { throw new OcrAssetError(`${asset.id}.source must contain immutable provenance fields`); }
        assertSafeRelativePath(source.path, `${asset.id}.source.path`);
        if (sourcePaths.has(source.path)) { throw new OcrAssetError(`OCR assets must not share source path ${source.path}`); }
        sourcePaths.add(source.path);
        assertSha256(source.sha256, `${asset.id}.source.sha256`);
        assertPositiveInteger(source.bytes, `${asset.id}.source.bytes`);
        assertSha256(asset.outputSha256, `${asset.id}.outputSha256`);
        assertPositiveInteger(asset.outputBytes, `${asset.id}.outputBytes`);
        if (typeof asset.license !== 'object' || asset.license === null || typeof asset.license.spdx !== 'string' || asset.license.spdx.length === 0 || typeof asset.license.evidenceUrl !== 'string' || !asset.license.evidenceUrl.startsWith('https://')) { throw new OcrAssetError(`${asset.id}.license must contain SPDX and primary evidence`); }
        if (typeof asset.transform !== 'object' || asset.transform === null || asset.transform.type !== 'copy' || asset.transform.tool !== null) { throw new OcrAssetError(`${asset.id} must use the supported copy transform`); }
        assertSha256(asset.transform.inputSha256, `${asset.id}.transform.inputSha256`);
        assertSha256(asset.transform.outputSha256, `${asset.id}.transform.outputSha256`);
        if (asset.transform.inputSha256 !== source.sha256 || asset.transform.outputSha256 !== asset.outputSha256 || source.sha256 !== asset.outputSha256 || source.bytes !== asset.outputBytes) { throw new OcrAssetError(`${asset.id} copy transform must preserve hash and byte size`); }
        if (asset.role === 'notice') {
            if (asset.noticeAssetId !== void 0 || asset.archive !== void 0) { throw new OcrAssetError(`${asset.id} notice asset must not reference a notice or archive`); }
        } else if (typeof asset.noticeAssetId !== 'string') {
            throw new OcrAssetError(`${asset.id} must reference a verified notice asset`);
        }
        if (asset.archive !== void 0) {
            if (asset.archive.format !== 'tar' || !Array.isArray(asset.archive.requiredEntries) || asset.archive.requiredEntries.length === 0) { throw new OcrAssetError(`${asset.id}.archive is invalid`); }
            for (const entry of asset.archive.requiredEntries) { assertSafeRelativePath(entry, `${asset.id}.archive.requiredEntries`); }
        }
        assetsById.set(asset.id, /** @type {OcrAsset} */ (asset));
    }
    for (const asset of assetsById.values()) {
        if (asset.role !== 'notice' && assetsById.get(/** @type {string} */ (asset.noticeAssetId))?.role !== 'notice') { throw new OcrAssetError(`${asset.id} must reference an asset with role notice`); }
    }
}

/**
 * @param {Buffer} source
 * @param {number} offset
 * @param {number} length
 * @returns {string}
 */
function readTarString(source, offset, length) {
    return source.subarray(offset, offset + length).toString('utf8').split('\0', 1)[0].trim();
}

/**
 * @param {Buffer} source
 * @param {number} offset
 * @param {number} length
 * @returns {number}
 * @throws {OcrAssetError}
 */
function readTarOctal(source, offset, length) {
    const value = readTarString(source, offset, length);
    if (!/^[0-7]+$/u.test(value)) { throw new OcrAssetError('tar header has an invalid octal value'); }
    const result = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(result)) { throw new OcrAssetError('tar header value is too large'); }
    return result;
}

/**
 * @param {Buffer} block
 * @returns {boolean}
 */
function isZeroBlock(block) { return block.every((value) => value === 0); }

/**
 * @param {Buffer} header
 * @throws {OcrAssetError}
 */
function assertTarChecksum(header) {
    const recorded = readTarOctal(header, 148, 8);
    let actual = 0;
    for (let index = 0; index < 512; ++index) { actual += index >= 148 && index < 156 ? 32 : header[index]; }
    if (recorded !== actual) { throw new OcrAssetError('tar header checksum does not match'); }
}

/**
 * Returns full regular-file names. Directories are accepted only as the one
 * top-level root directory; all files must be beneath that root.
 * @param {Buffer} source
 * @returns {Set<string>}
 * @throws {OcrAssetError}
 */
export function getUstarTarEntries(source) {
    if (source.length < 1024 || source.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) { throw new OcrAssetError('model archive must be an uncompressed ustar tar'); }
    const entries = new Set();
    const entryNames = new Set();
    let root = null;
    let offset = 0;
    let count = 0;
    let unpackedBytes = 0;
    let endOffset = -1;
    while (offset + 512 <= source.length) {
        const header = source.subarray(offset, offset + 512);
        if (isZeroBlock(header)) {
            if (offset + 1024 > source.length || !isZeroBlock(source.subarray(offset + 512, offset + 1024))) { throw new OcrAssetError('tar archive must end with two zero blocks'); }
            endOffset = offset + 1024;
            break;
        }
        count += 1;
        if (count > MAX_TAR_ENTRY_COUNT) { throw new OcrAssetError('tar archive has too many entries'); }
        assertTarChecksum(header);
        if (readTarString(header, 257, 6) !== 'ustar') { throw new OcrAssetError('model archive must use ustar headers'); }
        const name = readTarString(header, 0, 100);
        const prefix = readTarString(header, 345, 155);
        const entry = prefix.length === 0 ? name : `${prefix}/${name}`;
        const normalizedEntry = entry.endsWith('/') ? entry.slice(0, -1) : entry;
        assertSafeRelativePath(normalizedEntry, 'tar entry');
        const type = header[156];
        const size = readTarOctal(header, 124, 12);
        const parts = normalizedEntry.split('/');
        if (root === null) { root = parts[0]; }
        if (parts[0] !== root) { throw new OcrAssetError('tar archive must use exactly one top-level root'); }
        if (entryNames.has(normalizedEntry)) { throw new OcrAssetError('tar archive has duplicate normalized entries'); }
        entryNames.add(normalizedEntry);
        if (type === 53) {
            // Official PP-OCRv5 archives include .cache/huggingface directory
            // records below the model root. They are never extracted here; the
            // single-root and safe-path checks above still make them unambiguous.
            if (size !== 0) { throw new OcrAssetError('tar archive directory must be empty'); }
        } else if (type === 0 || type === 48) {
            if (parts.length < 2) { throw new OcrAssetError('tar archive has a root-level file entry'); }
            entries.add(normalizedEntry);
            unpackedBytes += size;
            if (unpackedBytes > MAX_TAR_UNPACKED_BYTES) { throw new OcrAssetError('tar archive unpacked size exceeds the limit'); }
        } else {
            throw new OcrAssetError(`tar entry ${entry} is not a regular file or approved root directory`);
        }
        const paddedSize = Math.ceil(size / 512) * 512;
        offset += 512 + paddedSize;
        if (offset > source.length) { throw new OcrAssetError('tar entry exceeds archive length'); }
    }
    if (endOffset < 0 || root === null || entries.size === 0) { throw new OcrAssetError('tar archive has no valid model entries'); }
    if (!isZeroBlock(source.subarray(endOffset))) { throw new OcrAssetError('tar archive has nonzero trailing data'); }
    return entries;
}

/**
 * @param {Set<string>} entries
 * @param {string[]} requiredEntries
 * @throws {OcrAssetError}
 */
function assertModelArchiveLayout(entries, requiredEntries) {
    const roots = new Set([...entries].map((entry) => entry.split('/')[0]));
    if (roots.size !== 1) { throw new OcrAssetError('tar archive must use exactly one model root'); }
    const root = [...roots][0];
    for (const entry of requiredEntries) {
        if (!entries.has(`${root}/${entry}`)) { throw new OcrAssetError(`model archive is missing ${entry} under its root`); }
    }
}

/**
 * @param {string} directory
 * @param {string} name
 * @throws {OcrAssetError}
 */
function assertDirectoryNotSymlink(directory, name) {
    if (!fs.existsSync(directory)) { throw new OcrAssetError(`${name} does not exist`); }
    const stats = fs.lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) { throw new OcrAssetError(`${name} must be a real directory, not a symlink`); }
}

/**
 * @param {string} directory
 * @returns {string[]}
 * @throws {OcrAssetError}
 */
function getRegularFiles(directory) {
    assertDirectoryNotSymlink(directory, 'OCR asset directory');
    /** @type {string[]} */ const files = [];
    /**
     * @param {string} current
     * @param {string} prefix
     * @throws {OcrAssetError}
     */
    function visit(current, prefix) {
        for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
            const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
            const fullPath = path.join(current, entry.name);
            const stats = fs.lstatSync(fullPath);
            if (stats.isSymbolicLink()) { throw new OcrAssetError(`OCR asset directory must not contain symlink ${relative}`); }
            if (stats.isDirectory()) {
                visit(fullPath, relative);
            } else if (stats.isFile()) {
                files.push(relative);
            } else {
                throw new OcrAssetError(`OCR asset directory contains unsupported entry ${relative}`);
            }
        }
    }
    visit(directory, '');
    return files.sort();
}

/**
 * @param {string} sourcePath
 * @returns {Buffer}
 * @throws {OcrAssetError}
 */
function readStableSourceFile(sourcePath) {
    const before = fs.lstatSync(sourcePath);
    if (before.isSymbolicLink() || !before.isFile()) { throw new OcrAssetError(`OCR source file must be a regular file: ${sourcePath}`); }
    const descriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) { throw new OcrAssetError(`OCR source file changed while being opened: ${sourcePath}`); }
        const source = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor);
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || source.byteLength !== opened.size) { throw new OcrAssetError(`OCR source file changed while being read: ${sourcePath}`); }
        return source;
    } finally {
        fs.closeSync(descriptor);
    }
}

/**
 * Stages an exact closure into a new sibling directory then atomically renames
 * it into place. Open descriptors plus inode/size checks mitigate source-file
 * replacement. A portable API cannot fully prevent hostile parent-path swaps,
 * so callers must use trusted build directories.
 * @param {{manifest: unknown, sourceDirectory: string, outputDirectory: string}} options
 * @returns {OcrAsset[]}
 * @throws {OcrAssetError}
 */
export function stageOcrAssets({manifest, sourceDirectory, outputDirectory}) {
    assertOcrAssetManifest(manifest);
    assertDirectoryNotSymlink(sourceDirectory, 'OCR asset source directory');
    if (fs.existsSync(outputDirectory)) { throw new OcrAssetError('OCR asset output directory must not already exist'); }
    const expectedSources = manifest.assets.map(({source}) => source.path).sort();
    if (JSON.stringify(getRegularFiles(sourceDirectory)) !== JSON.stringify(expectedSources)) { throw new OcrAssetError('OCR asset source directory does not exactly match the manifest'); }
    /** @type {Array<{asset: OcrAsset, source: Buffer}>} */ const verified = [];
    for (const asset of manifest.assets) {
        if (!asset.redistributionApproved) { throw new OcrAssetError(`${asset.id} is not approved for redistribution`); }
        const source = readStableSourceFile(path.join(sourceDirectory, asset.source.path));
        if (source.byteLength !== asset.source.bytes || getSha256(source) !== asset.source.sha256) { throw new OcrAssetError(`${asset.id} source hash or size does not match the manifest`); }
        if (asset.archive !== void 0) { assertModelArchiveLayout(getUstarTarEntries(source), asset.archive.requiredEntries); }
        verified.push({asset, source});
    }
    const parent = path.dirname(outputDirectory);
    assertDirectoryNotSymlink(parent, 'OCR asset output parent directory');
    const temporaryDirectory = fs.mkdtempSync(path.join(parent, `.${path.basename(outputDirectory)}.ocr-stage-`));
    try {
        for (const {asset, source} of verified) {
            const outputPath = path.join(temporaryDirectory, asset.destination);
            fs.mkdirSync(path.dirname(outputPath), {recursive: true});
            fs.writeFileSync(outputPath, source, {flag: 'wx'});
            const output = readStableSourceFile(outputPath);
            if (output.byteLength !== asset.outputBytes || getSha256(output) !== asset.outputSha256) { throw new OcrAssetError(`${asset.id} output hash or size does not match the manifest`); }
        }
        const expectedOutputs = manifest.assets.map(({destination}) => destination).sort();
        if (JSON.stringify(getRegularFiles(temporaryDirectory)) !== JSON.stringify(expectedOutputs)) { throw new OcrAssetError('OCR asset temporary output does not exactly match the manifest'); }
        if (fs.existsSync(outputDirectory)) { throw new OcrAssetError('OCR asset output directory appeared during staging'); }
        fs.renameSync(temporaryDirectory, outputDirectory);
        return manifest.assets;
    } catch (error) {
        fs.rmSync(temporaryDirectory, {recursive: true, force: true});
        throw error;
    }
}
