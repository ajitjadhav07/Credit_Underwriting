/**
 * Individual CIBIL Client (SOAP)
 * ----------------------------------------------------------------------
 * Individual (consumer) CIBIL goes through a SOAP/XML service
 * (BureauOneInternalService.svc) — a completely different protocol from
 * every other integration in this app, which are all JSON/REST. This is
 * the one place in the codebase that builds/parses XML instead of JSON.
 *
 * Two-step pattern confirmed from the real Postman collection:
 *   1. ProcessRequestOnline  — submit borrower details, get back a
 *      bureauOneRefNo (synchronous call, per Call_Type: "Synchronous")
 *   2. DownloadSingleResponseByBOneRefNo — fetch the actual bureau
 *      report by that reference number
 *
 * ⚠️ RESPONSE SHAPE NOT YET VERIFIED — the provided collection only had
 * sample REQUESTS for both calls, no captured response. The XML
 * request-building below is exact (matches AFL's sample byte-for-byte
 * in structure). The response parsing uses fast-xml-parser generically
 * and returns the full parsed object under `raw` — DO NOT trust any
 * specific extracted field (cibil_score, dpd, etc.) until verified
 * against a real UAT response.
 */

const { XMLParser } = require('fast-xml-parser');
const s3Client = require('./s3-client');

const CIBIL_SOAP_URL = process.env.MIDDLEWARE_CIBIL_SOAP_URL || 'https://aflmiddlepower.axisb.com:4002/BureauOneService.svc';
const TIMEOUT_MS = parseInt(process.env.MIDDLEWARE_TIMEOUT_MS || '30000', 10);

const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

function isCibilSoapConfigured() {
    if (!CIBIL_SOAP_URL) {
        return { configured: false, details: 'MIDDLEWARE_CIBIL_SOAP_URL not set' };
    }
    return { configured: true, details: `Calling individual CIBIL SOAP service at ${CIBIL_SOAP_URL}` };
}

async function saveResponseToS3(assessmentId, step, result) {
    if (!assessmentId) return null;
    try {
        const key = `assessments/${assessmentId}/api-responses/cibil-individual-${step}.json`;
        const body = Buffer.from(JSON.stringify({ provider: 'CIBIL Individual (SOAP)', assessmentId, fetchedAt: new Date().toISOString(), ...result }, null, 2));
        await s3Client.uploadFile(key, body, 'application/json');
        return key;
    } catch (error) {
        console.error('[CibilSoap] Failed to save response to S3:', error.message);
        return null;
    }
}

function escapeXml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

