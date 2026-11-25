"use client";

// "Bantu Saya Cetak" — a 3-question wizard that replaces every technical
// setting with plain-language intent. After the user answers, the store
// derives paper, orientation, margins, gaps, scale, quality and layout so a
// first-time operator gets a professional sheet without touching the menus.

import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  Gem,
  Images,
  Layers,
  Leaf,
  Maximize2,
  Scale,
  Sparkles,
  User,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  GuidedGoal,
  GuidedOutcome,
  GuidedPaper,
} from "@/hooks/use-print-station";

interface GuidedWizardProps {
  onApply: (goal: GuidedGoal, paper: GuidedPaper, outcome: GuidedOutcome) => void;
}

const GOALS: Array<{
  id: GuidedGoal;
  label: string;
  hint: string;
  icon: LucideIcon;
}> = [
  {
    id: "doc",
    label: "Dokumen",
    hint: "PDF / Word untuk dicetak apa adanya",
    icon: FileText,
  },
  {
    id: "pas-foto",
    label: "Pas foto",
    hint: "Lembar pas foto rapi + garis potong",
    icon: User,
  },
  {
    id: "banyak-foto",
    label: "Banyak foto",
    hint: "Beberapa foto berbeda dalam satu lembar",
    icon: Images,
  },
  {
    id: "lembar-penuh",
    label: "Foto penuh satu lembar",
    hint: "Satu foto mengisi seluruh kertas",
    icon: Maximize2,
  },
];

const PAPERS: Array<{ id: GuidedPaper; label: string; hint: string }> = [
  { id: "a4", label: "A4", hint: "210 × 297 mm — paling umum" },
  { id: "f4", label: "F4", hint: "210 × 330 mm — folio Indonesia" },
  { id: "4r", label: "4R", hint: "102 × 152 mm — kertas foto" },
  { id: "custom", label: "Ikuti kertas saat ini", hint: "yang sudah ada di tray" },
];

const OUTCOMES: Array<{
  id: GuidedOutcome;
  label: string;
  hint: string;
  icon: LucideIcon;
}> = [
  {
    id: "hemat",
    label: "Paling hemat",
    hint: "irit kertas & tinta, hasil cepat",
    icon: Leaf,
  },
  {
    id: "asli",
    label: "Ukuran asli",
    hint: "dicetak 1:1 tanpa penskalaan",
    icon: Scale,
  },
  {
    id: "kualitas",
    label: "Kualitas terbaik",
    hint: "warna maksimal — cocok untuk foto",
    icon: Gem,
  },
  {
    id: "semua",
    label: "Semua foto harus masuk",
    hint: "jumlah slot otomatis menyesuaikan",
    icon: Layers,
  },
];

function OptionRow({
  selected,
  onSelect,
  label,
  hint,
  icon: Icon,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  hint: string;
  icon: LucideIcon;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
        selected
          ? "border-[#003399] bg-[#003399]/5"
          : "border-[#E5E7EB] bg-white hover:bg-[#F9FAFB]"
      }`}
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${
          selected
            ? "border-[#003399]/30 bg-[#003399]/10 text-[#003399]"
            : "border-[#E5E7EB] bg-[#F9FAFB] text-[#6B7280]"
        }`}
        aria-hidden="true"
      >
        <Icon size={15} strokeWidth={1.6} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-semibold text-[#111827]">
          {label}
        </span>
        <span className="block truncate text-[11px] text-[#6B7280]">{hint}</span>
      </span>
      {selected ? (
        <Check size={15} strokeWidth={2} className="shrink-0 text-[#003399]" aria-hidden="true" />
      ) : null}
    </button>
  );
}

