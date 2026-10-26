import type { RequestInit, Response } from 'node-fetch';
import { randomUUID } from 'crypto';
import type { Identity } from '../utils/credentialManager';
import { normalizeProjectPath } from '../utils/pathSafety';
import { MAX_REMOTE_FILE_BYTES, validateOverleafId } from '../utils/remoteValidation';
import { BuildRouting, CompileArtifact, CompileResult, PdfLocation, SourceLocation } from './types';
import { assertPdfBytes } from './pdfValidation';

type Request = (route: string, options: RequestInit, maximum: number, timeout: number,
    signal?: AbortSignal, absoluteUrl?: string) => Promise<Response>;
const boundedString = (value: unknown): string | undefined => typeof value === 'string'
    && value.length > 0 && value.length <= 8192 && !/[\r\n\0]/.test(value) ? value : undefined;
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid compilation response.');
    return value as Record<string, unknown>;
}

export class CompileAPI {
    constructor(private readonly base: string, private readonly identity: () => Identity | undefined,
        private readonly request: Request, private readonly failure: (response: Response) => Promise<never>) {}

    private headers(json = false): Record<string, string> {
        const identity = this.identity();
        if (!identity) throw new Error('Not authenticated. Sign in to Overleaf first.');
        return { Cookie: identity.cookies, 'X-Csrf-Token': identity.csrfToken,
            ...(json ? { 'Content-Type': 'application/json' } : {}) };
    }

    private route(projectId: string): string { return `project/${encodeURIComponent(validateOverleafId(projectId, 'project ID'))}`; }

    private async json(route: string, options: RequestInit, signal?: AbortSignal, timeout = 30_000): Promise<unknown> {
        const response = await this.request(route, options, 10 * 1024 * 1024, timeout, signal);
        if (!response.ok) return this.failure(response);
        const text = await response.text();
        try { return JSON.parse(text) as unknown; }
        catch { throw new Error('Overleaf returned an invalid compilation response. Check your session and server.'); }
    }

