/**
 * Builds small, valid PDFs in memory so edge cases can be tested without
 * committing binary fixtures.
 *
 * Each entry in `pages` becomes one page; an empty string becomes a page with
 * no content stream, which is how a scanned page looks to a text extractor
 * (the image is there, the text is not).
 */
export function makePdf(pages: string[], options: { encrypted?: boolean } = {}): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };

  const catalog = add("");
  const pageTree = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const pageIds = pages.map((text) => {
    const contents = text
      ? add(stream(`BT /F1 12 Tf 72 720 Td (${escapePdfString(text)}) Tj ET`))
      : undefined;
    return add(
      `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${font} 0 R >> >>` +
        (contents ? ` /Contents ${contents} 0 R` : "") +
        " >>",
    );
  });

  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`;
  objects[pageTree - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  /*
   * Standard security handler with an owner and user password whose check
   * values are arbitrary. pdf.js tries the empty user password, fails the
   * check, and asks for a password -- exactly what a real password-protected
   * file does -- without the test needing to implement RC4.
   */
  const encrypt = options.encrypted
    ? add(
        `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -44 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> >>`,
      )
    : undefined;

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R` +
    (encrypt ? ` /Encrypt ${encrypt} 0 R /ID [<${"01".repeat(16)}> <${"01".repeat(16)}>]` : "") +
    ` >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return new TextEncoder().encode(body);
}

function stream(content: string): string {
  return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
}

function escapePdfString(text: string): string {
  return text.replace(/[\\()]/g, (char) => `\\${char}`);
}
