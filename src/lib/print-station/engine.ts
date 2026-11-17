// Browser print engine.
//
// Builds a strict, isolated print document inside a hidden iframe:
//   @page { size: <paper>mm; margin: 0 }   -> zero browser headers/footers
// Content is rendered at PRINT_DPI and composited into exact paper-sized
// sheets, so what the user sees in the preview is what the Epson driver gets.

import {
  PT_TO_MM,
  PX96_TO_MM,
  formatMm,
} from "@/lib/paper";
import type {
  ColorMode,
  DocxRender,
  LoadedFile,
  ScaleMode,
} from "@/lib/print-station/types";

export const PRINT_DPI = 200;
const MAX_SHEETS = 150;

export interface BrowserPrintRequest {
  file: LoadedFile;
  paperWmm: number;
  paperHmm: number;
  scaleMode: ScaleMode;
  colorMode: ColorMode;
  pages: number[];
  copies: number;
  getPdfDoc: () => Promise<import("pdfjs-dist").PDFDocumentProxy>;
  getDocxRender: () => Promise<DocxRender>;
  getDocHtml: () => Promise<string>;
}

function fmt(v: number): string {
  return formatMm(v);
}

function applyGrayscale(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = g;
    px[i + 1] = g;
    px[i + 2] = g;
  }
  ctx.putImageData(image, 0, 0);
}

/**
 * Print-black normalization (text enhancement).
 *
 * Inkjet drivers color-manage raster output, so "near-black" composite text
 * (e.g. #121726 / #333D4D) prints as a CMY mix that reads brown/warm on paper
 * instead of true black. Snapping dark neutral pixels to pure #000000 lets
 * the driver's GCR render them as K-only black; neutralizing mid-dark grays
 * removes the warm/cool cast on anti-aliased glyph edges. Conservative
 * thresholds keep intentional colored content untouched.
 */
function normalizePrintBlack(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = image.data;
  const DARK_MAX = 80; // max channel value still counted as black text
  const DARK_SPREAD = 28; // max channel spread still counted as neutral
  const NEUTRAL_SPREAD = 12; // spread below this = true neutral gray
  const NEUTRAL_MAX = 160; // grays darker than this get cast-removed
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const spread = max - min;
    if (max <= DARK_MAX && spread <= DARK_SPREAD) {
      // near-black text -> true black (K-only on the printer)
      px[i] = 0;
      px[i + 1] = 0;
      px[i + 2] = 0;
    } else if (spread <= NEUTRAL_SPREAD && max <= NEUTRAL_MAX) {
      // dark neutral gray (incl. glyph AA halo) -> exact luminance gray
      const l = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      px[i] = l;
      px[i + 1] = l;
      px[i + 2] = l;
    }
  }
  ctx.putImageData(image, 0, 0);
}

function fitScale(
  docWmm: number,
  docHmm: number,
  paperWmm: number,
  paperHmm: number,
  scaleMode: ScaleMode,
): number {
  if (scaleMode !== "fit") return 1;
  return Math.min(paperWmm / docWmm, paperHmm / docHmm);
}

function scaleSheets(sheets: string[], copies: number): string[] {
  const total = sheets.length * copies;
  if (total > MAX_SHEETS) {
    throw new Error(
      `Jumlah halaman × salinan melebihi batas ${MAX_SHEETS} lembar. Kurangi rentang halaman atau jumlah salinan.`,
    );
  }
  const out: string[] = [];
  for (let c = 0; c < copies; c++) out.push(...sheets);
  return out;
}

