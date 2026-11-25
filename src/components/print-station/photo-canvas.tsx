"use client";

// Word-like photo sheet editor.
// Free drag + 8-handle resize on a true-to-scale paper canvas, with smart
// snapping to the printable margins, page center and sibling photo edges.
// Word-like multi-selection: Ctrl/Shift+click, marquee lasso on the empty
// sheet and a tap-to-add touch mode — dragging any selected photo moves the
// WHOLE selection as a group. Geometry is millimeter-based (k = px/mm scale)
// so the editor, the preview and the print rasterizer stay in agreement.

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Crop, ImagePlus, Maximize2, Repeat, RotateCw, Trash2 } from "lucide-react";
import { MIN_PHOTO_MM, type LoadedFile, type PhotoAdjustments, type PhotoPlacement } from "@/lib/print-station/types";
import { photoAdjustFilterCss } from "@/lib/print-station/engine";

type HandleDir = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLE_DIRS: HandleDir[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

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

interface PhotoCanvasProps {
  paperWmm: number;
  paperHmm: number;
  /** px per mm of the preview stage */
  k: number;
  placements: PhotoPlacement[];
  files: LoadedFile[];
  /** All selected placement ids — the last one is the primary (handles/badge). */
  selectedIds: string[];
  marginMm: number;
  lockAspect: boolean;
  cutLines: boolean;
  grayscale: boolean;
  /** Sheet-wide adjustments — must match the print raster exactly. */
  adjust?: PhotoAdjustments;
  /** Touch-friendly multi-select: tapping a photo adds it to the selection. */
  multiMode: boolean;
  onSelect: (id: string | null, additive?: boolean) => void;
  /** Replace the whole selection (marquee-lasso result). */
  onSelectIds: (ids: string[]) => void;
  onSelectAll: () => void;
  onUpdateMany: (
    updates: Array<{ id: string; patch: Partial<PhotoPlacement> }>,
  ) => void;
  onRemove: (ids: string[]) => void;
  onDuplicate: (ids: string[]) => void;
  /** "Ubah Foto" — swap the source image of this slot in place. */
  onChangePhoto: (placementId: string, file: File) => void;
  /** "Potong Foto" — open the crop dialog for this slot's source image. */
  onCropPhoto: (placementId: string) => void;
  /** "Penuhi" — enlarge this photo until it covers the entire sheet
   * (full-bleed: overflow is cropped exactly at the paper edge). */
  onCoverPhoto: (placementId: string) => void;
  /** Open one undo step for a whole drag / resize gesture. */
  onBeginHistory: () => void;
  onEndHistory: () => void;
}

type Gesture =
  | {
      kind: "move";
      ids: string[];
      grabId: string;
      px0: number;
      py0: number;
      origins: Map<string, { x: number; y: number }>;
      /** Set when the grab may still become a tap-to-toggle (touch mode). */
      tapToggleId: string | null;
      movedPx: number;
    }
  | {
      kind: "resize";
      id: string;
      dir: HandleDir;
      px0: number;
      py0: number;
      orig: PhotoPlacement;
    }
  | {
      kind: "marquee";
      rect: DOMRect;
      x0: number;
      y0: number;
      px0: number;
      py0: number;
      moved: boolean;
    };

/** Visual bounding box of a placement (accounts for 90-step rotation). */
function bboxOf(p: PhotoPlacement): { x: number; y: number; w: number; h: number } {
  const rot = ((Math.round(p.rotation / 90) * 90) % 360 + 360) % 360;
  const swapped = rot === 90 || rot === 270;
  const w = swapped ? p.hMm : p.wMm;
  const h = swapped ? p.wMm : p.hMm;
  const cx = p.xMm + p.wMm / 2;
  const cy = p.yMm + p.hMm / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Resize with center-based rotation: the opposite anchor stays fixed. */
function resizePlacement(
  orig: PhotoPlacement,
  dir: HandleDir,
  dxMm: number,
  dyMm: number,
  lockAspect: boolean,
): { xMm: number; yMm: number; wMm: number; hMm: number } {
  const theta = (orig.rotation * Math.PI) / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  // screen delta -> placement-local delta (rotate by -theta)
  const lx = c * dxMm + s * dyMm;
  const ly = -s * dxMm + c * dyMm;

  let dw = 0;
  let dh = 0;
  if (dir.includes("e")) dw = lx;
  if (dir.includes("w")) dw = -lx;
  if (dir.includes("s")) dh = ly;
  if (dir.includes("n")) dh = -ly;

  const ratio = orig.hMm / orig.wMm;
  if (lockAspect && dw !== 0 && dh !== 0) {
    if (Math.abs(dw) / orig.wMm > Math.abs(dh) / orig.hMm) dh = dw * ratio;
    else dw = dh / ratio;
  }
  let w2 = Math.max(MIN_PHOTO_MM, orig.wMm + dw);
  let h2 = Math.max(MIN_PHOTO_MM, orig.hMm + dh);
  if (lockAspect && dw !== 0 && dh !== 0) {
    if (Math.abs(dw) / orig.wMm >= Math.abs(dh) / orig.hMm) h2 = w2 * ratio;
    else w2 = h2 / ratio;
  }

  // anchor = opposite handle point in local (center-relative) coords
  const fx = dir.includes("w") ? orig.wMm / 2 : dir.includes("e") ? -orig.wMm / 2 : 0;
  const fy = dir.includes("n") ? orig.hMm / 2 : dir.includes("s") ? -orig.hMm / 2 : 0;
  const cx0 = orig.xMm + orig.wMm / 2;
  const cy0 = orig.yMm + orig.hMm / 2;
  const fpx = cx0 + (c * fx - s * fy);
  const fpy = cy0 + (s * fx + c * fy);
  const nfx = dir.includes("w") ? w2 / 2 : dir.includes("e") ? -w2 / 2 : 0;
  const nfy = dir.includes("n") ? h2 / 2 : dir.includes("s") ? -h2 / 2 : 0;
  const ncx = fpx - (c * nfx - s * nfy);
  const ncy = fpy - (s * nfx + c * nfy);
  return { xMm: ncx - w2 / 2, yMm: ncy - h2 / 2, wMm: w2, hMm: h2 };
}

function attachWindowListeners(
  onMove: (ev: PointerEvent) => void,
  onUp: (ev?: Event) => void,
): void {
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  window.addEventListener("blur", onUp);
}

function detachWindowListeners(
  onMove: (ev: PointerEvent) => void,
  onUp: (ev?: Event) => void,
): void {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onUp);
  window.removeEventListener("blur", onUp);
}

export function PhotoCanvas(props: PhotoCanvasProps) {
  const {
    paperWmm,
    paperHmm,
    k,
    placements,
    files,
    selectedIds,
    marginMm,
    lockAspect,
    cutLines,
    grayscale,
    adjust,
    multiMode,
    onSelect,
    onSelectIds,
    onSelectAll,
    onUpdateMany,
    onRemove,
    onDuplicate,
    onChangePhoto,
    onCropPhoto,
    onCoverPhoto,
    onBeginHistory,
    onEndHistory,
  } = props;

  const gestureRef = useRef<Gesture | null>(null);
  const placementsRef = useRef(placements);
  const kRef = useRef(k);
  const lockRef = useRef(lockAspect);
  const paperRef = useRef({ wMm: paperWmm, hMm: paperHmm });
  const selectedIdsRef = useRef(selectedIds);
  const multiModeRef = useRef(multiMode);
  // Sync latest props into refs after commit — gesture/keyboard handlers read
  // them at event time (never during render).
  useEffect(() => {
    placementsRef.current = placements;
    kRef.current = k;
    lockRef.current = lockAspect;
    paperRef.current = { wMm: paperWmm, hMm: paperHmm };
    selectedIdsRef.current = selectedIds;
    multiModeRef.current = multiMode;
  }, [placements, k, lockAspect, paperWmm, paperHmm, selectedIds, multiMode]);
  const [guides, setGuides] = useState<{ v: number | null; h: number | null }>({
    v: null,
    h: null,
  });
  const [marquee, setMarquee] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  const primaryId = selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null;

  const sheetW = Math.round(paperWmm * k);
  const sheetH = Math.round(paperHmm * k);

  // -- pointer gesture engine ------------------------------------------------
  const endGesture = useCallback(() => {
    gestureRef.current = null;
    setGuides({ v: null, h: null });
    setMarquee(null);
  }, []);

  /** Group move: every id in `ids` translates by the same mm delta. */
  const beginMoveGesture = useCallback(
    (
      ids: string[],
      grabId: string,
      e: React.PointerEvent,
      tapToggleId: string | null,
    ) => {
      e.stopPropagation();
      e.preventDefault();
      onBeginHistory();
      const origins = new Map<string, { x: number; y: number }>();
      for (const p of placementsRef.current) {
        if (ids.includes(p.id)) origins.set(p.id, { x: p.xMm, y: p.yMm });
      }
      gestureRef.current = {
        kind: "move",
        ids,
        grabId,
        px0: e.clientX,
        py0: e.clientY,
        origins,
        tapToggleId,
        movedPx: 0,
      };
      const onMove = (ev: PointerEvent) => {
        const cur = gestureRef.current;
        if (!cur || cur.kind !== "move") return;
        const dxPx = ev.clientX - cur.px0;
        const dyPx = ev.clientY - cur.py0;
        cur.movedPx = Math.max(cur.movedPx, Math.abs(dxPx), Math.abs(dyPx));
        const scale = kRef.current || 1;
        let dx = dxPx / scale;
        let dy = dyPx / scale;
        // smart snapping (Word-like guides) — anchored on the grabbed photo
        const { wMm: paperW, hMm: paperH } = paperRef.current;
        const tolerance = 6 / scale;
        const me = placementsRef.current.find((p) => p.id === cur.grabId);
        const grabOrigin = cur.origins.get(cur.grabId);
        if (me && grabOrigin) {
          const moved = { ...me, xMm: grabOrigin.x + dx, yMm: grabOrigin.y + dy };
          const bb = bboxOf(moved);
          const tx: number[] = [0, marginMm, paperW - marginMm, paperW / 2, paperW];
          const ty: number[] = [0, marginMm, paperH - marginMm, paperH / 2, paperH];
          for (const o of placementsRef.current) {
            if (cur.ids.includes(o.id)) continue;
            const ob = bboxOf(o);
            tx.push(ob.x, ob.x + ob.w, ob.x + ob.w / 2);
            ty.push(ob.y, ob.y + ob.h, ob.y + ob.h / 2);
          }
          let bestX: { d: number; t: number } | null = null;
          let bestY: { d: number; t: number } | null = null;
          for (const t of tx) {
            for (const e2 of [bb.x, bb.x + bb.w, bb.x + bb.w / 2]) {
              const d = t - e2;
              if (Math.abs(d) <= tolerance && (!bestX || Math.abs(d) < Math.abs(bestX.d))) {
                bestX = { d, t };
              }
            }
          }
          for (const t of ty) {
            for (const e2 of [bb.y, bb.y + bb.h, bb.y + bb.h / 2]) {
              const d = t - e2;
              if (Math.abs(d) <= tolerance && (!bestY || Math.abs(d) < Math.abs(bestY.d))) {
                bestY = { d, t };
              }
            }
          }
          if (bestX) dx += bestX.d;
          if (bestY) dy += bestY.d;
          setGuides({ v: bestX ? bestX.t : null, h: bestY ? bestY.t : null });
        }
        onUpdateMany(
          cur.ids
            .filter((id) => cur.origins.has(id))
            .map((id) => {
              const o = cur.origins.get(id)!;
              return { id, patch: { xMm: o.x + dx, yMm: o.y + dy } };
            }),
        );
      };
      const onUp = () => {
        detachWindowListeners(onMove, onUp);
        onEndHistory();
        const cur = gestureRef.current;
        if (
          cur &&
          cur.kind === "move" &&
          cur.tapToggleId &&
          cur.movedPx < 4
        ) {
          // touch "Pilih Banyak": a tap (no drag) toggles the photo in
          onSelect(cur.tapToggleId, true);
        }
        endGesture();
      };
      attachWindowListeners(onMove, onUp);
    },
    [onUpdateMany, onSelect, marginMm, endGesture, onBeginHistory, onEndHistory],
  );

  const beginMove = useCallback(
    (p: PhotoPlacement, e: React.PointerEvent) => {
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (additive) {
        // Ctrl/Shift+click toggles into the multi-selection (Word-like);
        // no drag so building a group never accidentally moves photos.
        e.stopPropagation();
        e.preventDefault();
        onSelect(p.id, true);
        return;
      }
      const sel = selectedIdsRef.current;
      if (multiModeRef.current) {
        if (sel.includes(p.id)) {
          beginMoveGesture([...sel], p.id, e, null);
        } else {
          // tap adds it to the selection, drag moves just this photo
          beginMoveGesture([p.id], p.id, e, p.id);
        }
        return;
      }
      if (sel.includes(p.id)) {
        // already in the (possibly multi) selection — drag moves the group
        beginMoveGesture([...sel], p.id, e, null);
      } else {
        onSelect(p.id);
        beginMoveGesture([p.id], p.id, e, null);
      }
    },
    [beginMoveGesture, onSelect],
  );

  const beginResize = useCallback(
    (p: PhotoPlacement, dir: HandleDir, e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      onBeginHistory();
      gestureRef.current = {
        kind: "resize",
        id: p.id,
        dir,
        px0: e.clientX,
        py0: e.clientY,
        orig: p,
      };
      const onMove = (ev: PointerEvent) => {
        const cur = gestureRef.current;
        if (!cur || cur.kind !== "resize") return;
        const scale = kRef.current || 1;
        const dx = (ev.clientX - cur.px0) / scale;
        const dy = (ev.clientY - cur.py0) / scale;
        const r = resizePlacement(cur.orig, cur.dir, dx, dy, lockRef.current);
        onUpdateMany([{ id: cur.id, patch: r }]);
      };
      const onUp = () => {
        detachWindowListeners(onMove, onUp);
        onEndHistory();
        endGesture();
      };
      attachWindowListeners(onMove, onUp);
    },
    [onUpdateMany, endGesture, onBeginHistory, onEndHistory],
  );

  // -- marquee lasso on the empty sheet --------------------------------------
  const onSheetPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const scale = kRef.current || 1;
      const x0 = (e.clientX - rect.left) / scale;
      const y0 = (e.clientY - rect.top) / scale;
      gestureRef.current = {
        kind: "marquee",
        rect,
        x0,
        y0,
        px0: e.clientX,
        py0: e.clientY,
        moved: false,
      };
      const onMove = (ev: PointerEvent) => {
        const cur = gestureRef.current;
        if (!cur || cur.kind !== "marquee") return;
        if (
          Math.abs(ev.clientX - cur.px0) > 4 ||
          Math.abs(ev.clientY - cur.py0) > 4
        ) {
          cur.moved = true;
        }
        const x = (ev.clientX - cur.rect.left) / scale;
        const y = (ev.clientY - cur.rect.top) / scale;
        setMarquee({
          x: Math.min(x, cur.x0),
          y: Math.min(y, cur.y0),
          w: Math.abs(x - cur.x0),
          h: Math.abs(y - cur.y0),
        });
      };
      const onUp = (ev?: Event) => {
        detachWindowListeners(onMove, onUp);
        const cur = gestureRef.current;
        if (cur && cur.kind === "marquee" && cur.moved && ev) {
          const pe = ev as PointerEvent;
          const x1 = (pe.clientX - cur.rect.left) / scale;
          const y1 = (pe.clientY - cur.rect.top) / scale;
          const rx = Math.min(x1, cur.x0);
          const ry = Math.min(y1, cur.y0);
          const rw = Math.abs(x1 - cur.x0);
          const rh = Math.abs(y1 - cur.y0);
          const ids = placementsRef.current
            .filter((p) => {
              const bb = bboxOf(p);
              return (
                bb.x < rx + rw &&
                bb.x + bb.w > rx &&
                bb.y < ry + rh &&
                bb.y + bb.h > ry
              );
            })
            .map((p) => p.id);
          onSelectIds(ids);
        } else if (cur && cur.kind === "marquee" && !cur.moved) {
          // plain click on the empty sheet — clear the selection
          onSelect(null);
        }
        endGesture();
      };
      attachWindowListeners(onMove, onUp);
    },
    [onSelectIds, onSelect, endGesture],
  );

  // -- keyboard: group nudge / delete / duplicate / select-all ---------------
  useEffect(() => {
    if (placements.length === 0) return;
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
      const sel = selectedIdsRef.current;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        onSelectAll();
        return;
      }
      if (sel.length === 0) return;
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        onUpdateMany(
          placementsRef.current
            .filter((p) => sel.includes(p.id))
            .map((p) => ({ id: p.id, patch: { xMm: p.xMm + dx, yMm: p.yMm + dy } })),
        );
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        onRemove(sel);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        onDuplicate(sel);
      } else if (e.key === "Escape") {
        onSelect(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [placements.length, onSelectAll, onUpdateMany, onRemove, onDuplicate, onSelect]);

  const urlFor = (itemId: string) =>
    files.find((f) => f.id === itemId && f.kind === "image")?.url ?? null;

  // Same filter string the print rasterizer feeds to ctx.filter — the preview
  // and the paper are pixel-identical by construction.
  const adjustCss = photoAdjustFilterCss(adjust);
  const imgFilter =
    adjustCss !== "none" || grayscale
      ? `${adjustCss === "none" ? "" : adjustCss}${grayscale ? " grayscale(1)" : ""}`.trim()
      : undefined;

  return (
    <div
      data-testid="photo-sheet"
      className="relative shrink-0 cursor-default bg-white touch-none select-none"
      style={{ width: sheetW, height: sheetH }}
      onPointerDown={onSheetPointerDown}
      role="application"
      aria-label={`Lembar foto ${paperWmm}×${paperHmm} mm — ${placements.length} foto`}
    >
      {/* printable-area guide (Epson minimum margin) */}
      <div
        className="pointer-events-none absolute border border-dashed border-[#D8DCE2]"
        style={{
          left: marginMm * k,
          top: marginMm * k,
          width: Math.max(0, (paperWmm - 2 * marginMm) * k),
          height: Math.max(0, (paperHmm - 2 * marginMm) * k),
        }}
        title={`Area cetak — margin ${marginMm} mm`}
        aria-hidden="true"
      />

      {/* empty sheet hint */}
      {placements.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
          <ImagePlus size={22} strokeWidth={1.5} className="text-[#9CA3AF]" />
          <p className="max-w-[220px] text-[12.5px] leading-relaxed text-[#6B7280]">
            Unggah foto PNG/JPG untuk mulai menyusun lembar cetak
          </p>
          <p className="font-mono text-[10px] text-[#9CA3AF]">
            ukuran foto diatur pada panel kanan
          </p>
        </div>
      ) : null}

      {/* placements */}
      {placements.map((p, i) => {
        const url = urlFor(p.itemId);
        const selected = selectedIds.includes(p.id);
        const isPrimary = p.id === primaryId;
        // Floating-toolbar / badge placement: prefer outside the frame, fall
        // back inside for edge-to-edge photos (the sheet host clips overflow,
        // so a toolbar hanging off the paper would be invisible).
        const topPx = p.yMm * k;
        const bottomPx = (p.yMm + p.hMm) * k;
        const toolAbove = topPx >= 40;
        const toolBelow = !toolAbove && sheetH - bottomPx >= 40;
        const badgeBelow = sheetH - bottomPx >= 24;
        const badgeAbove = !badgeBelow && topPx >= 24;
        // Intentional full-bleed: skip the dashed cut guide — it would sit
        // exactly on the paper border (and print as dots there).
        const fullBleed =
          p.wMm >= paperWmm - 0.1 && p.hMm >= paperHmm - 0.1;
        return (
          <div
            key={p.id}
            data-photo-id={p.id}
            data-testid={`photo-${i + 1}`}
            onPointerDown={(e) => beginMove(p, e)}
            className={`absolute cursor-move ${
              selected
                ? isPrimary
                  ? "outline outline-1 outline-[#003399]"
                  : "outline outline-1 outline-dashed outline-[#003399]/60"
                : "outline outline-1 outline-transparent hover:outline-[#B6BCC6]"
            }`}
            style={{
              left: p.xMm * k,
              top: p.yMm * k,
              width: p.wMm * k,
              height: p.hMm * k,
              transform: `rotate(${p.rotation}deg)`,
              // Selected photos (and their floating toolbar / handles) paint
              // above sibling placements — DOM order alone would bury the
              // toolbar under later-row photos.
              zIndex: selected ? (isPrimary ? 30 : 20) : undefined,
            }}
            role="button"
            tabIndex={0}
            aria-label={`Foto ${i + 1} — ${Math.round(p.wMm)} × ${Math.round(p.hMm)} mm`}
          >
            {url ? (
              <img
                src={url}
                alt=""
                draggable={false}
                style={{
                  objectFit: p.fit === "cover" ? "cover" : "contain",
                  objectPosition: `${50 + (p.cropX ?? 0)}% ${50 + (p.cropY ?? 0)}%`,
                  filter: imgFilter,
                }}
              />
            ) : (
              <div className="h-full w-full bg-[#F3F4F6]" />
            )}

            {/* cut guide (matches dashed cut lines in the print raster) */}
            {cutLines && !fullBleed ? (
              <div
                className="pointer-events-none absolute inset-0 z-[5] border border-dashed border-[#AEB4BC]"
                aria-hidden="true"
              />
            ) : null}

            {/* Quick-action toolbar (single primary selection) — "Ubah Foto"
                swaps the source image in place; rotate / duplicate / delete
                mirror the inspector so the common fixes live on the photo. */}
            {isPrimary && selectedIds.length === 1 ? (
              <div
                data-testid="photo-toolbar"
                className="absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-md border border-[#E5E7EB] bg-white p-0.5 shadow-[0_2px_8px_rgba(17,24,39,0.16)]"
                style={
                  toolAbove
                    ? { bottom: "100%", marginBottom: 6 }
                    : toolBelow
                      ? { top: "100%", marginTop: 6 }
                      : { top: 8 }
                }
                onPointerDown={(e) => e.stopPropagation()}
              >
                <label
                  className="flex h-7 cursor-pointer items-center gap-1 whitespace-nowrap rounded px-2 text-[11px] font-semibold text-[#003399] transition-colors hover:bg-[#003399]/5"
                  title="Ganti foto di slot ini dengan file lain — posisi & ukuran tetap"
                >
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    className="sr-only"
                    aria-label={`Ubah foto ${i + 1}`}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onChangePhoto(p.id, f);
                      e.target.value = "";
                    }}
                  />
                  <Repeat size={11} strokeWidth={2} aria-hidden="true" />
                  Ubah Foto
                </label>
                <button
                  type="button"
                  title="Potong foto — buang bagian yang tidak perlu (mis. status bar screenshot)"
                  aria-label={`Potong foto ${i + 1}`}
                  onClick={() => onCropPhoto(p.id)}
                  className="flex h-7 items-center gap-1 whitespace-nowrap rounded px-2 text-[11px] font-semibold text-[#003399] transition-colors hover:bg-[#003399]/5"
                >
                  <Crop size={11} strokeWidth={2} aria-hidden="true" />
                  Potong
                </button>
                <button
                  type="button"
                  title="Perbesar sampai penuhi lembar — tanpa sisa kertas kosong (full bleed)"
                  aria-label={`Penuhi lembar dengan foto ${i + 1}`}
                  onClick={() => onCoverPhoto(p.id)}
                  className="flex h-7 items-center gap-1 whitespace-nowrap rounded px-2 text-[11px] font-semibold text-[#003399] transition-colors hover:bg-[#003399]/5"
                >
                  <Maximize2 size={11} strokeWidth={2} aria-hidden="true" />
                  Penuhi
                </button>
                <span className="mx-0.5 h-4 w-px bg-[#E5E7EB]" aria-hidden="true" />
                <button
                  type="button"
                  title="Putar 90° searah jarum jam"
                  aria-label={`Putar foto ${i + 1}`}
                  onClick={() =>
                    onUpdateMany([
                      { id: p.id, patch: { rotation: p.rotation + 90 } },
                    ])
                  }
                  className="flex h-7 w-7 items-center justify-center rounded text-[#374151] transition-colors hover:bg-[#F3F4F6]"
                >
                  <RotateCw size={12} strokeWidth={1.5} />
                </button>
                <button
                  type="button"
                  title="Duplikat foto ini"
                  aria-label={`Duplikat foto ${i + 1}`}
                  onClick={() => onDuplicate([p.id])}
                  className="flex h-7 w-7 items-center justify-center rounded text-[#374151] transition-colors hover:bg-[#F3F4F6]"
                >
                  <Copy size={12} strokeWidth={1.5} />
                </button>
                <button
                  type="button"
                  title="Hapus foto ini dari lembar"
                  aria-label={`Hapus foto ${i + 1}`}
                  onClick={() => onRemove([p.id])}
                  className="flex h-7 w-7 items-center justify-center rounded text-[#9CA3AF] transition-colors hover:bg-[#FEF2F2] hover:text-[#DC2626]"
                >
                  <Trash2 size={12} strokeWidth={1.5} />
                </button>
              </div>
            ) : null}

            {/* Word-like resize handles (primary photo only) */}
            {isPrimary
              ? HANDLE_DIRS.map((dir) => {
                  const isCorner = dir.length === 2;
                  const hx = dir.includes("w") ? 0 : dir.includes("e") ? 100 : 50;
                  const hy = dir.includes("n") ? 0 : dir.includes("s") ? 100 : 50;
                  const size = isCorner
                    ? { width: 12, height: 12 }
                    : dir === "n" || dir === "s"
                      ? { width: 20, height: 8 }
                      : { width: 8, height: 20 };
                  return (
                    <div
                      key={dir}
                      data-handle={dir}
                      onPointerDown={(e) => beginResize(p, dir, e)}
                      className="absolute z-10 rounded-[1px] border border-[#003399] bg-white after:absolute after:-inset-1.5 after:content-['']"
                      style={{
                        left: `${hx}%`,
                        top: `${hy}%`,
                        width: size.width,
                        height: size.height,
                        transform: "translate(-50%, -50%)",
                        cursor: HANDLE_CURSOR[dir],
                      }}
                      aria-label={`Ubah ukuran ${dir}`}
                    />
                  );
                })
              : null}

            {/* live dimension badge (primary photo only) */}
            {isPrimary ? (
              <div
                className={`pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded border border-[#E5E7EB] bg-white px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[#374151] shadow-[0_1px_2px_rgba(17,24,39,0.06)] ${
                  badgeBelow
                    ? "top-full mt-1"
                    : badgeAbove
                      ? "bottom-full mb-1"
                      : "bottom-1"
                }`}
              >
                {selectedIds.length > 1
                  ? `${selectedIds.length} foto • geser bersama`
                  : `${Math.round(p.wMm * 10) / 10} × ${Math.round(p.hMm * 10) / 10} mm`}
              </div>
            ) : null}
          </div>
        );
      })}

      {/* marquee lasso rectangle */}
      {marquee ? (
        <div
          className="pointer-events-none absolute z-20 border border-dashed border-[#003399]/70 bg-[#003399]/5"
          style={{
            left: marquee.x * k,
            top: marquee.y * k,
            width: marquee.w * k,
            height: marquee.h * k,
          }}
          aria-hidden="true"
        />
      ) : null}

      {/* smart snap guides */}
      {guides.v !== null ? (
        <div
          className="pointer-events-none absolute inset-y-0 z-20 w-px bg-[#003399]/55"
          style={{ left: guides.v * k }}
          aria-hidden="true"
        />
      ) : null}
      {guides.h !== null ? (
        <div
          className="pointer-events-none absolute inset-x-0 z-20 h-px bg-[#003399]/55"
          style={{ top: guides.h * k }}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
