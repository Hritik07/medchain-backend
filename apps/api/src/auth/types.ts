/**
 * Shape of the logged-in user attached to every authenticated request as `req.user`.
 * The `declare global` block tells TypeScript that Express requests may carry it.
 */
import type { Role } from '../config/constants';

export interface AuthUser {
  id: string;            // users.id (UUID)
  role: Role;
  providerId: string | null; // set for doctor/pharmacy/diagnostic staff
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
