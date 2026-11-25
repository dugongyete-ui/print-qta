"use client";

// 52px top utility bar: app identity, physical tray selector, printer status,
// and the document / photo work-mode switch.

import {
  FileText,
  GraduationCap,
  HardDrive,
  Image as ImageIcon,
  Monitor,
  Printer,
  Settings2,
  Sprout,
} from "lucide-react";
import {
  DOC_PAPER_IDS,
  PHOTO_PAPER_IDS,
  PAPERS,
  getPaper,
  type PaperId,
} from "@/lib/paper";
import type { PrintMode, SpoolerState } from "@/lib/print-station/types";
import { Segmented } from "./segmented";
import { GuidedWizard } from "./guided-wizard";
import type {
  GuidedGoal,
  GuidedOutcome,
  GuidedPaper,
  UiLevel,
} from "@/hooks/use-print-station";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type WorkMode = "doc" | "photo";

interface TopBarProps {
  workMode: WorkMode;
  onWorkModeChange: (mode: WorkMode) => void;
  paperId: PaperId;
  onPaperChange: (id: PaperId) => void;
  printMode: PrintMode;
  onPrintModeChange: (mode: PrintMode) => void;
  spooler: SpoolerState;
  onOpenSidebar: () => void;
  /** "Mode Pemula / Lanjutan" toggle. */
  uiLevel: UiLevel;
  onUiLevelChange: (v: UiLevel) => void;
  /** "Bantu Saya Cetak" wizard submission. */
  onApplyGuided: (goal: GuidedGoal, paper: GuidedPaper, outcome: GuidedOutcome) => void;
}

export function TopBar({
  workMode,
  onWorkModeChange,
  paperId,
  onPaperChange,
  printMode,
  onPrintModeChange,
  spooler,
  onOpenSidebar,
  uiLevel,
  onUiLevelChange,
  onApplyGuided,
}: TopBarProps) {
  const spoolerDot =
    spooler.state === "available" ? "ok" : spooler.state === "checking" ? "wait" : "off";

  const docPapers = PAPERS.filter((p) => DOC_PAPER_IDS.includes(p.id));
  const photoPapers = PAPERS.filter((p) => PHOTO_PAPER_IDS.includes(p.id));

  return (
    <header className="z-30 flex h-[52px] min-h-[52px] shrink-0 items-center gap-3 border-b border-[#E5E7EB] bg-white px-4">
      {/* Identity */}
      <div className="flex min-w-0 shrink-0 items-center gap-2.5">
        <Printer size={18} strokeWidth={1.5} className="shrink-0 text-[#111827]" aria-hidden="true" />
        <span className="whitespace-nowrap text-[13px] font-semibold tracking-[-0.01em] text-[#111827] sm:text-[14px]">
          <span className="hidden sm:inline">Epson Print Station</span>
          <span className="sm:hidden">Print Station</span>
        </span>
        <span className="hidden rounded border border-[#E5E7EB] bg-[#F9FAFB] px-1.5 py-0.5 font-mono text-[10px] font-medium text-[#6B7280] md:block">
          v1.2
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {/* "Bantu Saya Cetak" — plain-language 3-question wizard */}
        <GuidedWizard onApply={onApplyGuided} />

        {/* Work mode: document vs photo layout editor */}
        <Segmented<WorkMode>
          value={workMode}
          onChange={onWorkModeChange}
          options={[
            {
              value: "doc",
              label: "Dokumen",
              icon: <FileText size={13} strokeWidth={1.5} aria-hidden="true" />,
              labelClassName: "hidden md:inline",
            },
            {
              value: "photo",
              label: "Foto",
              icon: <ImageIcon size={13} strokeWidth={1.5} aria-hidden="true" />,
              labelClassName: "hidden md:inline",
            },
          ]}
          title="Mode kerja — dokumen atau lembar foto"
        />

        {/* Physical tray selector (accessible via drawer on <sm) */}
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <span className="hidden text-[11px] font-medium text-[#6B7280] xl:block">
            Kertas di Tray Printer
          </span>
          <Select value={paperId} onValueChange={(v) => onPaperChange(v as PaperId)}>
            <SelectTrigger
              aria-label="Kertas di tray printer"
              className="h-8 w-[62px] rounded-md border-[#E5E7EB] px-2 font-mono text-[11.5px] tabular-nums text-[#111827] shadow-none focus:ring-1 focus:ring-[#003399] sm:w-[178px] sm:px-3"
            >
              <span className="sm:hidden" aria-hidden="true">{getPaper(paperId).shortLabel}</span>
              <span className="hidden sm:inline"><SelectValue /></span>
            </SelectTrigger>
            <SelectContent className="rounded-md border-[#E5E7EB]">
              <SelectGroup>
                <SelectLabel className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-[#9CA3AF]">
                  Dokumen
                </SelectLabel>
                {docPapers.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="font-mono text-[11.5px] tabular-nums">
                    {p.label}
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectGroup>
                <SelectLabel className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-[#9CA3AF]">
                  Kertas Foto
                </SelectLabel>
                {photoPapers.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="font-mono text-[11.5px] tabular-nums">
                    {p.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {/* Printer status pill (hidden < lg to keep the utility bar within width) */}
        <div className="hidden h-8 items-center gap-2 rounded-full border border-[#E5E7EB] bg-white px-3 lg:flex">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#10B981]" aria-hidden="true" />
          <span className="whitespace-nowrap text-[12px] font-medium text-[#111827]">
            Epson L3210 Series
          </span>
          <span className="whitespace-nowrap text-[12px] text-[#6B7280]">• Siap</span>
        </div>

        {/* Print mode — labels collapse to icons below sm */}
        <Segmented<PrintMode>
          value={printMode}
          onChange={onPrintModeChange}
          options={[
            {
              value: "browser",
              label: "Browser",
              icon: <Monitor size={13} strokeWidth={1.5} aria-hidden="true" />,
              labelClassName: "hidden sm:inline",
            },
            {
              value: "spooler",
              label: "Spooler",
              icon: <HardDrive size={13} strokeWidth={1.5} aria-hidden="true" />,
              labelClassName: "hidden sm:inline",
              dot: spoolerDot,
            },
          ]}
          title="Mode eksekusi cetak"
        />

        {/* Mode Pemula / Lanjutan — beginners see only the essentials */}
        <Segmented<UiLevel>
          value={uiLevel}
          onChange={onUiLevelChange}
          options={[
            {
              value: "beginner",
              label: "Pemula",
              icon: <Sprout size={13} strokeWidth={1.5} aria-hidden="true" />,
              labelClassName: "hidden xl:inline",
            },
            {
              value: "advanced",
              label: "Lanjutan",
              icon: <GraduationCap size={13} strokeWidth={1.5} aria-hidden="true" />,
              labelClassName: "hidden xl:inline",
            },
          ]}
          title="Mode tampilan — Pemula menyederhanakan menu, Lanjutan menampilkan semua pengaturan"
        />

        {/* Inspector toggle (tablet / mobile — desktop shows the fixed sidebar) */}
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="Buka pengaturan cetak"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#E5E7EB] bg-white text-[#374151] transition-colors hover:bg-[#F9FAFB] lg:hidden"
        >
          <Settings2 size={15} strokeWidth={1.5} />
        </button>
      </div>
    </header>
  );
}
