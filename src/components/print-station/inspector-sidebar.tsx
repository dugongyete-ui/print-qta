"use client";

// Structured print inspector (fixed 360px). Hairline-divided sections,
// sticky summary footer with the primary Epson print action.
// Two branches: document mode (paper / range / duplex) and photo mode
// (size presets, position & size, sheet tools) sharing color/quality/copies.

import { Minus, Plus } from "lucide-react";
import { toast } from "sonner";
import { DOC_PAPER_IDS, PHOTO_PAPER_IDS, PAPERS, type PaperId } from "@/lib/paper";
import {
  PAPER_TYPES,
  QUALITY_HINT,
  getPaperType,
  type LoadedFile,
  type PaperType,
  type PrintSettings,
} from "@/lib/print-station/types";
import type { PhotoPreset } from "@/lib/print-station/photo-sizes";
import type {
  PhotoAlign,
} from "@/hooks/use-print-station";
import type {
  GridAlignH,
  GridAlignV,
  PhotoPlacement,
  PhotoSettings,
} from "@/lib/print-station/types";
import { Segmented } from "./segmented";
import { PhotoInspector } from "./photo-inspector";
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

/** Photo-mode inspector payload handed down from PrintStation. */
export interface PhotoPanelData {
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
  /** Borderless toggle — zeroes margin + re-tiles in one tick. */
  onBorderless: (v: boolean) => void;
  onPreset: (id: string, customDims?: { wMm: number; hMm: number }) => void;
  onUpdateSelected: (patch: Partial<PhotoPlacement>) => void;
  onAlign: (dir: PhotoAlign) => void;
  onFillSheet: () => void;
  /** Arrange exactly N preset-sized copies in a grid; opts override stale
   * settings in the same tick (margin / gap / alignment changes). */
  onArrangeCount: (
    n: number,
    opts?: {
      marginMm?: number;
      gapMm?: number;
      alignV?: GridAlignV;
      alignH?: GridAlignH;
    },
  ) => void;
  onArrange: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onSelect: (id: string | null) => void;
  onClear: () => void;
  onAddImages: () => void;
}