export function GuidedWizard({ onApply }: GuidedWizardProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [goal, setGoal] = useState<GuidedGoal | null>(null);
  const [paper, setPaper] = useState<GuidedPaper | null>(null);
  const [outcome, setOutcome] = useState<GuidedOutcome | null>(null);

  const reset = () => {
    setStep(1);
    setGoal(null);
    setPaper(null);
    setOutcome(null);
  };
  const close = () => {
    setOpen(false);
    window.setTimeout(reset, 200);
  };

  const canAdvance =
    step === 1 ? goal !== null : step === 2 ? paper !== null : outcome !== null;

  const finish = () => {
    if (!goal || !paper || !outcome) return;
    onApply(goal, paper, outcome);
    close();
  };

  return (
    <>
      <button
        type="button"
        data-testid="guided-wizard-trigger"
        onClick={() => setOpen(true)}
        title="Bantu Saya Cetak — jawab 3 pertanyaan, kami yang mengatur sisanya"
        aria-label="Bantu Saya Cetak"
        className="flex h-8 items-center justify-center gap-1.5 rounded-md bg-[#003399] px-2.5 text-[11.5px] font-semibold text-white transition-colors hover:bg-[#002673]"
      >
        <Sparkles size={13} strokeWidth={1.8} aria-hidden="true" />
        <span className="hidden sm:inline">Bantu Saya Cetak</span>
      </button>

      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : close())}>
        <DialogContent className="w-[420px] max-w-[94vw] gap-0 rounded-lg border-[#E5E7EB] p-0">
          <DialogHeader className="border-b border-[#E5E7EB] px-5 py-4 text-left">
            <DialogTitle className="flex items-center gap-2 text-[14px] font-semibold text-[#111827]">
              <Sparkles size={15} className="text-[#003399]" aria-hidden="true" />
              Bantu Saya Cetak
            </DialogTitle>
            <DialogDescription className="mt-1 text-[12px] leading-relaxed text-[#6B7280]">
              Jawab 3 pertanyaan — ukuran, margin, susunan, dan kualitas kami
              atur otomatis.
            </DialogDescription>
          </DialogHeader>

          <div className="px-5 py-4">
            <div className="mb-4 flex items-center gap-1.5" aria-hidden="true">
              {[1, 2, 3].map((n) => (
                <span
                  key={n}
                  className={`h-1.5 rounded-full transition-all ${
                    step === n
                      ? "w-6 bg-[#003399]"
                      : step > n
                        ? "w-3 bg-[#003399]/40"
                        : "w-3 bg-[#E5E7EB]"
                  }`}
                />
              ))}
              <span className="ml-2 font-mono text-[10px] text-[#9CA3AF]">
                {step}/3
              </span>
            </div>

            {step === 1 ? (
              <div role="radiogroup" aria-label="Mau mencetak apa?">
                <p className="mb-2 text-[12.5px] font-semibold text-[#111827]">
                  1. Mau mencetak apa?
                </p>
                <div className="grid grid-cols-1 gap-1.5">
                  {GOALS.map((g) => (
                    <OptionRow
                      key={g.id}
                      selected={goal === g.id}
                      onSelect={() => setGoal(g.id)}
                      label={g.label}
                      hint={g.hint}
                      icon={g.icon}
                    />
                  ))}
                </div>
              </div>
            ) : step === 2 ? (
              <div role="radiogroup" aria-label="Kertas yang digunakan?">
                <p className="mb-2 text-[12.5px] font-semibold text-[#111827]">
                  2. Kertas yang digunakan?
                </p>
                <div className="grid grid-cols-1 gap-1.5">
                  {PAPERS.map((p) => (
                    <OptionRow
                      key={p.id}
                      selected={paper === p.id}
                      onSelect={() => setPaper(p.id)}
                      label={p.label}
                      hint={p.hint}
                      icon={FileText}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div role="radiogroup" aria-label="Hasil yang diinginkan?">
                <p className="mb-2 text-[12.5px] font-semibold text-[#111827]">
                  3. Hasil yang diinginkan?
                </p>
                <div className="grid grid-cols-1 gap-1.5">
                  {OUTCOMES.map((o) => (
                    <OptionRow
                      key={o.id}
                      selected={outcome === o.id}
                      onSelect={() => setOutcome(o.id)}
                      label={o.label}
                      hint={o.hint}
                      icon={o.icon}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-[#E5E7EB] px-5 py-3">
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(1, s - 1))}
              disabled={step === 1}
              className="flex h-8 items-center gap-1 rounded-md px-2.5 text-[11.5px] font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB] disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ArrowLeft size={13} strokeWidth={1.8} aria-hidden="true" />
              Kembali
            </button>
            {step < 3 ? (
              <button
                type="button"
                onClick={() => setStep((s) => Math.min(3, s + 1))}
                disabled={!canAdvance}
                className="flex h-8 items-center gap-1.5 rounded-md bg-[#003399] px-3.5 text-[11.5px] font-semibold text-white transition-colors hover:bg-[#002673] disabled:cursor-not-allowed disabled:opacity-45"
              >
                Lanjut
                <ArrowRight size={13} strokeWidth={1.8} aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                data-testid="guided-wizard-apply"
                onClick={finish}
                disabled={!canAdvance}
                className="flex h-8 items-center gap-1.5 rounded-md bg-[#003399] px-3.5 text-[11.5px] font-semibold text-white transition-colors hover:bg-[#002673] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Check size={13} strokeWidth={2} aria-hidden="true" />
                Rapikan &amp; Siapkan Cetak
              </button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
