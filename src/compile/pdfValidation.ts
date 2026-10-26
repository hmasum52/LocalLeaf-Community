/** Reject login pages and truncated output before replacing the last successful PDF. */
export function assertPdfBytes(bytes: Uint8Array): void {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = buffer.subarray(0, 1024).toString('latin1');
    const tail = buffer.subarray(Math.max(0, buffer.length - 65_536)).toString('latin1');
    const trailers = [...tail.matchAll(/startxref\s+(\d+)\s+%%EOF\b/g)];
    const offset = Number(trailers.at(-1)?.[1]);
    if (!/%PDF-[12]\.\d/.test(header) || !trailers.length || !Number.isSafeInteger(offset) || offset < 0 || offset >= buffer.length
        || !/^(?:xref\b|\d+\s+\d+\s+obj\b)/.test(buffer.subarray(offset, offset + 64).toString('latin1'))) {
        throw new Error('Overleaf returned an invalid or incomplete PDF. The previous PDF was preserved.');
    }
}
