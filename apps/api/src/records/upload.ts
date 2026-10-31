/**
 * Shared multer setup for file uploads (app upload route + WhatsApp/n8n upload route).
 * Keeps the file in memory (max MAX_UPLOAD_MB), one file, form field name "file".
 */
import multer from 'multer';
import { config } from '../config';

export const uploadSingleFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
}).single('file');
