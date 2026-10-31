/**
 * Machine-to-machine routes for Member 2's n8n pipeline (mounted at /api/v1/internal, x-service-key required).
 *   GET  /files/:entryId            n8n downloads the stored file to send to Gemini
 *   POST /records/:entryId/parsed   n8n posts Gemini's extraction; THIS code computes High/Low from the printed range
 * Body for /parsed:
 *   { "status": "processed" | "failed", "error"?: string, "extracted"?: {...},
 *     "tests"?: [{ "name", "value", "unit", "range_low", "range_high", "confidence" }] }
 */
import { Router } from 'express';
import { z } from 'zod';
import { labResults, timelineEntries, type LabTest } from '../db/mongo';
import { AppError } from '../middleware/errors';
import { asyncHandler } from '../middleware/asyncHandler';
import { requireServiceKey } from '../middleware/serviceKey';
import { getFile } from '../integrations/storage';
import { flagLabValue, toNumber } from './lab';
import { parseEntryId } from './service';

export const internalRouter = Router();
internalRouter.use(requireServiceKey);

const NumOrString = z.union([z.number(), z.string().max(50)]);
const ParsedBody = z.object({
  status: z.enum(['processed', 'failed']).default('processed'),
  error: z.string().max(500).optional(),
  extracted: z.record(z.unknown()).optional(),
  tests: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        value: NumOrString,
        unit: z.string().max(50).nullable().optional(),
        range_low: NumOrString.nullable().optional(),
        range_high: NumOrString.nullable().optional(),
        confidence: z.number().min(0).max(1).nullable().optional(),
      }),
    )
    .max(300)
    .optional(),
});

internalRouter.get(
  '/files/:entryId',
  asyncHandler(async (req, res) => {
    const entry = await (await timelineEntries()).findOne({ _id: parseEntryId(req.params.entryId) });
    if (!entry) throw new AppError(404, 'RECORD_NOT_FOUND', 'Record not found');
    res.setHeader('Content-Type', entry.file_ref.mime);
    res.setHeader('Cache-Control', 'no-store');
    res.send(await getFile(entry.file_ref));
  }),
);

internalRouter.post(
  '/records/:entryId/parsed',
  asyncHandler(async (req, res) => {
    const body = ParsedBody.parse(req.body);
    const entries = await timelineEntries();
    const entry = await entries.findOne({ _id: parseEntryId(req.params.entryId) });
    if (!entry) throw new AppError(404, 'RECORD_NOT_FOUND', 'Record not found');
    const entryId = entry._id.toHexString();

    let flagged: LabTest[] = [];
    if (body.tests?.length) {
      flagged = body.tests.map((t) => ({
        name: t.name,
        value: toNumber(t.value) ?? t.value,
        unit: t.unit ?? null,
        range_low: toNumber(t.range_low),
        range_high: toNumber(t.range_high),
        status: flagLabValue(t.value, t.range_low, t.range_high),
        confidence: t.confidence ?? null,
      }));
      const now = new Date();
      await (await labResults()).updateOne(
        { entry_id: entryId },
        { $set: { patient_id: entry.patient_id, tests: flagged, updated_at: now }, $setOnInsert: { created_at: now } },
        { upsert: true },
      );
    }

    await entries.updateOne(
      { _id: entry._id },
      {
        $set: {
          processing_status: body.status,
          processing_error: body.status === 'failed' ? body.error ?? 'unknown error' : null,
          ...(body.extracted ? { extracted: body.extracted } : {}),
          updated_at: new Date(),
        },
      },
    );

    res.json({
      entryId,
      processingStatus: body.status,
      tests: flagged.length,
      abnormal: flagged.filter((t) => t.status === 'high' || t.status === 'low').map((t) => ({ name: t.name, status: t.status })),
    });
  }),
);
