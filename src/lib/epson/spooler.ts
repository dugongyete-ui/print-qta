// Local printer bridge — detection + direct spool dispatch.
//
// Two transports are supported, in priority order:
//   1. IPP   — EPSON_PRINTER_URL env var (e.g. http://192.168.1.42/ipp/print)
//              or EPSON_PRINTER_HOST (auto-built http://<host>/ipp/print)
//   2. lp    — CUPS command line (`lp`) present on the server machine
//
// DOCX/DOC documents are converted to PDF via LibreOffice headless when
// available; otherwise the caller receives a structured 422.

import { execFile } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import {
  buildPrintJobPacket,
  sendIppPrintJob,
} from "./ipp";
import { getPaperType, type PaperType, type SpoolerInfo } from "@/lib/print-station/types";

const execFileP = promisify(execFile);

async function which(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("which", [binary], { timeout: 4000 });
    const p = stdout.trim();
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

async function defaultLpPrinter(): Promise<string | null> {
  try {
    const { stdout } = await execFileP("lpstat", ["-d"], { timeout: 4000 });
    const m = /system default destination:\s*(\S+)/.exec(stdout);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function detectSpooler(): Promise<SpoolerInfo | null> {
  const ippUrl =
    process.env.EPSON_PRINTER_URL ??
    (process.env.EPSON_PRINTER_HOST
      ? `http://${process.env.EPSON_PRINTER_HOST}/ipp/print`
      : null);
  if (ippUrl) return { type: "ipp", printer: ippUrl };

  const lp = await which("lp");
  if (lp) {
    const printer = await defaultLpPrinter();
    return { type: "lp", printer };
  }
  return null;
}

export interface PrintJobPayload {
  fileName: string;
  mime: string;
  kind: "pdf" | "image" | "docx" | "doc";
  paperId: string;
  ippMedia: string;
  /** Epson media type loaded in the tray (omitted = plain stationery). */
  paperType?: PaperType;
  paperWmm: number;
  paperHmm: number;
  orientation: "portrait" | "landscape";
  colorMode: "color" | "grayscale";
  quality: "draft" | "standard" | "high";
  copies: number;
  duplex: boolean;
  scaleMode: "fit" | "original";
  pages: number[];
}

const QUALITY_ENUM = { draft: 3, standard: 4, high: 5 } as const;

async function convertToPdf(buffer: Buffer, ext: string): Promise<Buffer | null> {
  const soffice =
    (await which("soffice")) ?? (await which("libreoffice"));
  if (!soffice) return null;
  const tmp = await mkdtemp(path.join(os.tmpdir(), "epson-station-"));
  try {
    const src = path.join(tmp, `input.${ext}`);
    await writeFile(src, buffer);
    await execFileP(
      soffice,
      ["--headless", "--convert-to", "pdf", "--outdir", tmp, src],
      { timeout: 60000 },
    );
    return await readFile(path.join(tmp, "input.pdf"));
  } catch {
    return null;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function lpOptions(job: PrintJobPayload): string[] {
  const opts = [
    "-o",
    `media=${job.ippMedia}`,
    "-o",
    `print-color-mode=${job.colorMode === "grayscale" ? "monochrome" : "color"}`,
    "-o",
    `print-quality=${QUALITY_ENUM[job.quality]}`,
    "-o",
    `print-scaling=${job.scaleMode === "fit" ? "fit" : "none"}`,
    "-o",
    `orientation-requested=${job.orientation === "portrait" ? 3 : 4}`,
  ];
  // Media type hint for photo stock — drivers that don't know the option
  // simply ignore it, CUPS still spools the job.
  if (job.paperType && job.paperType !== "plain") {
    opts.push("-o", `media-type=${getPaperType(job.paperType).ippMediaType}`);
  }
  if (job.duplex) opts.push("-o", "sides=two-sided-long-edge");
  return opts;
}

export interface SpoolResult {
  jobId: string;
  transport: "ipp" | "lp";
}

export async function spoolPrint(
  job: PrintJobPayload,
  buffer: Buffer,
  spooler: SpoolerInfo,
): Promise<SpoolResult> {
  let document = buffer;
  let mime = job.mime;

  if (job.kind === "docx" || job.kind === "doc") {
    const pdf = await convertToPdf(buffer, job.kind);
    if (!pdf) {
      throw Object.assign(
        new Error(
          "Spooler langsung membutuhkan LibreOffice (soffice) untuk konversi DOCX/DOC ke PDF. Gunakan Mode Browser Print, atau unggah dokumen PDF.",
        ),
        { statusCode: 422, code: "CONVERSION_UNAVAILABLE" },
      );
    }
    document = pdf;
    mime = "application/pdf";
  }

  if (spooler.type === "ipp") {
    const packet = buildPrintJobPacket({
      printerUri: spooler.printer!,
      jobName: job.fileName,
      documentFormat: mime,
      copies: job.copies,
      colorMode: job.colorMode === "grayscale" ? "monochrome" : "color",
      quality: QUALITY_ENUM[job.quality],
      sides: job.duplex ? "two-sided-long-edge" : "one-sided",
      media: job.ippMedia,
      mediaType:
        job.paperType && job.paperType !== "plain"
          ? getPaperType(job.paperType).ippMediaType
          : undefined,
      orientation: job.orientation === "portrait" ? 3 : 4,
      pageRanges: job.pages.map((p) => [p, p]),
      fitToPage: job.scaleMode === "fit",
    });
    const result = await sendIppPrintJob(spooler.printer!, packet, new Uint8Array(document));
    return {
      jobId: result.jobId ?? `ipp-${Date.now()}`,
      transport: "ipp",
    };
  }

  // lp / CUPS transport
  const ext = mime === "application/pdf" ? "pdf" : mime.split("/")[1] ?? "bin";
  const tmp = await mkdtemp(path.join(os.tmpdir(), "epson-station-"));
  try {
    const file = path.join(tmp, `job.${ext}`);
    await writeFile(file, document);
    const args: string[] = [];
    if (spooler.printer) args.push("-d", spooler.printer);
    args.push("-n", String(Math.min(Math.max(job.copies, 1), 99)), "-t", job.fileName.slice(0, 90));
    args.push(...lpOptions(job));
    if (job.pages.length > 0 && job.pages.length < 999) {
      args.push("-o", `page-ranges=${simplifyRanges(job.pages)}`);
    }
    args.push(file);
    const { stdout } = await execFileP("lp", args, { timeout: 30000 });
    const m = /(?:id|Id)\s*[:=]?\s*([\w-]+)/.exec(stdout);
    return { jobId: m ? m[1] : `lp-${Date.now()}`, transport: "lp" };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function simplifyRanges(pages: number[]): string {
  const merged: Array<[number, number]> = [];
  const sorted = Array.from(new Set(pages)).sort((a, b) => a - b);
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) prev = sorted[i];
    else {
      merged.push([start, prev]);
      start = sorted[i];
      prev = sorted[i];
    }
  }
  merged.push([start, prev]);
  return merged.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(",");
}
