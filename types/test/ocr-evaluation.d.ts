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

export type Point = [number, number];

export type Bounds = {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
};

export type WritingMode = 'horizontal-tb' | 'vertical-rl' | 'vertical-lr';

export type CharacterHitPoint = {
    character: string;
    /** Unicode code-point index in NFC-normalized line text. */
    index: number;
    point: Point;
};

export type ScoredCharacter = {
    character: string;
    /** Unicode code-point index in NFC-normalized line text. */
    index: number;
    polygon: Point[];
};

export type ScoredLine = {
    text: string;
    score: number;
    polygon: Point[];
    writingMode: WritingMode;
    /** Lower values precede higher values in the engine-normalized reading order. */
    order?: number;
    /** Native character polygons or deterministic per-code-point subdivisions of the line polygon. */
    characters: ScoredCharacter[];
};

export type CoordinateHitResult = {
    hits: number;
    total: number;
    rate: number;
};

export type OcrEvaluationExpectedLine = {
    /** Lower values precede higher values in the expected reading order. */
    order: number;
    text: string;
    polygon: Point[];
    writingMode: WritingMode;
    characterHitPoints: CharacterHitPoint[];
};

export type LookupTarget = {
    lineOrder: number;
    point: Point;
    expectedTerm: string;
    reading?: string;
    dictionaryTerm?: string;
};

export type FrameCase = {
    id: string;
    embedding: 'top' | 'same-origin-iframe' | 'cross-origin-iframe';
    coordinateSpace: 'frame-viewport' | 'top-viewport';
};

export type GeneratedProvenance = {
    kind: 'generated-in-repository';
    description: string;
};

export type ExternalLicensedProvenance = {
    kind: 'external-licensed';
    description: string;
    sourceUrl: string;
    creator: string;
    license: string;
    attribution: string;
    review: {reviewedBy: string, reviewedAt: string};
    privacy: {containsPersonalData: boolean, notes: string};
};

export type OcrEvaluationProvenance = GeneratedProvenance | ExternalLicensedProvenance;

export type OcrEvaluationReadyFixture = {
    id: string;
    status: 'ready';
    category: 'synthetic-horizontal' | 'synthetic-vertical' | 'isolated-kanji' | 'mixed-text' | 'no-text';
    file: string;
    sha256: string;
    dimensions: {width: number, height: number};
    license: 'CC0-1.0';
    provenance: OcrEvaluationProvenance;
    expectedLines: OcrEvaluationExpectedLine[];
    lookupTargets: LookupTarget[];
    frameCase: FrameCase | null;
};

export type OcrEvaluationPendingFixture = {
    id: string;
    status: 'pending';
    category: 'natural-photo' | 'manga-game';
    reason: string;
};

export type OcrEvaluationManifest = {
    schemaVersion: 1;
    license: 'CC0-1.0';
    textNormalization: 'NFC';
    provenance: GeneratedProvenance;
    fixtures: Array<OcrEvaluationReadyFixture | OcrEvaluationPendingFixture>;
};
