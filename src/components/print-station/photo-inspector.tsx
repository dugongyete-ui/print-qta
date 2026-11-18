"use client";

import { useState } from "react";

// Photo-mode inspector: full photo size presets, Word-like position/size
// numeric controls, sheet tools (fill / arrange / align / cut lines) and the
// per-photo list of everything placed on the sheet.

import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Copy,
  Eraser,
  ImagePlus,
  LayoutGrid,
  Minus,
  Plus,
  Rows3,
  Trash2,
  Wand2,
} from "lucide-react";
import { formatBytes } from "@/lib/paper";
import type { PhotoAlign } from "@/hooks/use-print-station";
import {
  PHOTO_GROUP_LABEL,
  PHOTO_PRESETS,
  PRESET_CHIPS,
  presetDimsLabel,
  type PhotoPreset,
  type PhotoPresetGroup,
} from "@/lib/print-station/photo-sizes";
import type {
  LoadedFile,
  PhotoPlacement,
  PhotoSettings,
} from "@/lib/print-station/types";
import { Segmented } from "./segmented";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

function Section({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`border-b border-[#E5E7EB] px-4 py-4 ${className}`}>
      <h2 className="mb-3 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#6B7280]">
        {title}
      </h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[28px] items-center justify-between gap-3">
      <span className="text-[12.5px] text-[#111827]">{label}</span>
      {children}
    </div>
  );
}

