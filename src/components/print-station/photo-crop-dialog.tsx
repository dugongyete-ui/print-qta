"use client";

// "Potong Foto" — interactive crop dialog.
// Typical print-shop use: the customer hands over a screenshot and only the
// face / ID region matters. The operator drags a rectangle (or grabs a handle)
// to trim status bars, buttons and other junk away before printing.
//
// The crop is rasterized from the ORIGINAL image pixels at natural resolution
// and returned as a PNG file; the workspace commits it via cropPhotoItem so
// every placement that references the source photo updates — the preview and
// the print rasterizer stay in sync automatically.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crop, Loader2, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import type { LoadedFile, PhotoPlacement } from "@/lib/print-station/types";

/** Crop rectangle in normalized [0..1] image coordinates. */
interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type HandleDir = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type AspectMode = "sheet" | "free" | "1:1" | "4:3" | "3:4";

const HANDLE_DIRS: HandleDir[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const CORNER_DIRS: HandleDir[] = ["nw", "ne", "sw", "se"];

const HANDLE_CURSOR: Record<HandleDir, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

/** Minimum crop size as a fraction of each image axis. */
const MIN = 0.04;
/** Cap the output canvas at ~16 MP (≈400 DPI on A4) to keep rasterization safe. */
const MAX_OUT_PX = 16_000_000;

const ASPECT_CHIPS: Array<{ id: AspectMode; label: string }> = [
  { id: "sheet", label: "Ukuran Cetak" },
  { id: "free", label: "Bebas" },
  { id: "1:1", label: "1:1" },
  { id: "4:3", label: "4:3" },
  { id: "3:4", label: "3:4" },
];

type Drag =
  | { kind: "draw"; ax: number; ay: number; prev: CropRect }
  | { kind: "move"; px0: number; py0: number; start: CropRect }
  | { kind: "resize"; dir: HandleDir; start: CropRect }
  | { kind: "resizeA"; anchor: { x: number; y: number } };

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

function freeRectBetween(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): CropRect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  };
}

/**
 * Rect from a fixed anchor corner toward the pointer, keeping `aspect`
 * (w/h in real pixels). Clamped inside the image; `min` is enforced where
 * the image bounds still allow it.
 */
function aspectRectFromAnchor(
  anchor: { x: number; y: number },
  p: { x: number; y: number },
  aspect: number,
  min: number,
): CropRect {
  const sx = p.x >= anchor.x ? 1 : -1;
  const sy = p.y >= anchor.y ? 1 : -1;
  let w = Math.abs(p.x - anchor.x);
  let h = Math.abs(p.y - anchor.y);
  if (w / aspect <= h) h = w / aspect;
  else w = h * aspect;
  const maxW = sx > 0 ? 1 - anchor.x : anchor.x;
  const maxH = sy > 0 ? 1 - anchor.y : anchor.y;
  const scale = Math.min(1, maxW / Math.max(w, 1e-6), maxH / Math.max(h, 1e-6));
  w = Math.min(Math.max(w * scale, Math.min(min, maxW)), maxW);
  h = Math.min(Math.max(h * scale, Math.min(min, maxH)), maxH);
  return {
    x: sx > 0 ? anchor.x : anchor.x - w,
    y: sy > 0 ? anchor.y : anchor.y - h,
    w,
    h,
  };
}

function applyResizeFree(
  start: CropRect,
  dir: string,
  p: { x: number; y: number },
): CropRect {
  let { x, y, w, h } = start;
  const x1 = x + w;
  const y1 = y + h;
  if (dir.includes("w")) {
    x = clamp(p.x, 0, x1 - MIN);
    w = x1 - x;
  }
  if (dir.includes("e")) w = clamp(p.x, x + MIN, 1) - x;
  if (dir.includes("n")) {
    y = clamp(p.y, 0, y1 - MIN);
    h = y1 - y;
  }
  if (dir.includes("s")) h = clamp(p.y, y + MIN, 1) - y;
  return { x, y, w, h };
}

/** Largest rect with `aspect` centered inside `outer` (normalized coords). */
function fitInsideRect(
  outer: CropRect,
  aspect: number | null,
  nat: { w: number; h: number },
): CropRect {
  if (aspect == null || nat.w <= 0 || nat.h <= 0) return outer;
  // Target w/h ratio expressed in normalized (display) units.
  const r = (aspect * nat.h) / nat.w;
  const outerR = outer.w / Math.max(outer.h, 1e-6);
  let w: number;
  let h: number;
  if (r <= outerR) {
    h = outer.h;
    w = h * r;
  } else {
    w = outer.w;
    h = w / r;
  }
  return {
    x: outer.x + (outer.w - w) / 2,
    y: outer.y + (outer.h - h) / 2,
    w,
    h,
  };
}

