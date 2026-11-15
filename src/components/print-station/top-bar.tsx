"use client";

// 52px top utility bar: app identity, physical tray selector, printer status.

import { Printer, Settings2 } from "lucide-react";
import { PAPERS, getPaper, type PaperId } from "@/lib/paper";
import type { PrintMode, SpoolerState } from "@/lib/print-station/types";
import { Segmented } from "./segmented";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface TopBarProps {
  paperId: PaperId;
  onPaperChange: (id: PaperId) => void;
  printMode: PrintMode;
  onPrintModeChange: (mode: PrintMode) => void;
  spooler: SpoolerState;
  onOpenSidebar: () => void;
}

export function TopBar({
  paperId,
  onPaperChange,
  printMode,
  onPrintModeChange,
  spooler,
  onOpenSidebar,
}: TopBarProps) {
  const spoolerDot =
    spooler.state === "available" ? "ok" : spooler.state === "checking" ? "wait" : "off";

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
          v1.0
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
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
              {PAPERS.map((p) => (
                <SelectItem key={p.id} value={p.id} className="font-mono text-[11.5px] tabular-nums">
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Printer status pill */}
        <div className="hidden h-8 items-center gap-2 rounded-full border border-[#E5E7EB] bg-white px-3 sm:flex">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#10B981]" aria-hidden="true" />
          <span className="whitespace-nowrap text-[12px] font-medium text-[#111827]">
            Epson L3210 Series
          </span>
          <span className="whitespace-nowrap text-[12px] text-[#6B7280]">• Siap</span>
        </div>

        {/* Print mode */}
        <Segmented<PrintMode>
          value={printMode}
          onChange={onPrintModeChange}
          options={[
            { value: "browser", label: "Browser" },
            { value: "spooler", label: "Spooler", dot: spoolerDot },
          ]}
          title="Mode eksekusi cetak"
        />

        {/* Sidebar toggle (mobile/tablet) */}
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="Buka panel pengaturan cetak"
          className="flex h-8 w-8 items-center justify-center rounded-md border border-[#E5E7EB] bg-white text-[#374151] hover:bg-[#F9FAFB] lg:hidden"
        >
          <Settings2 size={15} strokeWidth={1.5} />
        </button>
      </div>
    </header>
  );
}