async function renderPdfSheets(req: BrowserPrintRequest): Promise<string[]> {
  const { file, paperWmm, paperHmm, scaleMode, colorMode, pages } = req;
  const doc = await req.getPdfDoc();
  const renderScale = PRINT_DPI / 72;
  const grayscale = colorMode === "grayscale";
  const sheets: string[] = [];

  for (const pageNo of pages) {
    const page = await doc.getPage(Math.min(pageNo, doc.numPages));
    const base = page.getViewport({ scale: 1 });
    const docWmm = base.width * PT_TO_MM;
    const docHmm = base.height * PT_TO_MM;
    const s = fitScale(docWmm, docHmm, paperWmm, paperHmm, scaleMode);

    const viewport = page.getViewport({ scale: renderScale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    await page.render({ canvas, viewport }).promise;
    if (grayscale) applyGrayscale(canvas);
    normalizePrintBlack(canvas);

    const w = docWmm * s;
    const h = docHmm * s;
    sheets.push(
      `<div class="sheet"><img src="${canvas.toDataURL("image/png")}" style="width:${fmt(w)}mm;height:${fmt(h)}mm" alt=""/></div>`,
    );
    page.cleanup();
  }
  return sheets;
}

async function renderImageSheets(req: BrowserPrintRequest): Promise<string[]> {
  const { file, paperWmm, paperHmm, scaleMode, colorMode } = req;
  if (!file.url) throw new Error("Sumber gambar tidak tersedia.");
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Gambar tidak dapat dibaca."));
    el.src = file.url as string;
  });

  const dpi = PRINT_DPI;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round((paperWmm / 25.4) * dpi);
  canvas.height = Math.round((paperHmm / 25.4) * dpi);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D tidak tersedia.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const imgWmm = img.naturalWidth * PX96_TO_MM;
  const imgHmm = img.naturalHeight * PX96_TO_MM;
  const s = fitScale(imgWmm, imgHmm, paperWmm, paperHmm, scaleMode);
  const drawW = (imgWmm / 25.4) * dpi * s;
  const drawH = (imgHmm / 25.4) * dpi * s;
  const dx = (canvas.width - drawW) / 2;
  const dy = (canvas.height - drawH) / 2;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, dx, dy, drawW, drawH);
  if (colorMode === "grayscale") applyGrayscale(canvas);
  normalizePrintBlack(canvas);

  return [
    `<div class="sheet"><img src="${canvas.toDataURL("image/png")}" style="width:${fmt(paperWmm)}mm;height:${fmt(paperHmm)}mm" alt=""/></div>`,
  ];
}

async function renderDocxHtml(req: BrowserPrintRequest): Promise<{ inner: string; css: string }> {
  const { paperWmm, paperHmm, scaleMode, colorMode } = req;
  const render = await req.getDocxRender();
  const zoom =
    scaleMode === "fit" && render.pageWmm > 0
      ? Math.min(paperWmm / render.pageWmm, paperHmm / render.pageHmm)
      : 1;
  const gray = colorMode === "grayscale" ? "filter:grayscale(1);" : "";
  const body = render.sectionsHtml.join("\n");
  return {
    inner: body,
    css: `
      .docx-wrapper{padding:0 !important;margin:0 !important;background:#fff !important;${gray}}
      .docx-wrapper>section.docx{
        margin:0 !important;box-shadow:none !important;background:#fff !important;
        page-break-after:always;break-after:page;
        transform-origin:top left;
        zoom:${zoom};
      }
      .docx-wrapper>section.docx:last-child{page-break-after:auto;break-after:auto}
    `,
  };
}

async function renderFlowHtml(req: BrowserPrintRequest): Promise<{ inner: string; css: string }> {
  const { paperWmm, colorMode, copies } = req;
  const html = await req.getDocHtml();
  const gray = colorMode === "grayscale" ? "filter:grayscale(1);" : "";
  const blocks: string[] = [];
  for (let c = 0; c < copies; c++) {
    blocks.push(
      `<div class="flow-copy" style="${c > 0 ? "break-before:page;page-break-before:always;" : ""}">${html}</div>`,
    );
  }
  return {
    inner: blocks.join("\n"),
    css: `
      body{width:${fmt(paperWmm)}mm;box-sizing:border-box;padding:20mm 18mm;${gray}}
      body>img{max-width:100%}
      .flow-copy p,.flow-copy h1,.flow-copy h2,.flow-copy h3,.flow-copy table{margin:0 0 6pt}
      .flow-copy table{border-collapse:collapse;width:100%}
      .flow-copy td,.flow-copy th{border:1px solid #d1d5db;padding:4pt 6pt;font-size:10pt}
      .flow-copy img{max-width:100%;height:auto}
    `,
  };
}

