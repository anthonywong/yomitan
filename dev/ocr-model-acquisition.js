/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import fs from 'node:fs';
import path from 'node:path';
import {assertSafeRelativePath, getSha256, getUstarTarEntries, OcrAssetError} from './ocr-asset-util.js';

export const MAX_OCR_CANDIDATE_BYTES = 32 * 1024 * 1024;
const MODEL_ORIGIN = 'https://paddle-model-ecology.bj.bcebos.com';
const MODEL_PATH_PREFIX = '/paddlex/official_inference_model/paddle3.0.0/';

/** @param {unknown} value @returns {asserts value is {schemaVersion: 1, upstream: {sdkPackage: string, sdkVersion: string, sdkCommit: string, sdkSourceUrl: string}, publicRelease: {status: string, gate: string}, models: Array<{id: string, role: string, url: string, sha256: string, bytes: number, archiveRoot: string}>}} */
export function assertOcrModelCandidates(value) {
    if (typeof value !== 'object' || value === null) { throw new OcrAssetError('OCR model candidates must be an object'); }
    const candidates = /** @type {{schemaVersion?: unknown, upstream?: unknown, publicRelease?: unknown, models?: unknown}} */ (value);
    if (candidates.schemaVersion !== 1 || !Array.isArray(candidates.models) || candidates.models.length === 0) { throw new OcrAssetError('OCR model candidates must use schema version 1 and a non-empty models array'); }
    const upstream = /** @type {{sdkPackage?: unknown, sdkVersion?: unknown, sdkCommit?: unknown, sdkSourceUrl?: unknown}} */ (candidates.upstream);
    if (upstream.sdkPackage !== '@paddleocr/paddleocr-js' || typeof upstream.sdkVersion !== 'string' || !/^[a-f0-9]{40}$/u.test(/** @type {string} */ (upstream.sdkCommit)) || upstream.sdkSourceUrl !== `https://github.com/PaddlePaddle/PaddleOCR/tree/${upstream.sdkCommit}/paddleocr-js/packages/core`) { throw new OcrAssetError('OCR candidate SDK provenance is invalid'); }
    const release = /** @type {{status?: unknown, gate?: unknown}} */ (candidates.publicRelease);
    if (release.status !== 'legal-review-required' || typeof release.gate !== 'string') { throw new OcrAssetError('OCR candidate public-release gate is invalid'); }
    const ids = new Set();
    for (const candidate of candidates.models) {
        if (typeof candidate !== 'object' || candidate === null) { throw new OcrAssetError('OCR candidate must be an object'); }
        const model = /** @type {{id?: unknown, role?: unknown, url?: unknown, sha256?: unknown, bytes?: unknown, archiveRoot?: unknown}} */ (candidate);
        if (typeof model.id !== 'string' || !/^PP-OCRv[0-9]_(?:small|tiny|mobile)_(?:det|rec)_onnx_infer$/u.test(model.id) || ids.has(model.id)) { throw new OcrAssetError('OCR candidate ID is invalid or duplicated'); }
        ids.add(model.id);
        if (!['detector', 'recognizer'].includes(/** @type {string} */ (model.role)) || typeof model.url !== 'string' || model.url !== `${MODEL_ORIGIN}${MODEL_PATH_PREFIX}${model.id}.tar` || typeof model.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(model.sha256) || !Number.isSafeInteger(model.bytes) || /** @type {number} */ (model.bytes) < 1 || /** @type {number} */ (model.bytes) > MAX_OCR_CANDIDATE_BYTES || model.archiveRoot !== model.id) { throw new OcrAssetError(`OCR candidate ${model.id} is invalid`); }
    }
}

/** @param {string} value @returns {string} */
function assertAllowedModelUrl(value) {
    const url = new URL(value);
    if (url.origin !== MODEL_ORIGIN || !url.pathname.startsWith(MODEL_PATH_PREFIX) || !url.pathname.endsWith('.tar') || url.search.length !== 0 || url.hash.length !== 0) { throw new OcrAssetError('OCR model URL is not on the allowlist'); }
    return url.href;
}

