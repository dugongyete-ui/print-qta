"use client";

// Central workspace state: file intake + inspection, print settings,
// auto-fit-to-tray logic, and the dual-mode print execution paths.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { toast } from "sonner";
import {
  PT_TO_MM,
  PX96_TO_MM,
  getPaper,
  matchPaper,
  paperDims,
  parsePageRange,
  sizeLabel,
} from "@/lib/paper";
import {
  DEFAULT_SETTINGS,
  MAX_FILE_BYTES,
  type DocxRender,
  type LoadedFile,
  type PrintSettings,
  type SpoolerState,
} from "@/lib/print-station/types";
import { printViaBrowser } from "@/lib/print-station/engine";

// ---------------------------------------------------------------------------
// Module-level document caches (survive component re-renders)
// ---------------------------------------------------------------------------
const pdfTaskCache = new Map<string, Promise<PDFDocumentLoadingTask>>();
const docxRenderCache = new Map<string, Promise<DocxRender>>();
const docHtmlCache = new Map<string, Promise<string>>();

const ACCEPTED_EXT: Record<string, { kind: LoadedFile["kind"]; mime: string }> = {
  pdf: { kind: "pdf", mime: "application/pdf" },
  doc: { kind: "doc", mime: "application/msword" },
  docx: {
    kind: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
};

function newId(): string {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...Array.from(bytes.subarray(i, i + chunk)),
    );
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Document inspection pipelines
// ---------------------------------------------------------------------------

function loadPdfTask(file: LoadedFile): Promise<PDFDocumentLoadingTask> {
  const cached = pdfTaskCache.get(file.id);
  if (cached) return cached;
  const task = (async () => {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    // pdf.js may transfer the buffer to the worker — always hand it a copy.
    const data = file.bytes!.slice();
    return pdfjs.getDocument({ data });
  })();
  pdfTaskCache.set(file.id, task);
  return task;
}

async function loadPdfDoc(file: LoadedFile): Promise<PDFDocumentProxy> {
  const task = await loadPdfTask(file);
  return task.promise;
}

async function inspectPdf(file: LoadedFile): Promise<Partial<LoadedFile>> {
  try {
    const doc = await loadPdfDoc(file);
    const page1 = await doc.getPage(1);
    const vp = page1.getViewport({ scale: 1 });
    const wMm = vp.width * PT_TO_MM;
    const hMm = vp.height * PT_TO_MM;
    const matched = matchPaper(wMm, hMm);
    return {
      status: "ready",
      pageCount: doc.numPages,
      docWidthMm: wMm,
      docHeightMm: hMm,
      docLabel: matched ? getPaper(matched).shortLabel : sizeLabel(wMm, hMm),
    };
  } catch {
    pdfTaskCache.delete(file.id);
    return {
      status: "error",
      error: "Dokumen PDF rusak, terproteksi, atau tidak dapat dibaca.",
    };
  }
}

async function inspectImage(file: LoadedFile): Promise<Partial<LoadedFile>> {
  if (!file.bytes) {
    return { status: "error", error: "Data gambar kosong." };
  }
  const url = URL.createObjectURL(
    new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: file.mime }),
  );
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode"));
      el.src = url;
    });
    return {
      status: "ready",
      url,
      pageCount: 1,
      docWidthMm: img.naturalWidth * PX96_TO_MM,
      docHeightMm: img.naturalHeight * PX96_TO_MM,
      docLabel: `${img.naturalWidth} × ${img.naturalHeight} px`,
    };
  } catch {
    URL.revokeObjectURL(url);
    return { status: "error", error: "Gambar tidak dapat dibaca atau rusak." };
  }
}

