// POST /api/convert-docx — server-side Word conversion fallback.
//   .docx → mammoth (HTML flow render)
//   .doc  → LibreOffice headless (.doc → .docx) → mammoth, when installed

import { NextResponse } from "next/server";
import mammoth from "mammoth";
import { execFile } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileP = promisify(execFile);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function which(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("which", [binary], { timeout: 4000 });
    const p = stdout.trim();
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

async function docToDocxBuffer(buffer: Buffer): Promise<Buffer> {
  const soffice = (await which("soffice")) ?? (await which("libreoffice"));
  if (!soffice) {
    throw Object.assign(
      new Error(
        "Pratinjau .doc memerlukan LibreOffice di server (tidak tersedia). Simpan ulang dokumen sebagai .docx atau PDF.",
      ),
      { statusCode: 422, code: "ENGINE_UNAVAILABLE" },
    );
  }
  const tmp = await mkdtemp(path.join(os.tmpdir(), "epson-convert-"));
  try {
    const src = path.join(tmp, "input.doc");
    await writeFile(src, buffer);
    await execFileP(
      soffice,
      ["--headless", "--convert-to", "docx", "--outdir", tmp, src],
      { timeout: 60000 },
    );
    return await readFile(path.join(tmp, "input.docx"));
  } catch (err) {
    throw Object.assign(
      new Error("Konversi .doc gagal di server (LibreOffice headless)."),
      { statusCode: 502, code: "CONVERSION_FAILED", cause: err },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function POST(request: Request) {
  let file: File | null = null;
  try {
    const form = await request.formData();
    file = form.get("file") as File | null;
  } catch {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", message: "Form-data tidak valid." },
      { status: 400 },
    );
  }

  if (!file) {
    return NextResponse.json(
      { ok: false, code: "NO_FILE", message: "Field 'file' wajib diisi." },
      { status: 400 },
    );
  }

  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (ext !== "doc" && ext !== "docx") {
    return NextResponse.json(
      {
        ok: false,
        code: "UNSUPPORTED_FORMAT",
        message: "Endpoint konversi menerima .doc dan .docx saja.",
      },
      { status: 415 },
    );
  }

  try {
    let buffer: Buffer<ArrayBufferLike> = Buffer.from(await file.arrayBuffer());
    if (ext === "doc") {
      buffer = await docToDocxBuffer(buffer);
    }
    const { value: html } = await mammoth.convertToHtml({ buffer });
    return NextResponse.json({ ok: true, html, engine: ext === "doc" ? "libreoffice+mammoth" : "mammoth" });
  } catch (err) {
    const e = err as Error & { statusCode?: number; code?: string };
    return NextResponse.json(
      {
        ok: false,
        code: e.code ?? "CONVERSION_FAILED",
        message: e.message || "Konversi dokumen gagal.",
      },
      { status: e.statusCode ?? 502 },
    );
  }
}
