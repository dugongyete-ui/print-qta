"use client";

// Live true-to-paper preview stage.
// Renders the active document inside a proportionally accurate paper sheet
// over the #F4F5F7 drafting mat, with grayscale simulation, orientation
// handling, margin guides, page navigation and zoom controls.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  ChevronLeft,
  ChevronRight,
  FileWarning,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  Ruler,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { MM_TO_PX96 } from "@/lib/paper";
import type {
  DocxRender,
  LoadedFile,
  PhotoAdjustments,
  PhotoPlacement,
  ZoomMode,
} from "@/lib/print-station/types";
import { FileQueue, UploadDropzone } from "./upload-queue";
import { PhotoCanvas } from "./photo-canvas";

const MARGIN_GUIDE_MM = 5; // typical Epson minimum printable margin

interface PhotoStageData {
  placements: PhotoPlacement[];
  /** All selected ids — last one is the primary. */
  selectedIds: string[];
  marginMm: number;
  lockAspect: boolean;
  cutLines: boolean;
  presetShort: string;
  grayscale: boolean;
  adjust: PhotoAdjustments;
  onSelect: (id: string | null, additive?: boolean) => void;
  onSelectIds: (ids: string[]) => void;
  onSelectAll: () => void;
  onUpdateMany: (
    updates: Array<{ id: string; patch: Partial<PhotoPlacement> }>,
  ) => void;
  onRemove: (ids: string[]) => void;
  onDuplicate: (ids: string[]) => void;
  /** "Ubah Foto" — swap one slot's source image in place. */
  onChangePhoto: (placementId: string, file: File) => void;
  /** "Potong Foto" — open the crop dialog for the slot's source image. */
  onCropPhoto: (placementId: string) => void;
}

interface PreviewStageProps {
  file: LoadedFile | null;
  files: LoadedFile[];
  activeQueueId: string | null;
  paperWmm: number;
  paperHmm: number;
  scale: number;
  grayscale: boolean;
  showMargins: boolean;
  zoom: ZoomMode;
  page: number;
  pageCount: number | null;
  continuous: boolean;
  mismatch: boolean;
  overflow: boolean;
  scaleMode: "fit" | "original";
  paperShortLabel: string;
  photo: PhotoStageData | null;
  onFiles: (files: File[]) => void;
  /** "Tambah Foto" picker intake — image-only, batch-friendly. */
  onAddPhotoFiles: (files: File[]) => void;
  onSamples: () => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onPageChange: (p: number) => void;
  onZoomChange: (z: ZoomMode) => void;
  onToggleMargins: () => void;
  onEstimatePages: (fileId: string, pages: number) => void;
  getPdfDoc: (f: LoadedFile) => Promise<PDFDocumentProxy>;
  getDocxRender: (f: LoadedFile) => Promise<DocxRender>;
  getDocHtml: (f: LoadedFile) => Promise<string>;
  duplexAssist: { evenPages: number[] } | null;
  onPrintEven: () => void;
  onCancelDuplex: () => void;
}

function AutoFitBadge({
  mismatch,
  overflow,
  docLabel,
  paperLabel,
  scaleMode,
}: {
  mismatch: boolean;
  overflow: boolean;
  docLabel: string;
  paperLabel: string;
  scaleMode: "fit" | "original";
}) {
  const warn = mismatch || overflow;
  const text =
    overflow && !mismatch
      ? `Asli: ${docLabel} — melebihi ${paperLabel}`
      : mismatch && scaleMode === "fit"
        ? `Asli: ${docLabel} → Penyesuaian Otomatis: ${paperLabel}`
        : mismatch
          ? `Asli: ${docLabel} — tidak sesuai tray ${paperLabel}`
          : `Asli: ${docLabel} — Sesuai Tray`;
  return (
    <div
      className={`flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 font-mono text-[10.5px] tabular-nums ${
        warn
          ? "border-[#FDE68A] bg-[#FFFBEB] text-[#92400E]"
          : "border-[#E5E7EB] bg-white text-[#6B7280]"
      }`}
      role="status"
    >
      {warn ? <TriangleAlert size={11} strokeWidth={1.5} /> : null}
      {text}
    </div>
  );
}

