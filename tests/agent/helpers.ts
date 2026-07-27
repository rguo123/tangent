import type { MockProvider } from '../../src/main/agent/provider'

/**
 * Queue one extraction proposal: concept N cites input N, which is what every
 * case that isn't specifically about source resolution wants. Tests that need
 * odd refs (an invented one, two concepts on one input) call `queueStructured`
 * directly.
 */
export function queueConcepts(provider: MockProvider, ...canonicalTexts: string[]): void {
  provider.queueStructured({
    concepts: canonicalTexts.map((canonicalText, i) => ({
      canonicalText,
      sourceRefs: [`i${i + 1}`],
    })),
  })
}

/**
 * A one-page, uncompressed PDF containing `text` — small enough to build by
 * hand, real enough for pdf.js to parse. Keeps the text-extraction tests free
 * of a binary fixture.
 */
export function minimalPdf(text: string): Buffer {
  const content = `BT /F1 18 Tf 40 700 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}
