// Shared domain types for the Epson Print Station workspace.

import type { PaperId } from "@/lib/paper";

export type Orientation = "portrait" | "landscape";
export type ScaleMode = "fit" | "original";
export type ColorMode = "color" | "grayscale";
export type PrintQuality = "draft" | "standard" | "high";
export type PrintMode = "browser" | "spooler";
export type FileKind = "pdf" | "image" | "docx" | "doc";
export type LoadStatus = "loading" | "ready" | "error";
export type ZoomMode = "fit" | "100";

export interface LoadedFile {
  id: string;
  name: string;
  ext: string;
  sizeBytes: number;
  kind: FileKind;
  mime: string;
  /** Original bytes (kept for pdf.js analysis + direct spooler upload). */
  bytes: Uint8Array | null;
  /** Object URL for image previews. */
  url: string | null;
  status: LoadStatus;
  error?: string;
  /** Page count; null until inspected. */
  pageCount: number | null;
  /** Continuous HTML flow (mammoth fallback) — pagination estimated on render. */
  continuous?: boolean;
  /** Document page size in mm (first page). */
  docWidthMm: number | null;
  docHeightMm: number | null;
  /** Human label of the source size: "Letter", "A4", "960 × 720 px", ... */
  docLabel: string | null;
}

export interface DocxRender {
  /** Outer HTML of every rendered page section. */
  sectionsHtml: string[];
  pageWpx: number;
  pageHpx: number;
  pageWmm: number;
  pageHmm: number;
  pageCount: number;
}

export interface PrintSettings {
  paperId: PaperId;
  orientation: Orientation;
  scaleMode: ScaleMode;
  colorMode: ColorMode;
  quality: PrintQuality;
  rangeMode: "all" | "custom";
  rangeText: string;
  copies: number;
  duplex: boolean;
  printMode: PrintMode;
}

export const DEFAULT_SETTINGS: PrintSettings = {
  paperId: "a4",
  orientation: "portrait",
  scaleMode: "fit",
  colorMode: "color",
  quality: "standard",
  rangeMode: "all",
  rangeText: "",
  copies: 1,
  duplex: false,
  printMode: "browser",
};

export const QUALITY_HINT: Record<PrintQuality, string> = {
  draft: "Ekonomi tinta • cepat",
  standard: "Normal • dokumen sehari-hari",
  high: "Presisi tinggi • foto & detail",
};

export interface SpoolerInfo {
  type: "ipp" | "lp";
  printer: string | null;
}

export interface SpoolerState {
  state: "checking" | "available" | "unavailable";
  info: SpoolerInfo | null;
}

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
