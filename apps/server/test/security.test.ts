import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canManageScopedResource, canReadScopedResource } from "../src/authorization.js";
import { loadConfig } from "../src/config.js";
import { CredentialCipher } from "../src/credentials.js";
import { isPrivateAddress } from "../src/network-security.js";

describe("credential encryption", () => {
  it("round-trips credentials without storing plaintext", () => {
    const cipher = CredentialCipher.fromBase64(randomBytes(32).toString("base64"));
    const record = cipher.encrypt({ apiKey: "super-secret" });
    expect(record.encryptedData.toString("utf8")).not.toContain("super-secret");
    expect(cipher.decrypt(record)).toEqual({ apiKey: "super-secret" });
  });

  it("rejects tampered ciphertext", () => {
    const cipher = CredentialCipher.fromBase64(randomBytes(32).toString("base64"));
    const record = cipher.encrypt({ token: "secret" });
    record.encryptedData[0] = (record.encryptedData[0] ?? 0) ^ 1;
    expect(() => cipher.decrypt(record)).toThrow();
  });
});

describe("tenant authorization", () => {
  const alice = { id: "alice", role: "USER" as const };
  const bobPrivate = { ownerUserId: "bob", scope: "PRIVATE" as const };
  const bobShared = { ownerUserId: "bob", scope: "SHARED" as const };

  it("does not expose another user's private resource", () => {
    expect(canReadScopedResource(alice, bobPrivate)).toBe(false);
    expect(canReadScopedResource(alice, bobPrivate, true)).toBe(false);
  });

  it("requires an explicit grant for a shared resource", () => {
    expect(canReadScopedResource(alice, bobShared)).toBe(false);
    expect(canReadScopedResource(alice, bobShared, true)).toBe(true);
  });

  it("does not turn a use grant into management access", () => {
    expect(canManageScopedResource(alice, bobShared)).toBe(false);
  });
});

describe("security configuration", () => {
  it("rejects partial bootstrap credentials", () => {
    expect(() => loadConfig({ BOOTSTRAP_ADMIN_EMAIL: "admin@example.com" })).toThrow();
  });

  it("recognizes local and metadata service address ranges", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("192.168.1.20")).toBe(true);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
  });
});
