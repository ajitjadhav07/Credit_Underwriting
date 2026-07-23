/**
 * api-response-ingest.js — Hybrid API/Upload ingestion layer
 * ----------------------------------------------------------------------
 * PURPOSE
 * Lets the application accept a manually-uploaded API-RESPONSE FILE in place
 * of making the live API call. If the user uploads (say) a GST response file,
 * we extract the data from it and SKIP the GST API call. APIs whose response
 * file was NOT uploaded still get called live. This makes assessments resilient
 * to API downtime.
 *
 * DESIGN PRINCIPLES (per requirements)
 * 1. Additive only — does not modify existing extractors or calc engine.
 * 2. Format-agnostic — a response file may be JSON, PDF, DOCX, or XLSX.
 *    JSON/XLSX/DOCX text is parsed directly (cheap, exact); PDF and
 *    image-like content fall back to Claude extraction (existing pipeline).
 * 3. Auto-categorization — given a file, detect WHICH API it belongs to
 *    from filename + content signature, so the UI can place it in the right
 *    category automatically.
 *
 * This module is a library. Wiring into bull-queue (skip-if-uploaded) and the
 * upload UI (auto-categorize dropdown) are separate, opt-in steps.
 */

// ── API registry ──────────────────────────────────────────────────────────
// Each entry: how to recognize an uploaded response file for this API, and
// which internal document category it maps to. When AFL provides the full API
// list, add entries here — nothing else needs to change.
const API_SIGNATURES = [
    // ── Via Middleware (afldatapoweruat / afloasuatweb) ──
    {
        api: 'pennant', category: 'pennant_response',
        fileHints: ['pennant', 'los_response', 'loandetails', 'loan_detail'],
        contentHints: ['customer_api', 'loan_detail_api', 'p_fin_reference', 'finreference'],
        requiredFields: ['customer_api', 'loan_detail_api'],
    },
    {
        api: 'mca', category: 'mca_response',
        fileHints: ['mca', 'company_master', 'roc', 'mca_details'],
        contentHints: ['cin', 'company_master', 'director', 'roc', 'incorporation'],
        requiredFields: ['cin'],
    },
    {
        api: 'epfo', category: 'epfo_response',
        fileHints: ['epfo', 'epf_', 'uan', 'epfuan'],
        contentHints: ['uan', 'establishment', 'pf_', 'epfo'],
        requiredFields: ['uan'],
    },
    {
        api: 'novel', category: 'novel_response',
        fileHints: ['novel', 'bankstatement_analysis', 'bank_analysis', 'perfios'],
        contentHints: ['average_balance', 'monthly_credits', 'bounce', 'banking_conduct'],
        requiredFields: [],
    },
    // ── External (api.karza.in / trackwizz) ──
    {
        api: 'gst_auth', category: 'gst_auth_response',
        fileHints: ['gst_auth', 'gstdetailed', 'gst_detailed', 'gst_authentication'],
        contentHints: ['gstin', 'legal_name', 'gst_status', 'registration_date'],
        requiredFields: ['gstin'],
    },
    {
        api: 'gst_return', category: 'gst_return',
        fileHints: ['gst_return', 'gstr', 'gst_return_status', 'return_filing'],
        contentHints: ['gstin', 'gstr', 'return_status', 'filing_status', 'ret_period'],
        requiredFields: ['gstin'],
    },
    {
        api: 'peer_comparison', category: 'peer_comparison_response',
        fileHints: ['peer', 'peer_comparison', 'peer_details'],
        contentHints: ['peer', 'comparison', 'industry_average', 'benchmark'],
        requiredFields: [],
    },
    {
        api: 'fir', category: 'fir_response',
        fileHints: ['fir', 'fir_data', 'fir_product'],
        contentHints: ['fir', 'police', 'case_details', 'crime'],
        requiredFields: [],
    },
    {
        api: 'bgv', category: 'bgv_response',
        fileHints: ['bgv', 'background_verification', 'bgv_data'],
        contentHints: ['background', 'verification', 'bgv', 'antecedent'],
        requiredFields: [],
    },
    {
        api: 'litigation', category: 'litigation_response',
        fileHints: ['litigation', 'litigations', 'court_case', 'classification'],
        contentHints: ['litigation', 'court', 'case', 'legal_proceeding', 'classification'],
        requiredFields: [],
    },
    {
        api: 'trackwizz', category: 'trackwizz_response',
        fileHints: ['trackwizz', 'rbi_suite', 'customerinfo', 'as501'],
        contentHints: ['trackwizz', 'customer_info', 'rbi', 'aml', 'watchlist'],
        requiredFields: [],
    },
    // ── CIBIL — upload-only (no API), kept for auto-categorization ──
    {
        api: 'cibil', category: 'cibil',
        fileHints: ['cibil', 'credit_report', 'bureau', 'cmr'],
        contentHints: ['cibil_score', 'cmr', 'dpd', 'credit_facility', 'bureau'],
        requiredFields: ['cibil_score'],
    },
    // ── ITR — via middleware Karza ──
    {
        api: 'itr', category: 'itr',
        fileHints: ['itr_response', 'itr_v', 'itr-', 'karza_itr'],
        contentHints: ['acknowledgement_number', 'assessment_year', 'gross_total_income', 'itr'],
        requiredFields: ['acknowledgement_number', 'assessment_year'],
    },
    // When new APIs are added, append one entry here — no other code changes.
];

