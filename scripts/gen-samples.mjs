// Generates public/samples/* used by the "Uji dengan contoh dokumen" action.
//   sample-letter.pdf — 3-page US Letter document (demonstrates auto-fit -> A4)
//   sample-warna.png  — colored calibration bars (demonstrates grayscale preview)
//   sample-dokumen.docx — 2-page A4 Word document
// Run: bun scripts/gen-samples.mjs

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  AlignmentType,
  Document,
  PageBreak,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outDir = path.resolve("public/samples");
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- PDF (Letter)
async function makePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);

  const pageSpecs = [
    { title: "HALAMAN 1", color: rgb(0.0, 0.2, 0.6) },
    { title: "HALAMAN 2", color: rgb(0.85, 0.33, 0.1) },
    { title: "HALAMAN 3", color: rgb(0.13, 0.55, 0.31) },
  ];

  for (const spec of pageSpecs) {
    // US Letter in points: 612 x 792 (216 x 279 mm) -> triggers auto-fit to A4
    const page = pdf.addPage([612, 792]);
    page.drawRectangle({
      x: 0, y: 640, width: 612, height: 152,
      color: spec.color,
    });
    page.drawText("EPSON PRINT STATION", {
      x: 48, y: 700, size: 26, font, color: rgb(1, 1, 1),
    });
    page.drawText("DOKUMEN UJI CETAK", {
      x: 48, y: 668, size: 13, font: fontRegular, color: rgb(1, 1, 1),
    });
    page.drawText(spec.title, {
      x: 48, y: 560, size: 42, font, color: rgb(0, 0, 0),
    });
    const lines = [
      "Ukuran dokumen asli: Letter (216 x 279 mm).",
      "Tray default aplikasi: A4 (210 x 297 mm).",
      "Sistem akan mengaktifkan Penyesuaian Otomatis (Fit to Page)",
      "agar tidak ada bagian yang terpotong saat dicetak.",
      "",
      "Dokumen uji ini memuat batang warna pada halaman pertama",
      "untuk menguji pratinjau Hitam Putih (grayscale).",
    ];
    lines.forEach((line, i) => {
      page.drawText(line, {
        x: 48, y: 500 - i * 24, size: 12, font: fontRegular,
        color: rgb(0, 0, 0),
      });
    });
  }

  const bytes = await pdf.save();
  writeFileSync(path.join(outDir, "sample-letter.pdf"), bytes);
  console.log("sample-letter.pdf", bytes.length, "bytes");
}

// ---------------------------------------------------------------- PNG (color bars)
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crc32.table = table;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng() {
  const W = 1000, H = 700;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  const bars = [
    [239, 68, 53], [245, 158, 11], [132, 204, 22],
    [16, 133, 165], [0, 51, 153], [126, 34, 206],
    [236, 72, 153], [17, 24, 39], [107, 114, 128],
  ];
  for (let y = 0; y < H; y++) {
    const rowStart = y * (W * 3 + 1);
    raw[rowStart] = 0; // filter none
    for (let x = 0; x < W; x++) {
      const barIndex = Math.floor((x / W) * bars.length);
      const c = bars[barIndex];
      let r = c[0], g = c[1], b = c[2];
      if (y > 480 && y < 520 && x > 80 && x < 920) { r = 255; g = 255; b = 255; }
      if (y >= 520 && y < 560 && x > 80 && x < 920) { r = 17; g = 24; b = 39; }
      const p = rowStart + 1 + x * 3;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path.join(outDir, "sample-warna.png"), png);
  console.log("sample-warna.png", png.length, "bytes");
}

// ---------------------------------------------------------------- DOCX
async function makeDocx() {
  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "LAPORAN UJI DOKUMEN", bold: true, size: 40 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "Epson Print Station — contoh DOCX", italics: true, size: 22 })],
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: "Dokumen ini dipakai untuk menguji pratinjau DOCX (docx-preview), penghitungan halaman, dan pencetakan bolak-balik manual. Ukuran halaman mengikuti A4 (210 x 297 mm).",
          size: 22,
        }),
      ],
      spacing: { after: 240 },
    }),
    new Paragraph({ children: [new TextRun("Bagian pertama berisi paragraf mengalir untuk menguji skala dan margin panduan cetak."), new PageBreak()], spacing: { after: 120 } }),
    new Paragraph({
      children: [new TextRun({ text: "Halaman 2 — Daftar Pemeriksaan Cetak", bold: true, size: 28 })],
    }),
    ...[
      "1. Ukuran kertas tray sesuai pengaturan aplikasi.",
      "2. Mode warna: Berwarna / Hitam Putih diuji pada pratinjau langsung.",
      "3. Kualitas cetak: Draf, Standar, Tinggi.",
      "4. Duplex manual: halaman ganjil, balik kertas, halaman genap.",
    ].map((t) => new Paragraph({ children: [new TextRun({ text: t, size: 22 })], spacing: { after: 120 } })),
  ];
  const doc = new Document({
    sections: [{ properties: {}, children }],
  });
  const buf = await Packer.toBuffer(doc);
  writeFileSync(path.join(outDir, "sample-dokumen.docx"), buf);
  console.log("sample-dokumen.docx", buf.length, "bytes");
}

await makePdf();
makePng();
await makeDocx();
console.log("samples written to", outDir);
