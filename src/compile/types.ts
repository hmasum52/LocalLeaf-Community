export interface CompileArtifact {
    path: string;
    url: string;
    type: string;
    build?: string;
    editorId?: string;
}

export interface BuildRouting {
    buildId?: string;
    editorId?: string;
    compileGroup?: string;
    clsiServerId?: string;
    pdfDownloadDomain?: string;
}

export interface CompileResult {
    status: string;
    artifacts: CompileArtifact[];
    routing: BuildRouting;
}

/** Durable metadata deliberately excludes download domains and URLs. */
export interface CompiledBuild {
    buildId?: string;
    editorId?: string;
    clsiServerId?: string;
    rootResourcePath: string;
    createdAt: string;
}

export interface PdfLocation {
    page: number;
    h: number;
    v: number;
    width: number;
    height: number;
}

export interface SourceLocation { file: string; line: number; column: number }
export type CompileState = 'idle' | 'synchronizing' | 'compiling' | 'ready' | 'failed';