async function renderDocx(file: LoadedFile): Promise<DocxRender> {
  const cached = docxRenderCache.get(file.id);
  if (cached) return cached;
  const task = (async () => {
    const docxPreview = await import("docx-preview");
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;left:-100000px;top:0;width:1200px;visibility:hidden;";
    document.body.appendChild(host);
    try {
      await docxPreview.renderAsync(
        new Blob([file.bytes!.slice().buffer as ArrayBuffer], { type: file.mime }),
        host,
        host,
        {
          inWrapper: true,
          breakPages: true,
          experimental: true,
          renderHeaders: true,
          renderFooters: true,
          useBase64URL: true,
          ignoreWidth: false,
          ignoreHeight: false,
        },
      );
      const wrapper = host.querySelector(".docx-wrapper");
      const sections = wrapper
        ? Array.from(wrapper.querySelectorAll("section.docx"))
        : Array.from(host.querySelectorAll("section.docx"));
      if (sections.length === 0) throw new Error("no-sections");
      const first = sections[0] as HTMLElement;
      const wpx = first.offsetWidth || Math.round(210 * (96 / 25.4));
      const hpx = first.offsetHeight || Math.round(297 * (96 / 25.4));
      return {
        sectionsHtml: sections.map((s) => (s as HTMLElement).outerHTML),
        pageWpx: wpx,
        pageHpx: hpx,
        pageWmm: wpx * PX96_TO_MM,
        pageHmm: hpx * PX96_TO_MM,
        pageCount: sections.length,
      } satisfies DocxRender;
    } finally {
      host.remove();
    }
  })();
  docxRenderCache.set(file.id, task);
  return task;
}

async function convertViaServer(file: LoadedFile): Promise<string> {
  const cached = docHtmlCache.get(file.id);
  if (cached) return cached;
  const task = (async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([file.bytes!.slice().buffer as ArrayBuffer], { type: file.mime }),
      file.name,
    );
    const res = await fetch("/api/convert-docx", { method: "POST", body: form });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new Error(body?.message ?? "Konversi dokumen gagal di server.");
    }
    const body = (await res.json()) as { html: string };
    return body.html;
  })();
  docHtmlCache.set(file.id, task);
  return task;
}

async function inspectWord(file: LoadedFile): Promise<Partial<LoadedFile>> {
  // 1st choice: client-side docx-preview (true pagination + layout)
  if (file.kind === "docx") {
    try {
      const render = await renderDocx(file);
      const matched = matchPaper(render.pageWmm, render.pageHmm);
      return {
        status: "ready",
        pageCount: render.pageCount,
        docWidthMm: render.pageWmm,
        docHeightMm: render.pageHmm,
        docLabel: matched ? getPaper(matched).shortLabel : sizeLabel(render.pageWmm, render.pageHmm),
      };
    } catch {
      docxRenderCache.delete(file.id);
      // fall through to server-side mammoth
    }
  }
  // 2nd choice: server conversion (mammoth / LibreOffice headless)
  try {
    await convertViaServer(file);
    return {
      status: "ready",
      continuous: true,
      pageCount: 1,
      docWidthMm: 210,
      docHeightMm: 297,
      docLabel: "Halaman Mengalir",
    };
  } catch (err) {
    return {
      status: "error",
      error:
        err instanceof Error
          ? err.message
          : "Konversi dokumen gagal. Simpan ulang sebagai .docx atau PDF.",
    };
  }
}

// ---------------------------------------------------------------------------

export interface DuplexAssist {
  evenPages: number[];
}

