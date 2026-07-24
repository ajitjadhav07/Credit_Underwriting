/**
 * finding-narratives.js
 * Turns normalized API responses into {severity, sentence, source}[] arrays
 * for the External APIs tab. severity ∈ 'good' | 'watch' | 'critical'.
 *
 * Field mappings per AFL's API-Analysis spec. All builders are defensive:
 * missing data → a single 'watch' card noting the source wasn't available,
 * never a crash.
 */

function n(v) { const x = parseFloat(v); return isNaN(x) ? null : x; }
function crFmt(rupees) {
    const v = n(rupees); if (v == null) return '';
    if (v >= 1e7) return '₹' + (v / 1e7).toFixed(2) + ' Cr';
    if (v >= 1e5) return '₹' + (v / 1e5).toFixed(2) + ' L';
    return '₹' + v.toLocaleString('en-IN');
}

// ── MCA Details ──
function buildMcaFindings(data) {
    if (!data || !data.success) return [{ severity: 'watch', sentence: 'MCA data not available for this assessment.', source: 'MCA Details' }];
    const c = data.company || data.result?.company || data;
    const out = [];
    const status = c.status || c.companyStatus;
    if (status) out.push({
        severity: /active/i.test(status) ? 'good' : 'critical',
        sentence: /active/i.test(status)
            ? `Company status at the Registrar is ${status} — no incorporation-level disqualifier.`
            : `Company status is ${status} — a struck-off/dormant entity is a hard disqualifier.`,
        source: 'company.status'
    });
    if (c.dateOfIncorporation) {
        const yrs = Math.floor((Date.now() - new Date(c.dateOfIncorporation)) / 3.156e10);
        out.push({ severity: yrs >= 3 ? 'good' : 'watch',
            sentence: `Incorporated on ${c.dateOfIncorporation} (${yrs} years ago), ${yrs >= 3 ? 'clearing' : 'below'} the 3-year minimum business vintage.`,
            source: 'company.dateOfIncorporation' });
    }
    const charges = (c.charges || []).filter(ch => /open/i.test(ch.status || ''));
    if (charges.length) out.push({ severity: 'critical',
        sentence: `${charges.length} charge(s) currently open against company assets — held by ${charges.slice(0,4).map(ch => `${ch.chargeHolderName} (${crFmt(ch.chargeAmount)})`).join(', ')}. Confirm none attach to the asset offered as security.`,
        source: 'charges[] where status = OPEN' });
    const dirs = c.directors || [];
    const serving = dirs.filter(d => !d.tenureEndDate);
    if (dirs.length) out.push({ severity: 'watch',
        sentence: `${serving.length} of ${dirs.length} directors on record are currently serving. Cross-check against those declared in this application.`,
        source: 'directors[] where tenureEndDate = null' });
    return out.length ? out : [{ severity: 'watch', sentence: 'MCA response received but no key fields could be read.', source: 'MCA Details' }];
}

// ── GST Authentication ──
function buildGstAuthFindings(data) {
    if (!data || !data.success) return [{ severity: 'watch', sentence: 'GST authentication data not available.', source: 'GST Authentication' }];
    const r = data.result || data;
    const out = [];
    const sts = r.sts || r.status;
    if (sts) out.push({ severity: /active/i.test(sts) ? 'good' : 'critical',
        sentence: /active/i.test(sts)
            ? 'GSTIN is Active with no cancellation on record — tax identity is valid and current.'
            : `GSTIN status is ${sts}${r.cxdt ? ' (cancelled ' + r.cxdt + ')' : ''} — a serious red flag on an operating business.`,
        source: 'sts, cxdt' });
    if (r.lgnm || r.tradeNam) out.push({ severity: 'good',
        sentence: `Legal name "${r.lgnm || r.tradeNam}"${r.ctb ? ', constitution ' + r.ctb : ''} — confirmed from the GST registry.`,
        source: 'lgnm, tradeNam, ctb' });
    if (r.aggreTurnOver) out.push({ severity: 'good',
        sentence: `Declared turnover slab: ${r.aggreTurnOver}${r.aggreTurnOverFY ? ' (' + r.aggreTurnOverFY + ')' : ''}.`,
        source: 'aggreTurnOver' });
    return out.length ? out : [{ severity: 'good', sentence: 'GSTIN validated.', source: 'GST Authentication' }];
}

