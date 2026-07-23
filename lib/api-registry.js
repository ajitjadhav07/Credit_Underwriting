/**
 * api-registry.js — Central definition of all AFL APIs
 * ----------------------------------------------------------------------
 * NOTE: URLs below are PLACEHOLDER/skeleton values pending AFL's actual
 * endpoints. Update the url fields when real URLs + response samples arrive.
 *
 * ROUTING (corrected per AFL):
 *   - method 'direct'     → internal APIs called directly: Pennant, Trackwizz
 *   - method 'middleware' → everything else, via AFL DataPower gateway
 *
 * Each entry: key / name / method / url / serviceCode (middleware only).
 * Adding/changing an API = edit this file only.
 */

// Base URLs (env-overridable via task definition) — PLACEHOLDER until real ones
const MIDDLEWARE_DATAPOWER = process.env.MIDDLEWARE_DATAPOWER_URL || 'https://afldatapoweruat.axisb.com:8441';
const MIDDLEWARE_NOVEL     = process.env.MIDDLEWARE_NOVEL_URL     || 'https://afldatapoweruat.axisb.com:8446';
const PENNANT_BASE         = process.env.PENNANT_BASE_URL         || 'https://afloasuatweb.axisb.com:8070';
const TRACKWIZZ_BASE       = process.env.TRACKWIZZ_BASE_URL       || 'https://axisfinanceltd-sb.trackwizz.app';

const API_REGISTRY = {
    // ── DIRECT (internal APIs, no middleware) ──
    pennant: {
        key: 'pennant', name: 'Pennant LOS', method: 'direct',
        url: `${PENNANT_BASE}/ords/afl/loan/v1/loandetails`,
    },
    trackwizz: {
        key: 'trackwizz', name: 'Trackwizz RBI Suite File', method: 'direct',
        url: `${TRACKWIZZ_BASE}/customerinfo/as501`,
    },

    // ── VIA MIDDLEWARE (AFL DataPower gateway) ──
    mca: {
        key: 'mca', name: 'MCA Details', method: 'middleware',
        url: `${MIDDLEWARE_DATAPOWER}/V1/KARZA/IN0238/MCA_Details`,
        serviceCode: 'IN0238MCA',
    },
    gst_auth: {
        key: 'gst_auth', name: 'GST Authentication', method: 'middleware',
        url: `${MIDDLEWARE_DATAPOWER}/V1/Karza/IN0159/GstAuthentication`,
        serviceCode: 'IN0159GSTAUTH',
    },
    gst_return: {
        key: 'gst_return', name: 'GST Return Filing', method: 'middleware',
        url: `${MIDDLEWARE_DATAPOWER}/V1/Karza/IN0149/GstReturnFilingAuthentication`,
        serviceCode: 'IN0149GSTRET',
    },
    peer_comparison: {
        key: 'peer_comparison', name: 'Peer Comparison', method: 'middleware',
        url: `${MIDDLEWARE_DATAPOWER}/V1/Karza/kscan/peer-details`,
        serviceCode: 'PEERDETAILS',   // PENDING real URL/code from AFL
        pending: true,
    },
    fir: {
        key: 'fir', name: 'FIR Product Note', method: 'middleware',
        url: `${MIDDLEWARE_DATAPOWER}/V1/Karza/kscan/fir-data`,
        serviceCode: 'FIRDATA',       // PENDING real URL/code from AFL
        pending: true,
    },
    bgv: {
        key: 'bgv', name: 'Background Verification', method: 'middleware',
        url: `${MIDDLEWARE_DATAPOWER}/V1/Karza/kscan/bgv-data`,
        serviceCode: 'BGVDATA',       // PENDING real URL/code from AFL
        pending: true,
    },
    litigation: {
        key: 'litigation', name: 'Litigation', method: 'middleware',
        url: `${MIDDLEWARE_DATAPOWER}/V1/Karza/kscan/litigations`,
        serviceCode: 'LITIGATION',    // PENDING real URL/code from AFL
        pending: true,
    },
    epfo: {
        key: 'epfo', name: 'EPFO', method: 'middleware',
        url: `${MIDDLEWARE_DATAPOWER}/V1/Karza/IN0108/EPFUANLookupOTP`,
        urlAuth: `${MIDDLEWARE_DATAPOWER}/V1/Karza/IN0109/EPFUANAuthentication`,
        serviceCode: 'IN0108UANOTP',
        serviceCodeAuth: 'IN0109UANAUTH',
    },
    novel_upload: {
        key: 'novel_upload', name: 'Novel Pattern Upload', method: 'middleware',
        url: `${MIDDLEWARE_NOVEL}/V1/IN0189/NOVEL/BANKSTATEMENTUPLOAD`,
        serviceCode: 'IN0189UPLOAD',
    },
    novel_download: {
        key: 'novel_download', name: 'Novel Pattern Download', method: 'middleware',
        url: `${MIDDLEWARE_NOVEL}/V1/IN0191/NOVEL/BANKSTATEMENTDOWNLOAD`,
        serviceCode: 'IN0191Download',
    },
    itr: {
        key: 'itr', name: 'ITR Verification', method: 'middleware',
        url: `${MIDDLEWARE_DATAPOWER}/V1/Karza/IN0114/ITR-V`,
        serviceCode: 'IN0114KARITR',
    },
};

module.exports = {
    API_REGISTRY,
    MIDDLEWARE_DATAPOWER, MIDDLEWARE_NOVEL, PENNANT_BASE, TRACKWIZZ_BASE,
};
