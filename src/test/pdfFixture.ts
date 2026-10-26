/** Tiny real PDF with searchable text and two pages; no binary fixture dependency. */
export function makePreviewPdf(text = 'LocalLeaf preview fixture', options: { openOutline?: boolean } = {}): Buffer {
    const objects = [
        `<< /Type /Catalog /Pages 2 0 R ${options.openOutline ? '/PageMode /UseOutlines /Outlines 8 0 R' : ''} >>`,
        '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        ...[text, 'Second page for navigation'].map(value => {
            const content = `BT /F1 24 Tf 72 700 Td (${value.replace(/[()\\]/g, '\\$&')}) Tj ET\n`;
            return `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`;
        }),
    ];
    if (options.openOutline) objects.push(
        '<< /Type /Outlines /First 9 0 R /Last 9 0 R /Count 1 >>',
        '<< /Title (Document outline) /Parent 8 0 R /Dest [3 0 R /Fit] >>',
    );
    let pdf = '%PDF-1.7\n';
    const offsets = [0];
    objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf);
}