/** Fixed anchor corner opposite a resize handle. */
function anchorOf(r: CropRect, dir: string): { x: number; y: number } {
  return {
    x: dir.includes("w") ? r.x + r.w : r.x,
    y: dir.includes("n") ? r.y + r.h : r.y,
  };
}

interface PhotoCropDialogProps {
  /** Placement being cropped — provides the slot aspect + source item. */
  placement: PhotoPlacement | null;
  /** Source image file of that placement (must be ready with a URL). */
  file: LoadedFile | null;
  /** Commit the cropped PNG against the source item id. */
  onApply: (itemId: string, cropped: File) => void;
  onClose: () => void;
}

export function PhotoCropDialog({
  placement,
  file,
  onApply,
  onClose,
}: PhotoCropDialogProps) {
  const [aspectMode, setAspectMode] = useState<AspectMode>("sheet");
  const [rect, setRect] = useState<CropRect>({ x: 0, y: 0, w: 1, h: 1 });
  const [nat, setNat] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  const [applying, setApplying] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<Drag | null>(null);

  const open = !!placement && !!file && file.status === "ready" && !!file.url;

  // Slot aspect, rotation-aware (a 90°-rotated slot displays h × w).
  const aspectRatio = useMemo<number | null>(() => {
    switch (aspectMode) {
      case "free":
        return null;
      case "1:1":
        return 1;
      case "4:3":
        return 4 / 3;
      case "3:4":
        return 3 / 4;
      case "sheet": {
        if (!placement) return null;
        const rot =
          ((Math.round(placement.rotation / 90) * 90) % 360 + 360) % 360;
        const swapped = rot === 90 || rot === 270;
        const w = swapped ? placement.hMm : placement.wMm;
        const h = swapped ? placement.wMm : placement.hMm;
        return h > 0 ? w / h : null;
      }
    }
  }, [aspectMode, placement]);

  /**
   * The locked aspect expressed in normalized (on-screen) units. The chips
   * describe real-pixel ratios (w/h as printed); the drag math works in
   * normalized coords, so the ratio must be converted by the image shape
   * (norm = aspect × natH / natW) or every drawn rect drifts off-ratio.
   */
  const normRatio = useMemo<number | null>(() => {
    if (aspectRatio == null || nat.w <= 0 || nat.h <= 0) return null;
    return (aspectRatio * nat.h) / nat.w;
  }, [aspectRatio, nat.h, nat.w]);

  // Fresh dialog state for each photo.
  useEffect(() => {
    setRect({ x: 0, y: 0, w: 1, h: 1 });
    setNat({ w: 0, h: 0 });
    setAspectMode("sheet");
  }, [placement?.id, file?.id]);

  // Aspect change (and image load) re-fit the rect: a fresh full-image rect
  // becomes the largest centered rect of the new aspect; a partial rect is
  // re-fit inside its own bounds so the operator keeps their context.
  useEffect(() => {
    setRect((cur) => {
      if (nat.w <= 0 || nat.h <= 0 || cur.w <= 0 || cur.h <= 0) return cur;
      if (cur.w >= 0.999 && cur.h >= 0.999) {
        return fitInsideRect({ x: 0, y: 0, w: 1, h: 1 }, aspectRatio, nat);
      }
      return fitInsideRect(cur, aspectRatio, nat);
    });
  }, [aspectRatio, nat.w, nat.h]);

  // Global pointer tracking while a crop gesture runs.
  useEffect(() => {
    if (!dragging) return;
    const point = (e: PointerEvent): { x: number; y: number } => {
      const el = stageRef.current;
      if (!el) return { x: 0, y: 0 };
      const r = el.getBoundingClientRect();
      return {
        x: clamp01((e.clientX - r.left) / Math.max(r.width, 1)),
        y: clamp01((e.clientY - r.top) / Math.max(r.height, 1)),
      };
    };
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const p = point(e);
      if (d.kind === "move") {
        const r = stageRef.current?.getBoundingClientRect();
        const dx = r && r.width > 0 ? (e.clientX - d.px0) / r.width : 0;
        const dy = r && r.height > 0 ? (e.clientY - d.py0) / r.height : 0;
        setRect({
          x: clamp(d.start.x + dx, 0, 1 - d.start.w),
          y: clamp(d.start.y + dy, 0, 1 - d.start.h),
          w: d.start.w,
          h: d.start.h,
        });
      } else if (d.kind === "resize") {
        setRect(applyResizeFree(d.start, d.dir, p));
      } else if (d.kind === "resizeA") {
        setRect(
          aspectRectFromAnchor(d.anchor, p, normRatio ?? 1, MIN),
        );
      } else {
        setRect(
          normRatio == null
            ? freeRectBetween(d.ax, d.ay, p.x, p.y)
            : aspectRectFromAnchor(
                { x: d.ax, y: d.ay },
                p,
                normRatio,
                0,
              ),
        );
      }
    };
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      if (d?.kind === "draw") {
        setRect((cur) => (cur.w < MIN || cur.h < MIN ? d.prev : cur));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [dragging, normRatio]);

  // Esc closes; Enter applies.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && !applying && rect.w >= MIN && rect.h >= MIN) {
        void applyCrop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, applying, rect]);

  const startDraw = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = clamp01((e.clientX - r.left) / Math.max(r.width, 1));
    const py = clamp01((e.clientY - r.top) / Math.max(r.height, 1));
    e.preventDefault();
    dragRef.current = { kind: "draw", ax: px, ay: py, prev: rect };
    setDragging(true);
  };

  const startMove = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { kind: "move", px0: e.clientX, py0: e.clientY, start: rect };
    setDragging(true);
  };

  const startResize = (dir: HandleDir) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current =
      normRatio != null
        ? { kind: "resizeA", anchor: anchorOf(rect, dir) }
        : { kind: "resize", dir, start: rect };
    setDragging(true);
  };

  const resetRect = () => {
    setRect(fitInsideRect({ x: 0, y: 0, w: 1, h: 1 }, aspectRatio, nat));
  };

  const applyCrop = useCallback(async () => {
    const img = imgRef.current;
    if (!img || !placement || !file || applying) return;
    if (rect.w < MIN || rect.h < MIN) return;
    setApplying(true);
    try {
      const sx = rect.x * img.naturalWidth;
      const sy = rect.y * img.naturalHeight;
      const sw = Math.max(1, Math.round(rect.w * img.naturalWidth));
      const sh = Math.max(1, Math.round(rect.h * img.naturalHeight));
      const scale = Math.min(1, Math.sqrt(MAX_OUT_PX / (sw * sh)));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sw * scale));
      canvas.height = Math.max(1, Math.round(sh * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!blob) throw new Error("blob");
      const base = file.name.replace(/\.[^.]+$/, "") || "foto";
      const out = new File([blob], `${base}-potong.png`, { type: "image/png" });
      onApply(placement.itemId, out);
      onClose();
    } catch {
      toast.error("Gagal membuat potongan foto.", {
        description: "Coba sesuaikan area potongan lalu terapkan lagi.",
      });
    } finally {
      setApplying(false);
    }
  }, [applying, file, onClose, onApply, placement, rect.h, rect.w, rect.x, rect.y]);

  if (!open || !placement || !file || !file.url) return null;

  const handleDirs = normRatio != null ? CORNER_DIRS : HANDLE_DIRS;
  const outW = Math.max(1, Math.round(rect.w * nat.w));
  const outH = Math.max(1, Math.round(rect.h * nat.h));
  const rectStyle = {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.w * 100}%`,
    height: `${rect.h * 100}%`,
  } as const;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#111827]/70 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Potong foto"
    >
      <div className="flex max-h-full w-full max-w-[880px] flex-col overflow-hidden rounded-lg border border-[#E5E7EB] bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[#E5E7EB] px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[14px] font-semibold text-[#111827]">
              <Crop size={15} strokeWidth={1.75} className="text-[#003399]" aria-hidden="true" />
              Potong Foto
            </p>
            <p className="mt-0.5 truncate text-[11.5px] leading-snug text-[#6B7280]">
              Tarik area untuk membuang bagian yang tidak perlu — mis. status bar
              &amp; tombol screenshot. Semua salinan foto ini di lembar ikut
              terpotong.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup potong foto"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[#6B7280] transition-colors hover:bg-[#F3F4F6] hover:text-[#111827]"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        {/* Stage */}
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[#111827] px-3 py-4 sm:px-6">
          <div
            ref={stageRef}
            data-crop-stage=""
            onPointerDown={startDraw}
            className="relative select-none touch-none"
          >
            <img
              ref={imgRef}
              src={file.url}
              alt="Foto sumber untuk dipotong"
              draggable={false}
              onLoad={() => {
                const img = imgRef.current;
                if (img) setNat({ w: img.naturalWidth, h: img.naturalHeight });
              }}
              className="block max-h-[42vh] max-w-full object-contain sm:max-h-[54vh]"
            />

            {/* Dark mask around the crop rect (four strips, no clipping tricks) */}
            <div className="pointer-events-none absolute inset-0" aria-hidden="true">
              <div className="absolute bg-black/60" style={{ left: 0, right: 0, top: 0, height: `${rect.y * 100}%` }} />
              <div className="absolute bg-black/60" style={{ left: 0, right: 0, bottom: 0, height: `${(1 - rect.y - rect.h) * 100}%` }} />
              <div className="absolute bg-black/60" style={{ top: `${rect.y * 100}%`, height: `${rect.h * 100}%`, left: 0, width: `${rect.x * 100}%` }} />
              <div className="absolute bg-black/60" style={{ top: `${rect.y * 100}%`, height: `${rect.h * 100}%`, right: 0, width: `${(1 - rect.x - rect.w) * 100}%` }} />
            </div>

            {/* Crop rect: move + rule-of-thirds + handles */}
            <div
              className="absolute cursor-move border border-white/90"
              style={rectStyle}
              onPointerDown={startMove}
              data-crop-rect=""
            >
              <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                <div className="absolute left-1/3 top-0 h-full w-px bg-white/35" />
                <div className="absolute left-2/3 top-0 h-full w-px bg-white/35" />
                <div className="absolute left-0 top-1/3 h-px w-full bg-white/35" />
                <div className="absolute left-0 top-2/3 h-px w-full bg-white/35" />
              </div>
              {handleDirs.map((dir) => {
                const hx = dir.includes("w") ? 0 : dir.includes("e") ? 100 : 50;
                const hy = dir.includes("n") ? 0 : dir.includes("s") ? 100 : 50;
                return (
                  <div
                    key={dir}
                    data-handle={dir}
                    onPointerDown={startResize(dir)}
                    className="absolute z-10 h-3.5 w-3.5 rounded-[2px] border border-[#003399] bg-white after:absolute after:-inset-2 after:content-['']"
                    style={{
                      left: `${hx}%`,
                      top: `${hy}%`,
                      transform: "translate(-50%, -50%)",
                      cursor: HANDLE_CURSOR[dir],
                    }}
                    aria-label={`Geser potongan ${dir}`}
                    role="button"
                    tabIndex={-1}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* Controls + footer */}
        <div className="flex flex-col gap-2.5 border-t border-[#E5E7EB] px-4 py-3 sm:px-5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Rasio potongan">
              {ASPECT_CHIPS.map((c) => {
                const active = aspectMode === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setAspectMode(c.id)}
                    className={`h-7 rounded-md border px-2 text-[11px] font-semibold transition-colors ${
                      active
                        ? "border-[#003399] bg-[#003399] text-white"
                        : "border-[#E5E7EB] bg-white text-[#374151] hover:bg-[#F9FAFB]"
                    }`}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
            <span
              className="whitespace-nowrap font-mono text-[10.5px] tabular-nums text-[#6B7280]"
              role="status"
              aria-label="Ukuran hasil potongan dalam piksel"
            >
              Hasil ≈ {outW} × {outH} px
            </span>
            {aspectMode === "free" ? (
              <span className="text-[10.5px] leading-snug text-[#9CA3AF]">
                Rasio Bebas — bagian di luar rasio lembar dipotong ulang otomatis saat cetak.
              </span>
            ) : null}
          </div>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={resetRect}
              disabled={dragging || applying}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#E5E7EB] bg-white px-3 text-[12px] font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB] disabled:opacity-40"
            >
              <RotateCcw size={12} strokeWidth={1.5} aria-hidden="true" />
              Atur Ulang
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={applying}
                className="h-9 rounded-md border border-[#E5E7EB] bg-white px-3.5 text-[12.5px] font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB] disabled:opacity-40"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => void applyCrop()}
                disabled={applying || dragging}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[#003399] px-4 text-[12.5px] font-semibold text-white transition-colors hover:bg-[#002673] disabled:opacity-50"
              >
                {applying ? (
                  <Loader2 size={13} strokeWidth={2} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Crop size={13} strokeWidth={2} aria-hidden="true" />
                )}
                {applying ? "Memproses…" : "Terapkan Potong"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
