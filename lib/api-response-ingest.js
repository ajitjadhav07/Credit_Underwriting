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
    {
        api: 'pennant',
        category: 'pennant_response',
        // filename hints
        fileHints: ['pennant', 'los_response', 'loandetails', 'loan_detail'],
        // content signature — keys/text that identify this API's response
        contentHints: ['customer_api', 'loan_detail_api', 'p_fin_reference', 'finreference'],
    },
    {
        api: 'gst',
        category: 'gst_return',
        fileHints: ['gst_response', 'gst_return', 'karza_gst', 'gstr'],
        contentHints: ['gstin', 'gstr', 'taxable_value', 'gst_return'],
    },
    {
        api: 'itr',
        category: 'itr',
        fileHints: ['itr_response', 'itr_v', 'itr-', 'karza_itr'],
        contentHints: ['acknowledgement_number', 'assessment_year', 'gross_total_income', 'itr'],
    },
    {
        api: 'cibil',
        category: 'cibil',
        fileHints: ['cibil', 'credit_report', 'bureau', 'cmr'],
        contentHints: ['cibil_score', 'cmr', 'dpd', 'credit_facility', 'bureau'],
    },
    {
        api: 'epfo',
        category: 'epfo_response',
        fileHints: ['epfo', 'epf_', 'uan', 'epfuan'],
        contentHints: ['uan', 'establishment', 'pf_', 'epfo'],
    },
    // Novel bank statement analysis, etc. — add when AFL provides the full list.
];

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
    return {
        fileName,
        format: content.format,
        api: id?.api || null,
        category: id?.category || null,
        confidence: id?.confidence || 'none',
        json: content.json,
        text: content.text,
        pdfNeedsClaude: content.pdfNeedsClaude || false,
        error: content.error || null,
    };
}

module.exports = {
    API_SIGNATURES,
    detectFileFormat,
    readFileContent,
    identifyApiResponse,
    ingestUploadedFile,
};
