"use client";

// Always-visible print execution bar for tablet / mobile (<lg) viewports.
// The desktop inspector sidebar carries its own sticky footer; this bar
// guarantees the primary "Cetak ke Epson" action is reachable at every
// breakpoint, with the monospace job summary alongside it.

interface PrintActionBarProps {
  summary: string;
  rangeInvalid: boolean;
  canPrint: boolean;
  printing: boolean;
  onPrint: () => void;
}

export function PrintActionBar({
  summary,
  rangeInvalid,
  canPrint,
  printing,
  onPrint,
}: PrintActionBarProps) {
  return (
    <footer
      className="z-20 shrink-0 border-t border-[#E5E7EB] bg-white px-3 pt-2 lg:hidden"
      style={{ paddingBottom: "max(8px, env(safe-area-inset-bottom))" }}
    >
      {/* Phones: compact summary line above the action row */}
      <p
        className={`mb-1.5 truncate text-center font-mono text-[10.5px] tabular-nums sm:hidden ${
          rangeInvalid ? "text-[#92400E]" : "text-[#374151]"
        }`}
      >
        {rangeInvalid ? "Periksa rentang halaman" : summary}
      </p>

      <div className="flex items-center gap-2">
        {/* sm–lg: inline summary centered in the leftover space */}
        <p
          className={`hidden min-w-0 flex-1 truncate text-center font-mono text-[11.5px] tabular-nums sm:block ${
            rangeInvalid ? "text-[#92400E]" : "text-[#374151]"
          }`}
        >
          {rangeInvalid ? "Periksa rentang halaman" : summary}
        </p>

        <button
          type="button"
          onClick={onPrint}
          disabled={!canPrint || printing}
          className="flex h-10 flex-1 items-center justify-center gap-2 rounded-md bg-[#003399] text-[13px] font-semibold text-white transition-colors hover:bg-[#002673] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#003399] sm:flex-none sm:px-6"
        >
          {printing ? (
            "Menyiapkan…"
          ) : (
            <>
              Cetak ke Epson
              <span className="hidden rounded bg-white/15 px-1.5 py-0.5 font-mono text-[10px] font-normal sm:inline">
                Ctrl P
              </span>
            </>
          )}
        </button>
      </div>
    </footer>
  );
}
