// Paper geometry & document size detection utilities.
// All linear values are millimeters unless stated otherwise.

export type PaperId = "a4" | "f4" | "letter" | "a5" | "4r";

export interface PaperSize {
  id: PaperId;
  /** Full label e.g. "A4 — 210 × 297 mm" */
  label: string;
  /** Compact label e.g. "A4" */
  shortLabel: string;
  /** Portrait width (mm) */
  widthMm: number;
  /** Portrait height (mm) */
  heightMm: number;
  /** IPP media keyword for the direct spooler path */
  ippMedia: string;
}

export const PT_TO_MM = 25.4 / 72;
export const PX96_TO_MM = 25.4 / 96;
export const MM_TO_PX96 = 96 / 25.4;

export const PAPERS: PaperSize[] = [
  {
    id: "a4",
    label: "A4 — 210 × 297 mm",
    shortLabel: "A4",
    widthMm: 210,
    heightMm: 297,
    ippMedia: "iso_a4_210x297mm",
  },
  {
    id: "f4",
    label: "F4/Folio — 215 × 330 mm",
    shortLabel: "F4",
    widthMm: 215,
    heightMm: 330,
    ippMedia: "custom_f4_215x330mm",
  },
  {
    id: "letter",
    label: "Letter — 216 × 279 mm",
    shortLabel: "Letter",
    widthMm: 215.9,
    heightMm: 279.4,
    ippMedia: "na_letter_8.5x11in",
  },
  {
    id: "a5",
    label: "A5 — 148 × 210 mm",
    shortLabel: "A5",
    widthMm: 148,
    heightMm: 210,
    ippMedia: "iso_a5_148x210mm",
  },
  {
    id: "4r",
    label: "4R — 102 × 152 mm",
    shortLabel: "4R",
    widthMm: 102,
    heightMm: 152,
    ippMedia: "na_4x6_4x6in",
  },
];

export const DEFAULT_PAPER: PaperId = "a4";

export function getPaper(id: PaperId): PaperSize {
  return PAPERS.find((p) => p.id === id) ?? PAPERS[0];
}

export function paperDims(
  id: PaperId,
  orientation: "portrait" | "landscape",
): { wMm: number; hMm: number } {
  const p = getPaper(id);
  return orientation === "portrait"
    ? { wMm: p.widthMm, hMm: p.heightMm }
    : { wMm: p.heightMm, hMm: p.widthMm };
}

/** Detect whether a document size corresponds to a known paper (either orientation). */
export function matchPaper(
  wMm: number,
  hMm: number,
  toleranceMm = 1.6,
): PaperId | null {
  for (const p of PAPERS) {
    const portrait =
      Math.abs(wMm - p.widthMm) <= toleranceMm &&
      Math.abs(hMm - p.heightMm) <= toleranceMm;
    const landscape =
      Math.abs(wMm - p.heightMm) <= toleranceMm &&
      Math.abs(hMm - p.widthMm) <= toleranceMm;
    if (portrait || landscape) return p.id;
  }
  return null;
}

/** "216 × 279 mm" — rounded, trimmed. */
export function sizeLabel(wMm: number, hMm: number): string {
  return `${Math.round(wMm)} × ${Math.round(hMm)} mm`;
}

export function formatMm(v: number): string {
  return String(Math.round(v * 100) / 100);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface PageRangeResult {
  pages: number[];
  valid: boolean;
}

/**
 * Parse custom page range syntax "1-3, 5" into a sorted, unique page list
 * bounded to 1..total. Returns valid=false when any token is malformed.
 */
export function parsePageRange(text: string, total: number): PageRangeResult {
  const trimmed = text.trim();
  if (!trimmed) return { pages: [], valid: false };
  const tokens = trimmed.split(",");
  const out = new Set<number>();
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
    if (!match) return { pages: [], valid: false };
    const a = Number(match[1]);
    const b = match[2] ? Number(match[2]) : a;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a || a > total) {
      return { pages: [], valid: false };
    }
    for (let i = a; i <= Math.min(b, total); i++) out.add(i);
  }
  const pages = Array.from(out).sort((x, y) => x - y);
  return { pages, valid: pages.length > 0 };
}
