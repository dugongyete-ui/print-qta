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
  PhotoAdjustments,
  PhotoPlacement,
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

// PHOTO SHEET ENGINE (Mode Foto) ------------------------------------------------

/**
 * CSS filter string for the sheet-wide photo adjustments. The preview <img>
 * uses the identical string, so screen and paper always agree.
 */
export function photoAdjustFilterCss(a?: PhotoAdjustments): string {
  if (!a) return "none";
  const parts: string[] = [];
  if (Math.abs(a.brightness - 1) > 0.002)
    parts.push(`brightness(${a.brightness.toFixed(3)})`);
  if (Math.abs(a.contrast - 1) > 0.002)
    parts.push(`contrast(${a.contrast.toFixed(3)})`);
  if (Math.abs(a.saturate - 1) > 0.002)
    parts.push(`saturate(${a.saturate.toFixed(3)})`);
  return parts.length > 0 ? parts.join(" ") : "none";
}

export interface PhotoSheetSpec {
  paperWmm: number;
  paperHmm: number;
  placements: PhotoPlacement[];
  /** itemId -> object URL of the source image (null when unavailable). */
  resolveImage: (itemId: string) => string | null;
  colorMode: ColorMode;
  cutLines: boolean;
  /** Sheet-wide brightness / contrast / saturation (CSS-filter identical). */
  adjust?: PhotoAdjustments;
}

const imgDecodeCache = new Map<string, Promise<HTMLImageElement>>();

function loadImageCached(url: string): Promise<HTMLImageElement> {
  const cached = imgDecodeCache.get(url);
  if (cached) return cached;
  const task = new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("decode"));
    el.src = url;
  });
  imgDecodeCache.set(url, task);
  return task;
}

/**
 * Rasterize the whole photo sheet (placements + cut lines) into one
 * paper-sized canvas at PRINT_DPI. Guarantees print output matches the
 * on-screen editor exactly, independent of driver CSS handling.
 */
export async function renderPhotoSheetCanvas(
  spec: PhotoSheetSpec,
): Promise<HTMLCanvasElement> {
  const { paperWmm, paperHmm, placements, resolveImage, colorMode, cutLines, adjust } = spec;
  const dpi = PRINT_DPI;
  const mmToPx = dpi / 25.4;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round((paperWmm / 25.4) * dpi));
  canvas.height = Math.max(1, Math.round((paperHmm / 25.4) * dpi));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D tidak tersedia.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";

  for (const p of placements) {
    const url = resolveImage(p.itemId);
    const drawW = p.wMm * mmToPx;
    const drawH = p.hMm * mmToPx;
    const cx = (p.xMm + p.wMm / 2) * mmToPx;
    const cy = (p.yMm + p.hMm / 2) * mmToPx;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((p.rotation * Math.PI) / 180);

    let img: HTMLImageElement | null = null;
    if (url) {
      try {
        img = await loadImageCached(url);
      } catch {
        img = null;
      }
    }
    if (img) {
      const iw = img.naturalWidth || 1;
      const ih = img.naturalHeight || 1;
      const scale =
        p.fit === "cover"
          ? Math.max(drawW / iw, drawH / ih)
          : Math.min(drawW / iw, drawH / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      // Crop shift mirrors CSS object-position: the point at frac% of the
      // oversized image aligns with frac% of the frame (0 = left/top,
      // 0.5 = centered, 1 = right/bottom).
      const fx = Math.min(Math.max((p.cropX ?? 0) / 100 + 0.5, 0), 1);
      const fy = Math.min(Math.max((p.cropY ?? 0) / 100 + 0.5, 0), 1);
      const offX = (drawW - dw) * fx;
      const offY = (drawH - dh) * fy;
      ctx.save();
      ctx.beginPath();
      ctx.rect(-drawW / 2, -drawH / 2, drawW, drawH);
      ctx.clip();
      const cssFilter = photoAdjustFilterCss(adjust);
      if (cssFilter !== "none") ctx.filter = cssFilter;
      ctx.drawImage(img, -dw / 2 + offX, -dh / 2 + offY, dw, dh);
      ctx.filter = "none";
      ctx.restore();
    } else {
      // Missing source: neutral placeholder so the sheet still prints.
      ctx.fillStyle = "#E5E7EB";
      ctx.fillRect(-drawW / 2, -drawH / 2, drawW, drawH);
    }

    if (cutLines) {
      // A placement whose rotated bbox covers the whole sheet is intentional
      // full-bleed ("Penuhi Lembar") — a dashed cut line at the paper edge
      // would print as dots along the border, so skip it there.
      const ca = Math.abs(Math.cos((p.rotation * Math.PI) / 180));
      const sa = Math.abs(Math.sin((p.rotation * Math.PI) / 180));
      const bbW = p.wMm * ca + p.hMm * sa;
      const bbH = p.wMm * sa + p.hMm * ca;
      const fullBleed = bbW >= paperWmm - 0.1 && bbH >= paperHmm - 0.1;
      if (!fullBleed) {
        ctx.strokeStyle = "#AEB4BC";
        ctx.lineWidth = Math.max(1, 0.15 * mmToPx);
        ctx.setLineDash([1.2 * mmToPx, 1.2 * mmToPx]);
        ctx.strokeRect(-drawW / 2, -drawH / 2, drawW, drawH);
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  if (colorMode === "grayscale") applyGrayscale(canvas);
  return canvas;
}

/** Browser print path for the photo sheet (iframe + exact @page). */
export async function printPhotoViaBrowser(
  spec: PhotoSheetSpec,
  copies: number,
): Promise<void> {
  const canvas = await renderPhotoSheetCanvas(spec);
  const sheet = `<div class="sheet"><img src="${canvas.toDataURL("image/png")}" style="width:${fmt(spec.paperWmm)}mm;height:${fmt(spec.paperHmm)}mm" alt=""/></div>`;
  const html = buildPrintHtml(spec.paperWmm, spec.paperHmm, scaleSheets([sheet], copies).join("\n"), "");
  await printIframe(html);
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
