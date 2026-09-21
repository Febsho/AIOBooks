import type { SearchProvider } from "@aiobooks/core";
import { NewznabSearchProvider, ProwlarrSearchProvider } from "@aiobooks/providers";
import type { AuthUser } from "./auth.js";
import type { CredentialCipher } from "./credentials.js";
import type { Database } from "./database.js";
import { validateRemoteUrl } from "./network-security.js";

interface ConnectionRow {
  id: string; name: string; kind: "PROWLARR" | "NEWZNAB" | "NZBHYDRA"; base_url: string;
  public_config: { categories?: string[]; priority?: number; timeoutMs?: number };
  owner_role: "ADMIN" | "USER"; key_version: number; encrypted_data: Buffer; nonce: Buffer; auth_tag: Buffer;
}

async function rowsForUser(sql: Database, user: AuthUser, connectionId?: string): Promise<ConnectionRow[]> {
  return sql<ConnectionRow[]>`
    SELECT c.id, c.name, c.kind, c.base_url, c.public_config, owner.role AS owner_role,
      cc.key_version, cc.encrypted_data, cc.nonce, cc.auth_tag
    FROM connections c
    JOIN users owner ON owner.id = c.owner_user_id
    JOIN connection_credentials cc ON cc.connection_id = c.id
    LEFT JOIN connection_permissions cp ON cp.connection_id = c.id AND cp.user_id = ${user.id}
    WHERE c.enabled = true AND c.kind IN ('PROWLARR', 'NEWZNAB', 'NZBHYDRA')
      AND (${connectionId ?? null}::uuid IS NULL OR c.id = ${connectionId ?? null})
      AND (${user.role === "ADMIN"} OR c.owner_user_id = ${user.id} OR (c.scope = 'SHARED' AND cp.can_use = true))
    ORDER BY COALESCE((c.public_config->>'priority')::int, 50), c.name
  `;
}

export async function loadSearchProviders(sql: Database, user: AuthUser, cipher: CredentialCipher, connectionId?: string): Promise<Array<{ provider: SearchProvider; timeoutMs: number }>> {
  const rows = await rowsForUser(sql, user, connectionId);
  return Promise.all(rows.map(async (row) => {
    await validateRemoteUrl(row.base_url, row.owner_role === "ADMIN");
    const credentials = cipher.decrypt<{ apiKey?: string }>({ keyVersion: row.key_version, encryptedData: row.encrypted_data, nonce: row.nonce, authTag: row.auth_tag });
    if (!credentials.apiKey) throw new Error(`Connection ${row.name} has no API key`);
    const common = { id: row.id, name: row.name, baseUrl: row.base_url, apiKey: credentials.apiKey, ...(row.public_config.categories ? { categories: row.public_config.categories } : {}), ...(row.public_config.priority !== undefined ? { priority: row.public_config.priority } : {}) };
    const provider = row.kind === "PROWLARR" ? new ProwlarrSearchProvider(common) : new NewznabSearchProvider(common);
    return { provider, timeoutMs: row.public_config.timeoutMs ?? 15_000 };
  }));
}