function buildPrintHtml(
  paperWmm: number,
  paperHmm: number,
  inner: string,
  extraCss: string,
): string {
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Print</title><style>
  @page{size:${fmt(paperWmm)}mm ${fmt(paperHmm)}mm;margin:0}
  html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sheet{width:${fmt(paperWmm)}mm;height:${fmt(paperHmm)}mm;overflow:hidden;page-break-after:always;break-after:page;display:flex;align-items:center;justify-content:center}
  .sheet:last-child{page-break-after:auto;break-after:auto}
  .sheet>img,.sheet>canvas{display:block}
  ${extraCss}
  </style></head><body>${inner}</body></html>`;
}

function printIframe(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("title", "print-frame");
    iframe.style.cssText =
      "position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0;pointer-events:none;";
    iframe.onload = () => {
      try {
        const win = iframe.contentWindow;
        if (!win) throw new Error("Print frame tidak tersedia.");
        window.setTimeout(() => {
          try {
            win.focus();
            win.print();
            window.setTimeout(() => {
              iframe.remove();
              resolve();
            }, 800);
          } catch (err) {
            iframe.remove();
            reject(err instanceof Error ? err : new Error("Print gagal."));
          }
        }, 180);
      } catch (err) {
        iframe.remove();
        reject(err instanceof Error ? err : new Error("Print gagal."));
      }
    };
    iframe.onerror = () => {
      iframe.remove();
      reject(new Error("Print frame gagal dimuat."));
    };
    document.body.appendChild(iframe);
    iframe.srcdoc = html;
  });
}

/**
 * Execute a browser print job via an isolated iframe with exact @page geometry.
 * Throws Error with a user-friendly (Indonesian) message when impossible.
 */
export async function printViaBrowser(req: BrowserPrintRequest): Promise<void> {
  const { file } = req;

  if (file.kind === "pdf") {
    const sheets = await renderPdfSheets(req);
    const html = buildPrintHtml(req.paperWmm, req.paperHmm, scaleSheets(sheets, req.copies).join("\n"), "");
    await printIframe(html);
    return;
  }

  if (file.kind === "image") {
    const sheets = await renderImageSheets(req);
    const html = buildPrintHtml(req.paperWmm, req.paperHmm, scaleSheets(sheets, req.copies).join("\n"), "");
    await printIframe(html);
    return;
  }

  if (file.kind === "docx") {
    const { inner, css } = await renderDocxHtml(req);
    // copies: repeat the whole docx flow, each copy starts on a new page
    const blocks: string[] = [];
    for (let c = 0; c < req.copies; c++) {
      blocks.push(
        `<div class="docx-copy" style="${c > 0 ? "break-before:page;page-break-before:always;" : ""}">${inner}</div>`,
      );
    }
    const cssCopy =
      css +
      "\n.docx-copy{page-break-after:auto}\n.docx-copy~.docx-copy .docx-wrapper{padding-top:0 !important}";
    const html = buildPrintHtml(req.paperWmm, req.paperHmm, blocks.join("\n"), cssCopy);
    await printIframe(html);
    return;
  }

  if (file.kind === "doc") {
    const flow = await renderFlowHtml(req);
    const html = buildPrintHtml(req.paperWmm, req.paperHmm, flow.inner, flow.css);
    await printIframe(html);
    return;
  }

  throw new Error("Format dokumen tidak didukung untuk dicetak.");
}
