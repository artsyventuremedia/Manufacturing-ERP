import { UnitOfWork } from '@manuling/db';
import { ConcurrencyConflictError, NotFoundError } from '@manuling/kernel';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { type AppUser } from '../domain/app-user.js';
import { type Tenant } from '../domain/tenant.js';
import { appUserTable, tenantDirectoryTable, tenantTable } from './schema.js';
import { insertStamp, updateStamp } from './stamp.js';

export interface DirectoryEntry {
  readonly id: string;
  readonly status: 'active' | 'suspended';
}

export type AppUserRecord = AppUser & { readonly createdAt: Date; readonly updatedAt: Date };

@Injectable()
export class IdentityRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get db() {
    return this.uow.current().db;
  }

  /** Global slug lookup; works before tenant context exists (no tenant data exposed). */
  async findDirectoryEntry(slug: string): Promise<DirectoryEntry | undefined> {
    const [row] = await this.db
      .select({ id: tenantDirectoryTable.id, status: tenantDirectoryTable.status })
      .from(tenantDirectoryTable)
      .where(eq(tenantDirectoryTable.slug, slug));
    return row;
  }

  /** The current tenant (RLS makes other tenants invisible). */
  async findCurrentTenant(): Promise<Tenant | undefined> {
    const [row] = await this.db.select().from(tenantTable);
    return row
      ? {
          id: row.id,
          slug: row.slug,
          name: row.name,
          edition: row.edition,
          status: row.status,
          defaultLocale: row.defaultLocale,
          defaultTimezone: row.defaultTimezone,
        }
      : undefined;
  }

  async insertTenant(tenant: Tenant): Promise<void> {
    await this.db
      .insert(tenantTable)
      .values({ ...tenant, ...insertStamp(), tenantId: tenant.id, dataRegion: 'in' });
  }

  async insertUser(user: AppUser): Promise<AppUserRecord> {
    const [row] = await this.db
      .insert(appUserTable)
      .values({ ...user, ...insertStamp() })
      .returning();
    return toUser(row!);
  }

  async findUserBySubject(subject: string): Promise<AppUserRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(appUserTable)
      .where(eq(appUserTable.idpSubject, subject));
    return row ? toUser(row) : undefined;
  }

  async findUser(id: string): Promise<AppUserRecord | undefined> {
    const [row] = await this.db.select().from(appUserTable).where(eq(appUserTable.id, id));
    return row ? toUser(row) : undefined;
  }

  async getUser(id: string): Promise<AppUserRecord> {
    const user = await this.findUser(id);
    if (!user) throw new NotFoundError('User', id);
    return user;
  }

  /** A pending invitation for this email (at most one: email is unique per tenant). */
  async findInvitation(email: string): Promise<AppUserRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(appUserTable)
      .where(
        and(
          eq(appUserTable.email, email),
          eq(appUserTable.status, 'invited'),
          isNull(appUserTable.idpSubject),
        ),
      );
    return row ? toUser(row) : undefined;
  }

  /** Binds an invitation to the signing-in subject; the user becomes active (plan D1). */
  async bindInvitation(userId: string, subject: string): Promise<AppUserRecord> {
    const [row] = await this.db
      .update(appUserTable)
      .set({
        idpSubject: subject,
        status: 'active',
        invitationExpiresAt: null,
        updatedBy: userId,
        updatedAt: new Date(),
        version: sql`${appUserTable.version} + 1`,
      })
      .where(
        and(
          eq(appUserTable.id, userId),
          eq(appUserTable.status, 'invited'),
          isNull(appUserTable.idpSubject),
        ),
      )
      .returning();
    if (!row) throw new NotFoundError('Invitation', userId);
    return toUser(row);
  }

  async listUsers(limit: number, after?: readonly [string, string]): Promise<AppUserRecord[]> {
    const rows = await this.db
      .select()
      .from(appUserTable)
      .where(
        after
          ? or(
              gt(appUserTable.email, after[0]),
              and(eq(appUserTable.email, after[0]), gt(appUserTable.id, after[1])),
            )
          : undefined,
      )
      .orderBy(asc(appUserTable.email), asc(appUserTable.id))
      .limit(limit + 1);
    return rows.map(toUser);
  }

  async listActiveUsers(): Promise<AppUserRecord[]> {
    const rows = await this.db.select().from(appUserTable).where(eq(appUserTable.status, 'active'));
    return rows.map(toUser);
  }

  async updateUser(user: AppUser, expectedVersion: number): Promise<AppUserRecord> {
    const [row] = await this.db
      .update(appUserTable)
      .set({
        displayName: user.displayName,
        status: user.status,
        version: sql`${appUserTable.version} + 1`,
        ...updateStamp(),
      })
      .where(and(eq(appUserTable.id, user.id), eq(appUserTable.version, expectedVersion)))
      .returning();
    if (!row) {
      const current = await this.findUser(user.id);
      throw current
        ? new ConcurrencyConflictError('User', user.id, expectedVersion, current.version)
        : new NotFoundError('User', user.id);
    }
    return toUser(row);
  }
}

function toUser(row: typeof appUserTable.$inferSelect): AppUserRecord {
  return {
    id: row.id,
    idpSubject: row.idpSubject,
    email: row.email,
    displayName: row.displayName,
    locale: row.locale,
    timezone: row.timezone,
    userType: row.userType,
    status: row.status,
    invitationExpiresAt: row.invitationExpiresAt,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
