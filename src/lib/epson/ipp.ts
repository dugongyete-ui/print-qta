// Minimal IPP/1.1 Print-Job encoder.
//
// Builds a binary IPP request packet suitable for Epson network interfaces
// (most EcoTank / L-Series Wi-Fi models expose /ipp/print). Only the
// attributes needed by this workspace are encoded.

const Tag = {
  OPERATION_ATTRIBUTES: 0x01,
  JOB_ATTRIBUTES: 0x02,
  INTEGER: 0x21,
  BOOLEAN: 0x22,
  ENUM: 0x23,
  KEYWORD: 0x44,
  URI: 0x45,
  NAME_WITHOUT_LANGUAGE: 0x42,
  TEXT_WITHOUT_LANGUAGE: 0x41,
  MIME_MEDIA_TYPE: 0x49,
  NATURAL_LANGUAGE: 0x48,
  CHARSET: 0x47,
  RANGE_OF_INTEGER: 0x33,
} as const;

function utf8(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function attr(tag: number, name: string, value: string): Buffer {
  const n = utf8(name);
  const v = utf8(value);
  return Buffer.concat([
    Buffer.from([tag]),
    Buffer.from([0x00, n.length]),
    n,
    Buffer.from([0x00, v.length]),
    v,
  ]);
}

function attrInt(tag: number, name: string, value: number): Buffer {
  const n = utf8(name);
  const v = Buffer.alloc(4);
  v.writeInt32BE(Math.trunc(value), 0);
  return Buffer.concat([
    Buffer.from([tag]),
    Buffer.from([0x00, n.length]),
    n,
    Buffer.from([0x00, 0x04]),
    v,
  ]);
}

/** Additional value of a 1setOf — empty attribute name. */
function attrAdditionalInt(tag: number, value: number): Buffer {
  const v = Buffer.alloc(4);
  v.writeInt32BE(Math.trunc(value), 0);
  return Buffer.concat([
    Buffer.from([tag]),
    Buffer.from([0x00, 0x00]),
    Buffer.from([0x00, 0x04]),
    v,
  ]);
}

function attrRange(
  tag: number,
  name: string,
  lower: number,
  upper: number,
): Buffer {
  const n = utf8(name);
  const v = Buffer.alloc(8);
  v.writeInt32BE(Math.trunc(lower), 0);
  v.writeInt32BE(Math.trunc(upper), 4);
  return Buffer.concat([
    Buffer.from([tag]),
    Buffer.from([0x00, n.length]),
    n,
    Buffer.from([0x00, 0x08]),
    v,
  ]);
}

function attrAdditionalRange(tag: number, lower: number, upper: number): Buffer {
  const v = Buffer.alloc(8);
  v.writeInt32BE(Math.trunc(lower), 0);
  v.writeInt32BE(Math.trunc(upper), 4);
  return Buffer.concat([
    Buffer.from([tag]),
    Buffer.from([0x00, 0x00]),
    Buffer.from([0x00, 0x08]),
    v,
  ]);
}

export interface IppPrintJobOptions {
  printerUri: string;
  jobName: string;
  userName?: string;
  documentFormat: string; // "application/pdf" | "image/jpeg" | ...
  copies: number;
  colorMode: "color" | "monochrome";
  quality: 3 | 4 | 5; // IPP print-quality enum
  sides: "one-sided" | "two-sided-long-edge";
  media: string; // IPP media keyword, e.g. iso_a4_210x297mm
  /** PWG media-type keyword, e.g. "photographic-glossy" (omitted for plain). */
  mediaType?: string;
  orientation: 3 | 4; // 3 = portrait, 4 = landscape
  pageRanges: Array<[number, number]>;
  fitToPage: boolean;
}

export function buildPrintJobPacket(options: IppPrintJobOptions): Uint8Array {
  const head = Buffer.alloc(8);
  head.writeUInt8(0x01, 0); // version major (1.1)
  head.writeUInt8(0x01, 1);
  head.writeUInt16BE(0x0003, 2); // Print-Job
  head.writeUInt32BE(1, 4); // request-id

  const op = Buffer.concat([
    Buffer.from([Tag.OPERATION_ATTRIBUTES]),
    attr(Tag.CHARSET, "attributes-charset", "utf-8"),
    attr(Tag.NATURAL_LANGUAGE, "attributes-natural-language", "en"),
    attr(Tag.URI, "printer-uri", options.printerUri),
    attr(Tag.NAME_WITHOUT_LANGUAGE, "requesting-user-name", options.userName ?? "epson-print-station"),
    attr(Tag.NAME_WITHOUT_LANGUAGE, "job-name", options.jobName.slice(0, 120)),
    attr(Tag.MIME_MEDIA_TYPE, "document-format", options.documentFormat),
  ]);

  const fitTag = options.fitToPage ? "fit" : "none"; // IPP print-scaling (PWG 5100.13)
  const jobParts: Buffer[] = [
    Buffer.from([Tag.JOB_ATTRIBUTES]),
    attrInt(Tag.INTEGER, "copies", Math.min(Math.max(options.copies, 1), 99)),
    attr(Tag.KEYWORD, "sides", options.sides),
    attrInt(Tag.ENUM, "print-quality", options.quality),
    attr(Tag.KEYWORD, "print-color-mode", options.colorMode),
    attr(Tag.KEYWORD, "media", options.media),
    attrInt(Tag.ENUM, "orientation-requested", options.orientation),
    attr(Tag.KEYWORD, "print-scaling", fitTag),
  ];
  if (options.mediaType) {
    jobParts.push(attr(Tag.KEYWORD, "media-type", options.mediaType));
  }

  // page-ranges: 1setOf rangeOfInteger (merge only non-contiguous)
  const ranges = mergeRanges(options.pageRanges);
  if (ranges.length > 0) {
    const [firstLower, firstUpper] = ranges[0];
    jobParts.push(attrRange(Tag.RANGE_OF_INTEGER, "page-ranges", firstLower, firstUpper));
    for (let i = 1; i < ranges.length; i++) {
      jobParts.push(attrAdditionalRange(Tag.RANGE_OF_INTEGER, ranges[i][0], ranges[i][1]));
    }
  }

  return new Uint8Array(Buffer.concat([head, op, ...jobParts]));
}

export function mergeRanges(
  input: Array<number | [number, number]>,
): Array<[number, number]> {
  if (input.length === 0) return [];
  const pages = input.map((v) => (Array.isArray(v) ? v[0] : v));
  const sorted = Array.from(new Set(pages)).sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
    } else {
      out.push([start, prev]);
      start = sorted[i];
      prev = sorted[i];
    }
  }
  out.push([start, prev]);
  return out;
}

