"use client";

// Word-like photo sheet editor.
// Free drag + 8-handle resize on a true-to-scale paper canvas, with smart
// snapping to the printable margins, page center and sibling photo edges.
// Geometry is millimeter-based (k = px/mm scale) so the editor, the preview
// and the print rasterizer stay in perfect agreement.

import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { MIN_PHOTO_MM, type LoadedFile, type PhotoPlacement } from "@/lib/print-station/types";

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
  selectedId: string | null;
  marginMm: number;
  lockAspect: boolean;
  cutLines: boolean;
  grayscale: boolean;
  onSelect: (id: string | null) => void;
  onUpdate: (id: string, patch: Partial<PhotoPlacement>) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
}

type Gesture =
  | { kind: "move"; id: string; px0: number; py0: number; x0: number; y0: number }
  | { kind: "resize"; id: string; dir: HandleDir; px0: number; py0: number; orig: PhotoPlacement };

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

export function PhotoCanvas(props: PhotoCanvasProps) {
  const {
    paperWmm,
    paperHmm,
    k,
    placements,
    files,
    selectedId,
    marginMm,
    lockAspect,
    cutLines,
    grayscale,
    onSelect,
    onUpdate,
    onRemove,
    onDuplicate,
  } = props;

  const gestureRef = useRef<Gesture | null>(null);
  const placementsRef = useRef(placements);
  const kRef = useRef(k);
  const lockRef = useRef(lockAspect);
  const paperRef = useRef({ wMm: paperWmm, hMm: paperHmm });
  const selectedRef = useRef(selectedId);
  // Sync latest props into refs after commit — gesture/keyboard handlers read
  // them at event time (never during render).
  useEffect(() => {
    placementsRef.current = placements;
    kRef.current = k;
    lockRef.current = lockAspect;
    paperRef.current = { wMm: paperWmm, hMm: paperHmm };
    selectedRef.current = selectedId;
  }, [placements, k, lockAspect, paperWmm, paperHmm, selectedId]);
  const [guides, setGuides] = useState<{ v: number | null; h: number | null }>({
    v: null,
    h: null,
  });

  const sheetW = Math.round(paperWmm * k);
  const sheetH = Math.round(paperHmm * k);

  // -- pointer gesture engine ------------------------------------------------
  const endGesture = useCallback(() => {
    gestureRef.current = null;
    setGuides({ v: null, h: null });
  }, []);

  const beginGesture = useCallback(
    (g: Gesture, e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      onSelect(g.id);
      gestureRef.current = g;
      const onMove = (ev: PointerEvent) => {
        const cur = gestureRef.current;
        if (!cur) return;
        const scale = kRef.current || 1;
        const dx = (ev.clientX - cur.px0) / scale;
        const dy = (ev.clientY - cur.py0) / scale;
        if (cur.kind === "move") {
          let x = cur.x0 + dx;
          let y = cur.y0 + dy;
          // smart snapping (Word-like guides)
          const { wMm: paperW, hMm: paperH } = paperRef.current;
          const tolerance = 6 / scale;
          const me = placementsRef.current.find((p) => p.id === cur.id);
          if (me) {
            const moved = { ...me, xMm: x, yMm: y };
            const bb = bboxOf(moved);
            const tx: number[] = [0, marginMm, paperW - marginMm, paperW / 2, paperW];
            const ty: number[] = [0, marginMm, paperH - marginMm, paperH / 2, paperH];
            for (const o of placementsRef.current) {
              if (o.id === cur.id) continue;
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
            if (bestX) x += bestX.d;
            if (bestY) y += bestY.d;
            setGuides({ v: bestX ? bestX.t : null, h: bestY ? bestY.t : null });
          }
          onUpdate(cur.id, { xMm: x, yMm: y });
        } else {
          const r = resizePlacement(cur.orig, cur.dir, dx, dy, lockRef.current);
          onUpdate(cur.id, r);
        }
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("blur", onUp);
        endGesture();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("blur", onUp);
    },
    [onSelect, onUpdate, marginMm, endGesture],
  );

  const beginMove = useCallback(
    (p: PhotoPlacement, e: React.PointerEvent) => {
      beginGesture(
        { kind: "move", id: p.id, px0: e.clientX, py0: e.clientY, x0: p.xMm, y0: p.yMm },
        e,
      );
    },
    [beginGesture],
  );

  const beginResize = useCallback(
    (p: PhotoPlacement, dir: HandleDir, e: React.PointerEvent) => {
      beginGesture(
        { kind: "resize", id: p.id, dir, px0: e.clientX, py0: e.clientY, orig: p },
        e,
      );
    },
    [beginGesture],
  );

  // -- keyboard nudge / delete / duplicate (Word-like) ------------------------
  useEffect(() => {
    if (!selectedId) return;
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
      const id = selectedRef.current;
      if (!id) return;
      const sel = placementsRef.current.find((p) => p.id === id);
      if (!sel) return;
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onUpdate(id, { xMm: sel.xMm - step });
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onUpdate(id, { xMm: sel.xMm + step });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        onUpdate(id, { yMm: sel.yMm - step });
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        onUpdate(id, { yMm: sel.yMm + step });
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        onRemove(id);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        onDuplicate(id);
      } else if (e.key === "Escape") {
        onSelect(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, onUpdate, onRemove, onDuplicate, onSelect]);

  const urlFor = (itemId: string) =>
    files.find((f) => f.id === itemId && f.kind === "image")?.url ?? null;

  return (
    <div
      data-testid="photo-sheet"
      className="relative shrink-0 bg-white touch-none select-none"
      style={{ width: sheetW, height: sheetH }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onSelect(null);
      }}
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
        const selected = p.id === selectedId;
        return (
          <div
            key={p.id}
            data-photo-id={p.id}
            data-testid={`photo-${i + 1}`}
            onPointerDown={(e) => beginMove(p, e)}
            className={`absolute cursor-move ${
              selected
                ? "outline outline-1 outline-[#003399]"
                : "outline outline-1 outline-transparent hover:outline-[#B6BCC6]"
            }`}
            style={{
              left: p.xMm * k,
              top: p.yMm * k,
              width: p.wMm * k,
              height: p.hMm * k,
              transform: `rotate(${p.rotation}deg)`,
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
                className={`h-full w-full ${grayscale ? "grayscale" : ""}`}
                style={{ objectFit: p.fit === "cover" ? "cover" : "contain" }}
              />
            ) : (
              <div className="h-full w-full bg-[#F3F4F6]" />
            )}

            {/* cut guide (matches dashed cut lines in the print raster) */}
            {cutLines ? (
              <div
                className="pointer-events-none absolute inset-0 z-[5] border border-dashed border-[#AEB4BC]"
                aria-hidden="true"
              />
            ) : null}

            {/* Word-like resize handles */}
            {selected
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

            {/* live dimension badge */}
            {selected ? (
              <div className="pointer-events-none absolute left-1/2 top-full z-10 mt-1 -translate-x-1/2 whitespace-nowrap rounded border border-[#E5E7EB] bg-white px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[#374151] shadow-[0_1px_2px_rgba(17,24,39,0.06)]">
                {Math.round(p.wMm * 10) / 10} × {Math.round(p.hMm * 10) / 10} mm
              </div>
            ) : null}
          </div>
        );
      })}

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
