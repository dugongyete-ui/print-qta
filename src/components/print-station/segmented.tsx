"use client";

// Small Swiss-style segmented control shared across the workspace.

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  dot?: "ok" | "off" | "wait";
}

interface SegmentedProps<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}

function Dot({ kind }: { kind: "ok" | "off" | "wait" }) {
  const color =
    kind === "ok" ? "bg-[#10B981]" : kind === "wait" ? "bg-[#9CA3AF] animate-pulse" : "bg-[#9CA3AF]";
  return <span className={`h-1.5 w-1.5 rounded-full ${color}`} aria-hidden="true" />;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  className = "",
  title,
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      title={title}
      className={`inline-flex items-center gap-0.5 rounded-md border border-[#E5E7EB] bg-white p-[3px] ${
        disabled ? "opacity-50 pointer-events-none" : ""
      } ${className}`}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`flex h-[26px] items-center gap-1.5 rounded-[5px] px-2.5 text-[12px] font-medium transition-colors ${
              active
                ? "bg-[#003399] text-white"
                : "text-[#374151] hover:bg-[#F3F4F6]"
            }`}
          >
            {opt.dot ? <Dot kind={opt.dot} /> : null}
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
