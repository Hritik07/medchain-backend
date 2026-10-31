/**
 * Delivers an OTP. Simulated for the prototype (production would use ABHA/ABDM or an SMS gateway).
 *   OTP_DELIVERY=console -> prints the code in the server log (what you use locally and for the demo)
 *   OTP_DELIVERY=n8n     -> POSTs {mobile, code, purpose} to N8N_OTP_WEBHOOK_URL so Member 2's flow sends it on WhatsApp
 */
import { config } from '../config';
import { AppError } from '../middleware/errors';
import type { OtpPurpose } from './service';

export async function deliverOtp(mobile: string, code: string, purpose: OtpPurpose): Promise<void> {
  if (config.OTP_DELIVERY === 'n8n') {
    if (!config.N8N_OTP_WEBHOOK_URL) {
      throw new AppError(500, 'OTP_DELIVERY_NOT_CONFIGURED', 'N8N_OTP_WEBHOOK_URL is not set');
    }
    try {
      const res = await fetch(config.N8N_OTP_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-service-key': config.SERVICE_API_KEY ?? '' },
        body: JSON.stringify({ mobile, code, purpose, ttlSeconds: config.OTP_TTL_SECONDS }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`n8n responded ${res.status}`);
      return;
    } catch (err) {
      console.error('OTP delivery via n8n failed:', (err as Error).message);
      throw new AppError(502, 'OTP_DELIVERY_FAILED', 'Could not send the OTP, please try again');
    }
  }

  // Simulated delivery: visible only in the server console, never in an API response.
  console.log(`📲 [SIMULATED OTP] to ${mobile} | purpose=${purpose} | code=${code} | valid ${config.OTP_TTL_SECONDS}s`);
}