/**
 * Validate that a parsed uploaded response actually contains the required
 * data for its API. Returns true only if ALL requiredFields are present and
 * non-empty (searched recursively so nested shapes still match). If false,
 * the caller should fall back to calling the live API.
 */
function hasCompleteData(apiName, json, text) {
    const sig = API_SIGNATURES.find(s => s.api === apiName);
    if (!sig) return false;
    if (!sig.requiredFields || sig.requiredFields.length === 0) {
        // No required fields defined — accept if we have any JSON or non-trivial text
        return !!(json && Object.keys(json).length > 0) || (text && text.length > 50);
    }
    const haystackJson = json ? JSON.stringify(json).toLowerCase() : '';
    const haystackText = (text || '').toLowerCase();
    const hay = haystackJson + ' ' + haystackText;

    // Every required field must appear AND (for JSON) have a non-empty value
    for (const field of sig.requiredFields) {
        const f = field.toLowerCase();
        if (!hay.includes(f)) return false;
        // If JSON, check the value isn't null/empty/0-length
        if (json) {
            const val = findKeyDeep(json, field);
            if (val === null || val === undefined || val === '' ||
                (Array.isArray(val) && val.length === 0)) {
                return false;
            }
        }
    }
    return true;
}

// Recursively find a key's value in a nested object/array
function findKeyDeep(obj, key) {
    if (!obj || typeof obj !== 'object') return undefined;
    const lk = key.toLowerCase();
    for (const k of Object.keys(obj)) {
        if (k.toLowerCase() === lk) return obj[k];
    }
    for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v && typeof v === 'object') {
            const found = findKeyDeep(v, key);
            if (found !== undefined) return found;
        }
    }
    return undefined;
}

/**
 * Determine the MIME/format family of an uploaded file from its name/bytes.
 * Returns one of: 'json' | 'pdf' | 'docx' | 'xlsx' | 'text' | 'unknown'
 */
function detectFileFormat(fileName, buffer) {
    const name = (fileName || '').toLowerCase();
    if (name.endsWith('.json')) return 'json';
    if (name.endsWith('.pdf')) return 'pdf';
    if (name.endsWith('.docx') || name.endsWith('.doc')) return 'docx';
    if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) return 'xlsx';
    if (name.endsWith('.txt')) return 'text';

    // Sniff magic bytes if extension is missing/ambiguous
    if (buffer && buffer.length > 4) {
        const head = buffer.slice(0, 4);
        // PDF: %PDF
        if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'pdf';
        // ZIP-based (docx/xlsx): PK\x03\x04
        if (head[0] === 0x50 && head[1] === 0x4B && head[2] === 0x03 && head[3] === 0x04) {
            // Could be docx or xlsx — decide from filename hint, else assume xlsx
            if (name.includes('doc')) return 'docx';
            return 'xlsx';
        }
        // JSON: starts with { or [
        const first = buffer.slice(0, 64).toString('utf-8').trimStart()[0];
        if (first === '{' || first === '[') return 'json';
    }
    return 'unknown';
}