async function postSoap(soapAction, xmlBody) {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(CIBIL_SOAP_URL, {
            method: 'POST',
            headers: {
                SOAPAction: soapAction,
                'Content-Type': 'text/xml'
            },
            body: xmlBody,
            signal: controller.signal
        });

        const durationMs = Date.now() - startTime;
        const text = await response.text();
        let parsed = null;
        try {
            parsed = xmlParser.parse(text);
        } catch (parseErr) {
            console.error('[CibilSoap] XML parse failed:', parseErr.message);
        }

        return { success: response.ok, status: response.status, raw: parsed, rawText: text, durationMs };

    } catch (error) {
        const durationMs = Date.now() - startTime;
        return {
            success: false,
            status: 0,
            error: error.name === 'AbortError' ? `CIBIL SOAP request timed out after ${TIMEOUT_MS}ms` : error.message,
            durationMs
        };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Step 1: submit a request for individual CIBIL. Field set matches
 * AFL's sample request exactly (BureauOne SOAP schema).
 * @param {Object} params - borrower personal/address details + assessmentId
 */
async function processIndividualRequest({
    addrLine1, addrLine2, city, state,
    firstName, lastName, dob, gender,
    pan, mobile, assessmentId
}) {
    const config = isCibilSoapConfigured();
    if (!config.configured) {
        return { success: false, error: config.details, skipped: true };
    }
    if (!pan && !mobile) {
        return { success: false, error: 'At least PAN or mobile number required for individual CIBIL', skipped: true };
    }

    const xmlBody = `<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:tem="http://tempuri.org/"
  xmlns:net="http://schemas.datacontract.org/2004/07/Nettpositive.BureauOne.BusinessObjects"
  xmlns:arr="http://schemas.microsoft.com/2003/10/Serialization/Arrays">
   <soapenv:Header/>
   <soapenv:Body>
      <tem:ProcessRequestOnline>
      <tem:request>
      <net:AccountNumber></net:AccountNumber>
      <net:AddrLine1>${escapeXml(addrLine1)}</net:AddrLine1>
      <net:AddrLine2>${escapeXml(addrLine2)}</net:AddrLine2>
      <net:AddrLine3></net:AddrLine3>
      <net:AddressType>1</net:AddressType>
      <net:BureauCategory>
              <net:CategoryId>1</net:CategoryId>
              <net:CategoryName></net:CategoryName>
      </net:BureauCategory>
      <net:Call_Type>Synchronous</net:Call_Type>
      <net:City>${escapeXml(city)}</net:City>
      <net:CreatedBy>UNDERWRITING-AGENT</net:CreatedBy>
      <net:CreatedOn>${new Date().toISOString()}</net:CreatedOn>
      <net:DBSave>true</net:DBSave>
      <net:DOB>${escapeXml(dob)}</net:DOB>
      <net:First_Name>${escapeXml(firstName)}</net:First_Name>
      <net:Gender>${escapeXml(gender)}</net:Gender>
      <net:LastName>${escapeXml(lastName)}</net:LastName>
      <net:MobileNumber>${escapeXml(mobile)}</net:MobileNumber>
      <net:PAN>${escapeXml(pan)}</net:PAN>
      <net:State>${escapeXml(state)}</net:State>
      </tem:request>
      </tem:ProcessRequestOnline>
   </soapenv:Body>
</soapenv:Envelope>`;

    // ⚠️ AFL confirmed the endpoint moved from BureauOneInternalService.svc
    // to BureauOneService.svc (new domain/port too — see CIBIL_SOAP_URL
    // above), but did NOT confirm whether the underlying SOAP interface/
    // contract name changed too. Deliberately NOT guessing this to
    // "IBureauOneService" — WCF services often rename the deployed route
    // without renaming the interface contract, so leaving the
    // last-confirmed-working value here. If this SOAP call faults with an
    // "action not supported" style error against the new endpoint, that's
    // the first thing to try changing.
    const result = await postSoap('http://tempuri.org/IBureauOneInternalService/ProcessRequestOnline', xmlBody);

    // NEEDS_REAL_RESPONSE_SAMPLE: bureauOneRefNo path is a best-effort
    // guess at the SOAP response envelope structure pending verification.
    const body = result.raw?.Envelope?.Body || result.raw?.['s:Envelope']?.['s:Body'] || {};
    const bureauOneRefNo = body?.ProcessRequestOnlineResponse?.ProcessRequestOnlineResult?.BureauOneRefNo
        ?? body?.ProcessRequestOnlineResponse?.ProcessRequestOnlineResult
        ?? null;

    const normalized = {
        provider: 'CIBIL Individual (SOAP)',
        purpose: 'Submit individual bureau request (step 1 of 2)',
        success: result.success,
        bureauOneRefNo, // NEEDS_REAL_RESPONSE_SAMPLE
        raw: result.raw,
        error: result.error,
        durationMs: result.durationMs
    };

    await saveResponseToS3(assessmentId, 'submit', normalized);
    return normalized;
}

/**
 * Step 2: download the bureau report by reference number returned
 * from processIndividualRequest().
 */
async function downloadByRefNo({ bureauOneRefNo, assessmentId }) {
    if (!bureauOneRefNo) {
        return { success: false, error: 'bureauOneRefNo required (from processIndividualRequest)', skipped: true };
    }

    const config = isCibilSoapConfigured();
    if (!config.configured) {
        return { success: false, error: config.details, skipped: true };
    }

    const xmlBody = `<soapenv:Envelope
xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
xmlns:tem="http://tempuri.org/">
    <soapenv:Header/>
    <soapenv:Body>
        <tem:DownloadSingleResponseByBOneRefNo>
            <tem:bureauOneRefNo>${escapeXml(bureauOneRefNo)}</tem:bureauOneRefNo>
        </tem:DownloadSingleResponseByBOneRefNo>
    </soapenv:Body>
</soapenv:Envelope>`;

    const result = await postSoap('http://tempuri.org/IBureauOneInternalService/DownloadSingleResponseByBOneRefNo', xmlBody);

    // NEEDS_REAL_RESPONSE_SAMPLE: every field here is a placeholder
    // pending a captured real response from this endpoint.
    const normalized = {
        provider: 'CIBIL Individual (SOAP)',
        purpose: 'Download bureau report (step 2 of 2)',
        success: result.success,
        cibil_score: null,   // NEEDS_REAL_RESPONSE_SAMPLE — path unknown
        dpd_history: [],     // NEEDS_REAL_RESPONSE_SAMPLE — path unknown
        raw: result.raw,
        error: result.error,
        durationMs: result.durationMs
    };

    await saveResponseToS3(assessmentId, 'download', normalized);
    return normalized;
}

module.exports = {
    isCibilSoapConfigured,
    processIndividualRequest,
    downloadByRefNo
};
