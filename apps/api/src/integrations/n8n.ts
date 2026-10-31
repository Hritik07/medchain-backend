/**
 * Triggers Member 2's n8n upload pipeline (Gemini parsing etc.) after a file is stored.
 * Sends links rather than the file itself: n8n downloads it from /internal/files/:id and posts results
 * to /internal/records/:id/parsed, both protected by the shared x-service-key.
 * Never throws: an n8n outage must not fail the upload.
 */
import { config } from '../config';

export interface UploadPipelinePayload {
  entry_id: string;
  patient_id: string;
  type: string;
  source: string;
  mime: string;
  doc_hash: string;
}

/** Returns 'triggered', 'not_configured' or 'failed'. */
export async function triggerUploadPipeline(p: UploadPipelinePayload): Promise<'triggered' | 'not_configured' | 'failed'> {
  if (!config.N8N_UPLOAD_WEBHOOK_URL) return 'not_configured';
  const base = config.API_PUBLIC_URL.replace(/\/+$/, '');
  try {
    const res = await fetch(config.N8N_UPLOAD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': config.SERVICE_API_KEY ?? '' },
      body: JSON.stringify({
        ...p,
        file_download_url: `${base}/api/v1/internal/files/${p.entry_id}`,
        callback_url: `${base}/api/v1/internal/records/${p.entry_id}/parsed`,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`n8n responded ${res.status}`);
    return 'triggered';
  } catch (err) {
    console.warn('n8n upload pipeline trigger failed:', (err as Error).message);
    return 'failed';
  }
}
