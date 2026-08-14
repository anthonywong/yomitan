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

import type {Application} from '../../ext/js/application';
import type {TextSourceGenerator} from '../../ext/js/dom/text-source-generator';
import type * as OcrUtil from './ocr-util';

export type ConstructorDetails = {
    application: Application;
    textSourceGenerator: TextSourceGenerator;
};

export type ImageSource = {
    type: 'image';
    image: HTMLImageElement;
};

export type RegionSource = {
    type: 'region';
    documentRect: OcrUtil.Rect;
};

export type Source = ImageSource | RegionSource;

export type Input = {
    dataUrl: string;
    width: number;
    height: number;
};

export type LastRequest = {
    mode: OcrUtil.Mode;
    source: Source;
};

export type WorkerProgress = {
    status?: string;
    progress?: number;
};

export type Worker = {
    setParameters(parameters: Record<string, string>): Promise<unknown>;
    recognize(
        image: string,
        options: Record<string, unknown>,
        output: {tsv: boolean},
    ): Promise<{data: {tsv?: string}}>;
    terminate(): Promise<unknown>;
};

export type CreateWorker = (
    language: string,
    oem: number,
    options: {
        workerPath: string;
        corePath: string;
        langPath: string;
        workerBlobURL: boolean;
        logger: (progress: WorkerProgress) => void;
    },
) => Promise<Worker>;

export type OverlayState = {
    root: HTMLDivElement;
    imageSpace: HTMLDivElement;
    lineNodes: HTMLSpanElement[];
    source: Source;
    sourceWidth: number;
    sourceHeight: number;
    resizeObserver: ResizeObserver | null;
    updateQueued: boolean;
};
