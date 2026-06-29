# SIEM Integration Specification

## AFL Underwriting Platform - SIEM Readiness

**Version:** 1.0.0  
**Date:** February 5, 2025  
**Status:** Planned  
**Author:** Applied Cloud Computing

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [S3 Storage Structure](#s3-storage-structure)
4. [Event Schema](#event-schema)
5. [API Endpoints](#api-endpoints)
6. [API Security](#api-security)
7. [SIEM Key Management](#siem-key-management)
8. [Implementation Files](#implementation-files)
9. [SIEM Client Configuration](#siem-client-configuration)
10. [Security Considerations](#security-considerations)

---

## Overview

### Current State

| Component | Status |
|-----------|--------|
| Security Events | ✅ Logging to S3 (JSON) |
| PII Access Audit | ✅ Logging to S3 (encrypted) |
| Access Logs | ✅ HTTP requests logged |
| Application Logs | ✅ Errors/warnings logged |
| Format | ❌ Custom JSON, not standardized |
| Real-time Streaming | ❌ Buffered writes only |
| Correlation IDs | ❌ Not implemented |
| CEF/LEEF/Syslog | ❌ Not supported |

### Target State

- Standardized CEF + JSON format
- Hourly partitioned S3 storage
- REST API for SIEM pull
- HMAC-signed authentication
- Correlation IDs across all logs
- Real-time indexing for fast queries

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         AFL Platform (Render)                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐    ┌──────────────────┐    ┌─────────────────────┐   │
│  │ Security     │───►│ SIEM Formatter   │───►│ S3 Storage          │   │
│  │ Logger       │    │ (CEF + JSON)     │    │ (Partitioned)       │   │
│  └──────────────┘    └──────────────────┘    └─────────────────────┘   │
│                                                         │               │
│  ┌──────────────┐                                       │               │
│  │ Correlation  │                                       │               │
│  │ ID Middleware│                                       │               │
│  └──────────────┘                                       │               │
│                                                         │               │
└─────────────────────────────────────────────────────────│───────────────┘
                                                          │
                                                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         S3 Bucket Structure                              │
├─────────────────────────────────────────────────────────────────────────┤
│  siem-logs/                                                              │
│  ├── security/                                                           │
│  │   └── year=2025/month=02/day=05/hour=19/                             │
│  │       ├── events_19-00-00_a1b2c3.json                                │
│  │       └── events_19-05-00_d4e5f6.json                                │
│  ├── access/                                                             │
│  │   └── year=2025/month=02/day=05/hour=19/...                          │
│  ├── pii-audit/                                                          │
│  │   └── year=2025/month=02/day=05/hour=19/...                          │
│  └── index/                                                              │
│      └── manifest_2025-02-05.json  (hourly index for fast lookup)       │
└─────────────────────────────────────────────────────────────────────────┘
                                                          │
                                                          │ SIEM API
                                                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         SIEM API Endpoints                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  GET /api/siem/events                                                    │
│      ?start=2025-02-05T00:00:00Z                                        │
│      &end=2025-02-05T23:59:59Z                                          │
│      &type=security|access|pii-audit|all                                │
│      &severity=critical|high|medium|low                                 │
│      &limit=1000                                                         │
│      &cursor=<pagination_token>                                          │
│                                                                          │
│  GET /api/siem/events/:correlationId                                    │
│      (Get all events for a specific request/transaction)                │
│                                                                          │
│  GET /api/siem/health                                                    │
│      (SIEM connectivity check)                                           │
│                                                                          │
│  GET /api/siem/schema                                                    │
│      (Return event schema for SIEM field mapping)                        │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                                          │
                                                          │ Pull (scheduled)
                                                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Customer's SIEM                                       │
│              (Splunk / QRadar / Sentinel / Elastic)                     │
├─────────────────────────────────────────────────────────────────────────┤
│  - Scheduled pull every 5 minutes                                        │
│  - Uses cursor for incremental fetch                                     │
│  - Parses CEF/JSON format                                                │
│  - Correlates with other enterprise logs                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## S3 Storage Structure

### Directory Layout

```
s3://axis-underwriting-documents/
└── siem-logs/
    ├── security/
    │   └── year=2025/month=02/day=05/hour=19/
    │       └── events_19-00-00_a1b2c3.json
    ├── access/
    │   └── year=2025/month=02/day=05/hour=19/
    │       └── events_19-00-00_d4e5f6.json
    ├── pii-audit/
    │   └── year=2025/month=02/day=05/hour=19/
    │       └── events_19-00-00_g7h8i9.json
    ├── application/
    │   └── year=2025/month=02/day=05/hour=19/
    │       └── events_19-00-00_j0k1l2.json
    └── index/
        ├── manifest_2025-02-05T19.json   (hourly manifest)
        └── cursor_state.json             (for incremental pulls)
```

### Why Hourly Partitioning?

- SIEM pulls every 5-15 minutes
- Hourly folders allow efficient S3 listing
- Athena/Glue compatible for analytics
- Easy retention policy management

### Retention Policy

| Log Type | Retention | Encryption |
|----------|-----------|------------|
| Security | 90 days | SSE-S3 |
| Access | 1 year | SSE-S3 |
| PII Audit | 7 years | SSE-KMS |
| Application | 90 days | SSE-S3 |

---

## Event Schema

### CEF + Extended JSON Format

Each event is stored in both CEF (Common Event Format) and extended JSON:

```json
{
  "cef": "CEF:0|ACC|AFL-Underwriting|7.4.0|AUTH_001|LOGIN_SUCCESS|3|src=45.115.XXX.XXX suser=user@domain.com ...",
  "event": {
    "id": "evt_a1b2c3d4e5f6",
    "timestamp": "2025-02-05T19:30:00.123Z",
    "correlation_id": "req_x9y8z7w6v5u4",
    "type": "security",
    "category": "authentication",
    "action": "LOGIN_SUCCESS",
    "severity": 3,
    "severity_label": "low",
    "outcome": "success"
  },
  "source": {
    "ip": "45.115.XXX.XXX",
    "geo": {
      "country": "IN",
      "city": "Mumbai"
    },
    "user_agent": "Mozilla/5.0...",
    "device_type": "desktop"
  },
  "user": {
    "id": "usr_abc123",
    "email_hash": "sha256:a1b2c3...",
    "role": "Admin",
    "session_hash": "sha256:d4e5f6..."
  },
  "resource": {
    "type": "assessment",
    "id": "ACC-2025-123456",
    "name": "Shree Textiles Pvt Ltd"
  },
  "request": {
    "method": "POST",
    "path": "/api/assessment/create",
    "response_code": 200,
    "response_time_ms": 145
  },
  "platform": {
    "name": "AFL-Underwriting",
    "version": "7.4.0",
    "environment": "production",
    "instance_id": "render-srv-abc123"
  }
}
```

### CEF Format Details

```
CEF:Version|Device Vendor|Device Product|Device Version|Signature ID|Name|Severity|Extension
```

Example:
```
CEF:0|ACC|AFL-Underwriting|7.4.0|AUTH_001|LOGIN_SUCCESS|3|src=45.115.XXX.XXX suser=user@domain.com sproc=chrome cs1Label=SessionID cs1=a1b2c3d4 cs2Label=AssessmentID cs2=ACC-2025-123456 rt=Feb 05 2025 19:30:00
```

### Severity Levels

| Level | Label | CEF Value | Use Case |
|-------|-------|-----------|----------|
| 1-2 | Low | 3 | Info, successful operations |
| 3-4 | Medium | 5 | Warnings, failed attempts |
| 5-6 | High | 7 | Security violations, errors |
| 7-10 | Critical | 10 | Breaches, critical failures |

### Event Categories

| Category | Event Types |
|----------|-------------|
| `authentication` | LOGIN_SUCCESS, LOGIN_FAILED, LOGOUT, SESSION_EXPIRED |
| `authorization` | ACCESS_DENIED, PERMISSION_DENIED, ROLE_CHANGED |
| `data_access` | VIEW_ASSESSMENT, EXPORT_PDF, EXPORT_DOCX, FORENSIC_EXPORT |
| `data_modification` | CREATE_ASSESSMENT, EDIT_ASSESSMENT, DELETE_ASSESSMENT |
| `pii_access` | VIEW_PII, EXPORT_PII, MASK_OVERRIDE |
| `system` | CONFIG_CHANGE, CACHE_FLUSH, SERVICE_START, SERVICE_STOP |
| `api` | RATE_LIMITED, API_ERROR, INVALID_REQUEST |

---

## API Endpoints

### Base URL

```
https://afl.acc.ltd/api/siem
```

### Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/events` | GET | API Key + HMAC | Fetch events with filters |
| `/events/:correlationId` | GET | API Key + HMAC | Get all events for a transaction |
| `/health` | GET | None | Health check |
| `/schema` | GET | API Key | Event schema for field mapping |
| `/keys` | GET | Super Admin Session | List API keys |
| `/keys` | POST | Super Admin Session | Generate new API key |
| `/keys/:id` | DELETE | Super Admin Session | Revoke API key |

### GET /api/siem/events

Fetch events with filters.

#### Query Parameters

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `start` | ISO datetime | Yes | - | Start of time range |
| `end` | ISO datetime | No | now | End of time range |
| `type` | string | No | all | security, access, pii-audit, application, all |
| `severity` | string | No | all | critical, high, medium, low |
| `category` | string | No | all | authentication, authorization, data_access, etc. |
| `limit` | int | No | 1000 | Max events (max: 10000) |
| `cursor` | string | No | - | Pagination cursor |
| `format` | string | No | json | json or cef |

#### Example Request

```http
GET /api/siem/events?start=2025-02-05T00:00:00Z&type=security&limit=500 HTTP/1.1
Host: afl.acc.ltd
X-API-Key: siem_abc123def456
X-Timestamp: 2025-02-05T19:30:00Z
X-Signature: a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0
Accept: application/json
```

#### Example Response

```json
{
  "success": true,
  "meta": {
    "request_id": "req_x9y8z7",
    "timestamp": "2025-02-05T19:30:00Z",
    "query": {
      "start": "2025-02-05T00:00:00Z",
      "end": "2025-02-05T19:30:00Z",
      "type": "security"
    },
    "total_count": 2847,
    "returned_count": 500,
    "has_more": true
  },
  "events": [
    {
      "cef": "CEF:0|ACC|AFL-Underwriting|7.4.0|AUTH_001|LOGIN_SUCCESS|3|...",
      "event": { ... }
    }
  ],
  "cursor": "eyJ0cyI6IjIwMjUtMDItMDVUMTk6MDA6MDAuMDAwWiIsIm9mZnNldCI6NTAwfQ=="
}
```

### GET /api/siem/events/:correlationId

Get all events for a specific request/transaction.

#### Example Request

```http
GET /api/siem/events/req_x9y8z7w6v5u4 HTTP/1.1
Host: afl.acc.ltd
X-API-Key: siem_abc123def456
X-Timestamp: 2025-02-05T19:30:00Z
X-Signature: a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0
```

### GET /api/siem/health

Health check endpoint (no authentication required).

#### Response

```json
{
  "status": "healthy",
  "timestamp": "2025-02-05T19:30:00Z",
  "version": "7.4.0",
  "s3_connected": true,
  "events_today": 15234
}
```

### GET /api/siem/schema

Returns the event schema for SIEM field mapping.

#### Response

```json
{
  "version": "1.0.0",
  "fields": {
    "event.id": { "type": "string", "description": "Unique event identifier" },
    "event.timestamp": { "type": "datetime", "description": "ISO 8601 timestamp" },
    "event.correlation_id": { "type": "string", "description": "Request correlation ID" },
    "event.type": { "type": "enum", "values": ["security", "access", "pii-audit", "application"] },
    "event.category": { "type": "enum", "values": ["authentication", "authorization", "data_access", ...] },
    "event.severity": { "type": "integer", "range": [1, 10] },
    "source.ip": { "type": "string", "description": "Masked source IP" },
    "user.email_hash": { "type": "string", "description": "SHA256 hash of email" }
  }
}
```

---

## API Security

### Authentication Flow

```
┌─────────────────┐                              ┌─────────────────┐
│   SIEM Client   │                              │   AFL Server    │
└────────┬────────┘                              └────────┬────────┘
         │                                                │
         │  1. Generate signature:                        │
         │     timestamp = 2025-02-05T19:30:00Z          │
         │     payload = timestamp + api_key              │
         │     signature = HMAC-SHA256(payload, secret)   │
         │                                                │
         │  2. Request:                                   │
         │     GET /api/siem/events                       │
         │     X-API-Key: siem_abc123                     │
         │     X-Timestamp: 2025-02-05T19:30:00Z         │
         │     X-Signature: hmac_signature_here           │
         │ ─────────────────────────────────────────────► │
         │                                                │
         │                     3. Validate:               │
         │                     - API key exists           │
         │                     - Timestamp within 5 min   │
         │                     - Signature matches        │
         │                     - Rate limit OK            │
         │                     - IP whitelist (optional)  │
         │                                                │
         │  4. Response:                                  │
         │     { events: [...], cursor: "..." }          │
         │ ◄───────────────────────────────────────────── │
         │                                                │
```

### Request Headers

| Header | Required | Description |
|--------|----------|-------------|
| `X-API-Key` | Yes | SIEM API key (siem_xxx...) |
| `X-Timestamp` | Yes | ISO 8601 timestamp |
| `X-Signature` | Yes | HMAC-SHA256 signature |
| `X-Request-ID` | No | Client request ID for correlation |

### Signature Generation

```javascript
// Client-side signature generation
const crypto = require('crypto');

function generateSignature(apiKey, apiSecret, timestamp) {
    const payload = `${timestamp}${apiKey}`;
    return crypto
        .createHmac('sha256', apiSecret)
        .update(payload)
        .digest('hex');
}

// Usage
const timestamp = new Date().toISOString();
const signature = generateSignature('siem_abc123', 'secret_xyz789', timestamp);
```

### Security Measures

| Layer | Mechanism | Details |
|-------|-----------|---------|
| **Authentication** | API Key + HMAC Signature | Time-based signature prevents replay |
| **Authorization** | Dedicated SIEM role | Read-only, logs only |
| **Transport** | HTTPS only | TLS 1.2+ enforced |
| **Rate Limiting** | 100 req/min | Prevents abuse |
| **IP Whitelist** | Optional | Restrict to SIEM server IPs |
| **Audit** | All API calls logged | Who pulled what, when |
| **Data Scope** | No raw PII | Hashed/masked values only |
| **Replay Prevention** | 5 min timestamp window | Rejects old requests |

### Error Responses

```json
// 401 Unauthorized - Invalid API key
{
  "success": false,
  "error": "invalid_api_key",
  "message": "API key not found or revoked"
}

// 401 Unauthorized - Invalid signature
{
  "success": false,
  "error": "invalid_signature",
  "message": "HMAC signature validation failed"
}

// 401 Unauthorized - Expired timestamp
{
  "success": false,
  "error": "timestamp_expired",
  "message": "Request timestamp outside 5 minute window"
}

// 403 Forbidden - IP not whitelisted
{
  "success": false,
  "error": "ip_not_allowed",
  "message": "Source IP not in whitelist"
}

// 429 Too Many Requests
{
  "success": false,
  "error": "rate_limited",
  "message": "Rate limit exceeded. Try again in 60 seconds",
  "retry_after": 60
}
```

---

## SIEM Key Management

### UI for Super Admins

```
┌──────────────────────────────────────────────────────────┐
│  SIEM API Key Management                           [X]   │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Active Keys:                                            │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Name: Splunk Production                            │ │
│  │ Key:  siem_abc1****************************        │ │
│  │ Created: 2025-01-15 by nilesh@acc.ltd             │ │
│  │ Last Used: 2025-02-05T19:25:00Z                   │ │
│  │ IP Whitelist: 10.0.0.5, 10.0.0.6                  │ │
│  │ [Revoke]                                           │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Name: QRadar Test                                  │ │
│  │ Key:  siem_def4****************************        │ │
│  │ Created: 2025-02-01 by admin@acc.ltd              │ │
│  │ Last Used: Never                                   │ │
│  │ IP Whitelist: Any                                  │ │
│  │ [Revoke]                                           │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  [+ Generate New API Key]                                │
│                                                          │
│  ─────────────────────────────────────────────────────── │
│  API Endpoint: https://afl.acc.ltd/api/siem/events      │
│  Documentation: https://afl.acc.ltd/api/siem/docs       │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Key Generation Modal

```
┌──────────────────────────────────────────────────────────┐
│  Generate New SIEM API Key                         [X]   │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Name: [Splunk Production________________]               │
│                                                          │
│  IP Whitelist (optional, comma-separated):               │
│  [10.0.0.5, 10.0.0.6_____________________]               │
│  Leave empty to allow any IP                             │
│                                                          │
│  Expiry:                                                 │
│  ( ) Never                                               │
│  (•) 1 Year                                              │
│  ( ) 6 Months                                            │
│  ( ) Custom: [____] days                                 │
│                                                          │
│  [Cancel]                        [Generate Key]          │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Key Storage (S3)

```json
// s3://bucket/siem-keys/keys.json
{
  "keys": [
    {
      "id": "key_a1b2c3d4",
      "name": "Splunk Production",
      "api_key": "siem_abc123def456...",
      "secret_hash": "sha256:...",
      "created_at": "2025-01-15T10:00:00Z",
      "created_by": "nilesh@acc.ltd",
      "expires_at": "2026-01-15T10:00:00Z",
      "ip_whitelist": ["10.0.0.5", "10.0.0.6"],
      "last_used_at": "2025-02-05T19:25:00Z",
      "last_used_ip": "10.0.0.5",
      "is_active": true
    }
  ]
}
```

---

## Implementation Files

| File | Purpose |
|------|---------|
| `lib/siem-formatter.js` | CEF + JSON event formatting |
| `lib/siem-storage.js` | S3 partitioned storage with hourly indexing |
| `lib/siem-api.js` | Express routes with HMAC authentication |
| `lib/siem-keys.js` | API key generation, validation, management |
| `lib/correlation-middleware.js` | Request correlation ID middleware |
| Update `server.js` | Mount SIEM routes, add correlation middleware |
| Update `security-logger.js` | Add SIEM formatter integration |
| Update `index.html` | SIEM key management UI for Super Admin |

### Estimated Implementation Time

| Component | Effort |
|-----------|--------|
| SIEM Formatter | 2-3 hours |
| S3 Partitioned Storage | 2-3 hours |
| API Routes + Auth | 3-4 hours |
| Key Management | 2-3 hours |
| UI Integration | 2-3 hours |
| Testing | 2-3 hours |
| **Total** | **~15-20 hours** |

---

## SIEM Client Configuration

### Splunk Configuration

```
# inputs.conf
[http://afl_siem]
interval = 300
sourcetype = afl:security
index = security_logs

# Custom script or Splunk HTTP Event Collector setup
# Use cursor-based pagination for incremental fetch
```

### QRadar Configuration

```xml
<!-- Log Source Extension -->
<device_extension>
    <log_source_type>AFL Underwriting Platform</log_source_type>
    <protocol>HTTPS</protocol>
    <url>https://afl.acc.ltd/api/siem/events</url>
    <polling_interval>300</polling_interval>
    <format>CEF</format>
</device_extension>
```

### Azure Sentinel Configuration

```json
{
  "type": "REST",
  "name": "AFL-Underwriting",
  "baseUrl": "https://afl.acc.ltd/api/siem",
  "authType": "APIKey",
  "pollingFrequency": "5m",
  "responseFormat": "JSON"
}
```

### Elastic SIEM Configuration

```yaml
# Filebeat configuration
filebeat.inputs:
  - type: httpjson
    interval: 5m
    request.url: https://afl.acc.ltd/api/siem/events
    request.method: GET
    request.headers:
      X-API-Key: "${SIEM_API_KEY}"
      X-Timestamp: "{{ now }}"
      X-Signature: "{{ hmac_sha256 }}"
    response.pagination:
      - set:
          target: url.params.cursor
          value: '[[.last_response.body.cursor]]'
```

---

## Security Considerations

### Threat Mitigation

| Threat | Mitigation |
|--------|------------|
| Unauthorized access | API Key + HMAC signature |
| Replay attacks | Timestamp validation (5 min window) |
| Brute force | Rate limiting (100/min) |
| Data exfiltration | No raw PII, hashed values only |
| Man-in-middle | HTTPS only, TLS 1.2+ |
| Key compromise | Key rotation, revocation, IP whitelist |
| Audit | All SIEM API calls logged |

### Data Privacy

- **No raw PII** in SIEM events
- Email addresses → SHA256 hash
- IP addresses → First 2 octets only (geo analysis)
- Session IDs → SHA256 hash
- User IDs → Internal IDs only

### Compliance

| Requirement | Implementation |
|-------------|----------------|
| RBI Data Localization | S3 in ap-south-1 (Mumbai) |
| 7-Year Retention | S3 lifecycle policies |
| Encryption at Rest | SSE-KMS for PII audit logs |
| Encryption in Transit | HTTPS/TLS 1.2+ |
| Access Audit | All SIEM API calls logged |

---

## Appendix: Event Type Reference

### Security Events

| Event ID | Action | Severity | Description |
|----------|--------|----------|-------------|
| AUTH_001 | LOGIN_SUCCESS | 3 | Successful user login |
| AUTH_002 | LOGIN_FAILED | 5 | Failed login attempt |
| AUTH_003 | LOGOUT | 3 | User logout |
| AUTH_004 | SESSION_EXPIRED | 3 | Session timeout |
| AUTH_005 | PASSWORD_CHANGED | 5 | Password change |
| AUTHZ_001 | ACCESS_DENIED | 7 | Unauthorized access attempt |
| AUTHZ_002 | PERMISSION_DENIED | 7 | Insufficient permissions |
| AUTHZ_003 | ROLE_CHANGED | 5 | User role modified |

### Data Access Events

| Event ID | Action | Severity | Description |
|----------|--------|----------|-------------|
| DATA_001 | VIEW_ASSESSMENT | 3 | Assessment viewed |
| DATA_002 | CREATE_ASSESSMENT | 3 | New assessment created |
| DATA_003 | EDIT_ASSESSMENT | 5 | Assessment modified |
| DATA_004 | DELETE_ASSESSMENT | 7 | Assessment deleted |
| DATA_005 | EXPORT_PDF | 5 | PDF export |
| DATA_006 | EXPORT_DOCX | 5 | DOCX export |
| DATA_007 | FORENSIC_EXPORT | 7 | Forensic export |

### PII Access Events

| Event ID | Action | Severity | Description |
|----------|--------|----------|-------------|
| PII_001 | VIEW_PII | 5 | PII field viewed |
| PII_002 | EXPORT_PII | 7 | PII exported |
| PII_003 | MASK_OVERRIDE | 7 | PII masking bypassed |

### System Events

| Event ID | Action | Severity | Description |
|----------|--------|----------|-------------|
| SYS_001 | CONFIG_CHANGE | 5 | Configuration modified |
| SYS_002 | CACHE_FLUSH | 3 | Cache flushed |
| SYS_003 | SERVICE_START | 3 | Service started |
| SYS_004 | SERVICE_STOP | 5 | Service stopped |
| SYS_005 | RATE_LIMITED | 5 | Rate limit triggered |

---

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-02-05 | ACC | Initial specification |

---

*Document prepared for Applied Cloud Computing - AFL Underwriting Platform*
