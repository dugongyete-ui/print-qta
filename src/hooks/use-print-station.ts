"use client";

// Central workspace state: file intake + inspection, print settings,
// auto-fit-to-tray logic, and the dual-mode print execution paths.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { toast } from "sonner";
import {
  PT_TO_MM,
  PX96_TO_MM,
  getPaper,
  matchPaper,
  paperDims,
  parsePageRange,
  sizeLabel,
  type PaperId,
} from "@/lib/paper";
import {
  DEFAULT_PHOTO_SETTINGS,
  DEFAULT_SETTINGS,
  EMPTY_PREFLIGHT,
  MAX_FILE_BYTES,
  MAX_PLACEMENTS,
  MIN_PHOTO_MM,
  getPaperType,
  type DocxRender,
  type GridAlignH,
  type GridAlignV,
  type LoadedFile,
  type PhotoPlacement,
  type PhotoSettings,
  type PreflightIssue,
  type PreflightReport,
  type PrintSettings,
  type SpoolerState,
} from "@/lib/print-station/types";
import {
  printPhotoViaBrowser,
  printViaBrowser,
  renderPhotoSheetCanvas,
  type PhotoSheetSpec,
} from "@/lib/print-station/engine";
import { getPhotoPreset } from "@/lib/print-station/photo-sizes";
import type { JobPresetId } from "@/lib/print-station/job-presets";

// ---------------------------------------------------------------------------
// Module-level document caches (survive component re-renders)
// ---------------------------------------------------------------------------
const pdfTaskCache = new Map<string, Promise<PDFDocumentLoadingTask>>();
const docxRenderCache = new Map<string, Promise<DocxRender>>();
const docHtmlCache = new Map<string, Promise<string>>();

// ---------------------------------------------------------------------------
// Session auto-save (photo mode) — an accidental refresh no longer destroys a
// tuned sheet: layout, settings and small image bytes live in localStorage
// until restored via toast, or expire after 48 hours.
// ---------------------------------------------------------------------------

const SESSION_KEY = "epson-print-station/session-v1";
const UI_LEVEL_KEY = "epson-print-station/ui-level";
const SESSION_MAX_FILE_BYTES = 1_200_000;
const SESSION_MAX_TOTAL_BYTES = 3_500_000;
const SESSION_MAX_AGE_H = 48;

interface SavedSessionFile {
  id: string;
  name: string;
  ext: string;
  mime: string;
  bytesB64: string;
}

interface SavedSession {
  v: 1;
  savedAt: number;
  settings: PrintSettings;
  photoSettings: PhotoSettings;
  placements: PhotoPlacement[];
  files: SavedSessionFile[];
}

/** Base64 cache — file bytes are immutable after intake, so encode once. */
const sessionB64Cache = new Map<string, string>();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Max copies of a w×h photo that fit one sheet (best of portrait/landscape,
 * clamped by the engine placement cap) — shared by optimize / wizard / presets
 * so every auto path reports the same numbers the arrangement produces.
 */
function gridCapacityFor(
  wMm: number,
  hMm: number,
  marginMm: number,
  gapMm: number,
  paperWmm: number,
  paperHmm: number,
): number {
  const printW = paperWmm - 2 * marginMm;
  const printH = paperHmm - 2 * marginMm;
  const capFor = (w: number, h: number) => {
    if (w > printW + PHOTO_TOL || h > printH + PHOTO_TOL) return 0;
    return (
      Math.max(1, Math.floor((printW + gapMm) / (w + gapMm))) *
      Math.max(1, Math.floor((printH + gapMm) / (h + gapMm)))
    );
  };
  return Math.min(Math.max(capFor(wMm, hMm), capFor(hMm, wMm)), MAX_PLACEMENTS);
}

