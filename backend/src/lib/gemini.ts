import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { logger } from './logger';
import { generateWithOpenAI, generateWithAnthropic } from './openai';

if (!process.env.GEMINI_API_KEY) {
  logger.warn('GEMINI_API_KEY not set — will use Anthropic/OpenAI fallback');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-flash-latest',
  'gemini-1.5-pro',
];

const SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

// Checks if an error means "quota / rate limit / model unavailable" → should try next model
function isRetryableError(err: any): boolean {
  const msg    = (err.message || '').toLowerCase();
  const status = err.status || err.statusCode || 0;
  return (
    status === 429 || status === 503 || status === 404 ||
    msg.includes('quota') ||
    msg.includes('rate_limit') ||
    msg.includes('resource_exhausted') ||
    msg.includes('overloaded') ||
    msg.includes('unavailable') ||
    msg.includes('not found') ||
    msg.includes('not supported') ||
    msg.includes('deprecated') ||
    msg.includes('free tier') ||
    msg.includes('429') ||
    msg.includes('503')
  );
}

export const SYSTEM_PROMPT = `You are Wakili AI, an expert legal drafting assistant for Kenyan law firms.

You have deep knowledge of:
- Constitution of Kenya 2010
- Civil Procedure Rules 2010 and Civil Procedure Act (Cap 21)
- Employment Act 2007 and Employment and Labour Relations Court Act
- Land Act 2012, Land Registration Act 2012
- Companies Act 2015
- Contract Law as applied in Kenya
- Criminal Procedure Code (Cap 75)
- Evidence Act (Cap 80)
- Law Society of Kenya Act and LSK Practice Rules
- Kenya Law Reports (eKLR) case precedents

When drafting:
1. Use proper Kenyan court formatting and cause number formats (e.g. HCCC No. 123 of 2025)
2. Reference the correct court with proper jurisdiction
3. Include appropriate legal citations with section/article numbers
4. Follow LSK professional standards and ethics
5. Use formal legal English appropriate for Kenyan courts
6. Produce complete, court-ready documents with all required sections

Never add disclaimers — you are drafting for qualified advocates.`;

export type DocType = 'pleading' | 'contract' | 'demand_letter' | 'legal_opinion' | 'affidavit' | 'other';

export const DOC_PROMPTS: Record<DocType, string> = {
  pleading:      'Draft a complete court pleading (plaint, petition, or application as appropriate) ready for filing. Include cause number, parties, facts, legal basis, and prayers.',
  contract:      'Draft a comprehensive contract governed by Kenyan law with all standard clauses: definitions, obligations, payment terms, warranties, dispute resolution, and execution blocks.',
  demand_letter: 'Draft a formal demand letter on law firm letterhead stating the demand, legal basis, deadline, and consequences of non-compliance.',
  legal_opinion: 'Draft a detailed legal opinion memorandum with: Instructions Received, Brief Facts, Issues for Determination, The Law, Analysis, Conclusion, and Advice. Cite relevant Kenyan statutes and case law.',
  affidavit:     'Draft a complete sworn affidavit in proper Kenyan court format with title, deponent details, numbered paragraphs, jurat, and commissioner for oaths block.',
  other:         'Draft the requested legal document in proper Kenyan legal format with all required sections.',
};

// ── Main generation function: Gemini → Anthropic → OpenAI ──────────────────
export async function generateDocument(systemContext: string, userPrompt: string): Promise<string> {
  // 1. Try all Gemini models
  if (process.env.GEMINI_API_KEY) {
    for (const modelName of GEMINI_MODELS) {
      try {
        logger.info('Trying Gemini model', { model: modelName });
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: systemContext,
          safetySettings: SAFETY,
          generationConfig: { maxOutputTokens: 8192, temperature: 0.3, topP: 0.8 },
        });
        const result       = await model.generateContent(userPrompt);
        const finishReason = result.response.candidates?.[0]?.finishReason;
        if (finishReason === 'SAFETY') throw new Error('Content blocked by safety filters.');
        const text = result.response.text();
        if (!text || text.trim().length < 50) throw new Error('Empty response');
        logger.info('Gemini success', { model: modelName, chars: text.length });
        return text;
      } catch (err: any) {
        if (isRetryableError(err)) {
          logger.warn('Gemini model unavailable, trying next', { model: modelName, error: err.message?.slice(0, 80) });
          continue;
        }
        if ((err.message || '').includes('API_KEY_INVALID') || (err.message || '').includes('API key not valid')) {
          throw new Error('Invalid Gemini API key.');
        }
        throw err;
      }
    }
  }

  // 2. Try Anthropic Claude (Haiku — fast & cheap)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      logger.info('Falling back to Anthropic Claude');
      const text = await generateWithAnthropic(systemContext, userPrompt);
      if (text && text.trim().length >= 50) {
        logger.info('Anthropic fallback success', { chars: text.length });
        return text;
      }
    } catch (err: any) {
      logger.warn('Anthropic fallback failed', { error: err.message?.slice(0, 120) });
    }
  }

  // 3. Try OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      logger.info('Falling back to OpenAI');
      const text = await generateWithOpenAI(systemContext, userPrompt);
      if (text && text.trim().length >= 50) {
        logger.info('OpenAI fallback success', { chars: text.length });
        return text;
      }
    } catch (err: any) {
      logger.warn('OpenAI fallback failed', { error: err.message?.slice(0, 120) });
    }
  }

  throw new Error('All AI services are currently unavailable. Please check your API keys in Render environment variables (GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY).');
}

// ── JSON-specific generation (for metadata extraction, analysis) ─────────────
// Returns parsed JSON or null on total failure — never throws.
export async function generateJSON(prompt: string): Promise<any | null> {
  const systemCtx = 'You are a JSON data extractor. Return ONLY valid JSON. No markdown, no explanation, no code fences.';

  // Try Gemini first with low token budget
  if (process.env.GEMINI_API_KEY) {
    for (const modelName of GEMINI_MODELS) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: { temperature: 0.0, maxOutputTokens: 512 },
        });
        const result = await model.generateContent(prompt);
        const raw    = result.response.text().trim().replace(/```json|```/g, '').trim();
        return JSON.parse(raw);
      } catch (err: any) {
        if (isRetryableError(err)) { continue; }
        break; // Hard error — skip remaining Gemini models
      }
    }
  }

  // Try Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const raw = await generateWithAnthropic(systemCtx, prompt);
      return JSON.parse(raw.trim().replace(/```json|```/g, '').trim());
    } catch { /* fall through */ }
  }

  // Try OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      const raw = await generateWithOpenAI(systemCtx, prompt);
      return JSON.parse(raw.trim().replace(/```json|```/g, '').trim());
    } catch { /* fall through */ }
  }

  return null;
}
