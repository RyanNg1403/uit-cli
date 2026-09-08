// ASCII PDF with a real page tree, text, graphics, xref table, and inert actions.
export function pdfFixture(width = 612, height = 792, pages = 2, pageSizes: Array<[number, number]> = []) {
  const streams = Array.from({ length: pages }, (_, index) => `BT /F1 24 Tf 40 700 Td (UIT OFFLINE PDF PAGE ${index + 1}) Tj ET\n0 ${index === 0 ? "0.8 0.3" : "0.3 0.8"} rg 40 480 240 120 re f\nq 80 0 0 80 320 480 cm /Im1 Do Q\n`);
  const font = 3 + pages * 2, action = font + 1, annotation = font + 2, image = font + 3;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /OpenAction ${action} 0 R >>`,
    `<< /Type /Pages /Kids [${streams.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${pages} >>`,
    ...streams.flatMap((stream, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageSizes[index]?.[0] ?? width} ${pageSizes[index]?.[1] ?? height}] /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im1 ${image} 0 R >> >> /Contents ${4 + index * 2} 0 R /Annots [${annotation} 0 R] >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    ]),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    '<< /S /JavaScript /JS (app.alert("PDF action must not execute")) >>',
    "<< /Type /Annot /Subtype /Link /Rect [40 480 280 600] /A << /S /URI /URI (https://example.invalid/pdf-action) >> >>",
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nFF0000>\nendstream",
  ];
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
