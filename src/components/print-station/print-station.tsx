"use client";

// Epson Print Station — boot directly into the functional print workspace.

import { useState } from "react";
import { toast } from "sonner";
import { usePrintStation } from "@/hooks/use-print-station";
import { TopBar } from "./top-bar";
import { PreviewStage } from "./preview-stage";
import { InspectorSidebar } from "./inspector-sidebar";

export function PrintStation() {
  const store = usePrintStation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handlePrintModeChange = (mode: "browser" | "spooler") => {
    store.setSetting("printMode", mode);
    if (mode === "spooler" && store.spooler.state !== "available") {
      toast.info("Spooler lokal tidak terdeteksi", {
        description:
          "Mode Direct Spooler memerlukan EPSON_PRINTER_URL (IPP) atau CUPS (lp) pada mesin server. Mode Browser Print tetap berfungsi penuh.",
      });
    }
  };

  return (
    <div className="flex h-screen min-h-0 flex-col bg-[#F4F5F7] text-[#111827]">
      <TopBar
        paperId={store.settings.paperId}
        onPaperChange={(id) => store.setSetting("paperId", id)}
        printMode={store.settings.printMode}
        onPrintModeChange={handlePrintModeChange}
        spooler={store.spooler}
        onOpenSidebar={() => setSidebarOpen(true)}
      />

      <main className="flex min-h-0 flex-1">
        <PreviewStage
          file={store.activeFile}
          files={store.files}
          activeQueueId={store.activeFile?.id ?? null}
          paperWmm={store.paperWmm}
          paperHmm={store.paperHmm}
          scale={store.contentScale}
          grayscale={store.settings.colorMode === "grayscale"}
          showMargins={store.showMargins}
          zoom={store.zoom}
          page={store.page}
          pageCount={store.activeFile?.pageCount ?? null}
          continuous={!!store.activeFile?.continuous}
          mismatch={store.paperMismatch}
          overflow={store.contentOverflows}
          scaleMode={store.settings.scaleMode}
          paperShortLabel={store.paper.shortLabel}
          onFiles={store.addFiles}
          onSamples={() => void store.loadSamples()}
          onSelect={store.selectFile}
          onRemove={store.removeFile}
          onPageChange={store.setPage}
          onZoomChange={store.setZoom}
          onToggleMargins={() => store.setShowMargins(!store.showMargins)}
          onEstimatePages={store.reportEstimatedPages}
          getPdfDoc={store.getPdfDoc}
          getDocxRender={store.getDocxRender}
          getDocHtml={store.getDocHtml}
          duplexAssist={store.duplexAssist}
          onPrintEven={() => void store.printEvenPass()}
          onCancelDuplex={store.cancelDuplex}
        />

        <InspectorSidebar
          file={store.activeFile}
          settings={store.settings}
          onSetting={store.setSetting}
          rangeInvalid={store.rangeInvalid}
          summary={store.summary}
          canPrint={store.canPrint}
          printing={store.printing}
          onPrint={() => void store.triggerPrint()}
          mobileOpen={sidebarOpen}
          onOpenChange={setSidebarOpen}
        />
      </main>
    </div>
  );
}