/** @param {string} url @param {typeof fetch} fetchImpl @returns {Promise<{response: Response, finalUrl: string}>} */
async function fetchAllowed(url, fetchImpl) {
    let currentUrl = assertAllowedModelUrl(url);
    for (let redirects = 0; redirects <= 3; ++redirects) {
        const response = await fetchImpl(currentUrl, {redirect: 'manual'});
        if (response.status < 300 || response.status >= 400) { return {response, finalUrl: currentUrl}; }
        const location = response.headers.get('location');
        if (location === null) { throw new OcrAssetError('OCR model redirect is missing a location'); }
        currentUrl = assertAllowedModelUrl(new URL(location, currentUrl).href);
    }
    throw new OcrAssetError('OCR model has too many redirects');
}

/** @param {Set<string>} entries @param {{archiveRoot: string}} candidate */
function assertCandidateLayout(entries, candidate) {
    if (!entries.has(`${candidate.archiveRoot}/inference.onnx`) || !entries.has(`${candidate.archiveRoot}/inference.yml`)) { throw new OcrAssetError(`OCR candidate ${candidate.archiveRoot} has an invalid archive layout`); }
}

/** @param {Parameters<typeof assertOcrModelCandidates>[0]} candidates @returns {object} */
export function createOcrModelVerificationLock(candidates) {
    assertOcrModelCandidates(candidates);
    return {
        schemaVersion: 1,
        upstream: candidates.upstream,
        models: candidates.models.map(({id, role, url, sha256, bytes, archiveRoot}) => ({id, role, url, sha256, bytes, archiveRoot})),
    };
}

/** @param {{candidates: Parameters<typeof assertOcrModelCandidates>[0], cacheDirectory: string, fetchImpl?: typeof fetch, now?: () => Date}} options */
export async function acquireOcrModelCandidates({candidates, cacheDirectory, fetchImpl = fetch, now = () => new Date()}) {
    assertOcrModelCandidates(candidates);
    if (typeof cacheDirectory !== 'string' || cacheDirectory.length === 0 || fs.existsSync(cacheDirectory)) { throw new OcrAssetError('OCR model cache directory must not already exist'); }
    const parent = path.dirname(cacheDirectory);
    fs.mkdirSync(parent, {recursive: true});
    if (!fs.existsSync(parent) || fs.lstatSync(parent).isSymbolicLink()) { throw new OcrAssetError('OCR model cache parent must be an existing real directory'); }
    const stage = fs.mkdtempSync(path.join(parent, `.${path.basename(cacheDirectory)}.stage-`));
    try {
        /** @type {Array<{id: string, finalUrl: string, sha256: string, bytes: number, archiveRoot: string}>} */
        const retrieved = [];
        for (const candidate of candidates.models) {
            const {response, finalUrl} = await fetchAllowed(candidate.url, fetchImpl);
            if (!response.ok) { throw new OcrAssetError(`OCR model ${candidate.id} download failed with HTTP ${response.status}`); }
            const declaredBytes = response.headers.get('content-length');
            if (declaredBytes === null || Number(declaredBytes) !== candidate.bytes) { throw new OcrAssetError(`OCR model ${candidate.id} content length does not match`); }
            const source = Buffer.from(await response.arrayBuffer());
            if (source.byteLength !== candidate.bytes || getSha256(source) !== candidate.sha256) { throw new OcrAssetError(`OCR model ${candidate.id} hash or size does not match`); }
            assertCandidateLayout(getUstarTarEntries(source), candidate);
            const output = path.join(stage, `${assertSafeRelativePath(candidate.id, 'OCR candidate ID')}.tar`);
            fs.writeFileSync(output, source, {flag: 'wx'});
            retrieved.push({id: candidate.id, finalUrl, sha256: candidate.sha256, bytes: candidate.bytes, archiveRoot: candidate.archiveRoot});
        }
        const lock = createOcrModelVerificationLock(candidates);
        fs.writeFileSync(path.join(stage, 'verification-lock.json'), `${JSON.stringify(lock, null, 4)}\n`, {flag: 'wx'});
        const report = {...lock, retrieval: {retrievedAt: now().toISOString(), models: retrieved}};
        fs.writeFileSync(path.join(stage, 'retrieval-report.json'), `${JSON.stringify(report, null, 4)}\n`, {flag: 'wx'});
        fs.renameSync(stage, cacheDirectory);
        return report;
    } catch (error) {
        fs.rmSync(stage, {recursive: true, force: true});
        throw error;
    }
}
