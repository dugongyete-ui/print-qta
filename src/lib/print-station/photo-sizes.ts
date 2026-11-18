// Standard photo print size presets for the photo layout editor.
// All values are millimeters (portrait orientation of the photo).

export type PhotoPresetGroup = "pas" | "r" | "square" | "custom";

export interface PhotoPreset {
  id: string;
  /** Full label e.g. "4R — 102 × 152 mm (4 × 6 inci)" */
  label: string;
  /** Compact label e.g. "4R" for summary lines */
  short: string;
  wMm: number;
  hMm: number;
  group: PhotoPresetGroup;
}

export const PHOTO_PRESETS: PhotoPreset[] = [
  // Pas foto standar Indonesia & dokumen perjalanan
  {
    id: "pf-2x3",
    label: "Pas Foto 2 × 3 cm",
    short: "2×3 cm",
    wMm: 20,
    hMm: 30,
    group: "pas",
  },
  {
    id: "pf-3x4",
    label: "Pas Foto 3 × 4 cm",
    short: "3×4 cm",
    wMm: 30,
    hMm: 40,
    group: "pas",
  },
  {
    id: "pf-35x45",
    label: "Pas Foto 3,5 × 4,5 cm (Visa)",
    short: "3,5×4,5",
    wMm: 35,
    hMm: 45,
    group: "pas",
  },
  {
    id: "pf-4x6",
    label: "Pas Foto 4 × 6 cm",
    short: "4×6 cm",
    wMm: 40,
    hMm: 60,
    group: "pas",
  },
  {
    id: "pf-2x3in",
    label: "Pas Foto 2 × 3 inci (Paspor)",
    short: "2×3 in",
    wMm: 50.8,
    hMm: 76.2,
    group: "pas",
  },
  // Seri R — kertas foto retail
  {
    id: "p-2r",
    label: "2R — 64 × 89 mm (2,5 × 3,5 inci)",
    short: "2R",
    wMm: 64,
    hMm: 89,
    group: "r",
  },
  {
    id: "p-3r",
    label: "3R — 89 × 127 mm (3,5 × 5 inci)",
    short: "3R",
    wMm: 89,
    hMm: 127,
    group: "r",
  },
  {
    id: "p-4r",
    label: "4R — 102 × 152 mm (4 × 6 inci)",
    short: "4R",
    wMm: 102,
    hMm: 152,
    group: "r",
  },
  {
    id: "p-5r",
    label: "5R — 127 × 178 mm (5 × 7 inci)",
    short: "5R",
    wMm: 127,
    hMm: 178,
    group: "r",
  },
  {
    id: "p-6r",
    label: "6R — 152 × 203 mm (6 × 8 inci)",
    short: "6R",
    wMm: 152,
    hMm: 203,
    group: "r",
  },
  {
    id: "p-8r",
    label: "8R — 203 × 254 mm (8 × 10 inci)",
    short: "8R",
    wMm: 203,
    hMm: 254,
    group: "r",
  },
  {
    id: "p-8rp",
    label: "8R+ — 203 × 305 mm (8 × 12 inci)",
    short: "8R+",
    wMm: 203,
    hMm: 305,
    group: "r",
  },
  // Kotak
  {
    id: "sq-5",
    label: "Kotak — 5 × 5 cm",
    short: "5×5 cm",
    wMm: 50,
    hMm: 50,
    group: "square",
  },
  {
    id: "sq-8",
    label: "Kotak — 8 × 8 cm",
    short: "8×8 cm",
    wMm: 80,
    hMm: 80,
    group: "square",
  },
  {
    id: "sq-10",
    label: "Kotak — 10 × 10 cm",
    short: "10×10 cm",
    wMm: 100,
    hMm: 100,
    group: "square",
  },
  {
    id: "custom",
    label: "Kustom — atur bebas (mm)",
    short: "Kustom",
    wMm: 102,
    hMm: 152,
    group: "custom",
  },
];

export const DEFAULT_PHOTO_PRESET_ID = "p-4r";

export const PHOTO_GROUP_LABEL: Record<PhotoPresetGroup, string> = {
  pas: "Pas Foto",
  r: "Seri R (Kertas Foto)",
  square: "Kotak",
  custom: "Kustom",
};

export function getPhotoPreset(id: string): PhotoPreset {
  return PHOTO_PRESETS.find((p) => p.id === id) ?? PHOTO_PRESETS[6]; // 4R fallback
}

/** Human-readable mm label e.g. "102 × 152 mm". */
export function presetDimsLabel(preset: PhotoPreset): string {
  const w = Math.round(preset.wMm * 10) / 10;
  const h = Math.round(preset.hMm * 10) / 10;
  return `${w} × ${h} mm`;
}