const ACCEPTED_EXT: Record<string, { kind: LoadedFile["kind"]; mime: string }> = {
  pdf: { kind: "pdf", mime: "application/pdf" },
  doc: { kind: "doc", mime: "application/msword" },
  docx: {
    kind: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
};

function newId(): string {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function newPhotoId(): string {
  return `ph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Photo placement geometry helpers (mm, center-based rotation)
// ---------------------------------------------------------------------------

const PHOTO_TOL = 0.5;

export type PhotoAlign =
  | "left"
  | "centerX"
  | "right"
  | "top"
  | "centerY"
  | "bottom";

function normRotation(rot: number): number {
  const r = Math.round(rot / 90) * 90;
  return ((r % 360) + 360) % 360;
}

function swappedBBox(rotation: number): boolean {
  const r = normRotation(rotation);
  return r === 90 || r === 270;
}

/** Visual bounding box (mm) of a placement, accounting for rotation. */
function placementBBox(p: {
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
  rotation: number;
}): { x: number; y: number; w: number; h: number } {
  const swapped = swappedBBox(p.rotation);
  const w = swapped ? p.hMm : p.wMm;
  const h = swapped ? p.wMm : p.hMm;
  const cx = p.xMm + p.wMm / 2;
  const cy = p.yMm + p.hMm / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * Manual-edit clamp: allow the photo to extend beyond the paper edges
 * ("full-bleed" — the preview stage and the print rasterizer both crop at
 * the sheet boundary, so what the user sees is exactly what prints). Only
 * the photo's center is kept on the paper so an oversized photo can never
 * be dragged completely off the sheet and lost.
 */
function clampPlacementBleed(
  p: PhotoPlacement,
  paperWmm: number,
  paperHmm: number,
): PhotoPlacement {
  const cx = Math.min(Math.max(p.xMm + p.wMm / 2, 0), paperWmm);
  const cy = Math.min(Math.max(p.yMm + p.hMm / 2, 0), paperHmm);
  return { ...p, xMm: cx - p.wMm / 2, yMm: cy - p.hMm / 2 };
}

/** Keep the visual bbox fully on the paper by clamping the rotation center. */
function clampPlacement(
  p: PhotoPlacement,
  paperWmm: number,
  paperHmm: number,
): PhotoPlacement {
  const bb = placementBBox(p);
  const cx = p.xMm + p.wMm / 2;
  const cy = p.yMm + p.hMm / 2;
  const ncx = Math.min(
    Math.max(cx, bb.w / 2),
    Math.max(bb.w / 2, paperWmm - bb.w / 2),
  );
  const ncy = Math.min(
    Math.max(cy, bb.h / 2),
    Math.max(bb.h / 2, paperHmm - bb.h / 2),
  );
  return { ...p, xMm: ncx - p.wMm / 2, yMm: ncy - p.hMm / 2 };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...Array.from(bytes.subarray(i, i + chunk)),
    );
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Document inspection pipelines
// ---------------------------------------------------------------------------

function loadPdfTask(file: LoadedFile): Promise<PDFDocumentLoadingTask> {
  const cached = pdfTaskCache.get(file.id);
  if (cached) return cached;
  const task = (async () => {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    // pdf.js may transfer the buffer to the worker — always hand it a copy.
    const data = file.bytes!.slice();
    return pdfjs.getDocument({ data });
  })();
  pdfTaskCache.set(file.id, task);
  return task;
}

async function loadPdfDoc(file: LoadedFile): Promise<PDFDocumentProxy> {
  const task = await loadPdfTask(file);
  return task.promise;
}

async function inspectPdf(file: LoadedFile): Promise<Partial<LoadedFile>> {
  try {
    const doc = await loadPdfDoc(file);
    const page1 = await doc.getPage(1);
    const vp = page1.getViewport({ scale: 1 });
    const wMm = vp.width * PT_TO_MM;
    const hMm = vp.height * PT_TO_MM;
    const matched = matchPaper(wMm, hMm);
    return {
      status: "ready",
      pageCount: doc.numPages,
      docWidthMm: wMm,
      docHeightMm: hMm,
      docLabel: matched ? getPaper(matched).shortLabel : sizeLabel(wMm, hMm),
    };
  } catch {
    pdfTaskCache.delete(file.id);
    return {
      status: "error",
      error: "Dokumen PDF rusak, terproteksi, atau tidak dapat dibaca.",
    };
  }
}

async function inspectImage(file: LoadedFile): Promise<Partial<LoadedFile>> {
  if (!file.bytes) {
    return { status: "error", error: "Data gambar kosong." };
  }
  const url = URL.createObjectURL(
    new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: file.mime }),
  );
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode"));
      el.src = url;
    });
    return {
      status: "ready",
      url,
      pageCount: 1,
      docWidthMm: img.naturalWidth * PX96_TO_MM,
      docHeightMm: img.naturalHeight * PX96_TO_MM,
      docLabel: `${img.naturalWidth} × ${img.naturalHeight} px`,
    };
  } catch {
    URL.revokeObjectURL(url);
    return { status: "error", error: "Gambar tidak dapat dibaca atau rusak." };
  }
}

async function renderDocx(file: LoadedFile): Promise<DocxRender> {
  const cached = docxRenderCache.get(file.id);
  if (cached) return cached;
  const task = (async () => {
    const docxPreview = await import("docx-preview");
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;left:-100000px;top:0;width:1200px;visibility:hidden;";
    document.body.appendChild(host);
    try {
      await docxPreview.renderAsync(
        new Blob([file.bytes!.slice().buffer as ArrayBuffer], { type: file.mime }),
        host,
        host,
        {
          inWrapper: true,
          breakPages: true,
          experimental: true,
          renderHeaders: true,
          renderFooters: true,
          useBase64URL: true,
          ignoreWidth: false,
          ignoreHeight: false,
        },
      );
      const wrapper = host.querySelector(".docx-wrapper");
      const sections = wrapper
        ? Array.from(wrapper.querySelectorAll("section.docx"))
        : Array.from(host.querySelectorAll("section.docx"));
      if (sections.length === 0) throw new Error("no-sections");
      const first = sections[0] as HTMLElement;
      const wpx = first.offsetWidth || Math.round(210 * (96 / 25.4));
      const hpx = first.offsetHeight || Math.round(297 * (96 / 25.4));
      return {
        sectionsHtml: sections.map((s) => (s as HTMLElement).outerHTML),
        pageWpx: wpx,
        pageHpx: hpx,
        pageWmm: wpx * PX96_TO_MM,
        pageHmm: hpx * PX96_TO_MM,
        pageCount: sections.length,
      } satisfies DocxRender;
    } finally {
      host.remove();
    }
  })();
  docxRenderCache.set(file.id, task);
  return task;
}

async function convertViaServer(file: LoadedFile): Promise<string> {
  const cached = docHtmlCache.get(file.id);
  if (cached) return cached;
  const task = (async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([file.bytes!.slice().buffer as ArrayBuffer], { type: file.mime }),
      file.name,
    );
    const res = await fetch("/api/convert-docx", { method: "POST", body: form });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new Error(body?.message ?? "Konversi dokumen gagal di server.");
    }
    const body = (await res.json()) as { html: string };
    return body.html;
  })();
  docHtmlCache.set(file.id, task);
  return task;
}

async function inspectWord(file: LoadedFile): Promise<Partial<LoadedFile>> {
  // 1st choice: client-side docx-preview (true pagination + layout)
  if (file.kind === "docx") {
    try {
      const render = await renderDocx(file);
      const matched = matchPaper(render.pageWmm, render.pageHmm);
      return {
        status: "ready",
        pageCount: render.pageCount,
        docWidthMm: render.pageWmm,
        docHeightMm: render.pageHmm,
        docLabel: matched ? getPaper(matched).shortLabel : sizeLabel(render.pageWmm, render.pageHmm),
      };
    } catch {
      docxRenderCache.delete(file.id);
      // fall through to server-side mammoth
    }
  }
  // 2nd choice: server conversion (mammoth / LibreOffice headless)
  try {
    await convertViaServer(file);
    return {
      status: "ready",
      continuous: true,
      pageCount: 1,
      docWidthMm: 210,
      docHeightMm: 297,
      docLabel: "Halaman Mengalir",
    };
  } catch (err) {
    return {
      status: "error",
      error:
        err instanceof Error
          ? err.message
          : "Konversi dokumen gagal. Simpan ulang sebagai .docx atau PDF.",
    };
  }
}

// ---------------------------------------------------------------------------

export interface DuplexAssist {
  evenPages: number[];
}

export type GuidedGoal = "doc" | "pas-foto" | "banyak-foto" | "lembar-penuh";
export type GuidedPaper = "a4" | "f4" | "4r" | "custom";
export type GuidedOutcome = "hemat" | "asli" | "kualitas" | "semua";

export type UiLevel = "beginner" | "advanced";

export function usePrintStation() {
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [settings, setSettings] = useState<PrintSettings>(DEFAULT_SETTINGS);
  const [photoMode, setPhotoModeState] = useState(false);
  const [photoPlacements, setPhotoPlacements] = useState<PhotoPlacement[]>([]);
  /** Word-like multi-selection — order matters: last id is the primary. */
  const [photoSelectedIds, setPhotoSelectedIds] = useState<string[]>([]);
  const [photoSettings, setPhotoSettings] = useState<PhotoSettings>(DEFAULT_PHOTO_SETTINGS);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<"fit" | "100">("fit");
  const [showMargins, setShowMargins] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [duplexAssist, setDuplexAssist] = useState<DuplexAssist | null>(null);
  const [spooler, setSpooler] = useState<SpoolerState>({
    state: "checking",
    info: null,
  });
  /** "Mode Pemula" hides advanced controls; "Mode Lanjutan" shows everything. */
  const [uiLevel, setUiLevelState] = useState<UiLevel>(() => {
    if (typeof window === "undefined") return "advanced";
    try {
      return window.localStorage.getItem(UI_LEVEL_KEY) === "beginner"
        ? "beginner"
        : "advanced";
    } catch {
      return "advanced";
    }
  });

  // -- photo layout history (undo / redo) -------------------------------------
  const photoHistoryPastRef = useRef<PhotoPlacement[][]>([]);
  const photoHistoryFutureRef = useRef<PhotoPlacement[][]>([]);
  /** True while a drag/resize gesture is open — its updates form ONE step. */
  const photoHistoryOpenRef = useRef(false);
  const lastPhotoHistoryPushRef = useRef(0);
  const [, setPhotoHistoryTick] = useState(0);

  const activeFile = useMemo(
    () => files.find((f) => f.id === activeId) ?? null,
    [files, activeId],
  );
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const filesRef = useRef(files);
  filesRef.current = files;
  const photoModeRef = useRef(photoMode);
  photoModeRef.current = photoMode;
  const photoPlacementsRef = useRef(photoPlacements);
  photoPlacementsRef.current = photoPlacements;
  const photoSelectedId = photoSelectedIds[photoSelectedIds.length - 1] ?? null;
  const photoSelectedIdsRef = useRef(photoSelectedIds);
  photoSelectedIdsRef.current = photoSelectedIds;
  const photoSelectedIdRef = useRef<string | null>(photoSelectedId);
  photoSelectedIdRef.current = photoSelectedId;
  const photoSettingsRef = useRef(photoSettings);
  photoSettingsRef.current = photoSettings;

  // -- derived paper geometry -----------------------------------------------
  const paper = getPaper(settings.paperId);
  const { wMm: paperWmm, hMm: paperHmm } = paperDims(
    settings.paperId,
    settings.orientation,
  );
  const paperDimsRef = useRef({ wMm: paperWmm, hMm: paperHmm });
  paperDimsRef.current = { wMm: paperWmm, hMm: paperHmm };
  // Assigned after the photo actions below — used by addFiles to auto-place images.
  const intakeImageRef = useRef<(itemId: string) => void>(() => {});
  // True when the user hand-edited the sheet since the last auto-grid arrange;
  // intake auto-arrange never reshuffles a hand-tuned layout.
  const layoutTouchedRef = useRef(false);
  const intakeTimerRef = useRef<number | null>(null);

  const contentScale = useMemo(() => {
    const f = activeFile;
    if (!f || f.docWidthMm == null || f.docWidthMm <= 0) return 1;
    if (settings.scaleMode !== "fit" || f.continuous) return 1;
    const paperW = paperWmm;
    const paperH = paperHmm;
    return Math.min(paperW / f.docWidthMm, paperH / (f.docHeightMm || 1));
  }, [activeFile, settings.scaleMode, paperWmm, paperHmm]);

  const paperMismatch = useMemo(() => {
    const f = activeFile;
    if (!f || f.docWidthMm == null || f.continuous) return false;
    return matchPaper(f.docWidthMm, f.docHeightMm ?? 0) !== settings.paperId;
  }, [activeFile, settings.paperId]);

  const contentOverflows = useMemo(() => {
    const f = activeFile;
    if (!f || f.docWidthMm == null || f.continuous) return false;
    const s = settings.scaleMode === "fit" ? contentScale : 1;
    return (
      f.docWidthMm * s > paperWmm + 0.5 || (f.docHeightMm ?? 0) * s > paperHmm + 0.5
    );
  }, [activeFile, contentScale, settings.scaleMode, paperWmm, paperHmm]);

  // -- page range -------------------------------------------------------------
  const selectedPages = useMemo(() => {
    const f = activeFile;
    if (!f || f.status !== "ready" || !f.pageCount) return [];
    if (settings.rangeMode === "all") {
      return Array.from({ length: f.pageCount }, (_, i) => i + 1);
    }
    const parsed = parsePageRange(settings.rangeText, f.pageCount);
    return parsed.valid ? parsed.pages : [];
  }, [activeFile, settings.rangeMode, settings.rangeText]);

  const rangeInvalid =
    settings.rangeMode === "custom" &&
    !parsePageRange(settings.rangeText, activeFile?.pageCount ?? 1).valid;

  const selectedPagesRef = useRef<number[]>([]);
  selectedPagesRef.current = selectedPages;

  const photoReady =
    photoPlacements.length > 0 &&
    photoPlacements.every((p) => {
      const it = files.find((f) => f.id === p.itemId);
      return !!it && it.kind === "image" && it.status === "ready" && !!it.url;
    });
  const photoPreset = getPhotoPreset(photoSettings.presetId);
  const photoSelected =
    photoPlacements.find((p) => p.id === photoSelectedId) ?? null;

  /**
   * Max copies of the current preset that fit on one sheet (best of portrait
   * / landscape orientation), clamped by the engine's placement cap.
   */
  const photoCapacity = useMemo(() => {
    const w = photoPreset.group === "custom" ? photoSettings.customWMm : photoPreset.wMm;
    const h = photoPreset.group === "custom" ? photoSettings.customHMm : photoPreset.hMm;
    const margin = photoSettings.marginMm;
    const gap = photoSettings.gapMm;
    const printW = paperWmm - 2 * margin;
    const printH = paperHmm - 2 * margin;
    const capFor = (pw: number, ph: number) => {
      if (pw > printW + PHOTO_TOL || ph > printH + PHOTO_TOL) return 0;
      return (
        Math.max(1, Math.floor((printW + gap) / (pw + gap))) *
        Math.max(1, Math.floor((printH + gap) / (ph + gap)))
      );
    };
    return Math.min(Math.max(capFor(w, h), capFor(h, w)), MAX_PLACEMENTS);
  }, [photoPreset, photoSettings, paperWmm, paperHmm]);

  const photoBeyondMargin = photoPlacements.some((p) => {
    const bb = placementBBox(p);
    return (
      bb.x < photoSettings.marginMm - PHOTO_TOL ||
      bb.y < photoSettings.marginMm - PHOTO_TOL ||
      bb.x + bb.w > paperWmm - photoSettings.marginMm + PHOTO_TOL ||
      bb.y + bb.h > paperHmm - photoSettings.marginMm + PHOTO_TOL
    );
  });

  const canPrint = photoMode
    ? photoReady && !printing
    : !!activeFile &&
      activeFile.status === "ready" &&
      selectedPages.length > 0 &&
      !printing;

  // -- spooler detection ------------------------------------------------------
  useEffect(() => {
    let alive = true;
    fetch("/api/print")
      .then((r) => r.json())
      .then((body: { spooler: { type: "ipp" | "lp"; printer: string | null } | null }) => {
        if (!alive) return;
        setSpooler(
          body.spooler
            ? { state: "available", info: body.spooler }
            : { state: "unavailable", info: null },
        );
      })
      .catch(() => alive && setSpooler({ state: "unavailable", info: null }));
    return () => {
      alive = false;
    };
  }, []);

  // -- auto-fit to loaded tray ------------------------------------------------
  const autoFitKey = useRef<string | null>(null);
  useEffect(() => {
    const f = activeFile;
    if (!f || f.status !== "ready" || f.docWidthMm == null || f.continuous) return;
    const key = `${f.id}:${settings.paperId}`;
    if (autoFitKey.current === key) return;
    const matched = matchPaper(f.docWidthMm, f.docHeightMm ?? 0);
    if (matched !== settings.paperId) {
      autoFitKey.current = key;
      setSettings((s) => (s.scaleMode === "fit" ? s : { ...s, scaleMode: "fit" }));
    }
  }, [activeFile, settings.paperId]);

  // -- file intake ------------------------------------------------------------
  const patchFile = useCallback((id: string, patch: Partial<LoadedFile>) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  const addFiles = useCallback(
    (incoming: File[]) => {
      for (const file of incoming) {
        const ext = (file.name.split(".").pop() ?? "").toLowerCase();
        const accepted = ACCEPTED_EXT[ext];
        if (!accepted) {
          toast.error(`Format .${ext || "?"} tidak didukung.`, {
            description: `${file.name} — gunakan PDF, DOC, DOCX, PNG, atau JPG.`,
          });
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          toast.error(`Ukuran file melebihi 50 MB.`, {
            description: file.name,
          });
          continue;
        }
        const id = newId();
        const loaded: LoadedFile = {
          id,
          name: file.name,
          ext,
          sizeBytes: file.size,
          kind: accepted.kind,
          mime: accepted.mime,
          bytes: null,
          url: null,
          status: "loading",
          pageCount: null,
          docWidthMm: null,
          docHeightMm: null,
          docLabel: null,
        };
        setFiles((prev) => [...prev, loaded]);
        setActiveId((cur) => cur ?? id);
        setPage(1);

        file
          .arrayBuffer()
          .then(async (buf) => {
            const bytes = new Uint8Array(buf);
            patchFile(id, { bytes });
            const probe: LoadedFile = { ...loaded, bytes };
            const patch =
              accepted.kind === "pdf"
                ? await inspectPdf(probe)
                : accepted.kind === "image"
                  ? await inspectImage(probe)
                  : await inspectWord(probe);
            patchFile(id, patch);
            if (patch.status === "ready" && accepted.kind === "image") {
              // Photo intake flow: uploading an image switches the workspace
              // into photo mode, drops it on the sheet and — once the upload
              // batch settles — re-tiles the auto grid to "Jumlah Foto".
              setPhotoModeState(true);
              intakeImageRef.current(id);
            }
            if (patch.status === "error" && patch.error) {
              toast.error("Dokumen tidak dapat dibuka", {
                description: `${file.name} — ${patch.error}`,
              });
            }
          })
          .catch(() => {
            patchFile(id, {
              status: "error",
              error: "Gagal membaca file dari disk.",
            });
          });
      }
    },
    [patchFile],
  );

  const removeFile = useCallback(
    (id: string) => {
      const task = pdfTaskCache.get(id);
      if (task) {
        task.then((t) => t.destroy()).catch(() => {});
        pdfTaskCache.delete(id);
      }
      docxRenderCache.delete(id);
      docHtmlCache.delete(id);
      sessionB64Cache.delete(id);
      const file = files.find((f) => f.id === id);
      if (file?.url) URL.revokeObjectURL(file.url);
      const next = files.filter((f) => f.id !== id);
      setFiles(next);
      // Purge photo placements referencing the removed file.
      const nextPlacements = photoPlacementsRef.current.filter(
        (p) => p.itemId !== id,
      );
      setPhotoPlacements(nextPlacements);
      setPhotoSelectedIds((cur) =>
        cur.filter((id) => nextPlacements.some((p) => p.id === id)),
      );
      if (id === activeId) {
        const fallback = next.find((f) => f.status === "ready") ?? next[0] ?? null;
        setActiveId(fallback ? fallback.id : null);
        setPage(1);
      }
    },
    [files, activeId],
  );

  const selectFile = useCallback((id: string) => {
    setActiveId(id);
    setPage(1);
  }, []);

  const setSetting = useCallback(
    <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) => {
      setSettings((s) => ({ ...s, [key]: value }));
    },
    [],
  );

  // --------------------------------------------------------------------------
  // Photo layout mode (Mode Foto — Word-like sheet editor)
  // --------------------------------------------------------------------------

  const setPhotoMode = useCallback((next: boolean) => {
    setPhotoModeState(next);
    if (next && photoPlacementsRef.current.length === 0) {
      const images = filesRef.current.filter(
        (f) => f.kind === "image" && f.status === "ready" && !!f.url,
      );
      for (const img of images) intakeImageRef.current(img.id);
    }
    if (!next) setPhotoSelectedIds([]);
  }, []);

  /** Select one photo. With `additive` (Ctrl/Shift/tap-mode) it toggles the
   * photo in/out of the multi-selection instead of replacing it. */
  const selectPhotoPlacement = useCallback(
    (id: string | null, additive?: boolean) => {
      setPhotoSelectedIds((cur) => {
        if (!id) return [];
        if (additive) {
          return cur.includes(id)
            ? cur.filter((x) => x !== id)
            : [...cur, id];
        }
        return cur.length === 1 && cur[0] === id ? cur : [id];
      });
    },
    [],
  );

  /** Replace the whole selection (marquee-lasso result). */
  const selectPhotoPlacements = useCallback((ids: string[]) => {
    setPhotoSelectedIds(ids);
  }, []);

  const selectAllPhotoPlacements = useCallback(() => {
    setPhotoSelectedIds(photoPlacementsRef.current.map((p) => p.id));
  }, []);

  const clearPhotoSelection = useCallback(() => {
    setPhotoSelectedIds([]);
  }, []);

  const setPhotoSetting = useCallback((patch: Partial<PhotoSettings>) => {
    setPhotoSettings((s) => ({
      ...s,
      ...patch,
      marginMm: patch.marginMm !== undefined
        ? Math.min(Math.max(patch.marginMm, 0), 30)
        : s.marginMm,
      gapMm: patch.gapMm !== undefined
        ? Math.min(Math.max(patch.gapMm, 0), 20)
        : s.gapMm,
      perSheet: patch.perSheet !== undefined
        ? Math.min(Math.max(Math.round(patch.perSheet), 1), 200)
        : s.perSheet,
      adjust: patch.adjust !== undefined
        ? {
            brightness: Math.min(Math.max(patch.adjust.brightness, 0.5), 1.6),
            contrast: Math.min(Math.max(patch.adjust.contrast, 0.5), 1.6),
            saturate: Math.min(Math.max(patch.adjust.saturate, 0), 2),
          }
        : s.adjust,
    }));
  }, []);

  const setUiLevel = useCallback((v: UiLevel) => {
    setUiLevelState(v);
    try {
      window.localStorage.setItem(UI_LEVEL_KEY, v);
    } catch {
      /* private mode — level stays for this session only */
    }
  }, []);

  // -- photo layout history -----------------------------------------------------

  /** Force one undo snapshot of the current layout (resets redo). */
  const snapshotPhotoHistory = useCallback(() => {
    photoHistoryPastRef.current.push(
      photoPlacementsRef.current.map((p) => ({ ...p })),
    );
    if (photoHistoryPastRef.current.length > 60) {
      photoHistoryPastRef.current.shift();
    }
    photoHistoryFutureRef.current = [];
    lastPhotoHistoryPushRef.current = Date.now();
    setPhotoHistoryTick((t) => t + 1);
  }, []);

  /** Coalesced snapshot for discrete edits (nudge, numeric inputs, rotate). */
  const pushPhotoHistory = useCallback(() => {
    if (photoHistoryOpenRef.current) return;
    if (Date.now() - lastPhotoHistoryPushRef.current < 500) return;
    snapshotPhotoHistory();
  }, [snapshotPhotoHistory]);

  /** Open a gesture (drag / resize) — all its updates become ONE undo step. */
  const beginPhotoHistory = useCallback(() => {
    if (photoHistoryOpenRef.current) return;
    photoHistoryOpenRef.current = true;
    snapshotPhotoHistory();
  }, [snapshotPhotoHistory]);

  const endPhotoHistory = useCallback(() => {
    photoHistoryOpenRef.current = false;
  }, []);

  const undoPhoto = useCallback(() => {
    const past = photoHistoryPastRef.current;
    if (past.length === 0) return;
    const prev = past.pop()!;
    photoHistoryFutureRef.current.push(
      photoPlacementsRef.current.map((p) => ({ ...p })),
    );
    lastPhotoHistoryPushRef.current = 0;
    setPhotoPlacements(prev);
    setPhotoSelectedIds([]);
    setPhotoHistoryTick((t) => t + 1);
  }, []);

  const redoPhoto = useCallback(() => {
    const future = photoHistoryFutureRef.current;
    if (future.length === 0) return;
    const next = future.pop()!;
    photoHistoryPastRef.current.push(
      photoPlacementsRef.current.map((p) => ({ ...p })),
    );
    lastPhotoHistoryPushRef.current = 0;
    setPhotoPlacements(next);
    setPhotoSelectedIds([]);
    setPhotoHistoryTick((t) => t + 1);
  }, []);

  /** Place an uploaded image on the sheet at its current preset size. */
  const placeImageOnSheet = useCallback((itemId: string) => {
    const ps = photoSettingsRef.current;
    const { wMm: paperW, hMm: paperH } = paperDimsRef.current;
    const preset = getPhotoPreset(ps.presetId);
    const w = Math.min(preset.group === "custom" ? ps.customWMm : preset.wMm, paperW);
    const h = Math.min(preset.group === "custom" ? ps.customHMm : preset.hMm, paperH);
    const id = newPhotoId();
    snapshotPhotoHistory();
    setPhotoPlacements((list) => {
      if (list.length >= MAX_PLACEMENTS) return list;
      const maxBottom = list.reduce((m, p) => Math.max(m, p.yMm + p.hMm), 0);
      let y = list.length === 0 ? ps.marginMm : maxBottom + ps.gapMm;
      if (y + h > paperH) y = ps.marginMm;
      const placement: PhotoPlacement = {
        id,
        itemId,
        xMm: (paperW - w) / 2,
        yMm: y,
        wMm: w,
        hMm: h,
        rotation: 0,
        fit: "cover",
        cropX: 0,
        cropY: 0,
      };
      return [...list, clampPlacement(placement, paperW, paperH)];
    });
    setPhotoSelectedIds([id]);
  }, []);

  /** Add every ready, not-yet-placed image to the sheet. */
  const addAllImagesToSheet = useCallback(() => {
    const placed = new Set(photoPlacementsRef.current.map((p) => p.itemId));
    const images = filesRef.current.filter(
      (f) => f.kind === "image" && f.status === "ready" && !!f.url && !placed.has(f.id),
    );
    if (images.length === 0) return;
    for (const img of images) intakeImageRef.current(img.id);
    toast.success(`${images.length} foto ditambahkan ke lembar.`, {
      description: "Foto otomatis dijajarkan sesuai jumlah foto.",
    });
  }, []);

  /**
   * "Tambah Foto" picker intake — several customers handing over face photos
   * at once. Only PNG/JPG images are accepted; anything else is skipped with
   * a hint so the operator understands why nothing appeared. Images flow
   * through the standard intake path and the grid re-tiles with every
   * distinct photo on it (coverAll).
   */
  const addPhotoFiles = useCallback(
    (incoming: File[]) => {
      const images = incoming.filter((f) => {
        const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
        return ACCEPTED_EXT[ext]?.kind === "image";
      });
      const skipped = incoming.length - images.length;
      if (skipped > 0) {
        toast.warning(`${skipped} file dilewati — bukan foto`, {
          description:
            "Tambah Foto hanya menerima PNG/JPG. Untuk PDF/DOC gunakan Unggah Dokumen.",
        });
      }
      if (images.length > 0) addFiles(images);
    },
    [addFiles],
  );

  /**
   * "Ubah Foto" — swap the source image of ONE placement in place. The slot,
   * size, rotation and the rest of the layout stay untouched; the replacement
   * file goes through the standard image inspection before the swap commits.
   * Queue focus and the auto-grid are deliberately left alone.
   */
  const replacePhotoItem = useCallback(
    (placementId: string, incoming: File) => {
      const ext = (incoming.name.split(".").pop() ?? "").toLowerCase();
      const accepted = ACCEPTED_EXT[ext];
      if (!accepted || accepted.kind !== "image") {
        toast.error(`${incoming.name} bukan foto.`, {
          description: "Ubah Foto hanya menerima PNG/JPG.",
        });
        return;
      }
      if (incoming.size > MAX_FILE_BYTES) {
        toast.error("Ukuran file melebihi 50 MB.", {
          description: incoming.name,
        });
        return;
      }
      if (
        !photoPlacementsRef.current.some((p) => p.id === placementId)
      ) {
        return;
      }
      const id = newId();
      const loaded: LoadedFile = {
        id,
        name: incoming.name,
        ext,
        sizeBytes: incoming.size,
        kind: "image",
        mime: accepted.mime,
        bytes: null,
        url: null,
        status: "loading",
        pageCount: null,
        docWidthMm: null,
        docHeightMm: null,
        docLabel: null,
      };
      setFiles((prev) => [...prev, loaded]);
      incoming
        .arrayBuffer()
        .then(async (buf) => {
          const bytes = new Uint8Array(buf);
          const probe: LoadedFile = { ...loaded, bytes };
          const patch = await inspectImage(probe);
          if (patch.status === "ready") {
            patchFile(id, { bytes, ...patch });
            setPhotoPlacements((list) =>
              list.map((p) =>
                p.id === placementId
                  ? { ...p, itemId: id, cropX: 0, cropY: 0 }
                  : p,
              ),
            );
            toast.success("Foto diganti.", {
              description: `${incoming.name} menggantikan foto pada slot ini — posisi & ukuran tetap.`,
            });
          } else {
            patchFile(id, { bytes, ...patch });
            toast.error("Foto pengganti tidak dapat dibuka.", {
              description: `${incoming.name} — ${patch.error ?? "format tidak didukung."}`,
            });
            setFiles((prev) => prev.filter((f) => f.id !== id));
          }
        })
        .catch(() => {
          toast.error("Gagal membaca file dari disk.", {
            description: incoming.name,
          });
          setFiles((prev) => prev.filter((f) => f.id !== id));
        });
    },
    [patchFile],
  );

  /**
   * "Potong Foto" — commit a cropped copy of a photo's source image and point
   * every placement that referenced the original at the cropped version, so
   * all copies on the sheet (pas-foto tiles) update in one gesture. The
   * untouched original stays in the queue for re-cropping. Goes through the
   * standard image inspection; no auto-grid / intake side effects.
   */
  const cropPhotoItem = useCallback(
    (itemId: string, incoming: File) => {
      const targets = photoPlacementsRef.current.filter(
        (p) => p.itemId === itemId,
      );
      if (targets.length === 0) return;
      const ext = (incoming.name.split(".").pop() ?? "").toLowerCase();
      const accepted = ACCEPTED_EXT[ext];
      if (!accepted || accepted.kind !== "image") {
        toast.error("Hasil potongan bukan gambar yang valid.");
        return;
      }
      const id = newId();
      const loaded: LoadedFile = {
        id,
        name: incoming.name,
        ext,
        sizeBytes: incoming.size,
        kind: "image",
        mime: accepted.mime,
        bytes: null,
        url: null,
        status: "loading",
        pageCount: null,
        docWidthMm: null,
        docHeightMm: null,
        docLabel: null,
      };
      setFiles((prev) => [...prev, loaded]);
      incoming
        .arrayBuffer()
        .then(async (buf) => {
          const bytes = new Uint8Array(buf);
          const probe: LoadedFile = { ...loaded, bytes };
          const patch = await inspectImage(probe);
          if (patch.status === "ready") {
            patchFile(id, { bytes, ...patch });
            setPhotoPlacements((list) =>
              list.map((p) =>
                p.itemId === itemId
                  ? { ...p, itemId: id, cropX: 0, cropY: 0 }
                  : p,
              ),
            );
            toast.success("Foto dipotong.", {
              description:
                targets.length > 1
                  ? `${targets.length} salinan foto di lembar ikut diperbarui.`
                  : `${incoming.name} menggantikan foto di slot ini.`,
            });
          } else {
            patchFile(id, { bytes, ...patch });
            toast.error("Hasil potongan tidak dapat diproses.", {
              description: patch.error ?? "Gambar tidak dapat dibaca.",
            });
            setFiles((prev) => prev.filter((f) => f.id !== id));
          }
        })
        .catch(() => {
          toast.error("Gagal memproses potongan foto.");
          setFiles((prev) => prev.filter((f) => f.id !== id));
        });
    },
    [patchFile],
  );

  /**
   * Batch geometry edit — group drag / group nudge / align / single resize.
   * Hand edit pauses auto re-tiling so a manual layout is never reshuffled by
   * the next upload. Sizes may exceed the paper (full-bleed enlargement —
   * "perbesar sampai kertas penuh"): the overflow is cropped at the sheet
   * boundary by the preview and the print rasterizer alike, so the editor
   * stays WYSIWYG while nothing blocks the photo from covering every mm of
   * the paper.
   */
  const updatePhotoPlacements = useCallback(
    (updates: Array<{ id: string; patch: Partial<PhotoPlacement> }>) => {
      if (updates.length === 0) return;
      pushPhotoHistory();
      layoutTouchedRef.current = true;
      const { wMm: paperW, hMm: paperH } = paperDimsRef.current;
      const patches = new Map(updates.map((u) => [u.id, u.patch]));
      setPhotoPlacements((list) =>
        list.map((p) => {
          const patch = patches.get(p.id);
          if (!patch) return p;
          const next = { ...p, ...patch };
          next.wMm = Math.max(next.wMm, MIN_PHOTO_MM);
          next.hMm = Math.max(next.hMm, MIN_PHOTO_MM);
          next.rotation = normRotation(next.rotation);
          return clampPlacementBleed(next, paperW, paperH);
        }),
      );
    },
    [pushPhotoHistory],
  );

  const updatePhotoPlacement = useCallback(
    (id: string, patch: Partial<PhotoPlacement>) => {
      updatePhotoPlacements([{ id, patch }]);
    },
    [updatePhotoPlacements],
  );

  const removePhotoPlacements = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const doomed = new Set(ids);
    const list = photoPlacementsRef.current;
    if (!list.some((p) => doomed.has(p.id))) return;
    snapshotPhotoHistory();
    layoutTouchedRef.current = true;
    setPhotoPlacements(list.filter((p) => !doomed.has(p.id)));
    setPhotoSelectedIds((cur) => cur.filter((id) => !doomed.has(id)));
  }, []);

  const removePhotoPlacement = useCallback(
    (id: string) => removePhotoPlacements([id]),
    [removePhotoPlacements],
  );

  /** Duplicate every selected photo (group offset 3 mm, Word-like). */
  const duplicatePhotoPlacements = useCallback((ids: string[]) => {
    const list = photoPlacementsRef.current;
    if (list.length === 0 || ids.length === 0) return;
    const wanted = new Set(ids);
    const src = list.filter((p) => wanted.has(p.id));
    if (src.length === 0) return;
    if (list.length + src.length > MAX_PLACEMENTS) {
      toast.error("Lembar penuh — tidak bisa menduplikasi lagi.", {
        description: `Maksimal ${MAX_PLACEMENTS} foto per lembar.`,
      });
      return;
    }
    layoutTouchedRef.current = true;
    const { wMm: paperW, hMm: paperH } = paperDimsRef.current;
    const copies = src.map((p) =>
      clampPlacement(
        { ...p, id: newPhotoId(), xMm: p.xMm + 3, yMm: p.yMm + 3 },
        paperW,
        paperH,
      ),
    );
    snapshotPhotoHistory();
    setPhotoPlacements((cur) => [...cur, ...copies]);
    setPhotoSelectedIds(copies.map((c) => c.id));
  }, [snapshotPhotoHistory]);

  const duplicatePhotoPlacement = useCallback(
    (id: string) => duplicatePhotoPlacements([id]),
    [duplicatePhotoPlacements],
  );

  const clearPhotoPlacements = useCallback(() => {
    if (photoPlacementsRef.current.length > 0) snapshotPhotoHistory();
    layoutTouchedRef.current = false;
    setPhotoPlacements([]);
    setPhotoSelectedIds([]);
  }, [snapshotPhotoHistory]);

  /**
   * Auto-grid arrange — the print-shop "ngejajar N foto" flow. Tiles N slots
   * sized to the current preset (or explicit dims) in a balanced grid
   * (6 → 3×2, 8 → 4×2, 9 → 3×3) aligned inside the printable area
   * (top / center / bottom × left / center / right); portrait / landscape is
   * picked by whichever capacity fits N. Slots are always filled round-robin
   * with every distinct ready photo on the sheet — changing the count never
   * collapses the sheet into copies of a hand-picked photo (use "Isi Penuh"
   * for that).
   */
  const arrangePhotoCopies = useCallback(
    (
      count: number,
      options?: {
        dims?: { wMm: number; hMm: number };
        auto?: boolean;
        /** Grow the slot count so every distinct uploaded photo keeps a slot
         * (several customers, one collective sheet). Intake-driven arranges
         * always set this so a newly added face photo is never dropped. */
        coverAll?: boolean;
        /** Explicit margin override — used when margin changes and re-tile
         * happens in the same tick (borderless toggle), where the settings
         * ref is still stale. */
        marginMm?: number;
        gapMm?: number;
        alignV?: GridAlignV;
        alignH?: GridAlignH;
        /** Explicit paper override — guided-mode applies a paper change and
         * re-tiles in the same tick, where paperDimsRef is still stale. */
        paperWmm?: number;
        paperHmm?: number;
      },
    ) => {
      const list = photoPlacementsRef.current;
      if (list.length === 0) return;
      const ps = photoSettingsRef.current;
      const paperW = options?.paperWmm ?? paperDimsRef.current.wMm;
      const paperH = options?.paperHmm ?? paperDimsRef.current.hMm;
      const preset = getPhotoPreset(ps.presetId);
      const presetW = preset.group === "custom" ? ps.customWMm : preset.wMm;
      const presetH = preset.group === "custom" ? ps.customHMm : preset.hMm;
      const pw = Math.min(options?.dims ? options.dims.wMm : presetW, paperW);
      const ph = Math.min(options?.dims ? options.dims.hMm : presetH, paperH);
      const margin = options?.marginMm ?? ps.marginMm;
      const gap = options?.gapMm ?? ps.gapMm;
      const alignV = options?.alignV ?? ps.alignV;
      const alignH = options?.alignH ?? ps.alignH;
      const printW = paperW - 2 * margin;
      const printH = paperH - 2 * margin;

      const fitFor = (w: number, h: number) => {
        if (w > printW + PHOTO_TOL || h > printH + PHOTO_TOL) return null;
        const cols = Math.max(1, Math.floor((printW + gap) / (w + gap)));
        const rows = Math.max(1, Math.floor((printH + gap) / (h + gap)));
        return { cols, rows, cap: cols * rows };
      };

      const portrait = fitFor(pw, ph);
      const landscape = fitFor(ph, pw);
      const n0 = Math.max(1, Math.round(count));
      // Keep the preset's own orientation whenever it can fit N copies —
      // rotating a pas-foto frame would crop faces. Only fall back to the
      // rotated fit when portrait cannot hold N (or doesn't fit at all).
      let useLandscape: boolean;
      if (portrait && landscape) {
        useLandscape =
          portrait.cap >= n0
            ? false
            : landscape.cap >= n0
              ? true
              : landscape.cap > portrait.cap;
      } else {
        useLandscape = !portrait && !!landscape;
      }
      const fit = useLandscape ? landscape : portrait;
      if (!fit) {
        if (!options?.auto) {
          toast.error("Foto melebihi area cetak lembar.", {
            description:
              "Kecilkan ukuran foto atau margin lembar, lalu susun ulang.",
          });
        }
        return;
      }
      // Slot sources: the distinct ready images already on the sheet fill
      // slots round-robin — every uploaded photo stays on the grid. Sources
      // resolve first so intake arranges can grow the slot count to cover
      // every distinct photo (several customers, one collective sheet).
      let sources: string[] = [];
      const seen = new Set<string>();
      for (const p of list) {
        if (seen.has(p.itemId)) continue;
        const it = filesRef.current.find(
          (f) =>
            f.id === p.itemId &&
            f.kind === "image" &&
            f.status === "ready" &&
            !!f.url,
        );
        if (it) {
          seen.add(p.itemId);
          sources.push(p.itemId);
        }
      }
      if (sources.length === 0) sources = [list[0].itemId];

      const baseTotal = Math.min(n0, fit.cap, MAX_PLACEMENTS);
      let total = baseTotal;
      // Intake-driven arrange ("coverAll"): never drop a customer's photo —
      // when more distinct photos are on the sheet than slots, the grid grows
      // to fit all of them (up to sheet capacity).
      let grown = false;
      if (options?.coverAll && sources.length > total) {
        total = Math.min(sources.length, fit.cap, MAX_PLACEMENTS);
        grown = total > baseTotal;
      }
      const overCap = Math.max(0, sources.length - total);

      // Balanced grid: fewest wasted slots first, then the most square block,
      // preferring the wider option on ties (6 → 3×2, 9 → 3×3, 8 → 4×2).
      let cols = fit.cols;
      let bestScore = Infinity;
      for (let c = 1; c <= fit.cols; c++) {
        const r = Math.ceil(total / c);
        if (r > fit.rows) continue;
        const score = (c * r - total) * 1000 + Math.abs(c - r);
        if (score < bestScore || (score === bestScore && c > cols)) {
          bestScore = score;
          cols = c;
        }
      }
      const w = useLandscape ? ph : pw;
      const h = useLandscape ? pw : ph;
      const rows = Math.ceil(total / cols);

      const gridH = rows * h + (rows - 1) * gap;
      const gy =
        alignV === "top"
          ? margin
          : alignV === "bottom"
            ? margin + printH - gridH
            : margin + (printH - gridH) / 2;
      const out: PhotoPlacement[] = [];
      for (let r = 0; r < rows; r++) {
        const inRow = Math.min(total - r * cols, cols);
        const rowW = inRow * w + (inRow - 1) * gap;
        const gx =
          alignH === "left"
            ? margin
            : alignH === "right"
              ? margin + printW - rowW
              : margin + (printW - rowW) / 2;
        for (let c = 0; c < inRow; c++) {
          const itemId = sources[(r * cols + c) % sources.length];
          const src = list.find((p) => p.itemId === itemId);
          out.push({
            id: newPhotoId(),
            itemId,
            xMm: gx + c * (w + gap),
            yMm: gy + r * (h + gap),
            wMm: w,
            hMm: h,
            rotation: 0,
            fit: src ? src.fit : "cover",
            cropX: src?.cropX ?? 0,
            cropY: src?.cropY ?? 0,
          });
        }
      }
      snapshotPhotoHistory();
      setPhotoPlacements(out);
      setPhotoSelectedIds([]);
      layoutTouchedRef.current = false;
      const gridDesc = `${useLandscape ? "Lanskap" : "Potret"} • ${cols} kolom × ${rows} baris • ${
        alignV === "top" ? "rata atas" : alignV === "bottom" ? "rata bawah" : "di tengah"
      } • jarak ${gap} mm`;
      if (overCap > 0) {
        if (options?.coverAll) {
          toast.warning(`Lembar penuh — ${overCap} foto tidak muat`, {
            description: `Hanya ${total} dari ${sources.length} foto bisa disusun ukuran preset ini. Pilih preset lebih kecil atau kertas lebih besar agar semua foto ikut.`,
          });
        } else {
          toast.info(
            `${total} foto tersusun dari ${sources.length} foto yang diunggah`,
            {
              description: `Naikkan jumlah foto ke ${sources.length} agar semua foto ikut tersusun.`,
            },
          );
        }
        return;
      }
      if (grown) {
        toast.success(`Semua ${sources.length} foto tersusun`, {
          description: `Jumlah foto dinaikkan otomatis ${n0} → ${total} agar setiap foto berbeda tetap ada. • ${gridDesc}`,
        });
        return;
      }
      if (n0 > fit.cap) {
        toast.info(`Lembar penuh — maksimal ${fit.cap} foto ukuran ini`, {
          description:
            "Kurangi jumlah foto, pilih preset lebih kecil, atau ganti kertas lebih besar.",
        });
        return;
      }
      if (!options?.auto || out.length > 1) {
        toast.success(`${out.length} foto tersusun otomatis`, {
          description: `${sources.length > 1 ? `${sources.length} foto berbeda • ` : ""}${gridDesc}`,
        });
      }
    },
    [snapshotPhotoHistory],
  );

  /**
   * Debounced intake arrange: uploads become ready one file at a time, so the
   * re-tile waits for a short quiet window before regenerating the grid with
   * every photo from the batch.
   */
  const scheduleIntakeArrange = useCallback(() => {
    if (intakeTimerRef.current !== null) {
      window.clearTimeout(intakeTimerRef.current);
    }
    intakeTimerRef.current = window.setTimeout(() => {
      intakeTimerRef.current = null;
      if (photoPlacementsRef.current.length === 0) return;
      // Every upload batch re-bundles the whole grid — "dibungkus": picking
      // the count is the only decision, tiling is always automatic. coverAll
      // keeps every distinct face photo on the collective sheet.
      arrangePhotoCopies(photoSettingsRef.current.perSheet, {
        auto: true,
        coverAll: true,
      });
    }, 350);
  }, [arrangePhotoCopies]);

  /**
   * Borderless toggle — zeroes / restores the sheet margin and re-tiles the
   * grid in the same tick with the explicit new margin (the settings ref is
   * still stale at this point, so it is passed explicitly).
   */
  const setPhotoBorderless = useCallback(
    (next: boolean) => {
      setPhotoSettings((s) => ({
        ...s,
        borderless: next,
        marginMm: next ? 0 : DEFAULT_PHOTO_SETTINGS.marginMm,
      }));
      const list = photoPlacementsRef.current;
      if (list.length === 0) return;
      arrangePhotoCopies(photoSettingsRef.current.perSheet, {
        auto: true,
        marginMm: next ? 0 : DEFAULT_PHOTO_SETTINGS.marginMm,
      });
    },
    [arrangePhotoCopies],
  );

  // Intake path used by addFiles / mode switch / "tambah foto": drop the
  // image on the sheet, then re-tile once the batch settles.
  intakeImageRef.current = (itemId: string) => {
    placeImageOnSheet(itemId);
    scheduleIntakeArrange();
  };

  /** Apply a photo size preset to the selected placement (or all when none). */
  const applyPhotoPreset = useCallback(
    (presetId: string, customDims?: { wMm: number; hMm: number }) => {
      const ps = photoSettingsRef.current;
      const { wMm: paperW, hMm: paperH } = paperDimsRef.current;
      setPhotoSettings((s) => ({
        ...s,
        presetId,
        ...(customDims
          ? { customWMm: customDims.wMm, customHMm: customDims.hMm }
          : {}),
      }));
      const preset = getPhotoPreset(presetId);
      const w = Math.min(
        customDims
          ? customDims.wMm
          : preset.group === "custom"
            ? ps.customWMm
            : preset.wMm,
        paperW,
      );
      const h = Math.min(
        customDims
          ? customDims.hMm
          : preset.group === "custom"
            ? ps.customHMm
            : preset.hMm,
        paperH,
      );
      // Untouched auto-grid sheet: the preset drives the whole layout —
      // re-tile every copy to the new size at once. A hand-tuned sheet keeps
      // its placement (sizes change in place) instead of reshuffling.
      if (!layoutTouchedRef.current && photoPlacementsRef.current.length > 0) {
        arrangePhotoCopies(ps.perSheet, {
          dims: { wMm: w, hMm: h },
        });
        return;
      }
      const selId = photoSelectedIdRef.current;
      snapshotPhotoHistory();
      setPhotoPlacements((list) =>
        list.map((p) => {
          if (selId && p.id !== selId) return p;
          const cx = p.xMm + p.wMm / 2;
          const cy = p.yMm + p.hMm / 2;
          return clampPlacement(
            { ...p, wMm: w, hMm: h, xMm: cx - w / 2, yMm: cy - h / 2 },
            paperW,
            paperH,
          );
        }),
      );
    },
    [arrangePhotoCopies, snapshotPhotoHistory],
  );

  /** Fill the whole sheet with copies of the selected photo (pas-foto sheets). */
  const fillPhotoSheet = useCallback(() => {
    const list = photoPlacementsRef.current;
    if (list.length === 0) return;
    layoutTouchedRef.current = true;
    const selId = photoSelectedIdRef.current;
    const p = list.find((x) => x.id === selId) ?? list[0];
    const ps = photoSettingsRef.current;
    const { wMm: paperW, hMm: paperH } = paperDimsRef.current;
    const margin = ps.marginMm;
    const gap = ps.gapMm;
    const printW = paperW - 2 * margin;
    const printH = paperH - 2 * margin;
    const bb = placementBBox(p);
    if (bb.w > printW + PHOTO_TOL || bb.h > printH + PHOTO_TOL) {
      toast.error("Foto lebih besar dari area cetak.", {
        description: "Perkecil ukuran foto atau margin lembar terlebih dahulu.",
      });
      return;
    }
    const cols = Math.max(1, Math.floor((printW + gap) / (bb.w + gap)));
    const rowsBase = Math.max(1, Math.floor((printH + gap) / (bb.h + gap)));
    const rows =
      cols * rowsBase > MAX_PLACEMENTS
        ? Math.max(1, Math.floor(MAX_PLACEMENTS / cols))
        : rowsBase;
    const gx = (printW - (cols * bb.w + (cols - 1) * gap)) / 2;
    const gy = (printH - (rows * bb.h + (rows - 1) * gap)) / 2;
    const out: PhotoPlacement[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const vx = margin + gx + c * (bb.w + gap);
        const vy = margin + gy + r * (bb.h + gap);
        out.push({
          id: newPhotoId(),
          itemId: p.itemId,
          xMm: vx + bb.w / 2 - p.wMm / 2,
          yMm: vy + bb.h / 2 - p.hMm / 2,
          wMm: p.wMm,
          hMm: p.hMm,
          rotation: p.rotation,
          fit: p.fit,
          cropX: p.cropX ?? 0,
          cropY: p.cropY ?? 0,
        });
      }
    }
    setPhotoPlacements(out.map((pl) => clampPlacement(pl, paperW, paperH)));
    setPhotoSelectedIds([]);
    toast.success(`Lembar terisi — ${cols} × ${rows} foto (${out.length} salinan).`);
  }, [snapshotPhotoHistory]);

  /**
   * "Penuhi Lembar" — enlarge until the paper shows no empty area at all.
   * One photo: the frame grows to the full sheet (full-bleed, fit=cover) so
   * every mm of paper is covered; the excess image is cropped exactly at the
   * paper edge by the preview and the print rasterizer. Several photos: the
   * whole group is scaled up uniformly around its center until it covers the
   * sheet, keeping relative positions (Word-like "fit group to page").
   */
  const coverPhotoSheet = useCallback(
    (ids?: string[], opts?: { paperWmm?: number; paperHmm?: number }) => {
      const list = photoPlacementsRef.current;
      if (list.length === 0) return;
      const wanted = ids && ids.length > 0 ? ids : photoSelectedIdsRef.current;
      const targets = wanted.length > 0
        ? list.filter((p) => wanted.includes(p.id))
        : list;
      if (targets.length === 0) return;
      snapshotPhotoHistory();
      layoutTouchedRef.current = true;
      const paperW = opts?.paperWmm ?? paperDimsRef.current.wMm;
      const paperH = opts?.paperHmm ?? paperDimsRef.current.hMm;

    if (targets.length === 1) {
      const t = targets[0];
      setPhotoPlacements((cur) =>
        cur.map((p) =>
          p.id === t.id
            ? { ...p, xMm: 0, yMm: 0, wMm: paperW, hMm: paperH, fit: "cover" }
            : p,
        ),
      );
      setPhotoSelectedIds([t.id]);
      toast.success("Foto mengisi lembar penuh — tidak ada kertas kosong.", {
        description:
          "Bagian foto yang melebihi kertas terpotong rapi di tepi (full bleed). Gunakan slider Geser Potongan di panel kanan untuk memilih bagian yang tercetak.",
      });
      return;
    }

    // Group: uniform scale until the group bbox covers the sheet (cover
    // factor — no empty paper left in any direction), re-centered on the
    // PAPER center so the covered area is symmetric (a top-aligned grid
    // would otherwise leave the far edge empty after scaling).
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of targets) {
      const bb = placementBBox(p);
      minX = Math.min(minX, bb.x);
      minY = Math.min(minY, bb.y);
      maxX = Math.max(maxX, bb.x + bb.w);
      maxY = Math.max(maxY, bb.y + bb.h);
    }
    const gw = Math.max(1e-6, maxX - minX);
    const gh = Math.max(1e-6, maxY - minY);
    const factor = Math.max(paperW / gw, paperH / gh);
    const gcx = (minX + maxX) / 2;
    const gcy = (minY + maxY) / 2;
    const pcx = paperW / 2;
    const pcy = paperH / 2;
    const patches = new Map(
      targets.map((p) => {
        const cx = p.xMm + p.wMm / 2;
        const cy = p.yMm + p.hMm / 2;
        const ncx = pcx + (cx - gcx) * factor;
        const ncy = pcy + (cy - gcy) * factor;
        return [
          p.id,
          {
            wMm: p.wMm * factor,
            hMm: p.hMm * factor,
            xMm: ncx - (p.wMm * factor) / 2,
            yMm: ncy - (p.hMm * factor) / 2,
          },
        ] as const;
      }),
    );
    setPhotoPlacements((cur) =>
      cur.map((p) => (patches.has(p.id) ? { ...p, ...patches.get(p.id)! } : p)),
    );
    toast.success(
      `${targets.length} foto diperbesar bersama sampai lembar penuh.`,
      {
        description:
          "Posisi antar foto tetap — bagian yang melebihi kertas terpotong rapi.",
      },
    );
  }, [snapshotPhotoHistory]);

  /** Tidy the sheet: pack every placement into rows within the printable area. */
  const autoArrangePhotos = useCallback(() => {
    const list = photoPlacementsRef.current;
    if (list.length === 0) return;
    layoutTouchedRef.current = true;
    const ps = photoSettingsRef.current;
    const { wMm: paperW, hMm: paperH } = paperDimsRef.current;
    const margin = ps.marginMm;
    const gap = ps.gapMm;
    const printW = paperW - 2 * margin;
    let x = margin;
    let y = margin;
    let rowH = 0;
    const out = list.map((p) => {
      const bb = placementBBox(p);
      const w = Math.min(bb.w, printW);
      if (x > margin && x + w > margin + printW + PHOTO_TOL) {
        x = margin;
        y += rowH + gap;
        rowH = 0;
      }
      const cx = x + bb.w / 2;
      const cy = y + bb.h / 2;
      const np = { ...p, xMm: cx - p.wMm / 2, yMm: cy - p.hMm / 2 };
      x += bb.w + gap;
      rowH = Math.max(rowH, bb.h);
      return np;
    });
    snapshotPhotoHistory();
    setPhotoPlacements(out.map((pl) => clampPlacement(pl, paperW, paperH)));
  }, [snapshotPhotoHistory]);

  /**
   * Align within the printable area (Word-like). With several photos
   * selected, the WHOLE GROUP moves as one block (group bounding box aligned
   * to the printable margin) — relative positions inside the group keep.
   */
  const alignPhotoPlacement = useCallback(
    (dir: PhotoAlign) => {
      const list = photoPlacementsRef.current;
      const selIds = photoSelectedIdsRef.current;
      const target =
        selIds.length > 1
          ? list.filter((p) => selIds.includes(p.id))
          : list.filter((p) => p.id === photoSelectedIdRef.current);
      if (target.length === 0) return;
      const ps = photoSettingsRef.current;
      const { wMm: paperW, hMm: paperH } = paperDimsRef.current;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of target) {
        const bb = placementBBox(p);
        minX = Math.min(minX, bb.x);
        minY = Math.min(minY, bb.y);
        maxX = Math.max(maxX, bb.x + bb.w);
        maxY = Math.max(maxY, bb.y + bb.h);
      }
      let dx = 0;
      let dy = 0;
      if (dir === "left") dx = ps.marginMm - minX;
      if (dir === "centerX") dx = (paperW - (maxX - minX)) / 2 - minX;
      if (dir === "right") dx = paperW - ps.marginMm - maxX;
      if (dir === "top") dy = ps.marginMm - minY;
      if (dir === "centerY") dy = (paperH - (maxY - minY)) / 2 - minY;
      if (dir === "bottom") dy = paperH - ps.marginMm - maxY;
      updatePhotoPlacements(
        target.map((p) => ({
          id: p.id,
          patch: { xMm: p.xMm + dx, yMm: p.yMm + dy },
        })),
      );
    },
    [updatePhotoPlacements],
  );

  // --------------------------------------------------------------------------
  // "Optimalkan Otomatis" — one-tap professional pass
  // --------------------------------------------------------------------------

  /**
   * Re-grids every distinct photo at the current preset, centered in the
   * printable area, margins respected — then reports what happened in one
   * human summary (slots, paper, cropped-or-not, leftover paper %).
   */
  const optimizePhotoLayout = useCallback(() => {
    const list = photoPlacementsRef.current;
    const ps = photoSettingsRef.current;
    const { wMm: paperW, hMm: paperH } = paperDimsRef.current;
    if (list.length === 0) {
      toast.info("Belum ada foto di lembar", {
        description:
          "Unggah foto PNG/JPG terlebih dahulu, lalu jalankan Optimalkan Otomatis.",
      });
      return;
    }
    const notReady = list.some((p) => {
      const it = filesRef.current.find((f) => f.id === p.itemId);
      return !it || it.kind !== "image" || it.status !== "ready" || !it.url;
    });
    if (notReady) {
      toast.warning("Sebagian foto masih diproses", {
        description: "Tunggu foto selesai dimuat, lalu jalankan lagi.",
      });
      return;
    }
    const distinct = new Set(list.map((p) => p.itemId)).size;
    const preset = getPhotoPreset(ps.presetId);
    const pw = Math.min(
      preset.group === "custom" ? ps.customWMm : preset.wMm,
      paperW,
    );
    const ph = Math.min(
      preset.group === "custom" ? ps.customHMm : preset.hMm,
      paperH,
    );
    const cap = gridCapacityFor(pw, ph, ps.marginMm, ps.gapMm, paperW, paperH);
    if (cap === 0) {
      toast.error("Ukuran foto melebihi area cetak", {
        description:
          "Kecilkan ukuran foto atau margin lembar, lalu jalankan lagi.",
      });
      return;
    }
    const total = Math.min(
      Math.max(ps.perSheet, distinct),
      cap,
      MAX_PLACEMENTS,
    );
    const overCap = Math.max(0, distinct - total);
    const willBumpQuality = settingsRef.current.quality === "draft";
    arrangePhotoCopies(ps.perSheet, {
      auto: true,
      coverAll: true,
      alignV: "center",
      alignH: "center",
    });
    const coveredPct = Math.min(
      100,
      Math.round(((total * pw * ph) / (paperW * paperH)) * 100),
    );
    const leftover = Math.max(0, 100 - coveredPct);
    if (willBumpQuality) {
      setSettings((s) =>
        s.quality === "draft" ? { ...s, quality: "standard" } : s,
      );
    }
    toast.success(
      `Selesai — ${total} foto ${preset.short} tersusun di ${getPaper(settingsRef.current.paperId).shortLabel}`,
      {
        description: [
          distinct > 1
            ? `${distinct} foto berbeda dibagi rata dalam grid.`
            : null,
          "Semua foto di dalam margin — tidak ada yang terpotong.",
          `Perkiraan sisa kertas: ${leftover}%.`,
          overCap > 0
            ? `${overCap} foto tidak muat — pilih preset lebih kecil atau kertas lebih besar.`
            : null,
          willBumpQuality
            ? "Kualitas dinaikkan ke Standar agar hasil tidak pudar."
            : null,
        ]
          .filter(Boolean)
          .join(" "),
      },
    );
  }, [arrangePhotoCopies]);

  // --------------------------------------------------------------------------
  // Preflight check — certainty before paper and ink are spent
  // --------------------------------------------------------------------------

  const photoPreflight = useMemo<PreflightReport>(() => {
    const placements = photoPlacements;
    if (placements.length === 0) {
      return { ...EMPTY_PREFLIGHT, headline: "Belum ada foto di lembar" };
    }
    const items: PreflightIssue[] = [];

    const notReady = placements.filter((p) => {
      const it = files.find((f) => f.id === p.itemId);
      return !it || it.kind !== "image" || it.status !== "ready" || !it.url;
    });
    if (notReady.length > 0) {
      items.push({
        id: "not-ready",
        severity: "error",
        fixable: false,
        label: "Foto belum siap",
        detail: `${notReady.length} foto masih diproses atau gagal dibaca — tunggu sebentar atau ganti fotonya.`,
        placementIds: notReady.map((p) => p.id),
      });
    }

    const overlapIds = new Set<string>();
    let overlapPairs = 0;
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        const a = placementBBox(placements[i]);
        const b = placementBBox(placements[j]);
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 0.5 && oy > 0.5) {
          overlapPairs++;
          overlapIds.add(placements[i].id);
          overlapIds.add(placements[j].id);
        }
      }
    }
    if (overlapPairs > 0) {
      items.push({
        id: "overlap",
        severity: "error",
        fixable: true,
        label: "Foto tumpang tindih",
        detail: `${overlapPairs} pasang foto bertumpuk — hasil cetak saling menutupi. "Perbaiki Otomatis" merapikan jadi barisan.`,
        placementIds: [...overlapIds],
      });
    }

    const crossing = placements.filter((p) => {
      const bb = placementBBox(p);
      if (bb.w >= paperWmm - 0.1 && bb.h >= paperHmm - 0.1) return false;
      return (
        bb.x < photoSettings.marginMm - PHOTO_TOL ||
        bb.y < photoSettings.marginMm - PHOTO_TOL ||
        bb.x + bb.w > paperWmm - photoSettings.marginMm + PHOTO_TOL ||
        bb.y + bb.h > paperHmm - photoSettings.marginMm + PHOTO_TOL
      );
    });
    if (crossing.length > 0) {
      items.push({
        id: "margin",
        severity: "warn",
        fixable: true,
        label: "Menyentuh tepi kertas",
        detail: `${crossing.length} foto melewati margin ${photoSettings.marginMm} mm — sebagian printer memangkas ±3 mm dari tepi. "Perbaiki Otomatis" mengecilkan & merapikan, atau aktifkan Borderless.`,
        placementIds: crossing.map((p) => p.id),
      });
    }

    const lowRes: Array<{ dpi: number; id: string }> = [];
    for (const p of placements) {
      const it = files.find((f) => f.id === p.itemId);
      if (!it?.url || !it.docWidthMm || !it.docHeightMm) continue;
      const pxW = it.docWidthMm / PX96_TO_MM;
      const pxH = it.docHeightMm / PX96_TO_MM;
      const dpi = Math.min(pxW / (p.wMm / 25.4), pxH / (p.hMm / 25.4));
      if (dpi < 90) lowRes.push({ dpi: Math.round(dpi), id: p.id });
    }
    if (lowRes.length > 0) {
      const worst = [...lowRes].sort((a, b) => a.dpi - b.dpi)[0];
      items.push({
        id: "lowres",
        severity: worst.dpi < 45 ? "error" : "warn",
        fixable: false,
        label: "Resolusi gambar rendah",
        detail: `${lowRes.length} foto di bawah 90 DPI untuk ukuran cetaknya (terendah ~${worst.dpi} DPI) — hasil berpotensi pecah. Kecilkan ukuran cetak atau pakai file lebih besar.`,
        placementIds: lowRes.map((x) => x.id),
      });
    }

    const covered = placements.reduce((sum, p) => {
      const bb = placementBBox(p);
      const cw = Math.min(bb.x + bb.w, paperWmm) - Math.max(bb.x, 0);
      const ch = Math.min(bb.y + bb.h, paperHmm) - Math.max(bb.y, 0);
      return sum + Math.max(0, cw) * Math.max(0, ch);
    }, 0);
    const coveragePct = Math.min(
      100,
      Math.round((covered / (paperWmm * paperHmm)) * 100),
    );
    const ink =
      coveragePct < 15 ? "rendah" : coveragePct < 45 ? "sedang" : "tinggi";
    const errors = items.filter((i) => i.severity === "error").length;
    const warns = items.filter((i) => i.severity === "warn").length;
    const status = errors > 0 ? "error" : warns > 0 ? "warn" : "ok";
    const headline =
      status === "ok"
        ? "Siap dicetak — tidak ada masalah"
        : errors > 0
          ? `${errors} masalah perlu diperbaiki`
          : `${warns} hal perlu diperiksa`;
    return { status, headline, items, ink, sheets: settings.copies, coveragePct };
  }, [photoPlacements, files, paperWmm, paperHmm, photoSettings, settings.copies]);

  const docPreflight = useMemo<PreflightReport>(() => {
    const f = activeFile;
    if (!f || f.status !== "ready") {
      return { ...EMPTY_PREFLIGHT, headline: "Belum ada dokumen" };
    }
    const items: PreflightIssue[] = [];
    if (rangeInvalid) {
      items.push({
        id: "range",
        severity: "error",
        fixable: true,
        label: "Rentang halaman tidak valid",
        detail: 'Format rentang tidak sesuai — contoh benar: "1-3, 5".',
      });
    }
    if (paperMismatch) {
      items.push({
        id: "paper",
        severity: "warn",
        fixable: false,
        label: "Ukuran dokumen berbeda dari kertas",
        detail: `Dokumen ${f.docLabel ?? ""} dibanding kertas ${paper.shortLabel} — mode "Sesuaikan Kertas" menskalakan otomatis.`,
      });
    }
    if (contentOverflows) {
      items.push({
        id: "overflow",
        severity: "warn",
        fixable: true,
        label: "Konten melebihi kertas",
        detail: 'Skala 100% aktif — bagian di luar kertas terpotong. "Perbaiki Otomatis" mengaktifkan Sesuaikan Kertas.',
      });
    }
    const sheets = selectedPages.length * settings.copies;
    if (sheets > 150) {
      items.push({
        id: "cap",
        severity: "error",
        fixable: false,
        label: "Melebihi batas 150 lembar",
        detail: `${selectedPages.length} hal × ${settings.copies} salinan = ${sheets} lembar. Kurangi rentang halaman atau salinan.`,
      });
    }
    const ink =
      settings.colorMode === "grayscale"
        ? settings.quality === "draft"
          ? "rendah"
          : "sedang"
        : settings.quality === "high"
          ? "tinggi"
          : "sedang";
    const errors = items.filter((i) => i.severity === "error").length;
    const warns = items.filter((i) => i.severity === "warn").length;
    const status = errors > 0 ? "error" : warns > 0 ? "warn" : "ok";
    const headline =
      status === "ok"
        ? `Siap dicetak — ${selectedPages.length} hal × ${settings.copies} salinan`
        : errors > 0
          ? `${errors} masalah perlu diperbaiki`
          : `${warns} hal perlu diperiksa`;
    return {
      status,
      headline,
      items,
      ink,
      sheets,
      coveragePct: Math.min(100, Math.round((sheets / 150) * 100)),
    };
  }, [
    activeFile,
    rangeInvalid,
    paperMismatch,
    contentOverflows,
    selectedPages.length,
    settings.copies,
    settings.colorMode,
    settings.quality,
    paper.shortLabel,
  ]);

  const preflight = photoMode ? photoPreflight : docPreflight;

  /** One tap resolves everything resolvable (arrange / shrink / reset scale). */
  const autoFixPreflight = useCallback(() => {
    if (photoModeRef.current) {
      const list = photoPlacementsRef.current;
      const ps = photoSettingsRef.current;
      const { wMm: paperW, hMm: paperH } = paperDimsRef.current;
      const printW = paperW - 2 * ps.marginMm;
      const printH = paperH - 2 * ps.marginMm;
      const shrink: Array<{
        id: string;
        patch: Partial<PhotoPlacement>;
      }> = [];
      for (const p of list) {
        const bb = placementBBox(p);
        if (bb.w >= paperW - 0.1 && bb.h >= paperH - 0.1) continue;
        const crossing =
          bb.x < ps.marginMm - PHOTO_TOL ||
          bb.y < ps.marginMm - PHOTO_TOL ||
          bb.x + bb.w > paperW - ps.marginMm + PHOTO_TOL ||
          bb.y + bb.h > paperH - ps.marginMm + PHOTO_TOL;
        if (!crossing) continue;
        const scale = Math.min(1, printW / bb.w, printH / bb.h);
        if (scale >= 1) continue;
        const w2 = Math.max(MIN_PHOTO_MM, p.wMm * scale);
        const h2 = Math.max(MIN_PHOTO_MM, p.hMm * scale);
        const cx = p.xMm + p.wMm / 2;
        const cy = p.yMm + p.hMm / 2;
        shrink.push({
          id: p.id,
          patch: { wMm: w2, hMm: h2, xMm: cx - w2 / 2, yMm: cy - h2 / 2 },
        });
      }
      if (shrink.length > 0) updatePhotoPlacements(shrink);
      autoArrangePhotos();
      toast.success("Perbaikan otomatis selesai", {
        description:
          "Foto yang menempel tepi disesuaikan ke dalam margin dan lembar dirapikan berbaris.",
      });
      return;
    }
    const s = settingsRef.current;
    const f = activeFileRef.current;
    let fixed = 0;
    if (
      s.rangeMode === "custom" &&
      !parsePageRange(s.rangeText, f?.pageCount ?? 1).valid
    ) {
      setSetting("rangeMode", "all");
      fixed++;
    }
    if (f && f.docWidthMm && !f.continuous) {
      const dims = paperDims(s.paperId, s.orientation);
      const sc =
        s.scaleMode === "fit"
          ? Math.min(dims.wMm / f.docWidthMm, dims.hMm / (f.docHeightMm || 1))
          : 1;
      const overflows =
        f.docWidthMm * sc > dims.wMm + 0.5 ||
        (f.docHeightMm ?? 0) * sc > dims.hMm + 0.5;
      if (overflows && s.scaleMode !== "fit") {
        setSetting("scaleMode", "fit");
        fixed++;
      }
    }
    if (fixed > 0) {
      toast.success("Perbaikan otomatis selesai", {
        description: "Pengaturan cetak disesuaikan agar aman dicetak.",
      });
    } else {
      toast.info("Tidak ada masalah yang bisa diperbaiki otomatis");
    }
  }, [updatePhotoPlacements, autoArrangePhotos, setSetting]);

  // --------------------------------------------------------------------------
  // "Bantu Saya Cetak" — guided wizard applies a complete configuration
  // --------------------------------------------------------------------------

  const applyGuidedChoice = useCallback(
    (goal: GuidedGoal, paper: GuidedPaper, outcome: GuidedOutcome) => {
      const paperId: PaperId = paper === "f4" ? "f4" : paper === "4r" ? "4r" : "a4";
      const dims = paperDims(paperId, "portrait");
      const margin = outcome === "hemat" ? 3 : 5;
      const gap = outcome === "hemat" ? 2 : 4;
      const quality =
        outcome === "kualitas" ? "high" : outcome === "hemat" ? "draft" : "standard";
      const readyImages = filesRef.current.filter(
        (f) => f.kind === "image" && f.status === "ready" && !!f.url,
      );
      const distinct = new Set([
        ...readyImages.map((f) => f.id),
        ...photoPlacementsRef.current.map((p) => p.itemId),
      ]).size;

      if (goal === "doc") {
        setPhotoModeState(false);
        setPhotoSelectedIds([]);
        setSettings((s) => ({
          ...s,
          paperId,
          scaleMode: outcome === "asli" ? "original" : "fit",
          colorMode: outcome === "hemat" ? "grayscale" : s.colorMode,
          quality,
          rangeMode: "all",
          rangeText: "",
        }));
        toast.success("Pengaturan dokumen siap", {
          description: `Kertas ${getPaper(paperId).shortLabel} • ${outcome === "asli" ? "ukuran asli" : "sesuaikan kertas"} • ${outcome === "hemat" ? "hemat tinta" : outcome === "kualitas" ? "kualitas terbaik" : "standar"} — tekan Cetak ke Epson.`,
        });
        return;
      }

      setSettings((s) => ({ ...s, paperId, quality }));
      setPhotoModeState(true);

      if (goal === "pas-foto") {
        const presetId = paper === "4r" ? "pf-4x6" : "pf-3x4";
        const preset = getPhotoPreset(presetId);
        const cap = gridCapacityFor(
          preset.wMm,
          preset.hMm,
          margin,
          gap,
          dims.wMm,
          dims.hMm,
        );
        const perSheet = Math.min(
          cap,
          Math.max(6, outcome === "semua" ? distinct : 6),
          MAX_PLACEMENTS,
        );
        setPhotoSettings((s) => ({
          ...s,
          presetId,
          marginMm: margin,
          gapMm: gap,
          cutLines: true,
          alignV: "center",
          alignH: "center",
          perSheet,
        }));
        arrangePhotoCopies(perSheet, {
          dims: { wMm: preset.wMm, hMm: preset.hMm },
          marginMm: margin,
          gapMm: gap,
          alignV: "center",
          alignH: "center",
          coverAll: outcome === "semua",
          paperWmm: dims.wMm,
          paperHmm: dims.hMm,
        });
        return;
      }

      if (goal === "banyak-foto") {
        const candidates = [
          { id: "p-4r", wMm: 102, hMm: 152 },
          { id: "p-3r", wMm: 89, hMm: 127 },
          { id: "p-2r", wMm: 64, hMm: 89 },
        ];
        let chosen = candidates[candidates.length - 1];
        for (const c of candidates) {
          chosen = c;
          if (
            gridCapacityFor(c.wMm, c.hMm, margin, gap, dims.wMm, dims.hMm) >=
            Math.max(1, distinct)
          ) {
            break;
          }
        }
        const cap = gridCapacityFor(
          chosen.wMm,
          chosen.hMm,
          margin,
          gap,
          dims.wMm,
          dims.hMm,
        );
        const perSheet = Math.min(cap, Math.max(2, distinct), MAX_PLACEMENTS);
        setPhotoSettings((s) => ({
          ...s,
          presetId: chosen.id,
          marginMm: margin,
          gapMm: gap,
          cutLines: true,
          alignV: "center",
          alignH: "center",
          perSheet,
        }));
        arrangePhotoCopies(perSheet, {
          dims: { wMm: chosen.wMm, hMm: chosen.hMm },
          marginMm: margin,
          gapMm: gap,
          alignV: "center",
          alignH: "center",
          coverAll: true,
          paperWmm: dims.wMm,
          paperHmm: dims.hMm,
        });
        return;
      }

      // lembar-penuh — one photo covering the whole sheet (full bleed)
      const itemId =
        photoPlacementsRef.current[0]?.itemId ?? readyImages[0]?.id ?? null;
      if (!itemId) {
        toast.info("Unggah satu foto terlebih dahulu", {
          description:
            "Mode lembar penuh menempatkan satu foto memenuhi kertas.",
        });
        return;
      }
      setPhotoSettings((s) => ({
        ...s,
        presetId: "custom",
        customWMm: dims.wMm,
        customHMm: dims.hMm,
        marginMm: 0,
        gapMm: 0,
        borderless: true,
        cutLines: false,
        alignV: "center",
        alignH: "center",
        perSheet: 1,
      }));
      const existing = photoPlacementsRef.current[0];
      const pid = existing?.id ?? newPhotoId();
      snapshotPhotoHistory();
      setPhotoPlacements([
        {
          id: pid,
          itemId,
          xMm: 0,
          yMm: 0,
          wMm: dims.wMm,
          hMm: dims.hMm,
          rotation: 0,
          fit: "cover",
          cropX: 0,
          cropY: 0,
        },
      ]);
      setPhotoSelectedIds([pid]);
      layoutTouchedRef.current = true;
      toast.success("Foto memenuhi lembar", {
        description: `Satu foto ${dims.wMm}×${dims.hMm} mm full bleed di ${getPaper(paperId).shortLabel} — geser "Potongan" di panel kanan untuk memilih bagian yang tercetak.`,
      });
    },
    [arrangePhotoCopies, snapshotPhotoHistory],
  );

  // --------------------------------------------------------------------------
  // Preset pekerjaan siap pakai ("Pekerjaan Cepat")
  // --------------------------------------------------------------------------

  const applyJobPreset = useCallback(
    (id: JobPresetId) => {
      switch (id) {
        case "doc-hemat":
        case "doc-kualitas":
        case "ttd-scan": {
          setPhotoModeState(false);
          setPhotoSelectedIds([]);
          if (id === "doc-hemat") {
            setSettings((s) => ({
              ...s,
              colorMode: "grayscale",
              quality: "draft",
              scaleMode: "fit",
            }));
            toast.success("Preset Dokumen Hemat aktif", {
              description: "Hitam-putih • Draf • sesuaikan kertas — paling irit tinta.",
            });
          } else if (id === "doc-kualitas") {
            setSettings((s) => ({
              ...s,
              colorMode: "color",
              quality: "high",
              scaleMode: "fit",
            }));
            toast.success("Preset Dokumen Kualitas aktif", {
              description: "Berwarna • Tinggi — untuk dokumen resmi & presentasi.",
            });
          } else {
            setSettings((s) => ({
              ...s,
              paperId: "a4",
              scaleMode: "original",
              colorMode: "grayscale",
              quality: "standard",
            }));
            toast.success("Preset Tanda Tangan aktif", {
              description:
                "Gambar dicetak ukuran asli di A4 — pastikan file scan sudah dipilih.",
            });
          }
          return;
        }
        case "pasfoto-3x4":
        case "pasfoto-4x6":
        case "lamaran":
        case "visa-paspor": {
          const cfg = {
            "pasfoto-3x4": { presetId: "pf-3x4", perSheet: 6 },
            "pasfoto-4x6": { presetId: "pf-4x6", perSheet: 6 },
            lamaran: { presetId: "pf-3x4", perSheet: 8 },
            "visa-paspor": { presetId: "pf-35x45", perSheet: 8 },
          }[id];
          const preset = getPhotoPreset(cfg.presetId);
          setPhotoModeState(true);
          setPhotoSettings((s) => ({
            ...s,
            presetId: cfg.presetId,
            marginMm: 4,
            gapMm: 3,
            cutLines: true,
            alignV: "center",
            alignH: "center",
            perSheet: cfg.perSheet,
          }));
          arrangePhotoCopies(cfg.perSheet, {
            dims: { wMm: preset.wMm, hMm: preset.hMm },
            marginMm: 4,
            gapMm: 3,
            alignV: "center",
            alignH: "center",
            coverAll: true,
          });
          return;
        }
        case "kartu-identitas": {
          setPhotoModeState(true);
          setPhotoSettings((s) => ({
            ...s,
            presetId: "custom",
            customWMm: 85.6,
            customHMm: 54,
            marginMm: 4,
            gapMm: 4,
            cutLines: true,
            alignV: "center",
            alignH: "center",
            perSheet: 2,
          }));
          arrangePhotoCopies(2, {
            dims: { wMm: 85.6, hMm: 54 },
            marginMm: 4,
            gapMm: 4,
            alignV: "center",
            alignH: "center",
            coverAll: true,
          });
          return;
        }
        case "penuh-a4":
        case "penuh-4r": {
          const paperId: PaperId = id === "penuh-4r" ? "4r" : "a4";
          const dims = paperDims(paperId, "portrait");
          const itemId =
            photoPlacementsRef.current[0]?.itemId ??
            filesRef.current.find(
              (f) => f.kind === "image" && f.status === "ready" && !!f.url,
            )?.id ??
            null;
          if (!itemId) {
            toast.info("Unggah foto terlebih dahulu", {
              description: "Preset ini menempatkan satu foto memenuhi lembar.",
            });
            return;
          }
          setSettings((s) => ({ ...s, paperId }));
          setPhotoModeState(true);
          setPhotoSettings((s) => ({
            ...s,
            presetId: "custom",
            customWMm: dims.wMm,
            customHMm: dims.hMm,
            marginMm: 0,
            gapMm: 0,
            borderless: true,
            cutLines: false,
            perSheet: 1,
            alignV: "center",
            alignH: "center",
          }));
          const existing = photoPlacementsRef.current[0];
          const pid = existing?.id ?? newPhotoId();
          snapshotPhotoHistory();
          setPhotoPlacements([
            {
              id: pid,
              itemId,
              xMm: 0,
              yMm: 0,
              wMm: dims.wMm,
              hMm: dims.hMm,
              rotation: 0,
              fit: "cover",
              cropX: 0,
              cropY: 0,
            },
          ]);
          setPhotoSelectedIds([pid]);
          layoutTouchedRef.current = true;
          toast.success(`Foto penuh ${getPaper(paperId).shortLabel}`, {
            description:
              "Full bleed — tidak ada kertas kosong. Geser Potongan di panel kanan untuk memilih bagian yang tercetak.",
          });
          return;
        }
      }
    },
    [arrangePhotoCopies, snapshotPhotoHistory],
  );

  // --------------------------------------------------------------------------
  // Export layout (PNG / PDF) — archive or hand to the customer
  // --------------------------------------------------------------------------

  const exportPhotoSheet = useCallback(async (format: "png" | "pdf") => {
    const s = settingsRef.current;
    const ps = photoSettingsRef.current;
    const placements = photoPlacementsRef.current;
    if (placements.length === 0) {
      toast.info("Belum ada foto untuk diekspor.");
      return;
    }
    const dims = paperDims(s.paperId, s.orientation);
    const spec: PhotoSheetSpec = {
      paperWmm: dims.wMm,
      paperHmm: dims.hMm,
      placements,
      resolveImage: (itemId) =>
        filesRef.current.find((f) => f.id === itemId && f.kind === "image")?.url ??
        null,
      colorMode: s.colorMode,
      cutLines: ps.cutLines,
      adjust: ps.adjust,
    };
    try {
      const canvas = await renderPhotoSheetCanvas(spec);
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === "png") {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
        if (!blob) throw new Error("PNG gagal dibuat.");
        downloadBlob(blob, `layout-foto-${stamp}.png`);
      } else {
        const { PDFDocument } = await import("pdf-lib");
        const pdf = await PDFDocument.create();
        const pngImage = await pdf.embedPng(canvas.toDataURL("image/png"));
        const ptW = (dims.wMm / 25.4) * 72;
        const ptH = (dims.hMm / 25.4) * 72;
        const page = pdf.addPage([ptW, ptH]);
        page.drawImage(pngImage, { x: 0, y: 0, width: ptW, height: ptH });
        const bytes = await pdf.save();
        downloadBlob(
          new Blob([bytes as unknown as BlobPart], {
            type: "application/pdf",
          }),
          `layout-foto-${stamp}.pdf`,
        );
      }
      toast.success(`Layout diekspor (${format.toUpperCase()})`, {
        description: "File terunduh — siap diarsipkan atau dikirim ke pelanggan.",
      });
    } catch (err) {
      toast.error("Ekspor gagal", {
        description: err instanceof Error ? err.message : "Kesalahan tidak diketahui.",
      });
    }
  }, []);

  // --------------------------------------------------------------------------
  // Session auto-save & restore (photo mode)
  // --------------------------------------------------------------------------

  const saveSessionNow = useCallback(() => {
    try {
      if (!photoModeRef.current) return;
      const placements = photoPlacementsRef.current;
      if (placements.length === 0) return;
      const images = filesRef.current.filter(
        (f) => f.kind === "image" && f.status === "ready" && !!f.bytes,
      );
      if (images.length === 0) return;
      let total = 0;
      const savedFiles: SavedSessionFile[] = [];
      for (const f of images) {
        if (!f.bytes || f.bytes.length > SESSION_MAX_FILE_BYTES) return;
        total += f.bytes.length;
        if (total > SESSION_MAX_TOTAL_BYTES) return;
        let b64 = sessionB64Cache.get(f.id);
        if (!b64) {
          b64 = toBase64(f.bytes);
          sessionB64Cache.set(f.id, b64);
        }
        savedFiles.push({ id: f.id, name: f.name, ext: f.ext, mime: f.mime, bytesB64: b64 });
      }
      const payload: SavedSession = {
        v: 1,
        savedAt: Date.now(),
        settings: settingsRef.current,
        photoSettings: photoSettingsRef.current,
        placements,
        files: savedFiles,
      };
      window.localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    } catch {
      /* quota exceeded / private mode — auto-save is best-effort */
    }
  }, []);

  const restoreSession = useCallback(
    (saved: SavedSession) => {
      const restored: LoadedFile[] = saved.files.map((f) => ({
        id: f.id,
        name: f.name,
        ext: f.ext,
        sizeBytes: Math.round((f.bytesB64.length * 3) / 4),
        kind: "image",
        mime: f.mime,
        bytes: b64ToBytes(f.bytesB64),
        url: null,
        status: "loading",
        pageCount: null,
        docWidthMm: null,
        docHeightMm: null,
        docLabel: null,
      }));
      setFiles(restored);
      for (const f of restored) {
        inspectImage(f)
          .then((patch) => patchFile(f.id, patch))
          .catch(() =>
            patchFile(f.id, {
              status: "error",
              error: "Gambar sesi tidak dapat dibaca.",
            }),
          );
      }
      setSettings(saved.settings);
      setPhotoSettings(saved.photoSettings);
      setPhotoPlacements(saved.placements.map((p) => ({ ...p })));
      setPhotoSelectedIds([]);
      setPhotoModeState(true);
      setActiveId(restored[0]?.id ?? null);
      setPage(1);
      photoHistoryPastRef.current = [];
      photoHistoryFutureRef.current = [];
      setPhotoHistoryTick((t) => t + 1);
      toast.success("Sesi dipulihkan", {
        description: `${saved.placements.length} foto, ukuran, dan pengaturan dikembalikan seperti sebelumnya.`,
      });
    },
    [patchFile],
  );

  const restoreSessionRef = useRef(restoreSession);
  restoreSessionRef.current = restoreSession;

  // mount-once: offer to restore the last session.
  // Deferred a tick: sonner only renders toasts published AFTER its <Toaster>
  // mounts, so firing during hydration would swallow the offer entirely.
  useEffect(() => {
    const t = window.setTimeout(() => {
      let raw: string | null = null;
      try {
        raw = window.localStorage.getItem(SESSION_KEY);
      } catch {
        raw = null;
      }
      if (!raw) return;
      let saved: SavedSession | null = null;
      try {
        saved = JSON.parse(raw) as SavedSession;
      } catch {
        saved = null;
      }
      if (
        !saved ||
        saved.v !== 1 ||
        !Array.isArray(saved.placements) ||
        saved.placements.length === 0 ||
        !Array.isArray(saved.files)
      ) {
        return;
      }
      if ((Date.now() - saved.savedAt) / 3_600_000 > SESSION_MAX_AGE_H) {
        try {
          window.localStorage.removeItem(SESSION_KEY);
        } catch {
          /* ignore */
        }
        return;
      }
      const snap = saved;
      const when = new Date(snap.savedAt).toLocaleTimeString("id-ID", {
        hour: "2-digit",
        minute: "2-digit",
      });
      toast.info("Sesi cetak terakhir ditemukan", {
        description: `${snap.placements.length} foto tersimpan otomatis (${when}). Pulihkan untuk melanjutkan pekerjaan tadi.`,
        duration: 15_000,
        action: {
          label: "Pulihkan",
          onClick: () => restoreSessionRef.current(snap),
        },
        cancel: {
          label: "Abaikan",
          onClick: () => {
            try {
              window.localStorage.removeItem(SESSION_KEY);
            } catch {
              /* ignore */
            }
          },
        },
      });
    }, 600);
    return () => window.clearTimeout(t);
  }, []);

  // debounced auto-save whenever the photo session changes
  useEffect(() => {
    if (!photoMode || photoPlacements.length === 0) return;
    const t = window.setTimeout(() => saveSessionNow(), 1200);
    return () => window.clearTimeout(t);
  }, [photoMode, photoPlacements, photoSettings, settings, saveSessionNow]);

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y — undo & redo the photo layout
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return;
      }
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redoPhoto();
        else undoPhoto();
      } else if ((e.ctrlKey || e.metaKey) && k === "y") {
        e.preventDefault();
        redoPhoto();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undoPhoto, redoPhoto]);

  // -- photo print execution ---------------------------------------------------
  const printPhotoLayout = useCallback(async () => {
    const s = settingsRef.current;
    const ps = photoSettingsRef.current;
    const placements = photoPlacementsRef.current;
    if (placements.length === 0) return;
    const dims = paperDims(s.paperId, s.orientation);
    const spec: PhotoSheetSpec = {
      paperWmm: dims.wMm,
      paperHmm: dims.hMm,
      placements,
      resolveImage: (itemId) =>
        filesRef.current.find((f) => f.id === itemId && f.kind === "image")?.url ??
        null,
      colorMode: s.colorMode,
      cutLines: ps.cutLines,
      adjust: ps.adjust,
    };
    if (s.printMode === "spooler") {
      const canvas = await renderPhotoSheetCanvas(spec);
      const data = canvas.toDataURL("image/png").split(",")[1] ?? "";
      const res = await fetch("/api/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job: {
            fileName: "Layout-Foto-Epson.png",
            mime: "image/png",
            kind: "image",
            paperId: s.paperId,
            ippMedia: getPaper(s.paperId).ippMedia,
            paperType: s.paperType,
            paperWmm: dims.wMm,
            paperHmm: dims.hMm,
            orientation: "portrait",
            colorMode: s.colorMode,
            quality: s.quality,
            copies: s.copies,
            duplex: false,
            scaleMode: "original",
            pages: [1],
          },
          data,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; jobId?: string; message?: string; spooler?: string }
        | null;
      if (!res.ok || !body?.ok) {
        toast.error("Direct Spooler menolak pekerjaan cetak", {
          description: body?.message ?? "Spooler lokal tidak tersedia.",
        });
        return;
      }
      toast.success("Pekerjaan cetak foto terkirim", {
        description: `${body.spooler ?? "spooler"} • job ${body.jobId ?? "-"}`,
      });
      return;
    }
    await printPhotoViaBrowser(spec, s.copies);
  }, []);

  // -- estimated page count for continuous HTML documents ---------------------
  const reportEstimatedPages = useCallback(
    (fileId: string, pages: number) => {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId && f.continuous && f.pageCount !== pages
            ? { ...f, pageCount: pages }
            : f,
        ),
      );
    },
    [],
  );

  // -- print execution --------------------------------------------------------
  const buildPrintRequest = useCallback(
    (pages: number[]) => {
      const f = activeFileRef.current;
      const s = settingsRef.current;
      if (!f) return null;
      return {
        file: f,
        paperWmm: paperDims(s.paperId, s.orientation).wMm,
        paperHmm: paperDims(s.paperId, s.orientation).hMm,
        scaleMode: s.scaleMode,
        colorMode: s.colorMode,
        pages,
        copies: s.copies,
        getPdfDoc: () => loadPdfDoc(f),
        getDocxRender: () => renderDocx(f),
        getDocHtml: () => convertViaServer(f),
      };
    },
    [],
  );

  const printPages = useCallback(async (pages: number[]) => {
    const req = buildPrintRequest(pages);
    if (!req) return;
    await printViaBrowser(req);
  }, [buildPrintRequest]);

  const spoolPrint = useCallback(async () => {
    const f = activeFileRef.current;
    const s = settingsRef.current;
    const pages = selectedPagesRef.current;
    if (!f || !f.bytes) return;
    const dims = paperDims(s.paperId, s.orientation);
    const res = await fetch("/api/print", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job: {
          fileName: f.name,
          mime: f.mime,
          kind: f.kind,
          paperId: s.paperId,
          ippMedia: getPaper(s.paperId).ippMedia,
          paperType: s.paperType,
          paperWmm: dims.wMm,
          paperHmm: dims.hMm,
          orientation: s.orientation,
          colorMode: s.colorMode,
          quality: s.quality,
          copies: s.copies,
          duplex: s.duplex,
          scaleMode: s.scaleMode,
          pages,
        },
        data: toBase64(f.bytes),
      }),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; jobId?: string; message?: string; spooler?: string }
      | null;
    if (!res.ok || !body?.ok) {
      toast.error("Direct Spooler menolak pekerjaan cetak", {
        description: body?.message ?? "Spooler lokal tidak tersedia.",
      });
      return;
    }
    toast.success("Pekerjaan cetak terkirim", {
      description: `${body.spooler ?? "spooler"} • job ${body.jobId ?? "-"}`,
    });
  }, []);

  const triggerPrint = useCallback(async () => {
    // Photo layout mode has its own print pipeline (single rasterized sheet).
    if (photoModeRef.current) {
      if (printing || photoPlacementsRef.current.length === 0) return;
      setPrinting(true);
      try {
        await printPhotoLayout();
      } catch (err) {
        toast.error("Cetak foto gagal", {
          description: err instanceof Error ? err.message : "Kesalahan tidak diketahui.",
        });
      } finally {
        setPrinting(false);
      }
      return;
    }
    const f = activeFileRef.current;
    const s = settingsRef.current;
    const pages = selectedPagesRef.current;
    if (!f || f.status !== "ready" || pages.length === 0 || printing) return;

    setPrinting(true);
    try {
      if (s.printMode === "spooler") {
        await spoolPrint();
        return;
      }
      // Manual duplex: pass 1 = odd pages, pass 2 (user-driven) = even pages reversed
      if (s.duplex && pages.length > 1) {
        const odd = pages.filter((p) => p % 2 === 1);
        await printPages(odd.length > 0 ? odd : pages);
        const even = pages.filter((p) => p % 2 === 0).reverse();
        if (even.length > 0) setDuplexAssist({ evenPages: even });
        return;
      }
      await printPages(pages);
    } catch (err) {
      toast.error("Cetak gagal", {
        description: err instanceof Error ? err.message : "Kesalahan tidak diketahui.",
      });
    } finally {
      setPrinting(false);
    }
  }, [printing, printPages, spoolPrint, printPhotoLayout]);

  const printEvenPass = useCallback(async () => {
    if (!duplexAssist) return;
    setPrinting(true);
    try {
      await printPages(duplexAssist.evenPages);
    } catch (err) {
      toast.error("Cetak sisi genap gagal", {
        description: err instanceof Error ? err.message : "Kesalahan tidak diketahui.",
      });
    } finally {
      setPrinting(false);
      setDuplexAssist(null);
    }
  }, [duplexAssist, printPages]);

  const cancelDuplex = useCallback(() => setDuplexAssist(null), []);

  // Ctrl+P / Cmd+P shortcut
  const triggerRef = useRef(triggerPrint);
  triggerRef.current = triggerPrint;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        void triggerRef.current();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const loadSamples = useCallback(async () => {
    try {
      const samples: Array<[string, string]> = [
        ["/samples/sample-letter.pdf", "Surat-Kwitansi-Letter.pdf"],
        ["/samples/sample-warna.png", "Grafik-Warna.png"],
        ["/samples/sample-dokumen.docx", "Laporan-Dokumen.docx"],
      ];
      const fetched: File[] = [];
      for (const [url, name] of samples) {
        const res = await fetch(url);
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        const ext = name.split(".").pop()!.toLowerCase();
        const mime =
          ext === "pdf"
            ? "application/pdf"
            : ext === "png"
              ? "image/png"
              : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        fetched.push(new File([buf], name, { type: mime }));
      }
      if (fetched.length > 0) addFiles(fetched);
    } catch {
      toast.error("Contoh dokumen tidak dapat dimuat.");
    }
  }, [addFiles]);

  // clamp preview page
  useEffect(() => {
    const total = activeFile?.pageCount ?? 1;
    if (page > total) setPage(Math.max(1, total));
  }, [activeFile?.pageCount, page]);

  const summary = useMemo(() => {
    const paperShort = paper.shortLabel;
    const typeShort = getPaperType(settings.paperType).short;
    const mediaLabel = typeShort ? ` • ${typeShort}` : "";
    const color = settings.colorMode === "color" ? "Berwarna" : "Hitam Putih";
    const copies = settings.copies;
    if (photoMode) {
      return `${photoPlacements.length} Foto • ${photoPreset.short} • ${paperShort}${mediaLabel} • ${color} • ${copies} Salinan`;
    }
    const pagesCount = selectedPages.length;
    const base = `${paperShort}${mediaLabel} • ${color} • ${pagesCount} Hal × ${copies} Salinan`;
    return settings.duplex ? `${base} • Bolak-Balik` : base;
  }, [
    photoMode,
    photoPlacements.length,
    photoPreset.short,
    paper.shortLabel,
    settings.colorMode,
    settings.copies,
    settings.duplex,
    settings.paperType,
    selectedPages.length,
  ]);

  return {
    // state
    files,
    activeFile,
    settings,
    page,
    zoom,
    showMargins,
    printing,
    duplexAssist,
    spooler,
    paper,
    paperWmm,
    paperHmm,
    contentScale,
    paperMismatch,
    contentOverflows,
    selectedPages,
    rangeInvalid,
    canPrint,
    summary,
    // photo mode state & derived
    photoMode,
    photoPlacements,
    photoSelectedId,
    photoSelectedIds,
    photoSettings,
    photoPreset,
    photoSelected,
    photoReady,
    photoBeyondMargin,
    photoCapacity,
    // actions
    addFiles,
    removeFile,
    selectFile,
    setSetting,
    setPage,
    setZoom,
    setShowMargins,
    triggerPrint,
    printEvenPass,
    cancelDuplex,
    reportEstimatedPages,
    loadSamples,
    // photo actions
    setPhotoMode,
    setPhotoSetting,
    setPhotoBorderless,
    applyPhotoPreset,
    selectPhotoPlacement,
    selectPhotoPlacements,
    selectAllPhotoPlacements,
    clearPhotoSelection,
    updatePhotoPlacement,
    updatePhotoPlacements,
    removePhotoPlacement,
    removePhotoPlacements,
    duplicatePhotoPlacement,
    duplicatePhotoPlacements,
    clearPhotoPlacements,
    fillPhotoSheet,
    coverPhotoSheet,
    arrangePhotoCopies,
    autoArrangePhotos,
    alignPhotoPlacement,
    addAllImagesToSheet,
    addPhotoFiles,
    replacePhotoItem,
    cropPhotoItem,
    // undo / redo (photo layout)
    undoPhoto,
    redoPhoto,
    beginPhotoHistory,
    endPhotoHistory,
    canUndoPhoto: photoHistoryPastRef.current.length > 0,
    canRedoPhoto: photoHistoryFutureRef.current.length > 0,
    // optimize / preflight / guided / presets / export / ui level
    optimizePhotoLayout,
    preflight,
    autoFixPreflight,
    applyGuidedChoice,
    applyJobPreset,
    exportPhotoSheet,
    uiLevel,
    setUiLevel,
    // document accessors for renderers
    getPdfDoc: loadPdfDoc,
    getDocxRender: renderDocx,
    getDocHtml: convertViaServer,
  };
}

export type PrintStationStore = ReturnType<typeof usePrintStation>;
