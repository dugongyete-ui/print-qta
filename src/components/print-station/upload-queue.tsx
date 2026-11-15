"use client";

// Structured drop zone shown when the workspace is empty + the file queue strip.

import { useRef, useState } from "react";
import { FileText, FileUp, Image as ImageIcon, Loader2, TriangleAlert, X } from "lucide-react";
import { formatBytes } from "@/lib/paper";
import type { LoadedFile } from "@/lib/print-station/types";

const FORMAT_BADGES = ["PDF", "DOC", "DOCX", "PNG", "JPG"];

interface DropzoneProps {
  onFiles: (files: File[]) => void;
  onSamples: () => void;
  dragging: boolean;
}

export function UploadDropzone({ onFiles, onSamples, dragging }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="flex w-full max-w-[520px] flex-col items-center">
        <label
          className={`flex w-full cursor-pointer flex-col items-center rounded-lg border-2 border-dashed bg-white px-8 py-12 text-center transition-colors ${
            dragging
              ? "border-[#003399]"
              : "border-[#D1D5DB] hover:border-[#9CA3AF]"
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
            className="sr-only"
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              if (list.length > 0) onFiles(list);
              e.target.value = "";
            }}
          />
          <FileUp size={26} strokeWidth={1.5} className="text-[#6B7280]" aria-hidden="true" />
          <p className="mt-3 text-[15px] font-semibold text-[#111827]">Unggah Dokumen</p>
          <p className="mt-1 text-[13px] leading-relaxed text-[#6B7280]">
            Seret &amp; letakkan file di sini, atau klik untuk memilih
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-1.5">
            {FORMAT_BADGES.map((b) => (
              <span
                key={b}
                className="rounded border border-[#E5E7EB] bg-[#F9FAFB] px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide text-[#374151]"
              >
                {b}
              </span>
            ))}
          </div>
          <p className="mt-3 font-mono text-[11px] text-[#6B7280]">Maks. 50 MB per file</p>
        </label>
        <button
          type="button"
          onClick={onSamples}
          className="mt-4 rounded px-2 py-1 text-[11px] text-[#6B7280] underline decoration-[#D1D5DB] underline-offset-2 transition-colors hover:text-[#003399]"
        >
          Uji dengan contoh dokumen (PDF + PNG + DOCX)
        </button>
      </div>
    </div>
  );
}

interface QueueProps {
  files: LoadedFile[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}

function kindIcon(kind: LoadedFile["kind"]) {
  if (kind === "image") return <ImageIcon size={13} strokeWidth={1.5} className="shrink-0 text-[#6B7280]" />;
  return <FileText size={13} strokeWidth={1.5} className="shrink-0 text-[#6B7280]" />;
}

export function FileQueue({ files, activeId, onSelect, onRemove }: QueueProps) {
  if (files.length === 0) return null;
  return (
    <div className="flex shrink-0 items-start gap-2 overflow-x-auto px-4 pb-2 pt-3 ps-scroll">
      {files.map((f) => {
        const active = f.id === activeId;
        return (
          <div
            key={f.id}
            role="button"
            tabIndex={0}
            aria-pressed={active}
            aria-label={`Pilih dokumen ${f.name}`}
            onClick={() => onSelect(f.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(f.id);
              }
            }}
            className={`group flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md border bg-white px-2.5 transition-colors ${
              active
                ? "border-[#003399]"
                : "border-[#E5E7EB] hover:border-[#C7CDD6]"
            }`}
          >
            {kindIcon(f.kind)}
            <span className="max-w-[150px] truncate text-[12px] font-medium text-[#111827]">
              {f.name}
            </span>
            <span className="whitespace-nowrap font-mono text-[10px] tabular-nums text-[#6B7280]">
              {f.status === "loading" ? (
                <Loader2 size={11} className="animate-spin text-[#6B7280]" />
              ) : f.status === "error" ? (
                <TriangleAlert size={11} className="text-[#F59E0B]" />
              ) : (
                `${formatBytes(f.sizeBytes)}${f.pageCount ? ` • ${f.pageCount} hal` : ""}`
              )}
            </span>
            <button
              type="button"
              aria-label={`Hapus ${f.name} dari daftar`}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(f.id);
              }}
              className="flex h-5 w-5 items-center justify-center rounded text-[#9CA3AF] opacity-0 transition-opacity hover:bg-[#F3F4F6] hover:text-[#111827] group-hover:opacity-100"
            >
              <X size={12} strokeWidth={1.5} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