function NumField({
  label,
  value,
  onCommit,
  min,
  max,
  disabled,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  disabled?: boolean;
}) {
  const fmt = (v: number) => String(Math.round(v * 10) / 10);
  const commit = (raw: string) => {
    const parsed = Number(raw.replace(",", "."));
    if (!Number.isFinite(parsed)) return;
    onCommit(Math.min(Math.max(parsed, min), max));
  };
  // Uncontrolled input keyed by the external value: dragging / resizing on the
  // canvas remounts it with fresh numbers, while local typing stays untouched.
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="font-mono text-[9.5px] uppercase tracking-[0.06em] text-[#6B7280]">
        {label}
      </span>
      <input
        key={`${label}-${fmt(value)}`}
        type="number"
        inputMode="decimal"
        step="0.5"
        defaultValue={fmt(value)}
        disabled={disabled}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        aria-label={label}
        className="h-8 w-full rounded-md border border-[#E5E7EB] bg-white px-2 font-mono text-[11.5px] tabular-nums text-[#111827] outline-none transition-colors focus:border-[#003399] disabled:opacity-40"
      />
    </label>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  children,
  active,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-8 items-center justify-center rounded-md border transition-colors disabled:opacity-30 disabled:hover:bg-transparent ${
        active
          ? "border-[#003399] bg-[#003399]/10 text-[#003399]"
          : "border-[#E5E7EB] bg-white text-[#374151] hover:bg-[#F9FAFB]"
      }`}
    >
      {children}
    </button>
  );
}

interface PhotoInspectorProps {
  placements: PhotoPlacement[];
  selected: PhotoPlacement | null;
  files: LoadedFile[];
  settings: PhotoSettings;
  preset: PhotoPreset;
  paperWmm: number;
  paperHmm: number;
  beyondMargin: boolean;
  /** Max copies of the current preset that fit on one sheet. */
  capacity: number;
  onSetting: (patch: Partial<PhotoSettings>) => void;
  onPreset: (id: string, customDims?: { wMm: number; hMm: number }) => void;
  onUpdateSelected: (patch: Partial<PhotoPlacement>) => void;
  onAlign: (dir: PhotoAlign) => void;
  onFillSheet: () => void;
  /** Arrange exactly N preset-sized copies in a grid. */
  onArrangeCount: (n: number) => void;
  onArrange: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onSelect: (id: string | null) => void;
  onClear: () => void;
  onAddImages: () => void;
}

const PRESET_GROUP_ORDER: PhotoPresetGroup[] = ["pas", "r", "square", "custom"];

const COUNT_QUICK: number[] = [2, 4, 6, 8, 12];

export function PhotoInspector({
  placements,
  selected,
  files,
  settings,
  preset,
  paperWmm,
  paperHmm,
  beyondMargin,
  capacity,
  onSetting,
  onPreset,
  onUpdateSelected,
  onAlign,
  onFillSheet,
  onArrangeCount,
  onArrange,
  onDuplicate,
  onRemove,
  onSelect,
  onClear,
  onAddImages,
}: PhotoInspectorProps) {
  // Requested copy count for "Susun N Foto" — clamped to what actually fits.
  const capSafe = Math.max(1, Math.min(capacity, 200));
  const [count, setCount] = useState(6);
  const n = Math.max(1, Math.min(count, capSafe));
  const placedIds = new Set(placements.map((p) => p.itemId));
  const unplacedImages = files.filter(
    (f) => f.kind === "image" && f.status === "ready" && !!f.url && !placedIds.has(f.id),
  );

  const scopeLabel = selected ? "menerapkan ke foto terpilih" : "menerapkan ke semua foto";

  return (
    <>
      {/* Ukuran Foto */}
      <Section title="Ukuran Foto">
        <Select
          value={preset.id}
          onValueChange={(v) => onPreset(v)}
        >
          <SelectTrigger
            aria-label="Ukuran cetak foto"
            className="h-8 w-full rounded-md border-[#E5E7EB] font-mono text-[11.5px] text-[#111827] shadow-none focus:ring-1 focus:ring-[#003399]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-md border-[#E5E7EB]">
            {PRESET_GROUP_ORDER.map((g) => (
              <SelectGroup key={g}>
                <SelectLabel className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-[#9CA3AF]">
                  {PHOTO_GROUP_LABEL[g]}
                </SelectLabel>
                {PHOTO_PRESETS.filter((p) => p.group === g).map((p) => (
                  <SelectItem
                    key={p.id}
                    value={p.id}
                    className="font-mono text-[11.5px] tabular-nums"
                  >
                    {p.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Preset ukuran cepat">
          {PRESET_CHIPS.map((c) => {
            const active = preset.id === c.id;
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={active}
                onClick={() => onPreset(c.id)}
                className={`h-7 rounded-md border px-2 font-mono text-[11px] font-medium tabular-nums transition-colors ${
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
        <p className="font-mono text-[10px] tabular-nums text-[#6B7280]">
          {presetDimsLabel(preset)} • {scopeLabel}
        </p>

        {preset.group === "custom" ? (
          <div className="flex gap-2">
            <NumField
              label="Lebar (mm)"
              value={settings.customWMm}
              min={10}
              max={paperWmm}
              onCommit={(v) => onPreset("custom", { wMm: v, hMm: settings.customHMm })}
            />
            <NumField
              label="Tinggi (mm)"
              value={settings.customHMm}
              min={10}
              max={paperHmm}
              onCommit={(v) => onPreset("custom", { wMm: settings.customWMm, hMm: v })}
            />
          </div>
        ) : null}

        <Row label="Kunci Rasio Aspek">
          <Switch
            checked={settings.lockAspect}
            onCheckedChange={(v) => onSetting({ lockAspect: v })}
            aria-label="Kunci rasio aspek foto"
            className="data-[state=checked]:bg-[#003399]"
          />
        </Row>
      </Section>

      {/* Posisi & Ukuran (Word-like) */}
      <Section
        title="Posisi & Ukuran Foto"
        className={selected ? "" : "opacity-60"}
      >
        {selected ? (
          <>
            <div className="flex gap-2">
              <NumField
                label="Posisi X"
                value={selected.xMm}
                min={0}
                max={paperWmm}
                onCommit={(v) => onUpdateSelected({ xMm: v })}
              />
              <NumField
                label="Posisi Y"
                value={selected.yMm}
                min={0}
                max={paperHmm}
                onCommit={(v) => onUpdateSelected({ yMm: v })}
              />
            </div>
            <div className="flex gap-2">
              <NumField
                label="Lebar"
                value={selected.wMm}
                min={10}
                max={paperWmm}
                onCommit={(v) =>
                  onUpdateSelected(
                    settings.lockAspect
                      ? {
                          wMm: v,
                          hMm: (v * selected.hMm) / selected.wMm,
                        }
                      : { wMm: v },
                  )
                }
              />
              <NumField
                label="Tinggi"
                value={selected.hMm}
                min={10}
                max={paperHmm}
                onCommit={(v) =>
                  onUpdateSelected(
                    settings.lockAspect
                      ? {
                          hMm: v,
                          wMm: (v * selected.wMm) / selected.hMm,
                        }
                      : { hMm: v },
                  )
                }
              />
            </div>
            <Row label="Rotasi">
              <Segmented
                value={String(selected.rotation)}
                onChange={(v) => onUpdateSelected({ rotation: Number(v) })}
                options={[
                  { value: "0", label: "0°" },
                  { value: "90", label: "90°" },
                  { value: "180", label: "180°" },
                  { value: "270", label: "270°" },
                ]}
                title="Rotasi foto"
              />
            </Row>
            <Row label="Isi Bingkai">
              <Segmented
                value={selected.fit}
                onChange={(v) => onUpdateSelected({ fit: v })}
                options={[
                  { value: "cover", label: "Potong Penuhi" },
                  { value: "contain", label: "Tampil Utuh" },
                ]}
                title="Cara foto mengisi bingkai"
              />
            </Row>
            <div className="grid grid-cols-6 gap-1">
              <IconBtn title="Rata kiri" onClick={() => onAlign("left")} disabled={!selected}>
                <AlignStartVertical size={13} strokeWidth={1.5} />
              </IconBtn>
              <IconBtn title="Rata tengah horizontal" onClick={() => onAlign("centerX")} disabled={!selected}>
                <AlignCenterVertical size={13} strokeWidth={1.5} />
              </IconBtn>
              <IconBtn title="Rata kanan" onClick={() => onAlign("right")} disabled={!selected}>
                <AlignEndVertical size={13} strokeWidth={1.5} />
              </IconBtn>
              <IconBtn title="Rata atas" onClick={() => onAlign("top")} disabled={!selected}>
                <AlignStartHorizontal size={13} strokeWidth={1.5} />
              </IconBtn>
              <IconBtn title="Rata tengah vertikal" onClick={() => onAlign("centerY")} disabled={!selected}>
                <AlignCenterHorizontal size={13} strokeWidth={1.5} />
              </IconBtn>
              <IconBtn title="Rata bawah" onClick={() => onAlign("bottom")} disabled={!selected}>
                <AlignEndHorizontal size={13} strokeWidth={1.5} />
              </IconBtn>
            </div>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={onDuplicate}
                className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-[#E5E7EB] bg-white text-[11.5px] font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB]"
              >
                <Copy size={12} strokeWidth={1.5} />
                Duplikat
              </button>
              <button
                type="button"
                onClick={onRemove}
                className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-[#E5E7EB] bg-white text-[11.5px] font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB]"
              >
                <Trash2 size={12} strokeWidth={1.5} />
                Hapus
              </button>
            </div>
            <p className="font-mono text-[9.5px] leading-relaxed text-[#9CA3AF]">
              Geser langsung di lembar • panah = 1 mm • Shift+panah = 10 mm
            </p>
          </>
        ) : (
          <p className="text-[12px] leading-relaxed text-[#6B7280]">
            Pilih salah satu foto pada lembar untuk mengatur posisi, ukuran,
            rotasi, dan cara pemotongannya.
          </p>
        )}
      </Section>

      {/* Susun & Lembar */}
      <Section title="Susun & Lembar">
        <Row label="Jumlah Foto">
          <div className="inline-flex items-center rounded-md border border-[#E5E7EB]">
            <button
              type="button"
              aria-label="Kurangi jumlah foto"
              disabled={n <= 1}
              onClick={() => setCount((c) => Math.max(1, c - 1))}
              className="flex h-8 w-8 items-center justify-center text-[#374151] transition-colors hover:bg-[#F9FAFB] disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <Minus size={13} strokeWidth={1.5} />
            </button>
            <span
              className="w-10 border-x border-[#E5E7EB] text-center font-mono text-[12px] font-medium tabular-nums text-[#111827]"
              aria-live="polite"
            >
              {n}
            </span>
            <button
              type="button"
              aria-label="Tambah jumlah foto"
              disabled={n >= capSafe}
              onClick={() => setCount((c) => Math.min(capSafe, c + 1))}
              className="flex h-8 w-8 items-center justify-center text-[#374151] transition-colors hover:bg-[#F9FAFB] disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <Plus size={13} strokeWidth={1.5} />
            </button>
          </div>
        </Row>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Jumlah foto cepat">
          {COUNT_QUICK.filter((q) => q <= capSafe).map((q) => (
            <button
              key={q}
              type="button"
              aria-pressed={n === q}
              onClick={() => setCount(q)}
              className={`h-7 min-w-[32px] rounded-md border px-1.5 font-mono text-[11px] font-medium tabular-nums transition-colors ${
                n === q
                  ? "border-[#003399] bg-[#003399]/10 text-[#003399]"
                  : "border-[#E5E7EB] bg-white text-[#374151] hover:bg-[#F9FAFB]"
              }`}
            >
              {q}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => onArrangeCount(n)}
          disabled={placements.length === 0}
          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-[#003399] bg-white text-[12px] font-semibold text-[#003399] transition-colors hover:bg-[#003399]/5 disabled:opacity-30"
        >
          <Rows3 size={13} strokeWidth={1.5} />
          Susun {n} Foto ({preset.short})
        </button>
        <p className="font-mono text-[9.5px] leading-relaxed text-[#9CA3AF]">
          Menjajarkan {n} salinan foto terpilih/pertama persis sesuai ukuran
          preset — grid rapi di tengah lembar, baris terakhir tetap seimbang.
        </p>
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            onClick={onFillSheet}
            disabled={placements.length === 0}
            className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-[#E5E7EB] bg-white text-[11.5px] font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB] disabled:opacity-30"
          >
            <LayoutGrid size={12} strokeWidth={1.5} />
            Isi Penuh
          </button>
          <button
            type="button"
            onClick={onArrange}
            disabled={placements.length === 0}
            className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-[#E5E7EB] bg-white text-[11.5px] font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB] disabled:opacity-30"
          >
            <Wand2 size={12} strokeWidth={1.5} />
            Rapikan
          </button>
        </div>
        <p className="font-mono text-[10px] tabular-nums text-[#6B7280]">
          Kapasitas lembar: {capSafe} foto • {preset.short} • margin {settings.marginMm} mm
        </p>
        <div className="flex gap-2">
          <NumField
            label="Margin (mm)"
            value={settings.marginMm}
            min={0}
            max={30}
            onCommit={(v) => onSetting({ marginMm: v })}
          />
          <NumField
            label="Jarak Antar Foto (mm)"
            value={settings.gapMm}
            min={0}
            max={20}
            onCommit={(v) => onSetting({ gapMm: v })}
          />
        </div>
        <Row label="Garis Potong">
          <Switch
            checked={settings.cutLines}
            onCheckedChange={(v) => onSetting({ cutLines: v })}
            aria-label="Tampilkan garis potong"
            className="data-[state=checked]:bg-[#003399]"
          />
        </Row>
        {beyondMargin ? (
          <p className="font-mono text-[10px] leading-relaxed text-[#92400E]">
            Ada foto melewati area margin — geser ke dalam garis putus-putus
            agar tidak terpotong driver Epson.
          </p>
        ) : null}
        {unplacedImages.length > 0 ? (
          <button
            type="button"
            onClick={onAddImages}
            className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-[#E5E7EB] bg-white text-[11.5px] font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB]"
          >
            <ImagePlus size={12} strokeWidth={1.5} />
            Tambah {unplacedImages.length} foto dari daftar
          </button>
        ) : null}
        {placements.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="mx-auto flex items-center gap-1 rounded px-1.5 py-1 font-mono text-[10px] text-[#9CA3AF] underline decoration-[#E5E7EB] underline-offset-2 transition-colors hover:text-[#6B7280]"
          >
            <Eraser size={10} strokeWidth={1.5} />
            kosongkan lembar
          </button>
        ) : null}
      </Section>

      {/* Foto di Lembar */}
      <Section title={`Foto di Lembar (${placements.length})`}>
        {placements.length === 0 ? (
          <p className="text-[12px] leading-relaxed text-[#6B7280]">
            Belum ada foto. Unggah PNG/JPG lewat area unggah, lalu foto langsung
            diletakkan di lembar.
          </p>
        ) : (
          <div className="ps-scroll flex max-h-56 flex-col gap-1 overflow-y-auto">
            {placements.map((p, i) => {
              const item = files.find((f) => f.id === p.itemId);
              const active = p.id === selected?.id;
              return (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={active}
                  aria-label={`Pilih foto ${i + 1}`}
                  onClick={() => onSelect(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(p.id);
                    }
                  }}
                  className={`group flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 transition-colors ${
                    active
                      ? "border-[#003399] bg-[#003399]/5"
                      : "border-transparent hover:border-[#E5E7EB] hover:bg-[#F9FAFB]"
                  }`}
                >
                  {item?.url ? (
                    <img
                      src={item.url}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded-[2px] border border-[#E5E7EB] object-cover"
                    />
                  ) : (
                    <div className="h-9 w-9 shrink-0 rounded-[2px] border border-[#E5E7EB] bg-[#F3F4F6]" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11.5px] font-medium text-[#111827]">
                      {item?.name ?? "—"}
                    </p>
                    <p className="font-mono text-[9.5px] tabular-nums text-[#6B7280]">
                      #{i + 1} • {Math.round(p.wMm)} × {Math.round(p.hMm)} mm
                      {item ? ` • ${formatBytes(item.sizeBytes)}` : ""}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}
