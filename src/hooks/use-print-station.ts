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
} from "@/lib/paper";
import {
  DEFAULT_PHOTO_SETTINGS,
  DEFAULT_SETTINGS,
  MAX_FILE_BYTES,
  MAX_PLACEMENTS,
  MIN_PHOTO_MM,
  getPaperType,
  type DocxRender,
  type LoadedFile,
  type PhotoPlacement,
  type PhotoSettings,
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

// ---------------------------------------------------------------------------
// Module-level document caches (survive component re-renders)
// ---------------------------------------------------------------------------
const pdfTaskCache = new Map<string, Promise<PDFDocumentLoadingTask>>();
const docxRenderCache = new Map<string, Promise<DocxRender>>();
const docHtmlCache = new Map<string, Promise<string>>();

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

export function usePrintStation() {
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [settings, setSettings] = useState<PrintSettings>(DEFAULT_SETTINGS);
  const [photoMode, setPhotoModeState] = useState(false);
  const [photoPlacements, setPhotoPlacements] = useState<PhotoPlacement[]>([]);
  const [photoSelectedId, setPhotoSelectedId] = useState<string | null>(null);
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
  const photoSelectedIdRef = useRef(photoSelectedId);
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
      const file = files.find((f) => f.id === id);
      if (file?.url) URL.revokeObjectURL(file.url);
      const next = files.filter((f) => f.id !== id);
      setFiles(next);
      // Purge photo placements referencing the removed file.
      const nextPlacements = photoPlacementsRef.current.filter(
        (p) => p.itemId !== id,
      );
      setPhotoPlacements(nextPlacements);
      setPhotoSelectedId((cur) =>
        cur && nextPlacements.some((p) => p.id === cur) ? cur : null,
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
    if (!next) setPhotoSelectedId(null);
  }, []);

  const selectPhotoPlacement = useCallback((id: string | null) => {
    setPhotoSelectedId(id);
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

  /** Place an uploaded image on the sheet at its current preset size. */
  const placeImageOnSheet = useCallback((itemId: string) => {
    const ps = photoSettingsRef.current;
    const { wMm: paperW, hMm: paperH } = paperDimsRef.current;
    const preset = getPhotoPreset(ps.presetId);
    const w = Math.min(preset.group === "custom" ? ps.customWMm : preset.wMm, paperW);
    const h = Math.min(preset.group === "custom" ? ps.customHMm : preset.hMm, paperH);
    const id = newPhotoId();
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
    setPhotoSelectedId(id);
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

  const updatePhotoPlacement = useCallback(
    (id: string, patch: Partial<PhotoPlacement>) => {
      // Hand edit (drag / resize / nudge / align) — pauses auto re-tiling so
      // a manual layout is never reshuffled by the next upload.
      layoutTouchedRef.current = true;
      const { wMm: paperW, hMm: paperH } = paperDimsRef.current;
      setPhotoPlacements((list) =>
        list.map((p) => {
          if (p.id !== id) return p;
          const next = { ...p, ...patch };
          next.wMm = Math.min(Math.max(next.wMm, MIN_PHOTO_MM), paperW);
          next.hMm = Math.min(Math.max(next.hMm, MIN_PHOTO_MM), paperH);
          next.rotation = normRotation(next.rotation);
          return clampPlacement(next, paperW, paperH);
        }),
      );
    },
    [],
  );

  const removePhotoPlacement = useCallback((id: string) => {
    layoutTouchedRef.current = true;
    setPhotoPlacements((list) => list.filter((p) => p.id !== id));
    setPhotoSelectedId((cur) => (cur === id ? null : cur));
  }, []);

  const duplicatePhotoPlacement = useCallback((id: string) => {
    layoutTouchedRef.current = true;
    const list = photoPlacementsRef.current;
    if (list.length >= MAX_PLACEMENTS) return;
    const src = list.find((p) => p.id === id);
    if (!src) return;
    const copy: PhotoPlacement = {
      ...src,
      id: newPhotoId(),
      xMm: src.xMm + 3,
      yMm: src.yMm + 3,
    };
    const idx = list.findIndex((p) => p.id === id);
    const next = [...list];
    next.splice(idx + 1, 0, clampPlacement(copy, paperDimsRef.current.wMm, paperDimsRef.current.hMm));
    setPhotoPlacements(next);
    setPhotoSelectedId(copy.id);
  }, []);

  const clearPhotoPlacements = useCallback(() => {
    layoutTouchedRef.current = false;
    setPhotoPlacements([]);
    setPhotoSelectedId(null);
  }, []);

  /**
   * Auto-grid arrange — the print-shop "ngejajar N foto" flow. Tiles N slots
   * sized to the current preset (or explicit dims) in a balanced grid
   * (6 → 3×2, 8 → 4×2, 9 → 3×3) centered inside the printable area;
   * portrait / landscape is picked by whichever capacity fits N. Slots are
   * filled round-robin with the distinct ready photos on the sheet; a
   * hand-picked photo duplicates itself across the whole grid instead
   * (unless ignoreSelection — used by preset changes & intake re-tiles).
   */
  const arrangePhotoCopies = useCallback(
    (
      count: number,
      options?: {
        dims?: { wMm: number; hMm: number };
        auto?: boolean;
        ignoreSelection?: boolean;
        /** Explicit margin override — used when margin changes and re-tile
         * happens in the same tick (borderless toggle), where the settings
         * ref is still stale. */
        marginMm?: number;
      },
    ) => {
      const list = photoPlacementsRef.current;
      if (list.length === 0) return;
      const ps = photoSettingsRef.current;
      const { wMm: paperW, hMm: paperH } = paperDimsRef.current;
      const preset = getPhotoPreset(ps.presetId);
      const presetW = preset.group === "custom" ? ps.customWMm : preset.wMm;
      const presetH = preset.group === "custom" ? ps.customHMm : preset.hMm;
      const pw = Math.min(options?.dims ? options.dims.wMm : presetW, paperW);
      const ph = Math.min(options?.dims ? options.dims.hMm : presetH, paperH);
      const margin = options?.marginMm ?? ps.marginMm;
      const gap = ps.gapMm;
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
      const total = Math.min(n0, fit.cap, MAX_PLACEMENTS);

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

      // Slot sources: a hand-picked photo duplicates itself; otherwise the
      // distinct ready images already on the sheet fill slots round-robin.
      let sources: string[] = [];
      const sel = options?.ignoreSelection
        ? null
        : list.find((x) => x.id === photoSelectedIdRef.current);
      if (sel) {
        sources = [sel.itemId];
      } else {
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
      }
      if (sources.length === 0) sources = [list[0].itemId];

      const gy = (printH - (rows * h + (rows - 1) * gap)) / 2;
      const out: PhotoPlacement[] = [];
      for (let r = 0; r < rows; r++) {
        const inRow = Math.min(total - r * cols, cols);
        const rowW = inRow * w + (inRow - 1) * gap;
        const gx = (printW - rowW) / 2;
        for (let c = 0; c < inRow; c++) {
          const itemId = sources[(r * cols + c) % sources.length];
          const src = list.find((p) => p.itemId === itemId);
          out.push({
            id: newPhotoId(),
            itemId,
            xMm: margin + gx + c * (w + gap),
            yMm: margin + gy + r * (h + gap),
            wMm: w,
            hMm: h,
            rotation: 0,
            fit: src ? src.fit : "cover",
            cropX: src?.cropX ?? 0,
            cropY: src?.cropY ?? 0,
          });
        }
      }
      setPhotoPlacements(out);
      setPhotoSelectedId(null);
      layoutTouchedRef.current = false;
      if (sources.length > total) {
        toast.info(
          `${total} foto tersusun dari ${sources.length} foto yang diunggah`,
          {
            description: `Naikkan jumlah foto ke ${sources.length} agar semua foto ikut tersusun.`,
          },
        );
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
          description: `${useLandscape ? "Lanskap" : "Potret"} • ${cols} kolom × ${rows} baris • jarak ${gap} mm`,
        });
      }
    },
    [],
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
      if (layoutTouchedRef.current) return;
      if (photoPlacementsRef.current.length === 0) return;
      arrangePhotoCopies(photoSettingsRef.current.perSheet, {
        auto: true,
        ignoreSelection: true,
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
        ignoreSelection: true,
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
      // re-tile every copy to the new size at once.
      if (!layoutTouchedRef.current && photoPlacementsRef.current.length > 0) {
        arrangePhotoCopies(ps.perSheet, {
          dims: { wMm: w, hMm: h },
          ignoreSelection: true,
        });
        return;
      }
      const selId = photoSelectedIdRef.current;
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
    [arrangePhotoCopies],
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
    setPhotoSelectedId(null);
    toast.success(`Lembar terisi — ${cols} × ${rows} foto (${out.length} salinan).`);
  }, []);

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
    setPhotoPlacements(out.map((pl) => clampPlacement(pl, paperW, paperH)));
  }, []);

  /** Align the selected placement within the printable area (Word-like). */
  const alignPhotoPlacement = useCallback((dir: PhotoAlign) => {
    const list = photoPlacementsRef.current;
    const selId = photoSelectedIdRef.current;
    const p = list.find((x) => x.id === selId);
    if (!p) return;
    const ps = photoSettingsRef.current;
    const { wMm: paperW, hMm: paperH } = paperDimsRef.current;
    const bb = placementBBox(p);
    let cx = p.xMm + p.wMm / 2;
    let cy = p.yMm + p.hMm / 2;
    if (dir === "left") cx = ps.marginMm + bb.w / 2;
    if (dir === "centerX") cx = paperW / 2;
    if (dir === "right") cx = paperW - ps.marginMm - bb.w / 2;
    if (dir === "top") cy = ps.marginMm + bb.h / 2;
    if (dir === "centerY") cy = paperH / 2;
    if (dir === "bottom") cy = paperH - ps.marginMm - bb.h / 2;
    updatePhotoPlacement(p.id, {
      xMm: cx - p.wMm / 2,
      yMm: cy - p.hMm / 2,
    });
  }, [updatePhotoPlacement]);

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
    updatePhotoPlacement,
    removePhotoPlacement,
    duplicatePhotoPlacement,
    clearPhotoPlacements,
    fillPhotoSheet,
    arrangePhotoCopies,
    autoArrangePhotos,
    alignPhotoPlacement,
    addAllImagesToSheet,
    // document accessors for renderers
    getPdfDoc: loadPdfDoc,
    getDocxRender: renderDocx,
    getDocHtml: convertViaServer,
  };
}

export type PrintStationStore = ReturnType<typeof usePrintStation>;
