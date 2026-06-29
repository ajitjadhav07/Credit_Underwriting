#!/bin/bash
# ============================================================
# BUILD VERIFICATION SCRIPT - Run after extracting zip
# Confirms all code changes are present before pushing to GitHub
# Usage: chmod +x verify-build.sh && ./verify-build.sh
# ============================================================

PASS=0
FAIL=0
TOTAL=0

check() {
    TOTAL=$((TOTAL + 1))
    local desc="$1"
    local file="$2"
    local pattern="$3"
    local expected_min="$4"
    
    if [ ! -f "$file" ]; then
        echo "❌ FAIL [$TOTAL] $desc"
        echo "   File not found: $file"
        FAIL=$((FAIL + 1))
        return
    fi
    
    local count=$(grep -c "$pattern" "$file" 2>/dev/null || echo 0)
    if [ "$count" -ge "$expected_min" ]; then
        echo "✅ PASS [$TOTAL] $desc (found $count match(es))"
        PASS=$((PASS + 1))
    else
        echo "❌ FAIL [$TOTAL] $desc (expected >=$expected_min, found $count)"
        FAIL=$((FAIL + 1))
    fi
}

# Check that a pattern does NOT exist in file
check_absent() {
    TOTAL=$((TOTAL + 1))
    local desc="$1"
    local file="$2"
    local pattern="$3"
    
    if [ ! -f "$file" ]; then
        echo "✅ PASS [$TOTAL] $desc (file not found — correct)"
        PASS=$((PASS + 1))
        return
    fi
    
    local count=$(grep -c "$pattern" "$file" 2>/dev/null | tr -d '\n' || echo 0)
    count=${count:-0}
    if [ "$count" -eq 0 ] 2>/dev/null; then
        echo "✅ PASS [$TOTAL] $desc (0 matches — correct)"
        PASS=$((PASS + 1))
    else
        echo "❌ FAIL [$TOTAL] $desc (found $count match(es) — should be 0)"
        FAIL=$((FAIL + 1))
    fi
}

echo ""
echo "============================================"
echo "  AXIS UNDERWRITING - BUILD VERIFICATION"
echo "  Expected Build: 2026-02-09 03:00 IST"
echo "============================================"
echo ""

# --- Login page build timestamp ---
echo "--- Build Identity ---"
check "Build timestamp in login page" \
    "public/login.html" "Build: 2026-02-10 16:00 IST" 1

echo ""
echo "--- S3-Backed Cache (In-Memory Fix) ---"
check "TTL cache wrapper replaces raw Map" \
    "server.js" "CACHE_TTL_MS" 2

check "assessmentsListTimestamp tracking" \
    "server.js" "assessmentsListTimestamp" 3

check "Dashboard refreshes from S3 when stale" \
    "server.js" "LIST_TTL_MS" 2

check "Delete removes from assessmentsList" \
    "server.js" "assessmentsList.splice" 1

echo ""
echo "--- Demo/Dummy Code Removal ---"
check "demoSeeder require commented out" \
    "server.js" "REMOVED.*demo-seeder" 1

check "dummyGenerator require commented out" \
    "server.js" "REMOVED.*dummy-generator" 1

check_absent "No active demoSeeder calls (excl comments)" \
    "server.js" "^[^/]*demoSeeder\."

check_absent "No active dummyGenerator calls (excl comments)" \
    "server.js" "^[^/]*dummyGenerator\."

check_absent "pdf-generator.js deleted" \
    "lib/pdf-generator.js" "."

check_absent "No dummyData in frontend" \
    "public/index.html" "dummyData"

echo ""
echo "--- S3-Backed Cache Layer ---"
check "getAssessmentById helper exists" \
    "server.js" "async function getAssessmentById" 1

check "All gets use getAssessmentById (25+ calls)" \
    "server.js" "getAssessmentById" 25

check "Only 1 bare assessments.get (inside getAssessmentById)" \
    "server.js" "assessments\.get(" 2

echo ""
echo "--- Dead Code Removal ---"
check "ratioCalculator require commented out" \
    "server.js" "REMOVED.*ratio-calculator" 1

