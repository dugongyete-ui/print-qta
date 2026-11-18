"use client";

// Epson Print Station — boot directly into the functional print workspace.

import { useState } from "react";
import { toast } from "sonner";
import { usePrintStation } from "@/hooks/use-print-station";
import { TopBar, type WorkMode } from "./top-bar";
import { PreviewStage } from "./preview-stage";
import { InspectorSidebar } from "./inspector-sidebar";
import { PrintActionBar } from "./print-action-bar";

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

  const handleWorkModeChange = (mode: WorkMode) => {
    store.setPhotoMode(mode === "photo");
  };

  return (
    <div className="flex h-screen min-h-0 flex-col bg-[#F4F5F7] text-[#111827]">
      <TopBar
        workMode={store.photoMode ? "photo" : "doc"}
        onWorkModeChange={handleWorkModeChange}
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
          photo={
            store.photoMode
              ? {
                  placements: store.photoPlacements,
                  selectedId: store.photoSelectedId,
                  marginMm: store.photoSettings.marginMm,
                  lockAspect: store.photoSettings.lockAspect,
                  cutLines: store.photoSettings.cutLines,
                  presetShort: store.photoPreset.short,
                  grayscale: store.settings.colorMode === "grayscale",
                  onSelect: store.selectPhotoPlacement,
                  onUpdate: store.updatePhotoPlacement,
                  onRemove: store.removePhotoPlacement,
                  onDuplicate: store.duplicatePhotoPlacement,
                }
              : null
          }
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
          photoMode={store.photoMode}
          photo={{
            placements: store.photoPlacements,
            selected: store.photoSelected,
            files: store.files,
            settings: store.photoSettings,
            preset: store.photoPreset,
            paperWmm: store.paperWmm,
            paperHmm: store.paperHmm,
            beyondMargin: store.photoBeyondMargin,
            onSetting: store.setPhotoSetting,
            onPreset: store.applyPhotoPreset,
            onUpdateSelected: (patch) => {
              if (store.photoSelected) {
                store.updatePhotoPlacement(store.photoSelected.id, patch);
              }
            },
            onAlign: store.alignPhotoPlacement,
            onFillSheet: store.fillPhotoSheet,
            onArrange: store.autoArrangePhotos,
            onDuplicate: () => {
              if (store.photoSelected) {
                store.duplicatePhotoPlacement(store.photoSelected.id);
              }
            },
            onRemove: () => {
              if (store.photoSelected) {
                store.removePhotoPlacement(store.photoSelected.id);
              }
            },
            onSelect: store.selectPhotoPlacement,
            onClear: store.clearPhotoPlacements,
            onAddImages: store.addAllImagesToSheet,
          }}
        />
      </main>

      {/* Tablet / mobile: persistent print execution bar (<lg) */}
      <PrintActionBar
        summary={store.summary}
        rangeInvalid={store.rangeInvalid}
        canPrint={store.canPrint}
        printing={store.printing}
        onPrint={() => void store.triggerPrint()}
      />
    </div>
  );
}