export function usePrintStation() {
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [settings, setSettings] = useState<PrintSettings>(DEFAULT_SETTINGS);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<"fit" | "100">("fit");
  const [showMargins, setShowMargins] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [duplexAssist, setDuplexAssist] = useState<DuplexAssist | null>(null);
  const [spooler, setSpooler] = useState<SpoolerState>({
    state: "checking",
    info: null,
  });

  const activeFile = useMemo(
    () => files.find((f) => f.id === activeId) ?? null,
    [files, activeId],
  );
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // -- derived paper geometry -----------------------------------------------
  const paper = getPaper(settings.paperId);
  const { wMm: paperWmm, hMm: paperHmm } = paperDims(
    settings.paperId,
    settings.orientation,
  );

  const contentScale = useMemo(() => {
    const f = activeFile;
    if (!f || f.docWidthMm == null || f.docWidthMm <= 0) return 1;
    if (settings.scaleMode !== "fit" || f.continuous) return 1;
    const paperW = paperWmm;
    const paperH = paperHmm;
    return Math.min(paperW / f.docWidthMm, paperH / (f.docHeightMm || 1));
  }, [activeFile, settings.scaleMode, paperWmm, paperHmm]);

  const paperMismatch = useMemo(() => {
    const f = activeFile;
    if (!f || f.docWidthMm == null || f.continuous) return false;
    return matchPaper(f.docWidthMm, f.docHeightMm ?? 0) !== settings.paperId;
  }, [activeFile, settings.paperId]);

  const contentOverflows = useMemo(() => {
    const f = activeFile;
    if (!f || f.docWidthMm == null || f.continuous) return false;
    const s = settings.scaleMode === "fit" ? contentScale : 1;
    return (
      f.docWidthMm * s > paperWmm + 0.5 || (f.docHeightMm ?? 0) * s > paperHmm + 0.5
    );
  }, [activeFile, contentScale, settings.scaleMode, paperWmm, paperHmm]);

  // -- page range -------------------------------------------------------------
  const selectedPages = useMemo(() => {
    const f = activeFile;
    if (!f || f.status !== "ready" || !f.pageCount) return [];
    if (settings.rangeMode === "all") {
      return Array.from({ length: f.pageCount }, (_, i) => i + 1);
    }
    const parsed = parsePageRange(settings.rangeText, f.pageCount);
    return parsed.valid ? parsed.pages : [];
  }, [activeFile, settings.rangeMode, settings.rangeText]);

  const rangeInvalid =
    settings.rangeMode === "custom" &&
    !parsePageRange(settings.rangeText, activeFile?.pageCount ?? 1).valid;

  const selectedPagesRef = useRef<number[]>([]);
  selectedPagesRef.current = selectedPages;

  const canPrint =
    !!activeFile &&
    activeFile.status === "ready" &&
    selectedPages.length > 0 &&
    !printing;

  // -- spooler detection ------------------------------------------------------
  useEffect(() => {
    let alive = true;
    fetch("/api/print")
      .then((r) => r.json())
      .then((body: { spooler: { type: "ipp" | "lp"; printer: string | null } | null }) => {
        if (!alive) return;
        setSpooler(
          body.spooler
            ? { state: "available", info: body.spooler }
            : { state: "unavailable", info: null },
        );
      })
      .catch(() => alive && setSpooler({ state: "unavailable", info: null }));
    return () => {
      alive = false;
    };
  }, []);

  // -- auto-fit to loaded tray ------------------------------------------------
  const autoFitKey = useRef<string | null>(null);
  useEffect(() => {
    const f = activeFile;
    if (!f || f.status !== "ready" || f.docWidthMm == null || f.continuous) return;
    const key = `${f.id}:${settings.paperId}`;
    if (autoFitKey.current === key) return;
    const matched = matchPaper(f.docWidthMm, f.docHeightMm ?? 0);
    if (matched !== settings.paperId) {
      autoFitKey.current = key;
      setSettings((s) => (s.scaleMode === "fit" ? s : { ...s, scaleMode: "fit" }));
    }
  }, [activeFile, settings.paperId]);

  // -- file intake ------------------------------------------------------------
  const patchFile = useCallback((id: string, patch: Partial<LoadedFile>) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  const addFiles = useCallback(
    (incoming: File[]) => {
      for (const file of incoming) {
        const ext = (file.name.split(".").pop() ?? "").toLowerCase();
        const accepted = ACCEPTED_EXT[ext];
        if (!accepted) {
          toast.error(`Format .${ext || "?"} tidak didukung.`, {
            description: `${file.name} — gunakan PDF, DOC, DOCX, PNG, atau JPG.`,
          });
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          toast.error(`Ukuran file melebihi 50 MB.`, {
            description: file.name,
          });
          continue;
        }
        const id = newId();
        const loaded: LoadedFile = {
          id,
          name: file.name,
          ext,
          sizeBytes: file.size,
          kind: accepted.kind,
          mime: accepted.mime,
          bytes: null,
          url: null,
          status: "loading",
          pageCount: null,
          docWidthMm: null,
          docHeightMm: null,
          docLabel: null,
        };
        setFiles((prev) => [...prev, loaded]);
        setActiveId((cur) => cur ?? id);
        setPage(1);

        file
          .arrayBuffer()
          .then(async (buf) => {
            const bytes = new Uint8Array(buf);
            patchFile(id, { bytes });
            const probe: LoadedFile = { ...loaded, bytes };
            const patch =
              accepted.kind === "pdf"
                ? await inspectPdf(probe)
                : accepted.kind === "image"
                  ? await inspectImage(probe)
                  : await inspectWord(probe);
            patchFile(id, patch);
            if (patch.status === "error" && patch.error) {
              toast.error("Dokumen tidak dapat dibuka", {
                description: `${file.name} — ${patch.error}`,
              });
            }
          })
          .catch(() => {
            patchFile(id, {
              status: "error",
              error: "Gagal membaca file dari disk.",
            });
          });
      }
    },
    [patchFile],
  );

  const removeFile = useCallback(
    (id: string) => {
      const task = pdfTaskCache.get(id);
      if (task) {
        task.then((t) => t.destroy()).catch(() => {});
        pdfTaskCache.delete(id);
      }
      docxRenderCache.delete(id);
      docHtmlCache.delete(id);
      const file = files.find((f) => f.id === id);
      if (file?.url) URL.revokeObjectURL(file.url);
      const next = files.filter((f) => f.id !== id);
      setFiles(next);
      if (id === activeId) {
        const fallback = next.find((f) => f.status === "ready") ?? next[0] ?? null;
        setActiveId(fallback ? fallback.id : null);
        setPage(1);
      }
    },
    [files, activeId],
  );

  const selectFile = useCallback((id: string) => {
    setActiveId(id);
    setPage(1);
  }, []);

  const setSetting = useCallback(
    <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) => {
      setSettings((s) => ({ ...s, [key]: value }));
    },
    [],
  );

  // -- estimated page count for continuous HTML documents ---------------------
  const reportEstimatedPages = useCallback(
    (fileId: string, pages: number) => {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId && f.continuous && f.pageCount !== pages
            ? { ...f, pageCount: pages }
            : f,
        ),
      );
    },
    [],
  );

  // -- print execution --------------------------------------------------------
  const buildPrintRequest = useCallback(
    (pages: number[]) => {
      const f = activeFileRef.current;
      const s = settingsRef.current;
      if (!f) return null;
      return {
        file: f,
        paperWmm: paperDims(s.paperId, s.orientation).wMm,
        paperHmm: paperDims(s.paperId, s.orientation).hMm,
        scaleMode: s.scaleMode,
        colorMode: s.colorMode,
        pages,
        copies: s.copies,
        getPdfDoc: () => loadPdfDoc(f),
        getDocxRender: () => renderDocx(f),
        getDocHtml: () => convertViaServer(f),
      };
    },
    [],
  );

  const printPages = useCallback(async (pages: number[]) => {
    const req = buildPrintRequest(pages);
    if (!req) return;
    await printViaBrowser(req);
  }, [buildPrintRequest]);

  const spoolPrint = useCallback(async () => {
    const f = activeFileRef.current;
    const s = settingsRef.current;
    const pages = selectedPagesRef.current;
    if (!f || !f.bytes) return;
    const dims = paperDims(s.paperId, s.orientation);
    const res = await fetch("/api/print", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job: {
          fileName: f.name,
          mime: f.mime,
          kind: f.kind,
          paperId: s.paperId,
          ippMedia: getPaper(s.paperId).ippMedia,
          paperWmm: dims.wMm,
          paperHmm: dims.hMm,
          orientation: s.orientation,
          colorMode: s.colorMode,
          quality: s.quality,
          copies: s.copies,
          duplex: s.duplex,
          scaleMode: s.scaleMode,
          pages,
        },
        data: toBase64(f.bytes),
      }),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; jobId?: string; message?: string; spooler?: string }
      | null;
    if (!res.ok || !body?.ok) {
      toast.error("Direct Spooler menolak pekerjaan cetak", {
        description: body?.message ?? "Spooler lokal tidak tersedia.",
      });
      return;
    }
    toast.success("Pekerjaan cetak terkirim", {
      description: `${body.spooler ?? "spooler"} • job ${body.jobId ?? "-"}`,
    });
  }, []);

  const triggerPrint = useCallback(async () => {
    const f = activeFileRef.current;
    const s = settingsRef.current;
    const pages = selectedPagesRef.current;
    if (!f || f.status !== "ready" || pages.length === 0 || printing) return;

    setPrinting(true);
    try {
      if (s.printMode === "spooler") {
        await spoolPrint();
        return;
      }
      // Manual duplex: pass 1 = odd pages, pass 2 (user-driven) = even pages reversed
      if (s.duplex && pages.length > 1) {
        const odd = pages.filter((p) => p % 2 === 1);
        await printPages(odd.length > 0 ? odd : pages);
        const even = pages.filter((p) => p % 2 === 0).reverse();
        if (even.length > 0) setDuplexAssist({ evenPages: even });
        return;
      }
      await printPages(pages);
    } catch (err) {
      toast.error("Cetak gagal", {
        description: err instanceof Error ? err.message : "Kesalahan tidak diketahui.",
      });
    } finally {
      setPrinting(false);
    }
  }, [printing, printPages, spoolPrint]);

  const printEvenPass = useCallback(async () => {
    if (!duplexAssist) return;
    setPrinting(true);
    try {
      await printPages(duplexAssist.evenPages);
    } catch (err) {
      toast.error("Cetak sisi genap gagal", {
        description: err instanceof Error ? err.message : "Kesalahan tidak diketahui.",
      });
    } finally {
      setPrinting(false);
      setDuplexAssist(null);
    }
  }, [duplexAssist, printPages]);

  const cancelDuplex = useCallback(() => setDuplexAssist(null), []);

  // Ctrl+P / Cmd+P shortcut
  const triggerRef = useRef(triggerPrint);
  triggerRef.current = triggerPrint;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        void triggerRef.current();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const loadSamples = useCallback(async () => {
    try {
      const samples: Array<[string, string]> = [
        ["/samples/sample-letter.pdf", "Surat-Kwitansi-Letter.pdf"],
        ["/samples/sample-warna.png", "Grafik-Warna.png"],
        ["/samples/sample-dokumen.docx", "Laporan-Dokumen.docx"],
      ];
      const fetched: File[] = [];
      for (const [url, name] of samples) {
        const res = await fetch(url);
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        const ext = name.split(".").pop()!.toLowerCase();
        const mime =
          ext === "pdf"
            ? "application/pdf"
            : ext === "png"
              ? "image/png"
              : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        fetched.push(new File([buf], name, { type: mime }));
      }
      if (fetched.length > 0) addFiles(fetched);
    } catch {
      toast.error("Contoh dokumen tidak dapat dimuat.");
    }
  }, [addFiles]);

  // clamp preview page
  useEffect(() => {
    const total = activeFile?.pageCount ?? 1;
    if (page > total) setPage(Math.max(1, total));
  }, [activeFile?.pageCount, page]);

  const summary = useMemo(() => {
    const paperShort = paper.shortLabel;
    const color = settings.colorMode === "color" ? "Berwarna" : "Hitam Putih";
    const pagesCount = selectedPages.length;
    const copies = settings.copies;
    const base = `${paperShort} • ${color} • ${pagesCount} Hal × ${copies} Salinan`;
    return settings.duplex ? `${base} • Bolak-Balik` : base;
  }, [paper.shortLabel, settings.colorMode, settings.copies, settings.duplex, selectedPages.length]);

  return {
    // state
    files,
    activeFile,
    settings,
    page,
    zoom,
    showMargins,
    printing,
    duplexAssist,
    spooler,
    paper,
    paperWmm,
    paperHmm,
    contentScale,
    paperMismatch,
    contentOverflows,
    selectedPages,
    rangeInvalid,
    canPrint,
    summary,
    // actions
    addFiles,
    removeFile,
    selectFile,
    setSetting,
    setPage,
    setZoom,
    setShowMargins,
    triggerPrint,
    printEvenPass,
    cancelDuplex,
    reportEstimatedPages,
    loadSamples,
    // document accessors for renderers
    getPdfDoc: loadPdfDoc,
    getDocxRender: renderDocx,
    getDocHtml: convertViaServer,
  };
}

export type PrintStationStore = ReturnType<typeof usePrintStation>;