check "fieldMapper require commented out" \
    "server.js" "REMOVED.*field-mapper" 1

check_absent "ratio-calculator.js deleted" \
    "lib/ratio-calculator.js" "."

check_absent "field-mapper.js deleted" \
    "lib/field-mapper.js" "."

check_absent "s3-client-v2.js deleted" \
    "lib/s3-client-v2.js" "."

check_absent "s3-client-improved.js deleted" \
    "lib/s3-client-improved.js" "."

check_absent "s3-migration.js deleted" \
    "lib/s3-migration.js" "."

echo ""
echo "--- Unused JSON Schema Removal ---"
check_absent "aml-screening-schema.json deleted" \
    "lib/aml-screening-schema.json" "."

check_absent "bulk-upload-schema.json deleted" \
    "lib/bulk-upload-schema.json" "."

check_absent "comprehensive-parameters-schema-COMPLETE.json deleted" \
    "lib/comprehensive-parameters-schema-COMPLETE.json" "."

check_absent "field-verification-schema.json deleted" \
    "lib/field-verification-schema.json" "."

check_absent "investigation-fraud-schema.json deleted" \
    "lib/investigation-fraud-schema.json" "."

check_absent "staff-monitoring-schema.json deleted" \
    "lib/staff-monitoring-schema.json" "."

echo ""
echo "--- Duplicate Route Removal ---"
check "compliance/latest route appears once" \
    "server.js" "app.get.*compliance/latest" 1

check "compliance/rescan route appears once" \
    "server.js" "app.post.*compliance/rescan" 1

check "compliance/report route appears once" \
    "server.js" "app.get.*compliance/report.*SUPER" 1

check "queue/stats route appears once" \
    "server.js" "app.get.*queue/stats" 1

echo ""
echo "--- Duplicate Detection (Human In Loop) ---"
check "HL table: duplicate detection banner" \
    "public/index.html" "Duplicate detection banner" 1

check "HL table: red DUPLICATE label in column headers" \
    "public/index.html" "bg-red-100 text-red-800.*DUPLICATE" 1

check "HL table: red cell background for duplicate years" \
    "public/index.html" "bg-red-50 text-red-700" 1

echo ""
echo "--- Duplicate Detection (Bulk Upload) ---"
check "Bulk upload: detectDuplicateFiles called" \
    "public/index.html" "detectDuplicateFiles" 3

check "Bulk upload: duplicate map in table (bulkDupMap)" \
    "public/index.html" "bulkDupMap" 4

echo ""
echo "--- Task Filtering (P&L/CF not showing) ---"
check "updateAgentTasks: availableTasks filter" \
    "public/index.html" "availableTasks" 5

check "buildDefaultAgentsForBackgroundView accepts docInfo" \
    "public/index.html" "function buildDefaultAgentsForBackgroundView(docInfo)" 1

echo ""
echo "--- Indian Number Format (Extraction) ---"
check "Balance Sheet prompt: INDIAN NUMBER FORMAT" \
    "lib/claude-extractor.js" "INDIAN NUMBER FORMAT" 4

check "Digit count verification rule in prompt" \
    "lib/claude-extractor.js" "digit count.*MUST be the same" 3

check "Cross-check instruction (Assets = Liabilities)" \
    "lib/claude-extractor.js" "Total Assets.*Total Liabilities" 1

echo ""
echo "--- Server-side Logging ---"
check "OCR text dump logging" \
    "lib/claude-extractor.js" "OCR TEXT DUMP" 2

check "Claude JSON response logging" \
    "lib/claude-extractor.js" "CLAUDE JSON START" 1

check "Post-extraction validation (BS)" \
    "lib/bull-queue.js" "POST-EXTRACTION VALIDATION" 1

echo ""
echo "============================================"
echo "  RESULTS: $PASS passed, $FAIL failed (out of $TOTAL)"
if [ "$FAIL" -eq 0 ]; then
    echo "  ✅ ALL CHECKS PASSED - Safe to push to GitHub"
else
    echo "  ❌ SOME CHECKS FAILED - DO NOT push until fixed"
fi
echo "============================================"
echo ""

exit $FAIL
