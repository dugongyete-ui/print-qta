// GET  /api/print     — detect available direct-spool transports (IPP / lp)
// POST /api/print     — send a job straight to the Epson spooler
//
// When no spooler is configured the endpoints respond with structured JSON so
// the UI can fall back to Browser Print without guessing.

import { NextResponse } from "next/server";
import {
  detectSpooler,
  spoolPrint,
  type PrintJobPayload,
} from "@/lib/epson/spooler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const spooler = await detectSpooler();
  return NextResponse.json({
    browserPrint: true,
    spooler,
    hints: {
      ipp: "Set EPSON_PRINTER_URL=http://<printer-ip>/ipp/print (atau EPSON_PRINTER_HOST) untuk Direct Spooler IPP.",
      lp: "Jalankan aplikasi ini pada mesin dengan CUPS terpasang (perintah `lp`) untuk spooler lokal.",
    },
  });
}

export async function POST(request: Request) {
  let payload: { job?: PrintJobPayload; data?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", message: "Body JSON tidak valid." },
      { status: 400 },
    );
  }

  const job = payload.job;
  if (!job || typeof job.fileName !== "string" || !Array.isArray(job.pages)) {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", message: "Payload pekerjaan cetak tidak lengkap." },
      { status: 400 },
    );
  }

  const spooler = await detectSpooler();
  if (!spooler) {
    return NextResponse.json(
      {
        ok: false,
        code: "SPOOLER_UNAVAILABLE",
        message:
          "Tidak ada spooler printer lokal yang terdeteksi. Gunakan Mode Browser Print (Ctrl+P), atau atur EPSON_PRINTER_URL / pasang CUPS (lp) pada server.",
      },
      { status: 503 },
    );
  }

  let buffer: Buffer | null = null;
  if (payload.data) {
    try {
      buffer = Buffer.from(payload.data, "base64");
    } catch {
      buffer = null;
    }
  }
  if (!buffer || buffer.length === 0) {
    return NextResponse.json(
      { ok: false, code: "NO_DOCUMENT", message: "Dokumen tidak terkirim ke server." },
      { status: 400 },
    );
  }

  try {
    const result = await spoolPrint(job, buffer, spooler);
    return NextResponse.json({
      ok: true,
      jobId: result.jobId,
      transport: result.transport,
      printer: spooler.printer,
    });
  } catch (err) {
    const e = err as Error & { statusCode?: number; code?: string };
    return NextResponse.json(
      {
        ok: false,
        code: e.code ?? "PRINT_FAILED",
        message: e.message || "Pekerjaan cetak gagal dieksekusi.",
      },
      { status: e.statusCode ?? 502 },
    );
  }
}
