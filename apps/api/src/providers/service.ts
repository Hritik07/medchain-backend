/**
 * Provider helpers shared by onboarding, admin review and the verified-provider guard.
 */
export interface ProviderRow {
  id: string;
  type: 'doctor' | 'pharmacy' | 'diagnostic';
  name: string;
  registration_number: string | null;
  verified_status: 'pending' | 'verified' | 'rejected';
  verified_at: Date | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
  created_at: Date;
}

/** Extra columns the admin listing JOINs in (first staff contact, staff count). */
export interface ProviderJoin {
  staff_name?: string | null;
  staff_email?: string | null;
  staff_count?: string | number | null; // Postgres count() arrives as a string
}

export function toProviderDto(p: ProviderRow & ProviderJoin) {
  return {
    id: p.id,
    type: p.type,
    name: p.name,
    registrationNumber: p.registration_number,
    verifiedStatus: p.verified_status,
    verifiedAt: p.verified_at ? new Date(p.verified_at).toISOString() : null,
    rejectionReason: p.rejection_reason,
    createdAt: new Date(p.created_at).toISOString(),
    // Present only in admin listings:
    ...(p.staff_email !== undefined
      ? { contact: { name: p.staff_name ?? null, email: p.staff_email ?? null }, staffCount: Number(p.staff_count ?? 0) }
      : {}),
  };
}