# AFL-84 Credit Underwriting Agent — Project Summary
**For continuing context in a new chat**
Generated: July 2026

---

## 1. Project Identity

| Item | Value |
|---|---|
| Project name | AFL-84-Credit-Underwriting |
| Application name | MSME Credit Underwriting Agent |
| Client | Axis Finance Limited (AFL) |
| Vendor / dev team | Applied Cloud Computing Limited (ACC) |
| Owner / AppRM | Prathamesh Malvankar |
| App PoC | Rushikesh Baikar |
| AppGH | Navalkumar Lad |
| Ajit's admin email | ajit.jadhav@atlascloud.in |
| Super admin email | nilesh@acc.ltd |
| GitHub repo | https://github.com/ajitjadhav07/Credit_Underwriting.git (branch: main) |
| GitHub PAT | <ROTATE-THIS-PAT> (**rotate this — it's been pasted in chat**) |
| UAT account ID | 975050184307 |
| AWS region | ap-south-1 (Mumbai) |
| UAT domain | aflcuwuat.axisb.com |
| Prod domain | aflcuwprod.axisb.com |

---

## 2. What the Application Does

AI-powered MSME loan underwriting decision-support system for AFL.

**Two ingestion paths:**
- **Path A (system-to-system):** DMS/LOS (on-prem) → Middleware/DataPower → Internal ALB → Backend EC2 → Processing pipeline
- **Path B (manual):** AFL underwriter → browser → Internal ALB → Frontend (Nginx) → Backend EC2 → Processing pipeline

**Processing pipeline (in order):**
1. Document uploaded to S3
2. `document-detector.js` — scanned vs native PDF check
3. If scanned → `lib/textract-ocr.js` (AWS Textract) extracts text first
4. `lib/claude-extractor.js` → Amazon Bedrock (Claude Sonnet 4.6, Global inference profile) — **data EXTRACTION only** — returns 524-field JSON
5. External verification APIs via Middleware (see §6)
6. `lib/calculation-engine.js` — **data ANALYSIS** — scores the borrower (Financial/Banking/Credit/Stability/Security, max 100 pts) → Approve/Refer/Decline decision
7. `lib/cam-eligibility.js` — CAM surrogate eligibility (4 programs)
8. DOCX report generated
9. Human-in-Loop (HIL) underwriter reviews/approves in browser

**Technology stack:** Node.js, Docker (split frontend/backend images), Bull/Redis queue, AWS ECS on EC2, ALB (internal), S3, ElastiCache Redis, Secrets Manager, KMS, Bedrock, Textract, CloudWatch. Auth: Microsoft Entra ID (Azure SSO).

---

## 3. Architecture Decisions (confirmed, do not revert)

| Decision | What was decided | Why |
|---|---|---|
| AI extraction | Amazon Bedrock (Claude Sonnet 4.6, `global.anthropic.claude-sonnet-4-6`, Global cross-region inference profile) — NOT direct Anthropic API | No NAT Gateway in UAT VPC; Bedrock uses IAM role via VPC, no internet egress needed |
| OCR | AWS Textract (`DetectDocumentText`) | Replaced Google Vision; uses same IAM role as S3, no extra credentials |
| ALB scheme | `internal` (not internet-facing) | Application handles sensitive MSME borrower PII; no public internet exposure |
| Docker split | `Dockerfile.backend` (Node.js full stack) + `Dockerfile.frontend` (Nginx reverse-proxy only) | server.js uses Express in-memory sessions for SSO — two Node processes can't share session state; Nginx proxies everything dynamic to the single backend |
| Pennant connection | **Direct** to `afloasuatweb.axisb.com:8070` — no Middleware | Per AFL's architecture diagram; Pennant has its own Oracle APEX API |
| All other external APIs | **Via Middleware Gateway** (DataPower) — never called directly | AFL architecture decision; Middleware owns encryption/decryption |
| CloudFormation template | **NOT in the GitHub repo** — kept separately | Contains environment-specific and sensitive infra values |
| EC2 OS | CIS-hardened RHEL 9 AMI (to be supplied by AFL security team) | AFL security policy requirement |

---

## 4. Source Code — Current State

**GitHub: https://github.com/ajitjadhav07/Credit_Underwriting.git (main)**

Latest commit: `c588dce` — "Update domain references to confirmed AFL UAT/Prod domains"

### Key files added/modified in this project

| File | Status | What it does |
|---|---|---|
| `lib/bedrock-client.js` | **NEW** | Bedrock Runtime adapter — mimics Anthropic SDK's `messages.create()` shape so `claude-extractor.js` call sites are unchanged |
| `lib/textract-ocr.js` | **NEW** | AWS Textract OCR replacing Google Vision |
| `lib/external-apis-manager.js` | **NEW** | Karza ITR/EPFO, CIBIL Commercial (JSON/REST), Novel bank statement — via real AFL API specs |
| `lib/pennant-client.js` | **NEW** | Pennant LOS direct client — parses confirmed `customer_api`/`collateral_api`/`loan_detail_api` response shape |
| `lib/cibil-soap-client.js` | **NEW** | SOAP/XML client for individual CIBIL (BureauOneInternalService) using `fast-xml-parser` |
| `lib/claude-extractor.js` | **MODIFIED** | Now requires `./bedrock-client` instead of `@anthropic-ai/sdk` |
| `lib/claude-processor.js` | **MODIFIED** | Bedrock-first init; exposes `mode: 'bedrock'/'direct'`; falls back to direct Anthropic only if AWS_REGION unset |
| `lib/calculation-engine.js` | **MODIFIED** | CIBIL scoring now uses real CIBIL data from `external_verification.cibil_commercial`; `calcCreditScore()` takes `cibilData` param |
| `lib/bull-queue.js` | **MODIFIED** | Requires both `externalApisManager` and `pennantClient`; runs external verifications after Claude extraction before calculation |
| `lib/cam-eligibility.js` | **UNCHANGED** | All 4 surrogate programs implemented: `evaluateGrossMargin()`, `evaluateProfessionalReceipt()`, `evaluateBanking()`, `evaluateCashProfit()` |
| `lib/ocr-pipeline.js` | **MODIFIED** | Points to `./textract-ocr` instead of `./vision-ocr` |
| `lib/vision-ocr.js` | **DELETED** | Replaced by textract-ocr.js |
| `server.js` | **MODIFIED** | Bedrock-aware health checks; new `/api/external/*` routes for OTP/SOAP flows; fixed CORS defaults to AFL domains |
| `Dockerfile.backend` | **NEW** | App tier: Node.js, all business logic |
| `Dockerfile.frontend` | **NEW** | Web tier: Nginx static + reverse proxy |
| `nginx/default.conf.template` | **NEW** | Nginx config; uses `BACKEND_UPSTREAM` env var |
| `docker-compose.yml` | **NEW** | Local dev only — not used in AWS |
| `.env.example` | **NEW** | Documents all env vars with AFL-specific values |

### Env vars required (backend container)

```
AWS_REGION=ap-south-1
BEDROCK_MODEL_ID=global.anthropic.claude-sonnet-4-6
S3_BUCKET_NAME=uat-underwriting-docs-975050184307-ap-south-1
REDIS_URL=<from RedisSecret in Secrets Manager>
SESSION_SECRET=<from SessionSecret>
MIDDLEWARE_DATAPOWER_URL=https://afldatapoweruat.axisb.com:8441
MIDDLEWARE_CIBIL_COMMERCIAL_URL=http://10.0.218.39:7083
MIDDLEWARE_NOVEL_UPLOAD_URL=http://10.0.218.39:7084
MIDDLEWARE_NOVEL_URL=http://10.0.218.39:7083
MIDDLEWARE_CIBIL_SOAP_URL=http://192.168.127.69:8096/BureauOneInternalService.svc
MIDDLEWARE_AUTH_KEY=<to be provided by AFL Middleware/Infra team>
MIDDLEWARE_CALLER_ID=INDUS
PENNANT_BASE_URL=https://afloasuatweb.axisb.com:8070
REDIRECT_URI=https://aflcuwuat.axisb.com/auth/callback
ALLOWED_ORIGINS=https://aflcuwuat.axisb.com
MICROSOFT_CLIENT_ID=<from AzureSecret>
MICROSOFT_CLIENT_SECRET=<from AzureSecret>
MICROSOFT_TENANT_ID=<from AzureSecret>
SUPER_ADMIN_EMAIL=nilesh@acc.ltd
KMS_KEY_ID=alias/uat-underwriting
```

### Frontend env vars required

```
BACKEND_UPSTREAM=<BackendEC2 private IP>:3000
```

---

## 5. Known Open Items / Gaps in Source Code

### High priority (will cause silent failures)
| Gap | File | Details |
|---|---|---|
| `NEEDS_REAL_RESPONSE_SAMPLE` — CIBIL Commercial response | `lib/external-apis-manager.js` lines 310-322 | Request-building is correct; response field paths (`cibil_score`, `dpd_history`) are guesses. Need real UAT response from Postman |
| `NEEDS_REAL_RESPONSE_SAMPLE` — Individual CIBIL SOAP | `lib/cibil-soap-client.js` lines 157-212 | Both `bureauOneRefNo` path and score/DPD paths are guesses. Need real UAT response |
| `NEEDS_REAL_RESPONSE_SAMPLE` — Novel bank download | `lib/external-apis-manager.js` line 428 | `average_monthly_balance` etc. field paths are guesses |
| `finReference` missing from intake | `lib/bull-queue.js` line ~1565 | Pennant call auto-skips with "finReference not available" — no UI field or LOS payload field captures it yet |
| `MIDDLEWARE_AUTH_KEY` empty | `.env.example` | AFL Middleware/Infra team must issue the real key before any Karza/CIBIL/Novel calls work |

### Medium priority
| Gap | Details |
|---|---|
| No webhook callback to LOS | Assessment results saved to S3 only; nothing auto-notifies LOS when Path A processing completes. Never built. Routes/logic missing entirely. |
| Products master is generic | `lib/masters-manager.js` seeds WC/TL/CC generic products instead of AFL's 16-product MSME catalogue (RBG/BBG/Surrogate). No policy-product linkage during assessment. |
| Add/Edit Product form in UI | `public/index.html` shows "Feature coming in next update" modal — backend routes (`POST /api/masters/products`, `PUT /api/masters/products/:id`) exist and work; only the frontend form is missing. |

### How to fix the NEEDS_REAL_RESPONSE_SAMPLE gaps
1. Have AFL team run the request in Postman against the UAT Middleware (need network access to `10.0.218.39` or `192.168.127.69`)
2. Capture the raw response JSON/XML
3. Share with Claude in the new chat
4. Claude updates the normalization field paths in `external-apis-manager.js` and `cibil-soap-client.js`

---

## 6. External API Integration Map

| Provider | Protocol | Gateway | File | Automated? |
|---|---|---|---|---|
| Pennant LOS | JSON/REST | **Direct** (no Middleware) | `lib/pennant-client.js` | Yes (needs `finReference`) |
| Karza ITR-V | JSON/REST | DataPower `afldatapoweruat.axisb.com:8441` | `lib/external-apis-manager.js` → `verifyITR()` | Yes (needs PAN + ITR ack number) |
| Karza EPFO | JSON/REST, 2-step OTP | DataPower | `lib/external-apis-manager.js` → `epfoLookupOTP()` + `epfoAuthenticate()` | **No** — OTP required; use `/api/external/epfo/send-otp` + `/api/external/epfo/authenticate` |
| CIBIL Commercial | JSON/REST | Internal gateway `10.0.218.39:7083` | `lib/external-apis-manager.js` → `fetchCommercialCIBIL()` | Yes (needs borrower name + CIN) |
| Novel bank stmt | Multipart upload + 3 steps | Internal gateway `10.0.218.39:7083/7084` | `lib/external-apis-manager.js` → `novelUploadBankStatement()` + `novelGenerateAutoFetchURL()` + `novelDownloadBankStatement()` | Partial (upload auto; download via `/api/external/novel/download`) |
| CIBIL Individual | SOAP/XML, 2-step | `192.168.127.69:8096/BureauOneInternalService.svc` | `lib/cibil-soap-client.js` → `processIndividualRequest()` + `downloadByRefNo()` | **No** — use `/api/external/cibil-individual/submit` + `/api/external/cibil-individual/download` |

Auth header convention (all except Pennant): `serviceCode`, `callerIdentification=INDUS`, `authorizationKey=MIDDLEWARE_AUTH_KEY`, `trackingId`.

---

## 7. CloudFormation Template — Current State

**File: `underwriting-CF-UAT.yaml` — NOT in GitHub repo.**
Keep it separately. Latest validated version was shared as a download in the previous chat session.

### What the template creates
- 1× ECS Cluster (EC2 launch type)
- 2× EC2 `c6a.large` (x86_64, AMD EPYC) — `FrontendEC2` + `BackendEC2` — CIS-hardened RHEL 9 AMI (parameter `RHELHardenedAMI`, **no default — must be supplied at deploy time**)
- 1× Internal ALB (scheme: `internal`) with ALB access logs → `s3://afl-alb-access-logs/UAT/`
- 1× S3 bucket `DocumentsBucket` with 5 security controls: Block Public Access, SSE-KMS, SSL-enforce policy, Server Access Logging → `s3://afl-alb-access-logs/UAT/s3-access-logs/`, Block pre-signed URL policy
- 1× ElastiCache Redis 7.1 with TLS + auto-generated AUTH token (Lambda custom resource)
- 4× Secrets Manager secrets (SessionSecret, RedisSecret, MiddlewareSecret, AzureSecret)
- 2× ECS Task Definitions (FrontendTaskDef, BackendTaskDef) + 2× ECS Services
- 1× CloudWatch log groups for frontend and backend
- Full IAM (ECSInstanceRole, TaskExecutionRole, BackendTaskRole with `bedrock:InvokeModel*`, FrontendTaskRole)
- All resources tagged with: `Owner=Prathamesh Malvankar`, `App Code=AFL-84-Credit-Underwriting`, `Support=Applied Cloud Computing Limited`, `App Name=Credit-Underwriting`, `App Poc=Rushikesh Baikar`, `AppGH=NAVALKUMAR LAD`, `Vendor=Applied Cloud Computing Limited`, `Env=UAT/Prod`, `AppRM=Prathamesh Malvankar`, `Role=<per-resource>`

### Known template gaps / pre-deploy checklist

| Item | Status | Action needed |
|---|---|---|
| `RHELHardenedAMI` parameter | **Empty (no default)** | AFL security team provides AMI ID; optionally copy it into UAT account with `aws ec2 copy-image --encrypted --kms-key-id <UAT-KMS>` |
| `BedrockModelId` | Default: `global.anthropic.claude-sonnet-4-6` | Verify exact ID via `aws bedrock list-foundation-models --region ap-south-1` before deploy |
| `MiddlewareSecret` | Has `REPLACE_WITH_...` values | Fill real Middleware URL + auth key in Secrets Manager after stack creates |
| `AzureSecret` | Has `REPLACE_WITH_...` values | Fill real Entra ID app credentials after stack creates |
| `SessionSecret` | Has `REPLACE_WITH_...` | Generate: `openssl rand -hex 64` |
| `ACMCertificateARN` | Empty (HTTP-only until filled) | Issue ACM cert for `aflcuwuat.axisb.com` then update |
| `UATDomain` | `aflcuwuat.axisb.com` | Confirmed |
| NAT/egress assumption | **Unconfirmed with network team** | VPC endpoints were removed — template assumes pre-existing VPC has NAT/IGW egress for ECR/Secrets/Logs/SSM. Confirm before deploying |
| `afl-alb-access-logs` bucket policy | **Unconfirmed with bucket owner** | Centralized bucket owner must grant `arn:aws:iam::718504428378:root` (ELB service account, ap-south-1) `s3:PutObject` under `UAT/` and `PROD/` prefixes |
| CIS RHEL 9 UserData | Written for bare RHEL 9 | Once AMI ID is known, verify with security team: is Docker pre-installed? Is ECS agent pre-installed? Is internet/S3 accessible from instance? Update UserData accordingly |

### Deploy commands (once checklist is complete)

```bash
# Build and push images (from jump server)
aws ecr get-login-password --region ap-south-1 | \
  docker login --username AWS --password-stdin 975050184307.dkr.ecr.ap-south-1.amazonaws.com

git clone https://github.com/ajitjadhav07/Credit_Underwriting.git
cd Credit_Underwriting

docker build -f Dockerfile.backend -t credit-underwriting-backend:latest .
docker tag credit-underwriting-backend:latest \
  975050184307.dkr.ecr.ap-south-1.amazonaws.com/credit-underwriting-backend:latest
docker push 975050184307.dkr.ecr.ap-south-1.amazonaws.com/credit-underwriting-backend:latest

docker build -f Dockerfile.frontend -t credit-underwriting-frontend:latest .
docker tag credit-underwriting-frontend:latest \
  975050184307.dkr.ecr.ap-south-1.amazonaws.com/credit-underwriting-frontend:latest
docker push 975050184307.dkr.ecr.ap-south-1.amazonaws.com/credit-underwriting-frontend:latest

# Deploy stack
aws cloudformation deploy \
  --template-file underwriting-CF-UAT.yaml \
  --stack-name underwriting-uat \
  --region ap-south-1 \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VPCId=vpc-02bf3c80b08206bf2 \
    LBSubnet1Id=<lb-subnet-1> LBSubnet2Id=<lb-subnet-2> \
    WebSubnet1Id=<web-subnet-1> WebSubnet2Id=<web-subnet-2> \
    AppSubnet1Id=<app-subnet-1> AppSubnet2Id=<app-subnet-2> \
    KMSKeyArn=<cross-account-kms-arn> \
    RHELHardenedAMI=<ami-id-from-security-team> \
    BedrockModelId=<verified-id-from-aws-cli> \
    FrontendImageURI=975050184307.dkr.ecr.ap-south-1.amazonaws.com/credit-underwriting-frontend:latest \
    BackendImageURI=975050184307.dkr.ecr.ap-south-1.amazonaws.com/credit-underwriting-backend:latest
```

---

## 8. Products / Policy Master Gap (last topic discussed — pending implementation)

The screenshot in the final message showed the Products master table with a broken "+ Add" button. **This is a 3-part pending implementation:**

**Part 1 — Re-seed Products master** (`lib/masters-manager.js`)
Replace generic WC/TL/CC products with AFL's real 16-product MSME catalogue from the credit policy PDF (March 2026). Each product needs: `product_code`, `product_group` (RBG/BBG/Surrogate), `min_amount_lakhs`, `max_amount_lakhs`, `dscr_min`, `ltv_matrix` (by property type), `tenure_max_months`, `eligible_assessment_programs` array, `documentation_requirements`, `sector` (General/Education/Healthcare/Hospitality/Automobile), `is_active`.

**Part 2 — Build Add/Edit Product form in UI** (`public/index.html`)
Backend routes already work (`POST/PUT /api/masters/products`). Only the frontend form is missing — replace the "Feature coming in next update" modal with an actual form.

**Part 3 — Policy-product linkage in assessment pipeline**
After extraction, identify which AFL product applies → pull its norms → validate extracted data → flag deviations with delegation level → surface in CAM report.

**Credit policy reference file:** `MSME_Business_Credit_Policy_March_26.pdf` (was uploaded in final message — Annexure II has surrogate program details already implemented in `lib/cam-eligibility.js`).

---

## 9. Previous Architecture / Flow Decisions Reference

| Topic | Decision |
|---|---|
| VPC | Pre-existing `vpc-02bf3c80b08206bf2` |
| Subnets | Pre-existing (LB/Web/App subnets, passed as CF params) |
| KMS | Pre-existing cross-account KMS key (passed as CF param) |
| No NAT Gateway in UAT | VPC endpoints were considered and then REMOVED — relies on pre-existing VPC egress |
| Redis AUTH | Auto-generated 32-char token by Lambda custom resource in CF template (same as Legal Audit prod stack pattern) |
| REDIS_URL format | `rediss://:<token>@<endpoint>:6379` — injected via Secrets Manager into backend container |
| ALB health check paths | Backend: `/health` (port 3000); Frontend: `/healthz` (port 8080) |
| ECS placement constraints | `attribute:role == frontend` pins FrontendTG → FrontendEC2; `attribute:role == backend` pins BackendTG → BackendEC2 |
| Session state | All sessions held in the single backend Node process — frontend Nginx never runs its own Node instance |
| Data residency | Bedrock `global.anthropic.claude-sonnet-4-6` routes worldwide — no India in-region path exists for Sonnet 4.6. AFL compliance/legal team has accepted this. |

---

## 10. What to Prioritize in the Next Chat

In order of impact:

1. **Get CIBIL/Novel real response samples** — Run the Postman requests against UAT, share raw JSON/XML. This unblocks fixing all `NEEDS_REAL_RESPONSE_SAMPLE` markers and completes the scoring pipeline.

2. **Get `MIDDLEWARE_AUTH_KEY`** — From AFL Middleware/Infra team. Without it, CIBIL/Karza/Novel calls are silently skipped every time.

3. **Get `RHELHardenedAMI` ID** — From AFL security team. Confirm cross-account sharing + whether Docker/ECS agent are pre-installed.

4. **Confirm NAT/egress with network team** — Is there a path from the App/Web subnets to ECR/Secrets/Logs/SSM?

5. **Products + Policy master implementation** — 3-part feature described in §8.

6. **Webhook callback to LOS** — Build the outbound call from `bull-queue.js` to notify LOS when Path A assessment completes (the one functional gap that was never built).