// ── GST Return Filing ──
function buildGstFilingFindings(data) {
    if (!data || !data.success) return [{ severity: 'watch', sentence: 'GST return filing data not available.', source: 'GST Return Filing' }];
    const cs = data.complianceStatus || data.result?.complianceStatus || {};
    const out = [];
    if (cs.isDefaulter != null) out.push({ severity: cs.isDefaulter ? 'critical' : 'good',
        sentence: cs.isDefaulter
            ? 'Flagged as a return-filing defaulter with a history of delayed filings.'
            : 'Not flagged as a filing defaulter — GST return filing is broadly compliant.',
        source: 'complianceStatus.isDefaulter' });
    const list = data.result?.[0]?.eFiledlist || data.eFiledlist || [];
    if (list.length) {
        const delayed = list.filter(f => f.isDelay);
        const onTime = list.length - delayed.length;
        const avgDelay = delayed.length ? Math.round(delayed.reduce((s,f)=>s+(n(f.delayDays)||0),0)/delayed.length) : 0;
        out.push({ severity: delayed.length > list.length/2 ? 'critical' : delayed.length ? 'watch' : 'good',
            sentence: `${onTime} of ${list.length} returns (${Math.round(onTime/list.length*100)}%) filed on time.${delayed.length ? ' Late filings averaged ' + avgDelay + ' days overdue.' : ''}`,
            source: 'eFiledlist[] — isDelay, delayDays' });
    }
    return out.length ? out : [{ severity: 'watch', sentence: 'GST filing response received but no filing list found.', source: 'GST Return Filing' }];
}

// ── Peer Comparison ──
function buildPeerFindings(data) {
    if (!data || !data.success) return [{ severity: 'watch', sentence: 'Peer comparison data not available.', source: 'Peer Comparison' }];
    const recs = data.records || data.result?.records || [];
    if (!recs.length) return [{ severity: 'watch', sentence: 'No comparable peer companies returned.', source: 'Peer Comparison' }];
    const out = [{ severity: 'good', sentence: `${recs.length} comparable companies identified in this sector for benchmarking.`, source: 'records[]' }];
    // Margins/ROCE median comparison if present
    const margins = recs.map(r => n(r.ratAnalysis?.ebitdaMargin)).filter(v => v != null);
    if (margins.length) {
        const median = margins.sort((a,b)=>a-b)[Math.floor(margins.length/2)];
        out.push({ severity: 'good', sentence: `Peer-group median EBITDA margin is ${median.toFixed(1)}% across the comparable set — use as sector context for the borrower's standalone margin.`, source: 'ratAnalysis.ebitdaMargin vs peer median' });
    }
    return out;
}

// ── Litigation / BGV (combined) ──
function buildLitigationFindings(bgv, litigation) {
    const data = (litigation && litigation.success) ? litigation : bgv;
    if (!data || !data.success) return [{ severity: 'watch', sentence: 'Litigation / background verification data not available.', source: 'Litigation / BGV' }];
    const sev = data.severityCount?.total || data.result?.severityCount?.total || {};
    const cases = data.totalCases || data.result?.totalCases || {};
    const out = [];
    const total = n(cases.total), pending = n(cases.pending), high = n(sev.high);
    if (total != null) out.push({ severity: high > 0 ? 'critical' : pending > 0 ? 'watch' : 'good',
        sentence: `${total} total case(s) found against this name${pending != null ? ', of which ' + pending + ' still pending' : ''}${high != null ? ' — ' + high + ' classified high severity' : ''}.`,
        source: 'totalCases, severityCount.total' });
    if (data.confidenceLevel || data.result?.confidenceLevel) out.push({ severity: 'watch',
        sentence: `Match confidence is ${data.confidenceLevel || data.result?.confidenceLevel} — factor this into how strongly the flag should weigh.`,
        source: 'confidenceLevel, matchFlags' });
    return out.length ? out : [{ severity: 'good', sentence: 'No adverse litigation or criminal records matched.', source: 'Litigation / BGV' }];
}

function buildAllFindings(ext) {
    ext = ext || {};
    return {
        mca:         buildMcaFindings(ext.mca),
        gstAuth:     buildGstAuthFindings(ext.gst_auth),
        gstFiling:   buildGstFilingFindings(ext.gst_return),
        peer:        buildPeerFindings(ext.peer_comparison),
        litigation:  buildLitigationFindings(ext.bgv, ext.litigation)
    };
}

module.exports = { buildAllFindings, buildMcaFindings, buildGstAuthFindings, buildGstFilingFindings, buildPeerFindings, buildLitigationFindings };