export function PreviewStage(props: PreviewStageProps) {
  const {
    file,
    paperWmm,
    paperHmm,
    scale,
    grayscale,
    showMargins,
    zoom,
    page,
    pageCount,
    continuous,
    mismatch,
    overflow,
    scaleMode,
    onFiles,
    onSamples,
    onSelect,
    onRemove,
    onPageChange,
    onZoomChange,
    onToggleMargins,
    onEstimatePages,
    getPdfDoc,
    getDocxRender,
    getDocHtml,
    duplexAssist,
    onPrintEven,
    onCancelDuplex,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const docxHostRef = useRef<HTMLDivElement>(null);
  const flowHostRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  const [docxRender, setDocxRender] = useState<DocxRender | null>(null);
  /** Touch-friendly multi-select mode: tap photos one by one to add. */
  const [photoMulti, setPhotoMulti] = useState(false);

  // -- stage calibration: px per mm ------------------------------------------
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const k = useMemo(() => {
    if (zoom === "100") return MM_TO_PX96;
    if (box.w < 40 || box.h < 40) return 0;
    const fit = Math.min((box.w - 72) / paperWmm, (box.h - 88) / paperHmm);
    return Math.max(0.4, Math.min(fit, 7));
  }, [zoom, box, paperWmm, paperHmm]);

  const sheetW = Math.round(paperWmm * k);
  const sheetH = Math.round(paperHmm * k);

  // -- content geometry -------------------------------------------------------
  const docWmm = file?.docWidthMm ?? paperWmm;
  const docHmm = file?.docHeightMm ?? paperHmm;
  const contentW = Math.round(docWmm * scale * k);
  const contentH = Math.round(docHmm * scale * k);
  const flowWidth = Math.round((paperWmm - 36) * k);
  const flowPadX = Math.round(18 * k);
  const flowPadY = Math.round(20 * k);
  const flowPageH = Math.round((paperHmm - 40) * k);

  // -- PDF rendering ----------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    if (!file || file.kind !== "pdf" || file.status !== "ready" || k <= 0) return;
    const render = async () => {
      try {
        // Serialize renders on the shared canvas: abort any in-flight paint first.
        renderTaskRef.current?.cancel();
        renderTaskRef.current = null;
        const doc = await getPdfDoc(file);
        if (cancelled) return;
        const docPage = await doc.getPage(Math.min(page, doc.numPages));
        if (cancelled) return;
        const base = docPage.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const targetW = Math.max(40, contentW * dpr);
        const capped = Math.min(targetW, 3200);
        const viewport = docPage.getViewport({ scale: capped / base.width });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        canvas.style.width = `${contentW}px`;
        canvas.style.height = `${contentH}px`;
        const task = docPage.render({ canvas, viewport });
        renderTaskRef.current = task;
        await task.promise;
        if (renderTaskRef.current === task) renderTaskRef.current = null;
        docPage.cleanup();
      } catch {
        /* aborted (superseded) or decode issue — preview keeps last frame */
      }
    };
    void render();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [file, file?.id, file?.status, page, contentW, contentH, k, getPdfDoc]);

  // -- DOCX section rendering -------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    if (!file || file.kind !== "docx" || file.status !== "ready" || !file.docWidthMm) return;
    if (docxHostRef.current && !continuous) docxHostRef.current.innerHTML = "";
    const render = async () => {
      try {
        const r = await getDocxRender(file);
        if (cancelled) return;
        setDocxRender(r);
        const host = docxHostRef.current;
        if (!host || continuous) return;
        const idx = Math.min(Math.max(page - 1, 0), r.sectionsHtml.length - 1);
        host.innerHTML = r.sectionsHtml[idx] ?? "";
      } catch {
        /* handled via file.status */
      }
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [file, file?.id, file?.status, page, continuous, getDocxRender]);

  // -- Flow HTML (mammoth / .doc conversion) -----------------------------------
  useEffect(() => {
    let cancelled = false;
    if (!file || !(file.kind === "docx" || file.kind === "doc") || file.status !== "ready") return;
    if (!file.continuous) return;
    const render = async () => {
      try {
        const html = await getDocHtml(file);
        if (cancelled) return;
        const host = flowHostRef.current;
        if (!host) return;
        host.innerHTML = html;
        // estimate page count from rendered height
        requestAnimationFrame(() => {
          if (cancelled || !host) return;
          const contentH2 = host.scrollHeight - flowPadY * 2;
          const pages = Math.max(1, Math.ceil(contentH2 / Math.max(1, flowPageH)));
          onEstimatePages(file.id, pages);
        });
      } catch {
        /* handled by file.status */
      }
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [file, file?.id, file?.status, flowPadY, flowPageH, getDocHtml, onEstimatePages]);

  const hasDocxFrame =
    !!file && file.kind === "docx" && file.status === "ready" && !file.continuous;
  const docxScale =
    hasDocxFrame && docxRender && docxRender.pageWpx > 0 && contentW > 0
      ? contentW / docxRender.pageWpx
      : 0;

  const dragHandlers = useMemo(
    () => ({
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        setDragging(true);
      },
      onDragLeave: (e: React.DragEvent) => {
        e.preventDefault();
        setDragging(false);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        setDragging(false);
        const list = Array.from(e.dataTransfer.files ?? []);
        if (list.length > 0) onFiles(list);
      },
    }),
    [onFiles],
  );

  const navDisabled = !file || file.status !== "ready" || !pageCount || pageCount < 2;

  const photo = props.photo;
  const photoMode = photo !== null;
  // Tap-to-add only applies while the photo editor is mounted.
  const multiActive = photoMode && photoMulti;

  const zoomControl = (
    <div className="flex items-center rounded-[5px] bg-[#F3F4F6] p-0.5">
      <button
        type="button"
        aria-pressed={zoom === "fit"}
        onClick={() => onZoomChange("fit")}
        className={`h-6 rounded-[4px] px-2 text-[11px] font-medium transition-colors ${
          zoom === "fit" ? "bg-white text-[#111827] shadow-sm" : "text-[#6B7280] hover:text-[#111827]"
        }`}
      >
        Fit
      </button>
      <button
        type="button"
        aria-pressed={zoom === "100"}
        onClick={() => onZoomChange("100")}
        className={`h-6 rounded-[4px] px-2 font-mono text-[11px] font-medium tabular-nums transition-colors ${
          zoom === "100" ? "bg-white text-[#111827] shadow-sm" : "text-[#6B7280] hover:text-[#111827]"
        }`}
      >
        100%
      </button>
    </div>
  );

  const setSafePage = useCallback(
    (p: number) => {
      const total = pageCount ?? 1;
      onPageChange(Math.min(Math.max(1, p), Math.max(1, total)));
    },
    [pageCount, onPageChange],
  );

  return (
    <section
      className="relative flex min-w-0 flex-1 flex-col bg-[#F4F5F7]"
      aria-label="Pratinjau Cetak"
      {...dragHandlers}
    >
      <FileQueue files={props.files ?? []} activeId={props.activeQueueId ?? null} onSelect={onSelect} onRemove={onRemove} />

      {/* Source-size meta row (badge lives here, never overlaps the queue) */}
      {photoMode && photo ? (
        <div className="flex min-h-9 shrink-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 py-1">
          <div
            className="flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-[#E5E7EB] bg-white px-3 font-mono text-[10.5px] tabular-nums text-[#6B7280]"
            role="status"
          >
            <ImageIcon size={11} strokeWidth={1.5} aria-hidden="true" />
            Mode Foto • {photo.placements.length} foto • {photo.presetShort} • margin {photo.marginMm} mm
          </div>
          {/* Always-visible picker: add more customers' face photos — the
              grid re-tiles automatically so every distinct photo keeps a slot. */}
          <label
            className="flex h-7 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border border-[#E5E7EB] bg-white px-2 text-[10.5px] font-semibold text-[#003399] transition-colors hover:bg-[#003399]/5"
            title="Tambah foto orang lain — semua foto otomatis dijajarkan dalam satu lembar"
          >
            <input
              type="file"
              multiple
              accept="image/png,image/jpeg"
              className="sr-only"
              aria-label="Tambah foto ke lembar"
              onChange={(e) => {
                const list = Array.from(e.target.files ?? []);
                if (list.length > 0) props.onAddPhotoFiles(list);
                e.target.value = "";
              }}
            />
            <ImagePlus size={11} strokeWidth={1.5} aria-hidden="true" />
            Tambah Foto
          </label>
          {photo.placements.length > 0 ? (
            <div className="flex h-8 items-center gap-0.5 rounded-md border border-[#E5E7EB] bg-white p-0.5 shadow-[0_1px_2px_rgba(17,24,39,0.05)]">
              {photo.selectedIds.length > 0 ? (
                <span
                  className="whitespace-nowrap px-1.5 font-mono text-[10px] font-medium tabular-nums text-[#003399]"
                  aria-live="polite"
                >
                  {photo.selectedIds.length} dipilih
                </span>
              ) : null}
              <button
                type="button"
                onClick={photo.onSelectAll}
                disabled={photo.selectedIds.length === photo.placements.length}
                title="Pilih semua foto — geser sekali untuk memindah semuanya"
                className="h-7 whitespace-nowrap rounded px-2 text-[10.5px] font-medium text-[#374151] transition-colors hover:bg-[#F3F4F6] disabled:opacity-30 disabled:hover:bg-transparent"
              >
                Pilih Semua
              </button>
              <button
                type="button"
                onClick={() => photo.onSelect(null)}
                disabled={photo.selectedIds.length === 0}
                title="Kosongkan pilihan"
                className="h-7 whitespace-nowrap rounded px-2 text-[10.5px] font-medium text-[#374151] transition-colors hover:bg-[#F3F4F6] disabled:opacity-30 disabled:hover:bg-transparent"
              >
                Kosongkan
              </button>
              <button
                type="button"
                aria-pressed={photoMulti}
                onClick={() => setPhotoMulti((v) => !v)}
                title="Mode pilih banyak (layar sentuh): ketuk foto satu per satu untuk menambah ke pilihan"
                className={`h-7 whitespace-nowrap rounded px-2 text-[10.5px] font-semibold transition-colors ${
                  photoMulti
                    ? "bg-[#003399] text-white"
                    : "text-[#003399] hover:bg-[#003399]/5"
                }`}
              >
                Pilih Banyak
              </button>
            </div>
          ) : null}
        </div>
      ) : file && file.status === "ready" ? (
        <div className="flex h-9 shrink-0 items-center justify-center px-4">
          <AutoFitBadge
            mismatch={mismatch}
            overflow={overflow}
            docLabel={file.docLabel ?? "—"}
            paperLabel={props.paperShortLabel}
            scaleMode={scaleMode}
          />
        </div>
      ) : null}

      <div ref={scrollRef} className="ps-scroll relative min-h-0 flex-1 overflow-auto">
        {/* ---- PHOTO MODE: Word-like sheet editor ---- */}
        {photoMode && photo ? (
          props.files.length === 0 ? (
            <UploadDropzone onFiles={onFiles} onSamples={onSamples} dragging={dragging} />
          ) : (
            <div className="flex min-h-full w-max min-w-full items-center justify-center p-9 pb-32 lg:pb-16">
              <div
                className="relative shrink-0 overflow-hidden rounded-[2px] border border-[#E5E7EB] bg-white shadow-[0_1px_2px_rgba(17,24,39,0.06)]"
                style={{ width: sheetW, height: sheetH }}
              >
                <PhotoCanvas
                  paperWmm={paperWmm}
                  paperHmm={paperHmm}
                  k={k}
                  placements={photo.placements}
                  files={props.files}
                  selectedIds={photo.selectedIds}
                  marginMm={photo.marginMm}
                  lockAspect={photo.lockAspect}
                  cutLines={photo.cutLines}
                  grayscale={photo.grayscale}
                  adjust={photo.adjust}
                  multiMode={multiActive}
                  onSelect={photo.onSelect}
                  onSelectIds={photo.onSelectIds}
                  onSelectAll={photo.onSelectAll}
                  onUpdateMany={photo.onUpdateMany}
                  onRemove={photo.onRemove}
                  onDuplicate={photo.onDuplicate}
                  onChangePhoto={photo.onChangePhoto}
                  onCropPhoto={photo.onCropPhoto}
                />
              </div>
            </div>
          )
        ) : !file ? (
          <UploadDropzone onFiles={onFiles} onSamples={onSamples} dragging={dragging} />
        ) : (
          <div className="flex min-h-full w-max min-w-full items-center justify-center p-9 pb-32 lg:pb-16">
            {file.status === "error" ? (
              <div className="flex w-full max-w-[440px] flex-col items-center rounded-lg border border-[#E5E7EB] bg-white px-8 py-10 text-center">
                <FileWarning size={24} strokeWidth={1.5} className="text-[#6B7280]" />
                <p className="mt-3 text-[14px] font-semibold text-[#111827]">
                  Dokumen tidak dapat dibuka
                </p>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#6B7280]">
                  {file.error ?? "Format tidak didukung atau file rusak."}
                </p>
                <p className="mt-3 max-w-full truncate rounded border border-[#E5E7EB] bg-[#F9FAFB] px-2 py-1 font-mono text-[10.5px] text-[#6B7280]">
                  {file.name}
                </p>
                <button
                  type="button"
                  onClick={() => onRemove(file.id)}
                  className="mt-5 inline-flex h-8 items-center gap-1.5 rounded-md border border-[#E5E7EB] bg-white px-3 text-[12px] font-medium text-[#374151] hover:bg-[#F9FAFB]"
                >
                  <Trash2 size={13} strokeWidth={1.5} />
                  Hapus dari Daftar
                </button>
              </div>
            ) : file.status === "loading" ? (
              <div className="flex flex-col items-center gap-3 py-16">
                <Loader2 size={22} strokeWidth={1.5} className="animate-spin text-[#6B7280]" />
                <p className="font-mono text-[11px] text-[#6B7280]">
                  Menganalisis dokumen — {file.name}
                </p>
              </div>
            ) : (
              /* ---- paper sheet ---- */
              <div
                className="relative shrink-0 overflow-hidden rounded-[2px] border border-[#E5E7EB] bg-white shadow-[0_1px_2px_rgba(17,24,39,0.06)]"
                style={{ width: sheetW, height: sheetH }}
                role="img"
                aria-label={`Pratinjau halaman ${page} pada kertas ${paperWmm}×${paperHmm} mm`}
              >
                {/* PDF page */}
                {file.kind === "pdf" ? (
                  <div
                    className="absolute flex items-center justify-center"
                    style={{
                      left: (sheetW - contentW) / 2,
                      top: (sheetH - contentH) / 2,
                      width: contentW,
                      height: contentH,
                      overflow: "hidden",
                    }}
                  >
                    <canvas
                      ref={canvasRef}
                      className={grayscale ? "grayscale" : undefined}
                    />
                  </div>
                ) : null}

                {/* Image */}
                {file.kind === "image" && file.url ? (
                  <div
                    className="absolute flex items-center justify-center"
                    style={{
                      left: (sheetW - contentW) / 2,
                      top: (sheetH - contentH) / 2,
                      width: contentW,
                      height: contentH,
                      overflow: "hidden",
                    }}
                  >
                    <img
                      src={file.url}
                      alt={`Pratinjau ${file.name}`}
                      style={{ width: contentW, height: contentH }}
                      className={grayscale ? "grayscale" : undefined}
                      draggable={false}
                    />
                  </div>
                ) : null}

                {/* DOCX (docx-preview sections) */}
                {hasDocxFrame ? (
                  <div
                    className="absolute overflow-hidden"
                    style={{
                      left: (sheetW - contentW) / 2,
                      top: (sheetH - contentH) / 2,
                      width: contentW,
                      height: contentH,
                    }}
                  >
                    <div
                      ref={docxHostRef}
                      className={grayscale ? "grayscale" : undefined}
                      style={{
                        width: "auto",
                        transformOrigin: "top left",
                        transform: docxScale > 0 ? `scale(${docxScale})` : undefined,
                      }}
                    />
                  </div>
                ) : null}

                {/* Continuous flow HTML */}
                {file.continuous && file.status === "ready" ? (
                  <div
                    className="ps-scroll absolute inset-0 overflow-y-auto"
                    style={{ width: sheetW }}
                  >
                    <div
                      ref={flowHostRef}
                      className={`doc-flow ${grayscale ? "grayscale" : undefined}`}
                      style={{
                        width: flowWidth,
                        paddingLeft: flowPadX,
                        paddingRight: flowPadX,
                        paddingTop: flowPadY,
                        paddingBottom: flowPadY,
                        minHeight: sheetH,
                      }}
                    />
                  </div>
                ) : null}

                {/* Margin guides */}
                {showMargins ? (
                  <div
                    className="pointer-events-none absolute rounded-[1px] border border-dashed border-[#D1D5DB]"
                    style={{
                      left: MARGIN_GUIDE_MM * k,
                      top: MARGIN_GUIDE_MM * k,
                      right: MARGIN_GUIDE_MM * k,
                      bottom: MARGIN_GUIDE_MM * k,
                    }}
                    aria-hidden="true"
                  />
                ) : null}
              </div>
            )}
          </div>
        )}

        {/* Drag overlay when a document is already loaded */}
        {dragging && file ? (
          <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-[#003399] bg-white/60">
            <span className="rounded-md border border-[#003399] bg-white px-3 py-1.5 text-[12px] font-medium text-[#003399]">
              Lepaskan untuk mengunggah
            </span>
          </div>
        ) : null}
      </div>

      {/* Floating stage controls */}
      {photoMode ? (
        <div className="absolute bottom-[84px] left-1/2 z-10 flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-md border border-[#E5E7EB] bg-white px-1.5 shadow-[0_1px_2px_rgba(17,24,39,0.05)] lg:bottom-4">
          {zoomControl}
          <span className="mr-1 whitespace-nowrap px-1 font-mono text-[10px] tabular-nums text-[#9CA3AF]">
            {props.paperShortLabel} • {Math.round(paperWmm)}×{Math.round(paperHmm)} mm
          </span>
        </div>
      ) : file && file.status !== "error" ? (
        <div className="absolute bottom-[84px] left-1/2 z-10 flex h-9 -translate-x-1/2 items-center gap-0.5 rounded-md border border-[#E5E7EB] bg-white px-1.5 shadow-[0_1px_2px_rgba(17,24,39,0.05)] lg:bottom-4">
          <button
            type="button"
            aria-label="Halaman sebelumnya"
            disabled={navDisabled || page <= 1}
            onClick={() => setSafePage(page - 1)}
            className="flex h-7 w-7 items-center justify-center rounded text-[#374151] transition-colors hover:bg-[#F3F4F6] disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronLeft size={14} strokeWidth={1.5} />
          </button>
          <span className="min-w-[64px] whitespace-nowrap text-center font-mono text-[11px] tabular-nums text-[#111827]">
            <span className="hidden sm:inline">Halaman </span>
            {page} / {pageCount ?? 1}
          </span>
          <button
            type="button"
            aria-label="Halaman berikutnya"
            disabled={navDisabled || page >= (pageCount ?? 1)}
            onClick={() => setSafePage(page + 1)}
            className="flex h-7 w-7 items-center justify-center rounded text-[#374151] transition-colors hover:bg-[#F3F4F6] disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronRight size={14} strokeWidth={1.5} />
          </button>

          <span className="mx-1 h-5 w-px bg-[#E5E7EB]" aria-hidden="true" />

          {zoomControl}

          <span className="mx-1 h-5 w-px bg-[#E5E7EB]" aria-hidden="true" />

          <button
            type="button"
            aria-label="Tampilkan panduan margin"
            aria-pressed={showMargins}
            title="Panduan margin (5 mm)"
            onClick={onToggleMargins}
            className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
              showMargins
                ? "bg-[#003399]/10 text-[#003399]"
                : "text-[#374151] hover:bg-[#F3F4F6]"
            }`}
          >
            <Ruler size={14} strokeWidth={1.5} />
          </button>
        </div>
      ) : null}

      {/* Manual duplex assist overlay */}
      {duplexAssist ? (
        <div className="absolute inset-0 z-20 grid place-items-center bg-[#F4F5F7]/85">
          <div className="w-[400px] max-w-[90vw] rounded-lg border border-[#E5E7EB] bg-white p-6">
            <p className="text-[14px] font-semibold text-[#111827]">Cetak Sisi Genap</p>
            <p className="mt-2 text-[12.5px] leading-relaxed text-[#6B7280]">
              Sisi ganjil telah dikirim ke dialog cetak. Ambil tumpukan hasil, balik
              kertasnya, susun ulang urutannya, lalu masukkan kembali ke tray Epson
              untuk mencetak sisi genap.
            </p>
            <p className="mt-3 rounded border border-[#E5E7EB] bg-[#F9FAFB] px-2.5 py-1.5 font-mono text-[11px] tabular-nums text-[#374151]">
              Halaman genap (terbalik): {duplexAssist.evenPages.join(", ")}
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onCancelDuplex}
                className="h-9 rounded-md border border-[#E5E7EB] bg-white px-3.5 text-[12.5px] font-medium text-[#374151] hover:bg-[#F9FAFB]"
              >
                Batalkan
              </button>
              <button
                type="button"
                onClick={onPrintEven}
                className="h-9 rounded-md bg-[#003399] px-4 text-[12.5px] font-semibold text-white hover:bg-[#002673]"
              >
                Cetak Sisi Genap
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
