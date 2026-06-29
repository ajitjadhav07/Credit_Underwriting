# Axis Underwriting — Codebase Analysis
**Date:** 2026-02-08 | **Build:** v7.6.6 | **Analyst:** Claude

---

## 1. ARCHITECTURE OVERVIEW

### Processing Flow (Current — Server-Side)
```
User uploads files → POST /api/assessment (saves to S3)
                   → POST /api/assessment/:id/process-server
                   → Bull Queue (Redis) → Worker picks up job
                   → claude-extractor.js → OCR Pipeline → Claude API
                   → calculation-engine.js → credit scoring → policy compliance
                   → Results saved to S3 → WebSocket notifies frontend
                   → Frontend loads results → Human In Loop review
```

### Processing Flow (Legacy — Client-Side Fallback)
```
User uploads files → POST /api/assessment (saves to S3)
                   → Frontend calls POST /api/extract-financials
                   → server.js loops through docs → claude-extractor.js
                   → SSE events back to frontend → Frontend runs calculations
                   → POST /api/assessment/:id/complete → saves results
```

### File Counts
| Category | Files | Lines |
|----------|-------|-------|
| Frontend (index.html) | 1 | 14,282 |
| Server (server.js) | 1 | 5,298 |
| Core Libraries (lib/*.js) | 33 | 21,319 |
| JSON Schemas | 15 | ~600KB |
| **Total** | **~50** | **~41,000** |

---

## 2. FILE-BY-FILE STATUS

### ✅ ACTIVELY USED — Core Processing

| File | Lines | Purpose | Used By |
|------|-------|---------|---------|
| `server.js` | 5,298 | Express server, all API routes, auth, WebSocket | Entry point |
| `public/index.html` | 14,282 | Entire frontend SPA (dashboard, processing, results, HIL) | Browser |
| `lib/bull-queue.js` | 2,398 | Server-side job processing worker (Bull + Redis) | server.js |
| `lib/claude-extractor.js` | 2,538 | Claude API extraction (BS, P&L, CF, GST, Bank, ITR, KYC, Legal) | bull-queue.js, server.js |
| `lib/calculation-engine.js` | 1,312 | Financial ratios, credit scoring, policy compliance, limits | bull-queue.js, server.js |
| `lib/masters-manager.js` | 2,293 | Masters data CRUD (policy rules, scoring, limits) from S3 | server.js |
| `lib/s3-client.js` | 839 | S3 operations (upload, download, list, delete assessments) | server.js, other libs |
| `lib/ocr-pipeline.js` | 522 | Orchestrates scan detection → image conversion → OCR → text | claude-extractor.js |
| `lib/vision-ocr.js` | 415 | Google Vision API integration for OCR | ocr-pipeline.js |
| `lib/image-preprocessor.js` | 267 | Image enhancement (contrast, denoise) before OCR | ocr-pipeline.js |
| `lib/document-detector.js` | 149 | Detects scanned vs native PDF | ocr-pipeline.js, claude-extractor.js |
| `lib/socket-manager.js` | 205 | WebSocket (Socket.io) management | server.js |
| `lib/user-manager.js` | 338 | User CRUD, role management (S3 JSON storage) | server.js |
| `lib/auth-config.js` | 182 | Microsoft Entra ID / Office 365 SSO config | server.js |
| `lib/docx-generator.js` | 697 | DOCX report export | server.js |
| `lib/compliance-scanner.js` | 888 | Code scanning (ESLint, npm audit, OWASP, NIST, CSA) | server.js |
| `lib/comprehensive-field-mapper.js` | 516 | Maps 524 parameters across 14 categories | server.js |
| `lib/centralized-logger.js` | 620 | Structured logging with PII masking | server.js |
| `lib/security-logger.js` | 424 | Security event logging (auth, access, changes) | server.js |

### ⚠️ DUPLICATE / OVERLAPPING — Will Cause Confusion

| File | Lines | Issue |
|------|-------|-------|
| `lib/claude-processor.js` | 635 | **OVERLAPS with claude-extractor.js.** Both initialize Anthropic client. claude-processor is only used for health check (`claudeProcessor.isReady()`). All actual extraction goes through claude-extractor.js. |
| `lib/ratio-calculator.js` | 255 | **OVERLAPS with calculation-engine.js.** Imported in server.js but **NEVER called** (`ratioCalculator.` appears 0 times). calculation-engine.js handles everything. |
| `lib/field-mapper.js` | 345 | **OVERLAPS with comprehensive-field-mapper.js.** Imported in server.js but `fieldMapper.` is **NEVER called**. comprehensive-field-mapper.js is the one actually used. |
| `lib/job-queue.js` | 411 | **OVERLAPS with bull-queue.js.** job-queue.js is a simple in-memory queue. bull-queue.js is the Redis-backed Bull queue. **Both are imported and both are used** — job-queue for legacy client-side processing, bull-queue for server-side. This is the most confusing overlap. |
| `lib/s3-client-v2.js` | 669 | **OLD VERSION of s3-client.js.** Not imported anywhere. Dead code. |
| `lib/s3-client-improved.js` | 339 | **OLD VERSION of s3-client.js.** Not imported anywhere. Dead code. |
| `lib/s3-migration.js` | 379 | Migration utility. Not imported by server.js. One-time use script. |

### ⚠️ LEGACY / DEMO CODE — Should Be Removed for Production

| File | Lines | Issue |
|------|-------|-------|
| `lib/dummy-generator.js` | 276 | Generates fake assessment data. **Still called in production** — line 4939 of server.js calls `dummyGenerator.generateCompleteAssessment()` with comment "Generate dummy data for compatibility with existing UI". |
| `lib/demo-seeder.js` | 247 | Seeds demo assessments on dashboard. Called on every dashboard load (`demoSeeder.getAllDemoAssessments()`). |
| `lib/pdf-generator.js` | 366 | **Not imported by server.js or any other file.** Completely dead code. |

### ⚠️ FEATURE FLAGS — Implemented But Possibly Not Fully Connected

| File | Lines | Status |
|------|-------|--------|
| `lib/aml-screening-manager.js` | 441 | AML screening — imported and has routes, but no real AML API integration |
| `lib/investigation-fraud-manager.js` | 566 | Fraud investigation — imported and has routes, but uses simulated data |
| `lib/forensic-export.js` | 556 | Forensic PDF export — imported, has route |
| `lib/pii-handler.js` | 392 | PII masking/unmasking — imported, used by logger |
| `lib/siem-api.js` | 486 | SIEM API endpoints — imported, has routes |
| `lib/siem-storage.js` | 353 | SIEM event storage in S3 — imported |

### ❌ UNUSED JSON SCHEMAS — Not Referenced Anywhere

| File | Size | Status |
|------|------|--------|
| `lib/aml-screening-schema.json` | 3.0K | 0 references |
| `lib/bulk-upload-schema.json` | 19K | 0 references (bulk upload uses inline mapping in index.html) |
| `lib/comprehensive-parameters-schema-COMPLETE.json` | 6.5K | 0 references (duplicate of comprehensive-parameters-schema.json) |
| `lib/field-verification-schema.json` | 5.5K | 0 references |
| `lib/investigation-fraud-schema.json` | 8.0K | 0 references |
| `lib/staff-monitoring-schema.json` | 8.5K | 0 references |

---

## 3. DUPLICATE ROUTE DEFINITIONS IN SERVER.JS

The following routes are defined **TWICE** in server.js:

| Route | First Definition | Second Definition |
|-------|-----------------|-------------------|
| `GET /api/compliance/latest` | Line 546 | Line 686 |
| `POST /api/compliance/rescan` | Line 591 | Line 731 |
| `GET /api/compliance/report` | Line 640 | Line 780 |
| `GET /api/queue/stats` | (check) | (check) |
| `GET /api/users` | (check) | (check) |
| `PUT /api/users/:email` | (check) | (check) |
| `PUT /api/masters/:masterType/:id` | (check) | (check) |

**Impact:** Express uses the FIRST matching route and ignores the second. The second definitions are dead code but create confusion about which code is "live."

---

## 4. FRONTEND (index.html) ANALYSIS — 14,282 Lines

### Screen System
| Screen | Function | Used? |
|--------|----------|-------|
| `dashboard` | `renderDashboard()` | ✅ Primary |
| `actualProcessing` | `renderActualProcessingScreen()` | ✅ Active processing view |
| `backgroundWatching` | `renderBackgroundWatching()` | ✅ Dashboard resume |
| `results` | `renderResults()` | ✅ Assessment results |
| `masters-tables` | `renderMastersTables()` | ✅ Masters management |
| `application` | `renderApplication()` | ⚠️ Legacy — was for client-side step-by-step flow |
| `processing` | `renderProcessing()` | ⚠️ Legacy — old processing screen |
| `chat` | `renderChat()` | ⚠️ AI Chat — appears non-functional |
| `aml-demo` | `renderAMLDemo()` | ⚠️ Demo only |

### Results Tabs
| Tab | Function | Status |
|-----|----------|--------|
| Decision | `renderDecisionTab()` | ✅ Active |
| Human in Loop | `renderHumanInLoopTab()` | ✅ Active — has sub-tabs: Extracted Parameters, Masters Used, Calculations, Final Decision, Audit Trail |
| Calculations | `renderCalculationsTab()` | ✅ Active |
| Processing | `renderProcessingTab()` | ✅ Active (shows processing logs) |
| Policy | `renderPolicyTab()` | ✅ Active |
| Legal | `renderLegalTab()` | ✅ Active (conditional) |
| Mapped Data | `renderMappedDataTab()` | ⚠️ Shows comprehensive field mapping — may overlap with HL Extracted |
| API Log | `renderApiLogResultsTab()` | ✅ Active |

### Two Data Display Tables — THE BIGGEST CONFUSION POINT

There are **TWO completely separate rendering functions** for the same extracted data:

1. **`renderExtractedDataTab()`** (line 4376) — The OLD "Extracted Parameters" tab. Has its own duplicate detection code, BS/P&L/CF table rendering, formatINR calls. This function is **defined but never called** (0 callers found). It may be dead code.

2. **`renderHumanLoopExtractedSection()`** (line 5239) → calls **`renderHLFinancialTable()`** (line 5560) — The NEW Human In Loop "Extracted Parameters" sub-tab. This is what users see in Image 4/5 of your screenshots.

Both render the same `extracted_data` but with different code. Changes to one don't affect the other. This already caused the duplicate-not-showing bug (I fixed HL but old table was different code).

### Agent Building — THREE Functions, Similar But Different

1. **`buildActualAgents(files)`** (bulk upload + single upload) — Builds agents based on actual uploaded files, sets `available: true/false` on tasks. Used during initial submit.

2. **`buildDefaultAgents()`** — Default 12-agent list for demo/preview. Used for the static demo flow.

3. **`buildDefaultAgentsForBackgroundView(docInfo)`** — Default 8-agent list for dashboard resume. Recently fixed to accept docInfo parameter, but callers may not always pass it.

---

## 5. DATA FLOW CONFUSION POINTS

### In-Memory Map vs S3

```
assessments = new Map();  // In-memory, line 974
```

Assessments live in **both** the in-memory Map AND S3. The code does:
1. Create assessment → save to Map AND S3
2. Load assessment → try Map first, fallback to S3
3. On server restart → Map is empty, everything loads from S3

**Risk:** If the server process restarts mid-processing (Render auto-restart, deploy), the in-memory state is lost. Bull Queue jobs survive (Redis), but the assessment data in the Map doesn't.

### Dual Processing Paths

The `submitAllAndProcess()` function in index.html has TWO code paths:

**Path A (Server-side):** Calls `tryServerSideProcessing()` → POST `/api/assessment/:id/process-server` → Bull Queue → Worker → S3.

**Path B (Client-side fallback):** If server fails, falls through to inline extraction code that calls `POST /api/extract-financials` → SSE events → client renders results.

Path B still contains ~300 lines of client-side extraction orchestration code (agents, tasks, progress tracking, category processing). This code is identical in purpose to bull-queue.js but runs differently.

### Calculation Duplication

Calculations run in **THREE places:**
1. `bull-queue.js` line ~1640 — Server-side after extraction
2. `server.js` line ~4900 — In `/api/assessment/:id/complete` endpoint (client-side path)
3. `index.html` — Human In Loop "Reprocess" button calls `POST /api/assessment/:id/recalculate`

All three call `calculationEngine.calculateAll()` but with slightly different data preparation. Results should be identical but the code paths are different.

---

## 6. COMMENT QUALITY

| Rating | Files |
|--------|-------|
| Good (>12% comments + JSDoc) | pii-handler.js, ratio-calculator.js, image-preprocessor.js, vision-ocr.js, ocr-pipeline.js, socket-manager.js, user-manager.js |
| Adequate (8-12%) | s3-client.js, bull-queue.js, compliance-scanner.js, centralized-logger.js, security-logger.js |
| Poor (<8%) | calculation-engine.js, claude-extractor.js, masters-manager.js, server.js, docx-generator.js |
| Minimal (<3%) | demo-seeder.js |

**Key gaps:**
- `server.js` (5,298 lines) has 0 JSDoc tags — no function documentation
- `calculation-engine.js` (1,312 lines) has only 2 JSDoc tags — critical business logic undocumented
- `masters-manager.js` (2,293 lines) has 0 JSDoc tags
- `index.html` (14,282 lines) has almost no comments — the most complex file has the least documentation

---

## 7. PRODUCTION READINESS ISSUES (Priority Order)

### 🔴 CRITICAL

1. **In-memory `assessments` Map** — Data loss on server restart. All assessments should load exclusively from S3, Map used only as cache with TTL.

2. **`dummy-generator.js` called in production** — Line 4939 of server.js: `dummyGenerator.generateCompleteAssessment()` is called for every completed assessment with comment "for compatibility with existing UI." This needs to be understood and removed.

3. **`demo-seeder.js` loads on every dashboard** — Lines 1165/1182/1204 call `demoSeeder.getAllDemoAssessments()` and mix demo data with real assessments.

4. **Duplicate route definitions** — 3 compliance routes defined twice. The second definitions are silently ignored. If someone edits the wrong one, changes won't take effect.

### 🟡 HIGH

5. **Two rendering paths for same data** — `renderExtractedDataTab()` vs `renderHLFinancialTable()`. Any UI fix must be applied to both or one should be removed.

6. **Three overlapping library pairs** — claude-processor/claude-extractor, ratio-calculator/calculation-engine, field-mapper/comprehensive-field-mapper. The unused one in each pair should be removed.

7. **Client-side fallback code** — ~300 lines of extraction orchestration in index.html. If server-side is the production path, this should either be removed or clearly gated behind a flag.

8. **Three S3 client files** — s3-client.js (used), s3-client-v2.js (dead), s3-client-improved.js (dead).

### 🟢 MEDIUM

9. **6 unused JSON schemas** — Dead files that add confusion.

10. **index.html is 14,282 lines** — Entire SPA in one file. For production maintainability, should consider splitting into modules.

11. **`renderExtractedDataTab()`** — Defined (line 4376) but appears to have 0 callers. If confirmed dead, should be removed.

12. **Error handling in frontend** — Most async functions have try/catch but error messages are generic alerts. Production should have structured error reporting.

---

## 8. RECOMMENDED CLEANUP SEQUENCE

### Phase 1 — Remove Dead Code (Low Risk)
- Delete: `s3-client-v2.js`, `s3-client-improved.js`, `s3-migration.js`, `pdf-generator.js`
- Delete: 6 unused JSON schemas
- Remove duplicate route definitions (keep first, delete second)
- Remove: `ratio-calculator.js`, `field-mapper.js` (and their requires from server.js)

### Phase 2 — Remove Demo/Dummy (Medium Risk)
- Remove `demo-seeder.js` usage from dashboard loading
- Audit and remove `dummy-generator.js` usage — understand what "compatibility" it provides
- Gate or remove `renderApplication()`, `renderProcessing()`, `renderChat()` screens

### Phase 3 — Consolidate (Higher Risk)
- Merge `claude-processor.js` health check into `claude-extractor.js`
- Decide: keep client-side fallback or remove entirely
- Decide: keep `renderExtractedDataTab()` or confirm dead and remove
- Consolidate `job-queue.js` (if client-side fallback is removed)

### Phase 4 — Production Hardening
- Convert `assessments` Map to S3-backed cache with TTL
- Add JSDoc to server.js, calculation-engine.js, masters-manager.js
- Add comprehensive error handling and structured logging to index.html
- Consider splitting index.html into modules (at minimum: dashboard.js, processing.js, results.js, humanloop.js)
