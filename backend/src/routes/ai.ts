import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/requireAuth';
import { anthropic, KENYA_LEGAL_SYSTEM_PROMPT, DOC_TYPE_PROMPTS, DocType } from '../lib/anthropic';
import { supabase } from '../lib/supabase';
import { validateDraft, validateRefine, validate } from '../middleware/validators';
import { guardPromptInjection } from '../middleware/security';
import { logAudit } from '../lib/logger';

export const aiRouter = Router();

aiRouter.post('/draft',
  validateDraft, validate, guardPromptInjection,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const { prompt, doc_type, case_id, title } = req.body;

    if (!req.profile?.firm_id) {
      res.status(400).json({ error: 'User has no firm. Please set up your firm first.' }); return;
    }

    if (case_id) {
      const { data: caseRow } = await supabase.from('cases').select('firm_id').eq('id', case_id).single();
      if (!caseRow || (caseRow as any).firm_id !== req.profile.firm_id) {
        res.status(403).json({ error: 'Case not found in your firm.' }); return;
      }
    }

    try {
      const typePrompt = DOC_TYPE_PROMPTS[doc_type as DocType] || DOC_TYPE_PROMPTS.other;
      const message = await anthropic.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 4096,
        system: KENYA_LEGAL_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `${typePrompt}\n\nMatter details:\n${prompt}\n\nProduce the complete document now.` }],
      });

      const content = message.content[0].type === 'text' ? message.content[0].text : '';

      const { data: doc, error } = await supabase
        .from('documents')
        .insert({
          firm_id: req.profile.firm_id,
          case_id: case_id || null,
          created_by: req.user!.id,
          title: title || `${doc_type} — ${new Date().toLocaleDateString('en-KE')}`,
          doc_type, content, prompt, status: 'draft',
        })
        .select().single();

      if (error) throw error;
      logAudit('AI_DRAFT_CREATED', req.user!.id, { doc_type, doc_id: (doc as any).id });
      res.json({ document: doc });
    } catch (_err) {
      res.status(500).json({ error: 'Failed to generate document. Please try again.' });
    }
  }
);

aiRouter.post('/refine',
  validateRefine, validate, guardPromptInjection,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const { document_id, instruction } = req.body;
    const firmId = req.profile?.firm_id;

    const { data: doc, error: fetchError } = await supabase
      .from('documents').select('*').eq('id', document_id).single();

    if (fetchError || !doc) { res.status(404).json({ error: 'Document not found' }); return; }
    if ((doc as any).firm_id !== firmId) { res.status(403).json({ error: 'Forbidden' }); return; }

    try {
      const message = await anthropic.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 4096,
        system: KENYA_LEGAL_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: `Here is the current document:\n\n${(doc as any).content}` },
          { role: 'assistant', content: 'I have reviewed the document.' },
          { role: 'user', content: `Please refine it with this instruction: ${instruction}` },
        ],
      });

      const refined = message.content[0].type === 'text' ? message.content[0].text : '';
      const { data: updated, error } = await supabase
        .from('documents')
        .update({ content: refined, updated_at: new Date().toISOString() })
        .eq('id', document_id).select().single();

      if (error) throw error;
      logAudit('AI_REFINE', req.user!.id, { document_id });
      res.json({ document: updated });
    } catch (_err) {
      res.status(500).json({ error: 'Failed to refine document. Please try again.' });
    }
  }
);
