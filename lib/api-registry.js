/**
 * api-registry.js — Central definition of all 12 AFL APIs
 * ----------------------------------------------------------------------
 * Single source of truth for every external API the application calls.
 * Each entry declares:
 *   - key: internal identifier
 *   - name: human label (matches AFL's list)
 *   - method: 'middleware' (via AFL DataPower/gateway, uses callMiddleware)
 *             or 'external' (direct HTTPS to api.karza.in / trackwizz)
 *   - url: full endpoint (env-overridable)
 *   - serviceCode: DataPower service code (middleware only)
 *
 * Adding/changing an API = edit this file only.
 */

// Base URLs (env-overridable via task definition)
const MIDDLEWARE_DATAPOWER = process.env.MIDDLEWARE_DATAPOWER_URL || 'https://afldatapoweruat.axisb.com:8441';
const MIDDLEWARE_NOVEL     = process.env.MIDDLEWARE_NOVEL_URL     || 'https://afldatapoweruat.axisb.com:8446';
const PENNANT_BASE         = process.env.PENNANT_BASE_URL         || 'https://afloasuatweb.axisb.com:8070';
const KARZA_EXTERNAL       = process.env.KARZA_EXTERNAL_BASE_URL  || 'https://api.karza.in';
const TRACKWIZZ_BASE       = process.env.TRACKWIZZ_BASE_URL       || 'https://axisfinanceltd-sb.trackwizz.app';

const API_REGISTRY = {
    // ── 1. MCA Details — via middleware ──
    mca: {
        key: 'mca', name: 'MCA Details', method: 'middleware',
        url: `${MIDDLEWARE_DATAPOWER}/V1/KARZA/IN0238/MCA_Details`,
        serviceCode: 'IN0238MCA',
    },
    // ── 2. GST Authentication — external Karza ──
    gst_auth: {
        key: 'gst_auth', name: 'GST Authentication', method: 'external',
        url: `${KARZA_EXTERNAL}/gst/uat/v2/gstdetailed`,
    },
    // ── 3. GST Return Filing — external Karza ──
    gst_return: {
        key: 'gst_return', name: 'GST Return Filing', method: 'external',
        url: `${KARZA_EXTERNAL}/gst/uat/v2/gst-return-status`,
    },
    // ── 4. Peer Comparison — external Karza ──
    peer_comparison: {
        key: 'peer_comparison', name: 'Peer Comparison', method: 'external',
        url: `${KARZA_EXTERNAL}/kscan/test/v1/peer-details/search`,
    },
    // ── 5. FIR Product Note — external Karza ──
    fir: {
        key: 'fir', name: 'FIR Product Note', method: 'external',
        url: `${KARZA_EXTERNAL}/kscan/test/v1/fir-data`,
    },
    // ── 6. Background Verification — external Karza ──
    bgv: {
        key: 'bgv', name: 'Background Verification', method: 'external',
        url: `${KARZA_EXTERNAL}/kscan/test/v1/bgv-data`,
    },
    // ── 7. Litigation — external Karza ──
    litigation: {
        key: 'litigation', name: 'Litigation', method: 'external',
        url: `${KARZA_EXTERNAL}/kscan/test/v1/litigations/bi/all/classification`,
    },
    // ── 8. EPFO — via middleware (2-step: OTP + Auth) ──
    epfo: {
        key: 'epfo', name: 'EPFO', method: 'middleware',
        url: `${MIDDLEWARE_DATAPOWER}/V1/Karza/IN0108/EPFUANLookupOTP`,
        urlAuth: `${MIDDLEWARE_DATAPOWER}/V1/Karza/IN0109/EPFUANAuthentication`,
        serviceCode: 'IN0108UANOTP',
        serviceCodeAuth: 'IN0109UANAUTH',
    },
    // ── 9. Novel Pattern Upload — via middleware ──
    novel_upload: {
        key: 'novel_upload', name: 'Novel Pattern Upload', method: 'middleware',
        url: `${MIDDLEWARE_NOVEL}/V1/IN0189/NOVEL/BANKSTATEMENTUPLOAD`,
        serviceCode: 'IN0189UPLOAD',
    },
    // ── 10. Novel Pattern Download — via middleware ──
    novel_download: {
        key: 'novel_download', name: 'Novel Pattern Download', method: 'middleware',
        url: `${MIDDLEWARE_NOVEL}/V1/IN0191/NOVEL/BANKSTATEMENTDOWNLOAD`,
        serviceCode: 'IN0191Download',
    },
    // ── 11. Pennant LOS — via middleware ──
    pennant: {
        key: 'pennant', name: 'Pennant LOS', method: 'middleware',
        url: `${PENNANT_BASE}/ords/afl/loan/v1/loandetails`,
        serviceCode: null,  // Pennant needs no DataPower service code
    },
    // ── 12. Trackwizz RBI Suite — external ──
    trackwizz: {
        key: 'trackwizz', name: 'Trackwizz RBI Suite File', method: 'external',
        url: `${TRACKWIZZ_BASE}/customerinfo/as501`,
    },
    // ── ITR — via middleware (in AFL's list under Karza) ──
    itr: {
        key: 'itr', name: 'ITR Verification', method: 'middleware',
        url: `${MIDDLEWARE_DATAPOWER}/V1/Karza/IN0114/ITR-V`,
        serviceCode: 'IN0114KARITR',
    },
};

module.exports = {
    API_REGISTRY,
    MIDDLEWARE_DATAPOWER, MIDDLEWARE_NOVEL, PENNANT_BASE, KARZA_EXTERNAL, TRACKWIZZ_BASE,
};
