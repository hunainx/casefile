import type {
  AuthenticationExtensionsClientOutputs,
  AuthenticationResponseJSON,
  AuthenticatorAttachment,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

/**
 * Parses the `response` field of the WebAuthn verify endpoints into the shape
 * @simplewebauthn/server expects. The request schema only guarantees an object, so
 * everything the library relies on is checked here; anything malformed returns null
 * and the route answers 400 instead of handing an unchecked object to the verifier.
 *
 * `clientExtensionResults` is required by the type but omitted by some clients; the
 * library never reads it at runtime, so a missing value becomes `{}`.
 */

type JsonObject = Record<string, unknown>;

const TRANSPORTS: readonly AuthenticatorTransportFuture[] = [
  "ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb",
];

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isAttachment(v: unknown): v is AuthenticatorAttachment {
  return v === "platform" || v === "cross-platform";
}

function isTransport(v: unknown): v is AuthenticatorTransportFuture {
  return TRANSPORTS.some((t) => t === v);
}

function parseExtensionResults(v: unknown): AuthenticationExtensionsClientOutputs | null {
  if (v === undefined) return {};
  if (!isObject(v)) return null;
  const out: AuthenticationExtensionsClientOutputs = {};
  if (v.appid !== undefined) {
    if (typeof v.appid !== "boolean") return null;
    out.appid = v.appid;
  }
  if (v.hmacCreateSecret !== undefined) {
    if (typeof v.hmacCreateSecret !== "boolean") return null;
    out.hmacCreateSecret = v.hmacCreateSecret;
  }
  if (v.credProps !== undefined) {
    if (!isObject(v.credProps)) return null;
    const rk = v.credProps.rk;
    if (rk !== undefined && typeof rk !== "boolean") return null;
    out.credProps = rk === undefined ? {} : { rk };
  }
  return out;
}

interface CredentialEnvelope {
  id: string;
  rawId: string;
  inner: JsonObject;
  clientExtensionResults: AuthenticationExtensionsClientOutputs;
  authenticatorAttachment?: AuthenticatorAttachment;
}

function parseEnvelope(v: unknown): CredentialEnvelope | null {
  if (!isObject(v)) return null;
  if (typeof v.id !== "string" || typeof v.rawId !== "string") return null;
  if (v.type !== "public-key") return null;
  if (!isObject(v.response)) return null;
  const clientExtensionResults = parseExtensionResults(v.clientExtensionResults);
  if (!clientExtensionResults) return null;
  if (v.authenticatorAttachment !== undefined && !isAttachment(v.authenticatorAttachment)) return null;
  return {
    id: v.id,
    rawId: v.rawId,
    inner: v.response,
    clientExtensionResults,
    ...(isAttachment(v.authenticatorAttachment) ? { authenticatorAttachment: v.authenticatorAttachment } : {}),
  };
}

function optionalString(v: unknown): { ok: true; value: string | undefined } | { ok: false } {
  if (v === undefined) return { ok: true, value: undefined };
  return typeof v === "string" ? { ok: true, value: v } : { ok: false };
}

export function parseRegistrationResponse(v: unknown): RegistrationResponseJSON | null {
  const env = parseEnvelope(v);
  if (!env) return null;
  const r = env.inner;
  if (typeof r.clientDataJSON !== "string" || typeof r.attestationObject !== "string") return null;

  const authenticatorData = optionalString(r.authenticatorData);
  const publicKey = optionalString(r.publicKey);
  if (!authenticatorData.ok || !publicKey.ok) return null;
  if (r.publicKeyAlgorithm !== undefined && typeof r.publicKeyAlgorithm !== "number") return null;

  let transports: AuthenticatorTransportFuture[] | undefined;
  if (r.transports !== undefined) {
    if (!Array.isArray(r.transports)) return null;
    transports = [];
    for (const t of r.transports) {
      if (!isTransport(t)) return null;
      transports.push(t);
    }
  }

  return {
    id: env.id,
    rawId: env.rawId,
    type: "public-key",
    clientExtensionResults: env.clientExtensionResults,
    ...(env.authenticatorAttachment ? { authenticatorAttachment: env.authenticatorAttachment } : {}),
    response: {
      clientDataJSON: r.clientDataJSON,
      attestationObject: r.attestationObject,
      ...(authenticatorData.value !== undefined ? { authenticatorData: authenticatorData.value } : {}),
      ...(publicKey.value !== undefined ? { publicKey: publicKey.value } : {}),
      ...(typeof r.publicKeyAlgorithm === "number" ? { publicKeyAlgorithm: r.publicKeyAlgorithm } : {}),
      ...(transports ? { transports } : {}),
    },
  };
}

export function parseAuthenticationResponse(v: unknown): AuthenticationResponseJSON | null {
  const env = parseEnvelope(v);
  if (!env) return null;
  const r = env.inner;
  if (
    typeof r.clientDataJSON !== "string" ||
    typeof r.authenticatorData !== "string" ||
    typeof r.signature !== "string"
  ) {
    return null;
  }
  const userHandle = optionalString(r.userHandle);
  if (!userHandle.ok) return null;

  return {
    id: env.id,
    rawId: env.rawId,
    type: "public-key",
    clientExtensionResults: env.clientExtensionResults,
    ...(env.authenticatorAttachment ? { authenticatorAttachment: env.authenticatorAttachment } : {}),
    response: {
      clientDataJSON: r.clientDataJSON,
      authenticatorData: r.authenticatorData,
      signature: r.signature,
      ...(userHandle.value !== undefined ? { userHandle: userHandle.value } : {}),
    },
  };
}
