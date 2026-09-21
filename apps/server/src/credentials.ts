import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptedCredential {
  keyVersion: number;
  encryptedData: Buffer;
  nonce: Buffer;
  authTag: Buffer;
}

export class CredentialCipher {
  constructor(private readonly keys: ReadonlyMap<number, Buffer>, readonly currentVersion: number) {
    const current = keys.get(currentVersion);
    if (!current || current.length !== 32) throw new Error("Credential encryption key must be 32 bytes");
  }

  static fromBase64(value: string, version = 1): CredentialCipher {
    return new CredentialCipher(new Map([[version, Buffer.from(value, "base64")]]), version);
  }

  encrypt(value: unknown): EncryptedCredential {
    const nonce = randomBytes(12);
    const key = this.keys.get(this.currentVersion)!;
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encryptedData = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { keyVersion: this.currentVersion, encryptedData, nonce, authTag: cipher.getAuthTag() };
  }

  decrypt<T>(record: EncryptedCredential): T {
    const key = this.keys.get(record.keyVersion);
    if (!key) throw new Error(`Unknown credential key version ${record.keyVersion}`);
    const decipher = createDecipheriv("aes-256-gcm", key, record.nonce);
    decipher.setAuthTag(record.authTag);
    const plaintext = Buffer.concat([decipher.update(record.encryptedData), decipher.final()]).toString("utf8");
    return JSON.parse(plaintext) as T;
  }
}
