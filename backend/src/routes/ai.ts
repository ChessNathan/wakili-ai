import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/requireAuth';
import { generateDocument, SYSTEM_PROMPT } from '../lib/gemini';
import { supabase } from '../lib/supabase';
import { body, validationResult } from 'express-validator';
import { logAudit, logger } from '../lib/logger';

export const aiRouter = Router();

const INJECTION = [/ignore.*instructions/i, /forget.*instructions/i, /you are now/i, /act as/i, /system prompt/i];

aiRouter.post('/draft', async (req: AuthRequest, res: Response) => {
  try {
    const { prompt, doc_type, case_id, title } = req.body;

    if (!prompt || prompt.length < 10) {
      return res.status(400).json({ error: "Prompt too short" });
    }

    const firmId = req.profile?.firm_id;
    if (!firmId) {
      return res.status(400).json({ error: "No firm linked" });
    }

    const content = await generateDocument(
      SYSTEM_PROMPT,
      `Document Type: ${doc_type}\n\nUser Request:\n${prompt}\n\nGenerate a COMPLETE legal document.`
    );

    const { data, error } = await supabase
      .from("documents")
      .insert({
        firm_id: firmId,
        case_id: case_id || null,
        created_by: req.user!.id,
        title: title || `${doc_type} - ${new Date().toLocaleDateString()}`,
        doc_type,
        content,
        prompt,
        status: "draft",
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ document: data });

  } catch (err: any) {
    console.error("DRAFT ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

aiRouter.post('/refine',
  body('document_id').isUUID(),
  body('instruction').trim().isLength({ min: 5, max: 2000 }),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) { res.status(422).json({ error: errors.array()[0].msg }); return; }

    const { document_id, instruction } = req.body;
    const { data: doc } = await supabase.from('documents').select('*').eq('id', document_id).single();
    if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
    if (doc.firm_id !== req.profile?.firm_id) { res.status(403).json({ error: 'Forbidden' }); return; }

    try {
      const refined = await generateDocument(SYSTEM_PROMPT,
        `Current document:\n\n${doc.content}\n\n---\nInstruction: ${instruction}\n\nReturn the complete updated document.`
      );
      const { data: updated } = await supabase.from('documents')
        .update({ content: refined, updated_at: new Date().toISOString() })
        .eq('id', document_id).select().single();
      res.json({ document: updated });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to refine document' });
    }
  }
);