/**
 * Extract raw text/structured content from any supported file format.
 * Returns { format, text, json } where json is populated for JSON/XLSX,
 * and text for everything (used for content-signature matching + Claude
 * fallback for PDF).
 */
async function readFileContent(fileName, buffer) {
    const format = detectFileFormat(fileName, buffer);
    const out = { format, text: '', json: null };

    try {
        if (format === 'json') {
            const raw = buffer.toString('utf-8');
            out.text = raw;
            out.json = JSON.parse(raw);
        } else if (format === 'text') {
            out.text = buffer.toString('utf-8');
        } else if (format === 'xlsx') {
            // Lazy-require so environments without the lib still load this module
            try {
                const XLSX = require('xlsx');
                const wb = XLSX.read(buffer, { type: 'buffer' });
                const parts = [];
                const jsonSheets = {};
                wb.SheetNames.forEach(sn => {
                    const ws = wb.Sheets[sn];
                    parts.push(XLSX.utils.sheet_to_csv(ws));
                    jsonSheets[sn] = XLSX.utils.sheet_to_json(ws);
                });
                out.text = parts.join('\n');
                out.json = jsonSheets;
            } catch (e) {
                out.text = '';
                out.error = 'xlsx parse failed: ' + e.message;
            }
        } else if (format === 'docx') {
            try {
                const mammoth = require('mammoth');
                const res = await mammoth.extractRawText({ buffer });
                out.text = res.value || '';
            } catch (e) {
                out.text = '';
                out.error = 'docx parse failed: ' + e.message;
            }
        } else if (format === 'pdf') {
            // PDF text isn't parsed here — the caller routes PDF through the
            // existing Claude extraction pipeline. We only note the format.
            out.text = '';
            out.pdfNeedsClaude = true;
        }
    } catch (e) {
        out.error = e.message;
    }
    return out;
}

/**
 * Identify which API an uploaded file belongs to, from filename + content.
 * Returns { api, category, confidence } or null if unrecognized.
 */
function identifyApiResponse(fileName, contentText, contentJson) {
    const name = (fileName || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const text = (contentText || '').toLowerCase();
    const jsonKeys = contentJson && typeof contentJson === 'object'
        ? JSON.stringify(Object.keys(contentJson)).toLowerCase() + ' ' + text.slice(0, 2000)
        : text.slice(0, 2000);

    let best = null;
    for (const sig of API_SIGNATURES) {
        let score = 0;
        for (const h of sig.fileHints)    if (name.includes(h)) score += 2;   // filename match = strong
        for (const h of sig.contentHints) if (jsonKeys.includes(h)) score += 1; // content match = supporting
        if (score > 0 && (!best || score > best.score)) {
            best = { api: sig.api, category: sig.category, score };
        }
    }
    if (!best) return null;
    return {
        api: best.api,
        category: best.category,
        confidence: best.score >= 3 ? 'high' : best.score >= 2 ? 'medium' : 'low',
    };
}

/**
 * Top-level: given an uploaded file, figure out (a) which API it is and
 * (b) return the parsed content ready to feed into the pipeline. For PDFs,
 * flags pdfNeedsClaude so the caller uses the existing Claude extractor.
 */
async function ingestUploadedFile(fileName, buffer) {
    const content = await readFileContent(fileName, buffer);
    const id = identifyApiResponse(fileName, content.text, content.json);
    const api = id?.api || null;
    // Completeness: for JSON/text we can validate now. For PDF (needs Claude),
    // completeness is decided AFTER Claude extraction by the caller.
    const complete = (api && !content.pdfNeedsClaude)
        ? hasCompleteData(api, content.json, content.text)
        : false;
    return {
        fileName,
        format: content.format,
        api,
        category: id?.category || null,
        confidence: id?.confidence || 'none',
        json: content.json,
        text: content.text,
        pdfNeedsClaude: content.pdfNeedsClaude || false,
        // true = uploaded file has all required data → SKIP the API call
        // false = incomplete/blank/PDF-pending → caller should call the API
        hasCompleteData: complete,
        error: content.error || null,
    };
}

module.exports = {
    API_SIGNATURES,
    detectFileFormat,
    readFileContent,
    identifyApiResponse,
    hasCompleteData,
    findKeyDeep,
    ingestUploadedFile,
};
