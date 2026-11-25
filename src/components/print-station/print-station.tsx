"use client";

// Epson Print Station — boot directly into the functional print workspace.

import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { usePrintStation } from "@/hooks/use-print-station";
import { TopBar, type WorkMode } from "./top-bar";
import { PreviewStage } from "./preview-stage";
import { InspectorSidebar } from "./inspector-sidebar";
import { PrintActionBar } from "./print-action-bar";
import { PhotoCropDialog } from "./photo-crop-dialog";

const emptySubscribe = () => () => {};

export function PrintStation() {
  const store = usePrintStation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** Placement id whose source photo is being cropped (dialog target). */
  const [cropPlacementId, setCropPlacementId] = useState<string | null>(null);
  // The workspace is a pure interactive tool (no SEO content). Rendering an
  // identical shell until hydration completes keeps the SSR tree trivially in
  // sync and eliminates the intermittent Radix Select aria-controls useId
  // mismatch (server/client useId drift) reported on this workspace.
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  if (!mounted) {
    return <div className="h-screen min-h-0 bg-[#F4F5F7]" aria-hidden="true" />;
  }

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
        uiLevel={store.uiLevel}
        onUiLevelChange={store.setUiLevel}
        onApplyGuided={store.applyGuidedChoice}
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
                  selectedIds: store.photoSelectedIds,
                  marginMm: store.photoSettings.marginMm,
                  lockAspect: store.photoSettings.lockAspect,
                  cutLines: store.photoSettings.cutLines,
                  presetShort: store.photoPreset.short,
                  grayscale: store.settings.colorMode === "grayscale",
                  adjust: store.photoSettings.adjust,
                  onSelect: store.selectPhotoPlacement,
                  onSelectIds: store.selectPhotoPlacements,
                  onSelectAll: store.selectAllPhotoPlacements,
                  onUpdateMany: store.updatePhotoPlacements,
                  onRemove: store.removePhotoPlacements,
                  onDuplicate: store.duplicatePhotoPlacements,
                  onChangePhoto: store.replacePhotoItem,
                  onCropPhoto: setCropPlacementId,
                  onCoverPhoto: (id) => store.coverPhotoSheet([id]),
                  onBeginHistory: store.beginPhotoHistory,
                  onEndHistory: store.endPhotoHistory,
                }
              : null
          }
          onFiles={store.addFiles}
          onAddPhotoFiles={store.addPhotoFiles}
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
          photoMode={store.photoMode}
          uiLevel={store.uiLevel}
          preflight={store.preflight}
          onAutoFixPreflight={store.autoFixPreflight}
          onViewProblem={(issue) => {
            const first = issue.placementIds?.[0];
            if (first) store.selectPhotoPlacement(first);
          }}
          onJobPreset={store.applyJobPreset}
          photo={{
            placements: store.photoPlacements,
            selected: store.photoSelected,
            selectedIds: store.photoSelectedIds,
            files: store.files,
            settings: store.photoSettings,
            preset: store.photoPreset,
            paperWmm: store.paperWmm,
            paperHmm: store.paperHmm,
            beyondMargin: store.photoBeyondMargin,
            capacity: store.photoCapacity,
            onSetting: store.setPhotoSetting,
            onBorderless: store.setPhotoBorderless,
            onPreset: store.applyPhotoPreset,
            onUpdateSelected: (patch) => {
              if (store.photoSelected) {
                store.updatePhotoPlacement(store.photoSelected.id, patch);
              }
            },
            onAlign: store.alignPhotoPlacement,
            onFillSheet: store.fillPhotoSheet,
            onArrangeCount: store.arrangePhotoCopies,
            onArrange: store.autoArrangePhotos,
            onDuplicate: store.duplicatePhotoPlacements,
            onRemove: store.removePhotoPlacements,
            onSelect: store.selectPhotoPlacement,
            onSelectAll: store.selectAllPhotoPlacements,
            onClearSelection: store.clearPhotoSelection,
            onClear: store.clearPhotoPlacements,
            onAddImages: store.addAllImagesToSheet,
            onAddPhotoFiles: store.addPhotoFiles,
            onChangePhoto: store.replacePhotoItem,
            onCropPhoto: setCropPlacementId,
            onCoverSheet: store.coverPhotoSheet,
            onOptimize: store.optimizePhotoLayout,
            onExportSheet: (format) => void store.exportPhotoSheet(format),
            onUndoPhoto: store.undoPhoto,
            onRedoPhoto: store.redoPhoto,
            canUndoPhoto: store.canUndoPhoto,
            canRedoPhoto: store.canRedoPhoto,
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
        preflight={store.preflight}
      />

      {/* "Potong Foto" — interactive crop dialog for the targeted slot's photo */}
      <PhotoCropDialog
        placement={
          cropPlacementId
            ? store.photoPlacements.find((p) => p.id === cropPlacementId) ?? null
            : null
        }
        file={
          cropPlacementId
            ? (store.files.find(
                (f) =>
                  f.id ===
                  (store.photoPlacements.find((p) => p.id === cropPlacementId)
                    ?.itemId ?? ""),
              ) ?? null)
            : null
        }
        onApply={store.cropPhotoItem}
        onClose={() => setCropPlacementId(null)}
      />
    </div>
  );
}