    async compileProject(projectId: string, rootResourcePath: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CompileResult> {
        const root = normalizeProjectPath(rootResourcePath, false).slice(1);
        if (!root.toLowerCase().endsWith('.tex')) throw new Error('Select a main .tex document first.');
        const data = record(await this.json(`${this.route(projectId)}/compile?auto_compile=true`, {
            method: 'POST', headers: this.headers(true),
            body: JSON.stringify({ check: 'silent', draft: false, incrementalCompilesEnabled: true,
                rootResourcePath: root, stopOnFirstError: false }),
        }, options.signal, options.timeoutMs ?? 180_000));
        if (!boundedString(data.status) || !Array.isArray(data.outputFiles) || data.outputFiles.length > 10_000) {
            throw new Error('Overleaf returned invalid compilation output.');
        }
        const artifacts = data.outputFiles.map((value): CompileArtifact => {
            const item = record(value);
            const url = boundedString(item.url);
            const file = boundedString(item.path);
            if (!url || !file) throw new Error('Overleaf returned an invalid output file.');
            normalizeProjectPath(file, false);
            return { path: file, url, type: boundedString(item.type) ?? '',
                build: boundedString(item.build), editorId: boundedString(item.editorId) };
        });
        const pdf = artifacts.find(item => item.path === 'output.pdf') ?? artifacts.find(item => item.type === 'pdf');
        const pdfUrl = pdf ? this.artifactUrl(projectId, pdf) : undefined;
        return { status: data.status as string, artifacts, routing: {
            buildId: pdf?.build ?? pdfUrl?.searchParams.get('buildId')
                ?? pdfUrl?.pathname.match(/\/(?:build|output)\/([^/]+)\/output\//)?.[1],
            editorId: pdf?.editorId ?? pdfUrl?.searchParams.get('editorId') ?? undefined,
            compileGroup: boundedString(data.compileGroup), clsiServerId: boundedString(data.clsiServerId),
            pdfDownloadDomain: boundedString(data.pdfDownloadDomain),
        } };
    }

    async stopCompile(projectId: string): Promise<void> {
        const response = await this.request(`${this.route(projectId)}/compile/stop`,
            { method: 'POST', headers: this.headers() }, 1024 * 1024, 30_000);
        if (!response.ok) return this.failure(response);
        await response.text();
    }

    private artifactUrl(projectId: string, artifact: CompileArtifact): URL {
        const base = new URL(this.base);
        const url = new URL(artifact.url, base);
        const prefix = `${base.pathname}${this.route(projectId)}/`;
        if (url.origin !== base.origin || !url.pathname.startsWith(prefix) || url.username || url.password || url.hash) {
            throw new Error('Overleaf returned an output URL outside the linked project.');
        }
        // Reject encoded traversal/separators as well as URL-normalized escapes.
        for (const segment of url.pathname.split('/').filter(Boolean)) {
            const decoded = decodeURIComponent(segment);
            if (decoded === '.' || decoded === '..' || /[\\/\0]/.test(decoded)) throw new Error('Unsafe output URL.');
        }
        return url;
    }

    async downloadCompileOutput(projectId: string, artifact: CompileArtifact, routing: BuildRouting,
        signal?: AbortSignal): Promise<Uint8Array> {
        const serverUrl = this.artifactUrl(projectId, artifact);
        let url = serverUrl;
        let headers: Record<string, string> = this.headers();
        if (routing.pdfDownloadDomain && routing.clsiServerId) {
            const domain = new URL(routing.pdfDownloadDomain);
            if (domain.protocol !== 'https:' || domain.username || domain.password || domain.search || domain.hash) {
                throw new Error('Overleaf returned an invalid PDF download domain.');
            }
            url = new URL(serverUrl.pathname.replace(/^\//, ''), `${domain.href.replace(/\/$/, '')}/`);
            url.search = serverUrl.search;
            url.searchParams.set('clsiserverid', routing.clsiServerId);
            if (routing.compileGroup) url.searchParams.set('compileGroup', routing.compileGroup);
            url.searchParams.set('enable_pdf_caching', 'true');
            headers = {}; // Cross-origin requests must never receive account credentials.
        }
        const chunks: Buffer[] = [];
        let offset = 0;
        let total: number | undefined;
        let validator: string | null = null;
        for (let count = 0; count < 10_000; count++) {
            const rangeHeaders: Record<string, string> = { ...headers, ...(offset ? { Range: `bytes=${offset}-`, ...(validator ? { 'If-Range': validator } : {}) } : {}) };
            const response: Response = await this.request('', { method: 'GET', headers: rangeHeaders }, MAX_REMOTE_FILE_BYTES,
                30_000, signal, url.href).catch(() => {
                    // A fetch error can contain the full signed artifact URL. Keep it out of the viewer and logs.
                    throw new Error(signal?.aborted ? 'Compiled output download cancelled.'
                        : 'Compiled output download failed or timed out. Check the connection and retry.');
                });
            if (response.status !== 200 && response.status !== 206) return this.failure(response);
            const bytes = await response.buffer();
            if (response.status === 200) {
                if (offset) throw new Error('The compiled file changed during download.');
                return this.validateContent(artifact, bytes);
            }
            const match = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
            const tag: string | null = response.headers.get('etag') ?? response.headers.get('last-modified');
            if (!match) throw new Error('Invalid compiled output download range.');
            const [start, end, size] = match.slice(1).map(Number);
            if (![start, end, size].every(Number.isSafeInteger) || start !== offset || end < start || end >= size
                || size > MAX_REMOTE_FILE_BYTES || bytes.length !== end - start + 1
                || (total !== undefined && (total !== size || tag !== validator))) throw new Error('Compiled output changed or returned an invalid range.');
            total = size; validator = tag; chunks.push(bytes); offset = end + 1;
            if (offset === size) return this.validateContent(artifact, Buffer.concat(chunks, size));
        }
        throw new Error('Too many partial output downloads.');
    }

    private validateContent(artifact: CompileArtifact, bytes: Buffer): Uint8Array {
        if (/^\s*(?:<!doctype\s+html|<html|<form)\b/i.test(bytes.subarray(0, 4096).toString('utf8'))) {
            throw new Error('Overleaf returned an HTML page instead of compiled output. Check your session and retry.');
        }
        if (bytes.length > MAX_REMOTE_FILE_BYTES) throw new Error('The compiled output exceeds the download size limit.');
        if (artifact.path.toLowerCase().endsWith('.pdf') || artifact.type === 'pdf') assertPdfBytes(bytes);
        return bytes;
    }

    private buildQuery(build: BuildRouting): URLSearchParams {
        const query = new URLSearchParams();
        query.set('editorId', build.editorId ?? randomUUID());
        if (build.buildId) query.set('buildId', build.buildId);
        if (build.clsiServerId) query.set('clsiserverid', build.clsiServerId);
        return query;
    }

    private async syncRequest(route: string, signal?: AbortSignal): Promise<unknown> {
        try { return await this.json(route, { headers: this.headers() }, signal); }
        catch (error) {
            const status = error && typeof error === 'object' ? (error as { status?: number }).status : undefined;
            if (status === 404 || status === 410) throw new Error('SyncTeX data has expired. Recompile the project and try again.');
            throw error;
        }
    }

    async syncCode(projectId: string, source: SourceLocation, build: BuildRouting, signal?: AbortSignal): Promise<PdfLocation[]> {
        const query = this.buildQuery(build);
        query.set('file', source.file); query.set('line', String(source.line)); query.set('column', String(source.column));
        const data = record(await this.syncRequest(`${this.route(projectId)}/sync/code?${query}`, signal));
        if (!Array.isArray(data.pdf) || !data.pdf.length || data.pdf.length > 10_000) throw new Error('SyncTeX data is unavailable. Recompile the project.');
        return data.pdf.map(value => {
            const point = record(value);
            if (!Number.isInteger(point.page) || Number(point.page) < 1 || !['h', 'v', 'width', 'height'].every(key =>
                typeof point[key] === 'number' && Number.isFinite(point[key]))) throw new Error('Invalid SyncTeX PDF location.');
            return point as unknown as PdfLocation;
        });
    }

    async syncPdf(projectId: string, point: { page: number; h: number; v: number }, build: BuildRouting,
        signal?: AbortSignal): Promise<SourceLocation> {
        const query = this.buildQuery(build);
        query.set('page', String(point.page)); query.set('h', point.h.toFixed(2)); query.set('v', point.v.toFixed(2));
        const data = record(await this.syncRequest(`${this.route(projectId)}/sync/pdf?${query}`, signal));
        const source = record(Array.isArray(data.code) ? data.code[0] : undefined);
        if (!boundedString(source.file) || !Number.isInteger(source.line) || Number(source.line) < 1) {
            throw new Error('SyncTeX source is unavailable. Recompile the project.');
        }
        return { file: source.file as string, line: source.line as number,
            column: Number.isInteger(source.column) && Number(source.column) >= 0 ? Number(source.column) : 0 };
    }
}
