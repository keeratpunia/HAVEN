import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MeUserDTO } from '@haven/shared';
import * as api from '../services/api-client.js';

/**
 * Which hostel a staff member is working in (SDD §3.4: "A user can hold roles in several
 * hostels; the client sends X-Hostel-Id for staff endpoints"). The choice is remembered
 * per browser; the server still checks every request against role_assignments.
 */

export type StaffRole = 'warden' | 'office' | 'super_admin';
export interface StaffHostel {
  id: string;
  name: string;
  code: string;
  roles: StaffRole[];
}

const ALL_HOSTELS = '*';
const STORAGE_KEY = 'haven.staffHostel';

export function staffRoles(me: MeUserDTO | null): StaffRole[] {
  return [...new Set((me?.roles ?? []).map((r) => r.r))];
}

export function isStaff(me: MeUserDTO | null): boolean {
  return staffRoles(me).length > 0;
}

/** The hostels this user may act in, with their roles there. */
export async function loadStaffHostels(me: MeUserDTO): Promise<StaffHostel[]> {
  const hostels = await api.getHostels();
  const superAdmin = me.roles.some((r) => r.r === 'super_admin' && r.h === ALL_HOSTELS);
  return hostels
    .map((h) => ({
      id: h.id,
      name: h.name,
      code: h.code,
      roles: [
        ...me.roles.filter((r) => r.h === h.id).map((r) => r.r),
        ...(superAdmin ? (['super_admin'] as StaffRole[]) : []),
      ],
    }))
    .filter((h) => h.roles.length > 0);
}

function remembered(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function remember(id: string): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    // private mode: the choice just isn't remembered
  }
}

interface StaffState {
  hostels: StaffHostel[] | null;
  hostel: StaffHostel | null;
  choose: (id: string) => void;
  can: (...roles: StaffRole[]) => boolean;
}

const StaffContext = createContext<StaffState | null>(null);

export function StaffProvider({ me, children }: { me: MeUserDTO; children: ReactNode }) {
  const [hostels, setHostels] = useState<StaffHostel[] | null>(null);
  const [selected, setSelected] = useState<string | null>(remembered());

  useEffect(() => {
    void loadStaffHostels(me)
      .then(setHostels)
      .catch(() => setHostels([]));
  }, [me]);

  const value = useMemo<StaffState>(() => {
    const hostel = hostels?.find((h) => h.id === selected) ?? hostels?.[0] ?? null;
    return {
      hostels,
      hostel,
      choose: (id) => {
        remember(id);
        setSelected(id);
      },
      can: (...roles) => Boolean(hostel && roles.some((r) => hostel.roles.includes(r))),
    };
  }, [hostels, selected]);

  return <StaffContext.Provider value={value}>{children}</StaffContext.Provider>;
}

export function useStaff(): StaffState {
  const ctx = useContext(StaffContext);
  if (!ctx) throw new Error('useStaff must be used within StaffProvider');
  return ctx;
}
