import { BusinessRuleViolation, ValidationError, newId } from '@manuling/kernel';
import { parseEmail, parseName } from './validation.js';

export type UserType = 'internal' | 'portal' | 'agent';
export type UserStatus = 'invited' | 'active' | 'disabled';

export const INVITATION_TTL_DAYS = 7;

export interface AppUser {
  readonly id: string;
  /** null until an invited user first signs in (plan decision D1). */
  readonly idpSubject: string | null;
  readonly email: string;
  readonly displayName: string;
  readonly locale: string | null;
  readonly timezone: string | null;
  readonly userType: UserType;
  readonly status: UserStatus;
  readonly invitationExpiresAt: Date | null;
  readonly version: number;
}

/** A user bound to an IdP subject straight away (tenant provisioning). */
export function createAppUser(input: {
  idpSubject: string;
  email: string;
  displayName: string;
  userType?: UserType;
}): AppUser {
  const idpSubject = input.idpSubject.trim();
  if (idpSubject.length === 0 || idpSubject.length > 255) {
    throw new ValidationError(
      'platform.user.subject_invalid',
      'Identity-provider subject is required',
    );
  }
  return {
    id: newId(),
    idpSubject,
    email: parseEmail(input.email),
    displayName: parseName(input.displayName, 'displayName'),
    locale: null,
    timezone: null,
    userType: input.userType ?? 'internal',
    status: 'active',
    invitationExpiresAt: null,
    version: 1,
  };
}

/** An invitation: bound to whoever first signs in with this verified email before expiry. */
export function inviteUser(input: { email: string; displayName: string }, now: Date): AppUser {
  return {
    id: newId(),
    idpSubject: null,
    email: parseEmail(input.email),
    displayName: parseName(input.displayName, 'displayName'),
    locale: null,
    timezone: null,
    userType: 'internal',
    status: 'invited',
    invitationExpiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000),
    version: 1,
  };
}

export function isInvitationUsable(user: AppUser, now: Date): boolean {
  return (
    user.status === 'invited' && user.invitationExpiresAt !== null && user.invitationExpiresAt > now
  );
}

export interface UserChanges {
  readonly displayName?: string | undefined;
  readonly status?: 'active' | 'disabled' | undefined;
}

export function changeUser(user: AppUser, changes: UserChanges, actingUserId: string): AppUser {
  if (changes.status !== undefined && changes.status !== user.status) {
    if (user.status === 'invited') {
      throw new BusinessRuleViolation(
        'platform.user.invitation_pending',
        'An invited user can only be activated by signing in',
      );
    }
    if (changes.status === 'disabled' && user.id === actingUserId) {
      throw new BusinessRuleViolation(
        'platform.user.cannot_disable_self',
        'You cannot disable your own account',
      );
    }
  }
  return {
    ...user,
    displayName:
      changes.displayName === undefined
        ? user.displayName
        : parseName(changes.displayName, 'displayName'),
    status: changes.status ?? user.status,
  };
}
