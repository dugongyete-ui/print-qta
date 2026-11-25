"use client";

// Preflight check panel — the certainty gate before printing. One glance
// tells the operator whether the job is safe ("Siap dicetak") or what to
// fix ("1 hal perlu diperiksa"), with one-tap auto-fix and focus-on-problem.

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  Info,
  ShieldAlert,
  Wand2,
  XCircle,
} from "lucide-react";
import type { PreflightIssue, PreflightReport } from "@/lib/print-station/types";

const SEVERITY_STYLE: Record<
  PreflightIssue["severity"],
  { icon: typeof XCircle; color: string; bg: string }
> = {
  error: {
    icon: XCircle,
    color: "text-[#DC2626]",
    bg: "bg-[#FEF2F2]",
  },
  warn: {
    icon: AlertTriangle,
    color: "text-[#B45309]",
    bg: "bg-[#FFFBEB]",
  },
  info: {
    icon: Info,
    color: "text-[#374151]",
    bg: "bg-[#F9FAFB]",
  },
};

const STATUS_DOT: Record<PreflightReport["status"], string> = {
  ok: "bg-[#10B981]",
  warn: "bg-[#F59E0B]",
  error: "bg-[#DC2626]",
};

interface PreflightPanelProps {
  report: PreflightReport;
  photoMode: boolean;
  onAutoFix: () => void;
  /** Focus the first offending placement on the canvas. */
  onViewProblem: (issue: PreflightIssue) => void;
}

export function PreflightPanel({
  report,
  photoMode,
  onAutoFix,
  onViewProblem,
}: PreflightPanelProps) {
  const [open, setOpen] = useState(false);
  const hasIssues = report.items.length > 0;
  const fixable = report.items.some((i) => i.fixable);

  return (
    <div
      data-testid="preflight"
      className={`mb-2.5 rounded-md border ${
        report.status === "ok"
          ? "border-[#D1FAE5] bg-[#F0FDF9]"
          : report.status === "warn"
            ? "border-[#FDE68A] bg-[#FFFBEB]"
            : "border-[#FECACA] bg-[#FEF2F2]"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-label={`Pemeriksaan pra-cetak: ${report.headline}`}
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[report.status]}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-[12px] font-semibold ${
              report.status === "ok"
                ? "text-[#047857]"
                : report.status === "warn"
                  ? "text-[#92400E]"
                  : "text-[#991B1B]"
            }`}
          >
            {report.headline}
          </span>
          <span className="block truncate font-mono text-[9.5px] tabular-nums text-[#6B7280]">
            {photoMode
              ? `${report.sheets} lembar • tinta ${report.ink}`
              : `${report.sheets} lembar • tinta ${report.ink}`}
          </span>
        </span>
        {hasIssues ? (
          open ? (
            <ChevronUp size={14} className="shrink-0 text-[#6B7280]" />
          ) : (
            <ChevronDown size={14} className="shrink-0 text-[#6B7280]" />
          )
        ) : (
          <CheckCircle2 size={14} className="shrink-0 text-[#10B981]" />
        )}
      </button>

      {open && hasIssues ? (
        <div className="border-t border-black/5 px-3 pb-3 pt-2">
          <ul className="flex flex-col gap-2" role="list">
            {report.items.map((issue) => {
              const style = SEVERITY_STYLE[issue.severity];
              const Icon = style.icon;
              return (
                <li
                  key={issue.id}
                  className={`rounded-md border border-black/5 p-2 ${style.bg}`}
                >
                  <div className="flex items-start gap-2">
                    <Icon
                      size={13}
                      strokeWidth={1.8}
                      className={`mt-0.5 shrink-0 ${style.color}`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-[11.5px] font-semibold ${style.color}`}
                      >
                        {issue.label}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-[#374151]">
                        {issue.detail}
                      </p>
                    </div>
                    {photoMode && issue.placementIds?.length ? (
                      <button
                        type="button"
                        onClick={() => onViewProblem(issue)}
                        className="flex h-6 shrink-0 items-center gap-1 rounded border border-[#E5E7EB] bg-white px-1.5 text-[10px] font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB]"
                        aria-label={`Lihat masalah: ${issue.label}`}
                      >
                        <Eye size={10} strokeWidth={1.8} aria-hidden="true" />
                        Lihat
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {fixable ? (
            <button
              type="button"
              onClick={onAutoFix}
              className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-[#003399]/30 bg-white text-[11.5px] font-semibold text-[#003399] transition-colors hover:bg-[#003399]/5"
            >
              <Wand2 size={12} strokeWidth={1.8} aria-hidden="true" />
              Perbaiki Otomatis
            </button>
          ) : null}
        </div>
      ) : null}

      {!open && hasIssues && report.status === "error" ? (
        <p className="px-3 pb-2 font-mono text-[9.5px] text-[#991B1B]">
          ketuk panel untuk melihat detail masalah
        </p>
      ) : null}
    </div>
  );
}

/** Compact one-line preflight status for the mobile print bar. */
export function PreflightMini({ report }: { report: PreflightReport }) {
  const Icon =
    report.status === "ok"
      ? CheckCircle2
      : report.status === "warn"
        ? AlertTriangle
        : ShieldAlert;
  const color =
    report.status === "ok"
      ? "text-[#10B981]"
      : report.status === "warn"
        ? "text-[#B45309]"
        : "text-[#DC2626]";
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap font-mono text-[10px] tabular-nums ${color}`}
      aria-label={`Status pra-cetak: ${report.headline}`}
    >
      <Icon size={11} strokeWidth={1.8} aria-hidden="true" />
      {report.status === "ok" ? "Siap" : report.headline}
    </span>
  );
}