function ColorQualitySection({
  settings,
  onSetting,
}: {
  settings: PrintSettings;
  onSetting: <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) => void;
}) {
  const paperType = getPaperType(settings.paperType);
  const isPhotoPaper = settings.paperType !== "plain";
  return (
    <Section title="Warna & Kualitas Epson">
      <Row label="Mode Warna">
        <Segmented
          value={settings.colorMode}
          onChange={(v) => onSetting("colorMode", v)}
          options={[
            { value: "color", label: "Berwarna" },
            { value: "grayscale", label: "Hitam Putih" },
          ]}
        />
      </Row>
      <div className="flex flex-col gap-1.5">
        <Row label="Jenis Kertas">
          <Select
            value={settings.paperType}
            onValueChange={(v) => {
              const t = v as PaperType;
              onSetting("paperType", t);
              // Epson-like recommendation: photo paper deserves high quality.
              if (t !== "plain" && settings.quality !== "high") {
                onSetting("quality", "high");
                toast.info("Kualitas dinaikkan ke Tinggi", {
                  description: `${getPaperType(t).label} menghasilkan warna terbaik pada kualitas Tinggi.`,
                });
              }
            }}
          >
            <SelectTrigger
              aria-label="Jenis kertas di tray"
              className="h-8 w-[170px] rounded-md border-[#E5E7EB] text-[11.5px] text-[#111827] shadow-none focus:ring-1 focus:ring-[#003399]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-md border-[#E5E7EB]">
              {PAPER_TYPES.map((t) => (
                <SelectItem key={t.id} value={t.id} className="text-[11.5px]">
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <p className="font-mono text-[9.5px] leading-relaxed text-[#9CA3AF]">
          {paperType.hint}
        </p>
      </div>
      <Row label="Kualitas Cetak">
        <Segmented
          value={settings.quality}
          onChange={(v) => onSetting("quality", v)}
          options={[
            { value: "draft", label: "Draf" },
            { value: "standard", label: "Standar" },
            { value: "high", label: "Tinggi" },
          ]}
        />
      </Row>
      <p className="font-mono text-[10px] text-[#6B7280]">
        {QUALITY_HINT[settings.quality]}
      </p>
      {isPhotoPaper ? (
        <p className="font-mono text-[10px] leading-relaxed text-[#92400E]">
          Gunakan Kualitas Tinggi + beri waktu kering 10–15 menit sebelum
          menumpuk hasil cetak foto.
        </p>
      ) : null}
    </Section>
  );
}

function CopiesSection({
  copies,
  onCopies,
}: {
  copies: number;
  onCopies: (n: number) => void;
}) {
  return (
    <Row label="Jumlah Salinan">
      <div className="inline-flex items-center rounded-md border border-[#E5E7EB]">
        <button
          type="button"
          aria-label="Kurangi salinan"
          disabled={copies <= 1}
          onClick={() => onCopies(Math.max(1, copies - 1))}
          className="flex h-8 w-8 items-center justify-center text-[#374151] transition-colors hover:bg-[#F9FAFB] disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Minus size={13} strokeWidth={1.5} />
        </button>
        <span className="w-9 border-x border-[#E5E7EB] text-center font-mono text-[12px] font-medium tabular-nums text-[#111827]">
          {copies}
        </span>
        <button
          type="button"
          aria-label="Tambah salinan"
          disabled={copies >= 99}
          onClick={() => onCopies(Math.min(99, copies + 1))}
          className="flex h-8 w-8 items-center justify-center text-[#374151] transition-colors hover:bg-[#F9FAFB] disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Plus size={13} strokeWidth={1.5} />
        </button>
      </div>
    </Row>
  );
}

function PaperSelect({
  paperId,
  onPaper,
}: {
  paperId: PaperId;
  onPaper: (id: PaperId) => void;
}) {
  const docPapers = PAPERS.filter((p) => DOC_PAPER_IDS.includes(p.id));
  const photoPapers = PAPERS.filter((p) => PHOTO_PAPER_IDS.includes(p.id));
  return (
    <Select value={paperId} onValueChange={(v) => onPaper(v as PaperId)}>
      <SelectTrigger
        aria-label="Ukuran kertas target"
        className="h-8 w-[170px] rounded-md border-[#E5E7EB] font-mono text-[11.5px] tabular-nums text-[#111827] shadow-none focus:ring-1 focus:ring-[#003399]"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="rounded-md border-[#E5E7EB]">
        <SelectGroup>
          <SelectLabel className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-[#9CA3AF]">
            Dokumen
          </SelectLabel>
          {docPapers.map((p) => (
            <SelectItem
              key={p.id}
              value={p.id}
              className="font-mono text-[11.5px] tabular-nums"
            >
              {p.label}
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-[#9CA3AF]">
            Kertas Foto
          </SelectLabel>
          {photoPapers.map((p) => (
            <SelectItem
              key={p.id}
              value={p.id}
              className="font-mono text-[11.5px] tabular-nums"
            >
              {p.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

interface SidebarContentProps {
  file: LoadedFile | null;
  settings: PrintSettings;
  onSetting: <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) => void;
  rangeInvalid: boolean;
  summary: string;
  canPrint: boolean;
  printing: boolean;
  onPrint: () => void;
  photoMode: boolean;
  photo: PhotoPanelData;
}

function SidebarContent({
  file,
  settings,
  onSetting,
  rangeInvalid,
  summary,
  canPrint,
  printing,
  onPrint,
  photoMode,
  photo,
}: SidebarContentProps) {
  const disabled = !file || file.status !== "ready";

  return (
    <>
      <div className="flex-1 overflow-y-auto ps-scroll">
        {/* Active document header */}
        <div className="flex items-center justify-between gap-2 border-b border-[#E5E7EB] px-4 py-3">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#6B7280]">
            Inspektor Cetak
          </span>
          {photoMode ? (
            <span className="rounded border border-[#003399]/25 bg-[#003399]/5 px-2 py-0.5 font-mono text-[10px] font-medium text-[#003399]">
              MODE FOTO
            </span>
          ) : file ? (
            <span className="max-w-[200px] truncate rounded border border-[#E5E7EB] bg-[#F9FAFB] px-2 py-0.5 font-mono text-[10px] text-[#374151]">
              {file.name}
            </span>
          ) : (
            <span className="font-mono text-[10px] text-[#9CA3AF]">belum ada dokumen</span>
          )}
        </div>

        {photoMode ? (
          <>
            <PhotoInspector
              placements={photo.placements}
              selected={photo.selected}
              files={photo.files}
              settings={photo.settings}
              preset={photo.preset}
              paperWmm={photo.paperWmm}
              paperHmm={photo.paperHmm}
              beyondMargin={photo.beyondMargin}
              capacity={photo.capacity}
              onSetting={photo.onSetting}
              onBorderless={photo.onBorderless}
              onPreset={photo.onPreset}
              onUpdateSelected={photo.onUpdateSelected}
              onAlign={photo.onAlign}
              onFillSheet={photo.onFillSheet}
              onArrangeCount={photo.onArrangeCount}
              onArrange={photo.onArrange}
              onDuplicate={photo.onDuplicate}
              onRemove={photo.onRemove}
              onSelect={photo.onSelect}
              onClear={photo.onClear}
              onAddImages={photo.onAddImages}
            />
            <ColorQualitySection settings={settings} onSetting={onSetting} />
            <Section title="Salinan">
              <CopiesSection
                copies={settings.copies}
                onCopies={(n) => onSetting("copies", n)}
              />
            </Section>
          </>
        ) : (
          <div
            className={disabled ? "pointer-events-none select-none opacity-40" : ""}
            aria-hidden={disabled}
          >
            {/* Kertas & Skala */}
            <Section title="Kertas & Skala">
              <div className="flex flex-col gap-1.5">
                <Row label="Ukuran Kertas Target">
                  <PaperSelect
                    paperId={settings.paperId}
                    onPaper={(id) => onSetting("paperId", id)}
                  />
                </Row>
                <p className="font-mono text-[9.5px] text-[#9CA3AF]">
                  tersinkron dengan tray printer
                </p>
              </div>
              <Row label="Orientasi">
                <Segmented
                  value={settings.orientation}
                  onChange={(v) => onSetting("orientation", v)}
                  options={[
                    { value: "portrait", label: "Potret" },
                    { value: "landscape", label: "Lanskap" },
                  ]}
                />
              </Row>
              <Row label="Skala">
                <Segmented
                  value={settings.scaleMode}
                  onChange={(v) => onSetting("scaleMode", v)}
                  options={[
                    { value: "fit", label: "Sesuaikan Kertas" },
                    { value: "original", label: "Asli 100%" },
                  ]}
                />
              </Row>
              {settings.scaleMode === "original" ? (
                <p className="font-mono text-[10px] leading-relaxed text-[#6B7280]">
                  Fit to Page dinonaktifkan — konten dicetak 1:1, bagian yang
                  melebihi kertas terpotong.
                </p>
              ) : null}
            </Section>

            <ColorQualitySection settings={settings} onSetting={onSetting} />

            {/* Halaman & Salinan */}
            <Section title="Halaman & Salinan">
              <div className="flex flex-col gap-2">
                <Row label="Rentang Halaman">
                  <Segmented
                    value={settings.rangeMode}
                    onChange={(v) => onSetting("rangeMode", v)}
                    options={[
                      { value: "all", label: "Semua" },
                      { value: "custom", label: "Kustom" },
                    ]}
                  />
                </Row>
                {settings.rangeMode === "custom" ? (
                  <input
                    type="text"
                    value={settings.rangeText}
                    onChange={(e) => onSetting("rangeText", e.target.value)}
                    placeholder="cth. 1-3, 5"
                    aria-label="Rentang halaman kustom"
                    spellCheck={false}
                    className={`h-8 w-full rounded-md border bg-white px-2.5 font-mono text-[11.5px] tabular-nums text-[#111827] outline-none transition-colors placeholder:text-[#9CA3AF] ${
                      rangeInvalid
                        ? "border-[#F59E0B] focus:border-[#F59E0B]"
                        : "border-[#E5E7EB] focus:border-[#003399]"
                    }`}
                  />
                ) : null}
                {rangeInvalid ? (
                  <p className="font-mono text-[10px] text-[#92400E]">
                    Rentang tidak valid — gunakan format 1-3, 5 (maks. {file?.pageCount ?? 1})
                  </p>
                ) : null}
              </div>
              <CopiesSection
                copies={settings.copies}
                onCopies={(n) => onSetting("copies", n)}
              />
              <Row label="Cetak Bolak-Balik (Manual)">
                <Switch
                  checked={settings.duplex}
                  onCheckedChange={(v) => onSetting("duplex", v)}
                  aria-label="Cetak bolak-balik manual"
                  className="data-[state=checked]:bg-[#003399]"
                />
              </Row>
              {settings.duplex ? (
                <p className="text-[11px] leading-relaxed text-[#6B7280]">
                  Panduan duplex manual: cetak halaman ganjil, balik &amp; susun
                  ulang tumpukan kertas, lalu cetak sisi genap.
                </p>
              ) : null}
            </Section>
          </div>
        )}
      </div>

      {/* Sticky footer */}
      <footer className="shrink-0 border-t border-[#E5E7EB] bg-white px-4 pb-4 pt-3">
        <p className="mb-2.5 truncate text-center font-mono text-[11.5px] tabular-nums text-[#374151]">
          {rangeInvalid ? (
            <span className="text-[#92400E]">Periksa rentang halaman</span>
          ) : (
            summary
          )}
        </p>
        <button
          type="button"
          onClick={onPrint}
          disabled={!canPrint || printing}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[#003399] text-[13px] font-semibold text-white transition-colors hover:bg-[#002673] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#003399]"
        >
          {printing ? (
            "Menyiapkan…"
          ) : (
            <>
              Cetak ke Epson
              <span className="rounded bg-white/15 px-1.5 py-0.5 font-mono text-[10px] font-normal">
                Ctrl P
              </span>
            </>
          )}
        </button>
      </footer>
    </>
  );
}

interface SidebarProps extends SidebarContentProps {
  onOpenChange: (open: boolean) => void;
  mobileOpen: boolean;
}

export function InspectorSidebar(props: SidebarProps) {
  const { mobileOpen, onOpenChange, ...content } = props;
  return (
    <>
      {/* Desktop: fixed column */}
      <aside className="hidden w-[360px] shrink-0 flex-col border-l border-[#E5E7EB] bg-white lg:flex">
        <SidebarContent {...content} />
      </aside>

      {/* Tablet / mobile: drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Tutup panel pengaturan"
            onClick={() => onOpenChange(false)}
            className="absolute inset-0 bg-[#111827]/25"
          />
          <div className="absolute bottom-0 right-0 top-0 flex w-[360px] max-w-[92vw] flex-col border-l border-[#E5E7EB] bg-white">
            <SidebarContent {...content} />
          </div>
        </div>
      ) : null}
    </>
  );
}
