// TLS identities and pinned peer requests. Runtime uses only node:https and node:crypto.
// Trust model: a connection to a peer is accepted only if the SHA-256 of the peer certificate's
// public key is one of the validator fingerprints recorded in the genesis configuration.
// The check runs right after the handshake, before any request body is sent.
// Message signatures still bind every vote, proposal and block to a validator key.

import https from "node:https";
import { X509Certificate, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainError } from "../chain/core.js";

const MAX_RESPONSE_BYTES = 8_000_000;

// Fingerprint = SHA-256 of the DER-encoded SubjectPublicKeyInfo. Matches `openssl pkey -pubin -outform DER`.
export function fingerprintOfCertificate(certificate) {
  const spki = certificate.publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("hex");
}

export const fingerprintOfPem = (pem) => fingerprintOfCertificate(new X509Certificate(pem));

// Creates a self-signed Ed25519 certificate with OpenSSL. This runs at setup time, not while the node runs.
export function createTlsIdentity(commonName) {
  if (!/^[a-z0-9-]{1,40}$/.test(commonName)) throw new Error("اسم الشهادة غير صالح.");
  const dir = mkdtempSync(join(tmpdir(), "snn-tls-"));
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "ed25519", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
        "-days", "3650", "-subj", `/CN=${commonName}`],
      { stdio: "ignore" },
    );
    const key = readFileSync(join(dir, "k.pem"), "utf8");
    const cert = readFileSync(join(dir, "c.pem"), "utf8");
    return { key, cert, fingerprint: fingerprintOfPem(cert) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Sends one JSON request to a peer over HTTPS, pinned to `pins` (a Set of fingerprints).
// Resolves with { status, body }. Rejects with TLS_PIN_MISMATCH if the certificate is not pinned,
// and in that case no request bytes leave the process.
export function peerRequest({ url, method = "GET", path, body, headers = {}, pins, timeoutMs = 3000 }) {
  const target = new URL(path, url);
  if (target.protocol !== "https:") {
    return Promise.reject(new ChainError("INSECURE_PEER", "النظير يجب أن يُخدم عبر https."));
  }
  const payload = body === undefined ? null : JSON.stringify(body);
  const sendHeaders = { ...headers };
  if (payload !== null) {
    sendHeaders["content-type"] = "application/json";
    sendHeaders["content-length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: sendHeaders,
        agent: false,
        // Verification is done by the pin below, not by a certificate authority.
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > MAX_RESPONSE_BYTES) req.destroy(new ChainError("TOO_LARGE", "استجابة النظير أكبر من الحد."));
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
          } catch {
            reject(new ChainError("BAD_JSON", "استجابة النظير ليست JSON صالحاً."));
          }
        });
        res.on("error", reject);
      },
    );

    req.on("socket", (socket) => {
      socket.on("secureConnect", () => {
        const fingerprint = fingerprintOfCertificate(new X509Certificate(socket.getPeerCertificate().raw));
        if (!pins || !pins.has(fingerprint)) {
          req.destroy(new ChainError("TLS_PIN_MISMATCH", "شهادة النظير غير معتمدة."));
          return;
        }
        req.end(payload ?? undefined); // the body is sent only after the pin matches
      });
    });
    req.on("timeout", () => req.destroy(new ChainError("TIMEOUT", "انتهت مهلة النظير.")));
    req.on("error", reject);
  });
}