export interface IppSendResult {
  jobId: string | null;
  status: string;
}

/** POST the IPP Print-Job and interpret the response status code. */
export async function sendIppPrintJob(
  printerUri: string,
  packet: Uint8Array,
  document: Uint8Array,
): Promise<IppSendResult> {
  const url = printerUri.includes("/ipp")
    ? printerUri
    : `${printerUri.replace(/\/$/, "")}/ipp/print`;

  const body = new Uint8Array(packet.length + document.length);
  body.set(packet, 0);
  body.set(document, packet.length);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/ipp" },
    body,
    signal: AbortSignal.timeout(20000),
  });

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(`IPP endpoint menanggapi HTTP ${res.status} (${url})`);
  }
  if (buffer.length < 8) {
    throw new Error("Respon IPP tidak valid (terlalu pendek).");
  }
  const statusCode = buffer.readUInt16BE(2);
  const statusName = ippStatusName(statusCode);
  if (statusCode !== 0x0000 && statusCode !== 0x0001) {
    throw new Error(`IPP menolak pekerjaan: 0x${statusCode.toString(16)} ${statusName}`);
  }
  return {
    jobId: extractJobId(buffer),
    status: statusName,
  };
}

function extractJobId(buffer: Buffer): string | null {
  // Walk the attribute groups loosely to find "job-id" (integer 0x21).
  let i = 8; // version(2) status(2) request-id(4)
  while (i < buffer.length - 1) {
    const tag = buffer[i];
    if (tag <= 0x0f || tag >= 0x7f) {
      // delimiter tag (attribute group end-tag or unsupported-values) — skip
      i += 1;
      continue;
    }
    const nameLen = buffer.readUInt16BE(i + 1);
    if (nameLen === 0) {
      i += 3;
      continue;
    }
    const name = buffer.toString("utf8", i + 3, i + 3 + nameLen);
    const valLen = buffer.readUInt16BE(i + 3 + nameLen);
    const valStart = i + 3 + nameLen + 2;
    if (name === "job-id" && tag === Tag.INTEGER && valLen === 4) {
      return String(buffer.readInt32BE(valStart));
    }
    i = valStart + valLen;
  }
  return null;
}

function ippStatusName(code: number): string {
  const map: Record<number, string> = {
    0x0000: "successful-ok",
    0x0001: "successful-ok-ignored-or-substituted-attributes",
    0x0002: "successful-ok-conflicting-attributes",
    0x0400: "bad-request",
    0x0401: "forbidden",
    0x0403: "not-possible",
    0x0404: "printer-not-available",
    0x0409: "client-error-not-possible",
    0x0503: "server-error-busy",
  };
  return map[code] ?? `status-${code}`;
}
