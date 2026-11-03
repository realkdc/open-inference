import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import type { AccessMode, UsagePlanId } from './config.js';

export type Workspace = { id: string; name: string; createdAt: string; planId: UsagePlanId };
export type ApiKeyMode = AccessMode;
export type ApiKeyView = {
  id: string;
  mode: ApiKeyMode;
  label: string;
  prefix: string;
  createdAt: string;
};
export type ApiCredential = ApiKeyView & { workspaceId: string; secretHash: string; planId: UsagePlanId };
export type HostTokenView = { id: string; label: string; prefix: string; createdAt: string };
export type HostTokenCredential = HostTokenView & { workspaceId: string; secretHash: string };
export type MeshOwnerView = { ownerId: string; label: string; createdAt: string };
export type MeshAdmissionSnapshot = { generation: number; verifiedGeneration: number; verified: boolean };
export type UsageRow = {
  mode: AccessMode;
  model: string;
  day: string;
  usedUnits: number;
  reservedUnits: number;
};

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;

export class Store {
  private db: Database.Database;

  constructor(databasePath: string) {
    const absolutePath = resolve(databasePath);
    const directory = dirname(absolutePath);
    const directoryExists = existsSync(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!directoryExists) {
      try { chmodSync(directory, 0o700); } catch { /* Windows applies its own directory ACL model. */ }
    }
    this.db = new Database(absolutePath);
    try { chmodSync(absolutePath, 0o600); } catch { /* Windows applies its own file ACL model. */ }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        dashboard_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        plan_id TEXT NOT NULL DEFAULT 'free'
      );
      CREATE TABLE IF NOT EXISTS invites (
        token_hash TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        redeemed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('private', 'community')),
        label TEXT NOT NULL,
        prefix TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS api_keys_workspace_idx ON api_keys(workspace_id, revoked_at);
      CREATE TABLE IF NOT EXISTS host_tokens (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        prefix TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS host_tokens_workspace_idx ON host_tokens(workspace_id, revoked_at);
      CREATE TABLE IF NOT EXISTS mesh_owners (
        owner_id TEXT PRIMARY KEY CHECK (length(owner_id) = 64),
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS mesh_admission_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation INTEGER NOT NULL DEFAULT 1,
        verified_generation INTEGER NOT NULL DEFAULT 0,
        verified_owner_hash TEXT
      );
      INSERT OR IGNORE INTO mesh_admission_state (singleton, generation, verified_generation)
      VALUES (1, 1, 0);
      CREATE TABLE IF NOT EXISTS usage (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('private', 'community')),
        model TEXT NOT NULL,
        day TEXT NOT NULL,
        used_units INTEGER NOT NULL DEFAULT 0,
        reserved_units INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, mode, model, day)
      );
    `);
    // Existing beta databases predate named plans; keep every existing workspace on Free.
    const workspaceColumns = this.db.pragma('table_info(workspaces)') as Array<{ name: string }>;
    if (!workspaceColumns.some(column => column.name === 'plan_id')) {
      this.db.exec("ALTER TABLE workspaces ADD COLUMN plan_id TEXT NOT NULL DEFAULT 'free'");
    }
    // This beta runs as a single gateway process. Release reservations left by a
    // crash so one interrupted request cannot consume today's allowance forever.
    const today = new Date().toISOString().slice(0, 10);
    this.db.prepare('UPDATE usage SET reserved_units = 0 WHERE day = ?').run(today);
  }

  createInvite(expiresInHours: number): { token: string; expiresAt: string } {
    const token = `oi_inv_${randomBytes(24).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
    this.db.prepare('INSERT INTO invites (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .run(digest(token), new Date().toISOString(), expiresAt);
    return { token, expiresAt };
  }

  claimInvite(token: string, workspaceName: string): { workspace: Workspace; dashboardToken: string } | null {
    const tokenHash = digest(token);
    const now = new Date().toISOString();
    const dashboardToken = `oiw_${randomBytes(32).toString('base64url')}`;
    const workspace: Workspace = { id: id('ws'), name: workspaceName, createdAt: now, planId: 'free' };
    const transaction = this.db.transaction(() => {
      const invite = this.db.prepare('SELECT expires_at, redeemed_at FROM invites WHERE token_hash = ?').get(tokenHash) as
        | { expires_at: string; redeemed_at: string | null }
        | undefined;
      if (!invite || invite.redeemed_at || invite.expires_at <= now) return false;
      this.db.prepare('UPDATE invites SET redeemed_at = ? WHERE token_hash = ?').run(now, tokenHash);
      this.db.prepare('INSERT INTO workspaces (id, name, dashboard_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(workspace.id, workspace.name, digest(dashboardToken), workspace.createdAt);
      return true;
    });
    return transaction() ? { workspace, dashboardToken } : null;
  }

  authenticateDashboard(token: string): Workspace | null {
    const tokenHash = digest(token);
    const row = this.db.prepare(`
      SELECT id, name, created_at AS createdAt, plan_id AS planId FROM workspaces WHERE dashboard_hash = ?
    `).get(tokenHash) as Workspace | undefined;
    return row ?? null;
  }

  listWorkspaces(): Workspace[] {
    return this.db.prepare(`
      SELECT id, name, created_at AS createdAt, plan_id AS planId
      FROM workspaces ORDER BY created_at DESC
    `).all() as Workspace[];
  }

  setWorkspacePlan(workspaceId: string, planId: UsagePlanId): boolean {
    const result = this.db.prepare('UPDATE workspaces SET plan_id = ? WHERE id = ?').run(planId, workspaceId);
    return result.changes > 0;
  }

  createApiKey(workspaceId: string, mode: ApiKeyMode, label: string): { view: ApiKeyView; secret: string } {
    const secret = `oi_${mode === 'private' ? 'priv' : 'comm'}_${randomBytes(32).toString('base64url')}`;
    const createdAt = new Date().toISOString();
    const keyId = id('key');
    const view: ApiKeyView = { id: keyId, mode, label, prefix: secret.slice(0, 14), createdAt };
    this.db.prepare(`
      INSERT INTO api_keys (id, workspace_id, mode, label, prefix, secret_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(keyId, workspaceId, mode, label, view.prefix, digest(secret), createdAt);
    return { view, secret };
  }

  listApiKeys(workspaceId: string): ApiKeyView[] {
    return this.db.prepare(`
      SELECT id, mode, label, prefix, created_at AS createdAt
      FROM api_keys WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY created_at DESC
    `).all(workspaceId) as ApiKeyView[];
  }

  activeApiKeyCount(workspaceId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM api_keys WHERE workspace_id = ? AND revoked_at IS NULL
    `).get(workspaceId) as { count: number };
    return row.count;
  }

  revokeApiKey(workspaceId: string, keyId: string): boolean {
    const result = this.db.prepare(`
      UPDATE api_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), keyId, workspaceId);
    return result.changes > 0;
  }

  authenticateApiKey(secret: string): ApiCredential | null {
    const row = this.db.prepare(`
      SELECT k.id, k.workspace_id AS workspaceId, k.mode, k.label, k.prefix,
             k.secret_hash AS secretHash, k.created_at AS createdAt, w.plan_id AS planId
      FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id
      WHERE k.secret_hash = ? AND k.revoked_at IS NULL
    `).get(digest(secret)) as ApiCredential | undefined;
    return row ?? null;
  }

  createHostToken(workspaceId: string, label: string): { view: HostTokenView; secret: string } {
    const secret = `oi_host_${randomBytes(32).toString('base64url')}`;
    const createdAt = new Date().toISOString();
    const tokenId = id('host');
    const view: HostTokenView = { id: tokenId, label, prefix: secret.slice(0, 14), createdAt };
    this.db.prepare(`
      INSERT INTO host_tokens (id, workspace_id, label, prefix, secret_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(tokenId, workspaceId, label, view.prefix, digest(secret), createdAt);
    return { view, secret };
  }

  listHostTokens(workspaceId: string): HostTokenView[] {
    return this.db.prepare(`
      SELECT id, label, prefix, created_at AS createdAt
      FROM host_tokens WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY created_at DESC
    `).all(workspaceId) as HostTokenView[];
  }

  activeHostTokenCount(workspaceId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM host_tokens WHERE workspace_id = ? AND revoked_at IS NULL
    `).get(workspaceId) as { count: number };
    return row.count;
  }

  revokeHostToken(workspaceId: string, tokenId: string): boolean {
    const result = this.db.prepare(`
      UPDATE host_tokens SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), tokenId, workspaceId);
    return result.changes > 0;
  }

  authenticateHostToken(secret: string): HostTokenCredential | null {
    const row = this.db.prepare(`
      SELECT id, workspace_id AS workspaceId, label, prefix,
             secret_hash AS secretHash, created_at AS createdAt
      FROM host_tokens WHERE secret_hash = ? AND revoked_at IS NULL
    `).get(digest(secret)) as HostTokenCredential | undefined;
    return row ?? null;
  }

  addTrustedMeshOwner(ownerId: string, label: string): MeshOwnerView | null {
    const normalized = ownerId.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalized)) return null;
    const createdAt = new Date().toISOString();
    const existing = this.db.prepare('SELECT revoked_at FROM mesh_owners WHERE owner_id = ?').get(normalized) as { revoked_at: string | null } | undefined;
    if (existing && !existing.revoked_at) return null;

    const transaction = this.db.transaction(() => {
      if (existing) {
        this.db.prepare('UPDATE mesh_owners SET label = ?, created_at = ?, revoked_at = NULL WHERE owner_id = ?')
          .run(label, createdAt, normalized);
      } else {
        this.db.prepare('INSERT INTO mesh_owners (owner_id, label, created_at) VALUES (?, ?, ?)')
          .run(normalized, label, createdAt);
      }
      this.db.prepare('UPDATE mesh_admission_state SET generation = generation + 1 WHERE singleton = 1').run();
    });
    transaction();
    return { ownerId: normalized, label, createdAt };
  }

  listTrustedMeshOwners(): MeshOwnerView[] {
    return this.db.prepare(`
      SELECT owner_id AS ownerId, label, created_at AS createdAt
      FROM mesh_owners WHERE revoked_at IS NULL ORDER BY created_at DESC
    `).all() as MeshOwnerView[];
  }

  listTrustedMeshOwnerIds(): string[] {
    return this.db.prepare('SELECT owner_id FROM mesh_owners WHERE revoked_at IS NULL ORDER BY owner_id')
      .all().map((row: unknown) => (row as { owner_id: string }).owner_id);
  }

  revokeTrustedMeshOwner(ownerId: string): boolean {
    const normalized = ownerId.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalized)) return false;
    const transaction = this.db.transaction(() => {
      const result = this.db.prepare('UPDATE mesh_owners SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL')
        .run(new Date().toISOString(), normalized);
      if (result.changes > 0) {
        this.db.prepare('UPDATE mesh_admission_state SET generation = generation + 1 WHERE singleton = 1').run();
      }
      return result.changes > 0;
    });
    return transaction();
  }

  meshAdmissionSnapshot(ownerIds: string[]): MeshAdmissionSnapshot {
    const normalized = [...new Set(ownerIds.map(ownerId => ownerId.toLowerCase()))].sort();
    const ownerHash = digest(normalized.join('\n'));
    const state = this.db.prepare(`
      SELECT generation, verified_generation AS verifiedGeneration, verified_owner_hash AS verifiedOwnerHash
      FROM mesh_admission_state WHERE singleton = 1
    `).get() as { generation: number; verifiedGeneration: number; verifiedOwnerHash: string | null };
    return {
      generation: state.generation,
      verifiedGeneration: state.verifiedGeneration,
      verified: state.generation === state.verifiedGeneration && state.verifiedOwnerHash === ownerHash
    };
  }

  verifyMeshAdmission(ownerIds: string[]): MeshAdmissionSnapshot {
    const normalized = [...new Set(ownerIds.map(ownerId => ownerId.toLowerCase()))].sort();
    const ownerHash = digest(normalized.join('\n'));
    this.db.prepare(`
      UPDATE mesh_admission_state
      SET verified_generation = generation, verified_owner_hash = ?
      WHERE singleton = 1
    `).run(ownerHash);
    return this.meshAdmissionSnapshot(normalized);
  }

  reserveUsage(input: {
    workspaceId: string;
    mode: AccessMode;
    model: string;
    day: string;
    units: number;
    dailyLimit: number;
  }): boolean {
    const transaction = this.db.transaction(() => {
      const current = this.db.prepare(`
        SELECT COALESCE(SUM(used_units + reserved_units), 0) AS total
        FROM usage WHERE workspace_id = ? AND mode = ? AND day = ?
      `).get(input.workspaceId, input.mode, input.day) as { total: number };
      if (current.total + input.units > input.dailyLimit) return false;
      this.db.prepare(`
        INSERT INTO usage (workspace_id, mode, model, day, reserved_units)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, mode, model, day)
        DO UPDATE SET reserved_units = reserved_units + excluded.reserved_units
      `).run(input.workspaceId, input.mode, input.model, input.day, input.units);
      return true;
    });
    return transaction();
  }

  settleUsage(input: {
    workspaceId: string;
    mode: AccessMode;
    model: string;
    day: string;
    reservedUnits: number;
    actualUnits: number;
  }): void {
    this.db.prepare(`
      UPDATE usage
      SET reserved_units = MAX(0, reserved_units - ?), used_units = used_units + ?
      WHERE workspace_id = ? AND mode = ? AND model = ? AND day = ?
    `).run(input.reservedUnits, Math.max(0, input.actualUnits), input.workspaceId, input.mode, input.model, input.day);
  }

  usageForWorkspace(workspaceId: string): UsageRow[] {
    const day = new Date().toISOString().slice(0, 10);
    return this.db.prepare(`
      SELECT mode, model, day, used_units AS usedUnits, reserved_units AS reservedUnits
      FROM usage WHERE workspace_id = ? AND day = ? ORDER BY mode, model
    `).all(workspaceId, day) as UsageRow[];
  }

  close(): void {
    this.db.close();
  }
}
