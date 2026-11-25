// Ready-made job presets ("Pekerjaan Cepat") — one tap applies a complete,
// field-tested configuration: work mode, paper, photo size, margins, gaps,
// cut lines, quality and the auto-grid arrangement. Presets encode what an
// experienced print-shop operator would set up by hand.

export type JobPresetId =
  | "pasfoto-3x4"
  | "pasfoto-4x6"
  | "lamaran"
  | "visa-paspor"
  | "kartu-identitas"
  | "penuh-a4"
  | "penuh-4r"
  | "doc-hemat"
  | "doc-kualitas"
  | "ttd-scan";

export interface JobPreset {
  id: JobPresetId;
  label: string;
  hint: string;
  /** Which work mode this preset belongs to. */
  mode: "doc" | "photo";
}

export const JOB_PRESETS: JobPreset[] = [
  {
    id: "pasfoto-3x4",
    label: "Pas Foto 3×4",
    hint: "Lembar penuh pas foto 3×4 cm dengan garis potong",
    mode: "photo",
  },
  {
    id: "pasfoto-4x6",
    label: "Pas Foto 4×6",
    hint: "Lembar penuh pas foto 4×6 cm dengan garis potong",
    mode: "photo",
  },
  {
    id: "lamaran",
    label: "Foto Lamaran",
    hint: "8 potret 3×4 cm rata tengah — siap lampiran CV",
    mode: "photo",
  },
  {
    id: "visa-paspor",
    label: "Visa / Paspor",
    hint: "8 potret 3,5×4,5 cm — rasio standar dokumen perjalanan",
    mode: "photo",
  },
  {
    id: "kartu-identitas",
    label: "Kartu Identitas",
    hint: "Depan & belakang ukuran asli 85,6 × 54 mm",
    mode: "photo",
  },
  {
    id: "penuh-a4",
    label: "Foto Penuh A4",
    hint: "Satu foto memenuhi lembar A4 (full bleed)",
    mode: "photo",
  },
  {
    id: "penuh-4r",
    label: "Foto Penuh 4R",
    hint: "Satu foto memenuhi kertas 4R (full bleed)",
    mode: "photo",
  },
  {
    id: "doc-hemat",
    label: "Dokumen Hemat",
    hint: "Hitam-putih, kualitas Draf, skala sesuaikan kertas",
    mode: "doc",
  },
  {
    id: "doc-kualitas",
    label: "Dokumen Kualitas",
    hint: "Berwarna, kualitas Tinggi — untuk dokumen penting",
    mode: "doc",
  },
  {
    id: "ttd-scan",
    label: "Tanda Tangan",
    hint: "Hasil scan/tanda tangan dicetak ukuran asli di A4",
    mode: "doc",
  },
];

export function getJobPreset(id: JobPresetId): JobPreset {
  return JOB_PRESETS.find((p) => p.id === id) ?? JOB_PRESETS[0];
}
