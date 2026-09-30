import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { randomUUID, generateKeyPairSync, createSign, createHash } from "node:crypto";
import { getDbUrl, createDbClient, withTenant } from "@casefile/db";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { buildApp } from "../src/app.js";

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

describe("apps/api — WebAuthn / Passkeys Integration Tests (AUTH-03)", () => {
  let app: FastifyInstance;
  let db: postgres.Sql;

  beforeAll(async () => {
    db = createDbClient(getDbUrl());
    app = buildApp({ db, logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (db) await db.end();
  });

  it("REQ-AUTH-03: WebAuthn registration options, challenge storage, and validation", async () => {
    const testEmail = `passkey_reg_${Date.now()}@casefile.test`;
    const password = "Password123!";

    // 1. Register a user
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: testEmail,
        password,
        name: "Passkey User",
        orgName: "Passkey Org",
      },
    });
    expect(regRes.statusCode).toBe(201);
    const { accessToken, user } = JSON.parse(regRes.body);

    // 2. Request WebAuthn Registration Options
    const optRes = await app.inject({
      method: "POST",
      url: "/v1/auth/webauthn/register/options",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(optRes.statusCode).toBe(200);
    const options = JSON.parse(optRes.body);
    expect(options.challenge).toBeDefined();
    expect(options.rp.name).toBe("Casefile");
    expect(options.user.name).toBe(testEmail);

    // 3. Verify challenge was recorded in database
    const challengeRows = await withTenant(user.tenantId, async (tx) => {
      return await tx<{ challenge: string; purpose: string }[]>`
        SELECT challenge, purpose FROM webauthn_challenges
        WHERE tenant_id = ${user.tenantId} AND user_id = ${user.id} AND purpose = 'registration';
      `;
    }, db);
    expect(challengeRows.length).toBeGreaterThanOrEqual(1);
    expect(challengeRows[0]!.challenge).toBe(options.challenge);
  });

  it("REQ-AUTH-03: WebAuthn assertion authentication, replay rejection, and cross-user isolation", async () => {
    const testEmailA = `passkey_user_a_${Date.now()}@casefile.test`;
    const testEmailB = `passkey_user_b_${Date.now()}@casefile.test`;
    const password = "Password123!";

    // 1. Register User A
    const regA = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmailA, password, name: "User A", orgName: "Org A" },
    });
    const userA = JSON.parse(regA.body).user;

    // 2. Register User B
    const regB = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: testEmailB, password, name: "User B", orgName: "Org B" },
    });
    const userB = JSON.parse(regB.body).user;

    // 3. Generate a real P-256 key pair for User A's credential
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });

    const jwk = publicKey.export({ format: "jwk" });
    const coseMap = new Map();
    coseMap.set(1, 2); // kty: EC2
    coseMap.set(3, -7); // alg: ES256
    coseMap.set(-1, 1); // crv: P-256
    coseMap.set(-2, Buffer.from(jwk.x!, "base64url"));
    coseMap.set(-3, Buffer.from(jwk.y!, "base64url"));
    const coseKey = isoCBOR.encode(coseMap);

    const credentialId = base64url(Buffer.from(`cred_${Date.now()}_${randomUUID()}`));

    // Store User A's passkey inside tenant context
    await withTenant(userA.tenantId, async (tx) => {
      await tx`
        INSERT INTO webauthn_credentials (
          id, tenant_id, user_id, public_key, counter, device_type, backed_up, transports, name
        ) VALUES (
          ${credentialId},
          ${userA.tenantId},
          ${userA.id},
          ${Buffer.from(coseKey)},
          1,
          'singleDevice',
          false,
          '{}'::text[],
          'MacBook TouchID'
        );
      `;
    }, db);

    // 4. Request Authentication Options for User A
    const authOptRes = await app.inject({
      method: "POST",
      url: "/v1/auth/webauthn/authenticate/options",
      payload: { email: testEmailA, tenantId: userA.tenantId },
    });
    expect(authOptRes.statusCode).toBe(200);
    const authOptions = JSON.parse(authOptRes.body);
    const challenge = authOptions.challenge;

    // 5. Construct a valid WebAuthn assertion response
    const clientDataJSONObj = {
      type: "webauthn.get",
      challenge: challenge,
      origin: "http://localhost:3000",
      crossOrigin: false,
    };
    const clientDataJSON = base64url(Buffer.from(JSON.stringify(clientDataJSONObj)));
    const clientDataHash = createHash("sha256").update(Buffer.from(JSON.stringify(clientDataJSONObj))).digest();

    // AuthenticatorData: 32 bytes rpIdHash + 1 byte flags (0x05 = UP + UV) + 4 bytes counter (2)
    const rpIdHash = createHash("sha256").update("localhost").digest();
    const flags = Buffer.from([0x05]); // User Present (UP) + User Verified (UV)
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32BE(2, 0);
    const authDataBuf = Buffer.concat([rpIdHash, flags, counterBuf]);
    const authenticatorData = base64url(authDataBuf);

    // Sign (authData || clientDataHash) with private key
    const sign = createSign("SHA256");
    sign.update(authDataBuf);
    sign.update(clientDataHash);
    const signatureDer = sign.sign({ key: privateKey, format: "der", type: "pkcs8" });
    const signature = base64url(signatureDer);

    const assertionPayload = {
      response: {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          clientDataJSON,
          authenticatorData,
          signature,
        },
      },
      tenantId: userA.tenantId,
    };

    // 6. Successful assertion verification & Token issuance
    const verifyRes = await app.inject({
      method: "POST",
      url: "/v1/auth/webauthn/authenticate/verify",
      payload: assertionPayload,
    });
    expect(verifyRes.statusCode).toBe(200);
    const tokenData = JSON.parse(verifyRes.body);
    expect(tokenData.accessToken).toBeDefined();
    expect(tokenData.user.id).toBe(userA.id);

    // 7. Replay Rejection: Attempting to verify the exact same assertion response fails (challenge already consumed)
    const replayRes = await app.inject({
      method: "POST",
      url: "/v1/auth/webauthn/authenticate/verify",
      payload: assertionPayload,
    });
    expect(replayRes.statusCode).toBe(400); // Challenge expired or already used
    const replayError = JSON.parse(replayRes.body);
    expect(replayError.detail).toContain("challenge");

    // 8. Cross-User / Cross-Tenant Isolation: User B cannot authenticate with User A's credential
    // Generate fresh challenge for User B's tenant
    const optResB = await app.inject({
      method: "POST",
      url: "/v1/auth/webauthn/authenticate/options",
      payload: { email: testEmailB, tenantId: userB.tenantId },
    });
    expect(optResB.statusCode).toBe(200);

    const crossTenantPayload = {
      response: assertionPayload.response,
      tenantId: userB.tenantId,
    };

    const crossRes = await app.inject({
      method: "POST",
      url: "/v1/auth/webauthn/authenticate/verify",
      payload: crossTenantPayload,
    });
    expect(crossRes.statusCode).toBe(404); // Credential does not belong to User B's tenant
  });
});
