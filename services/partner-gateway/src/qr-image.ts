import { createHmac, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";

function signature(key: Buffer, orderId: string, qr: string): string {
  return createHmac("sha256", key).update(`${orderId}.${qr}`, "utf8").digest("base64url");
}

export function qrImageUrl(
  publicBaseUrl: string,
  signingKey: Buffer,
  orderId: string,
  qr: string,
): string {
  const token = signature(signingKey, orderId, qr);
  return `${publicBaseUrl.replace(/\/$/, "")}/payment-qr/${encodeURIComponent(orderId)}.png?token=${encodeURIComponent(token)}`;
}

export function verifyQrImageToken(
  signingKey: Buffer,
  orderId: string,
  qr: string,
  supplied: string | undefined,
): boolean {
  if (!supplied) return false;
  const expected = Buffer.from(signature(signingKey, orderId, qr), "utf8");
  const actual = Buffer.from(supplied, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function renderQrPng(qr: string): Promise<Buffer> {
  return QRCode.toBuffer(qr, {
    type: "png",
    width: 360,
    margin: 2,
    errorCorrectionLevel: "M",
  });
}
