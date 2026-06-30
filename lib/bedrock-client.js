/**
 * Bedrock Client Adapter
 * ----------------------------------------------------------------------
 * Drop-in replacement for the Anthropic SDK's `anthropic.messages.create()`
 * call shape, backed by Amazon Bedrock Runtime's Converse API instead of
 * a direct call to api.anthropic.com.
 *
 * Why this exists:
 *   The UAT/Prod network design has no NAT Gateway / direct internet
 *   egress for the App tier. A direct call to api.anthropic.com would
 *   simply fail. Bedrock is reached over standard AWS networking (same
 *   path as S3/Textract/CloudWatch calls) using the task's IAM role —
 *   no API key, no internet egress required.
 *
 * Design: rather than rewriting every extraction function in
 * claude-extractor.js (24+ call sites), this module exposes the same
 * `.messages.create({ model, max_tokens, system, messages, temperature })`
 * shape and the same Anthropic-style response shape
 * (`{ content: [{type:'text', text}], usage: {input_tokens, output_tokens}, model }`)
 * so existing call sites work unmodified — only the require() at the top
 * of claude-extractor.js / claude-processor.js needs to change.
 *
 * Model IDs: callers keep using literal Anthropic model strings like
 * "claude-sonnet-4-20250514" (unchanged from before — this is just an
 * internal lookup key, it doesn't need to match the real model name).
 * This module maps those strings to the actual Bedrock model ID via
 * BEDROCK_MODEL_ID (single override, set in the CloudFormation task
 * definition) or BEDROCK_MODEL_MAP (JSON, for multiple Anthropic model
 * strings -> different Bedrock IDs).
 *
 * Currently deployed model: Claude Sonnet 4.6.
 *
 * IMPORTANT — verify before go-live: the exact Bedrock catalog ID/
 * inference profile string for Sonnet 4.6 in your account+region must
 * be confirmed via:
 *   aws bedrock list-foundation-models --region ap-south-1 --by-provider anthropic
 *   aws bedrock list-inference-profiles --region ap-south-1
 * The BEDROCK_MODEL_ID env var (set by the CloudFormation template's
 * BedrockModelId parameter) always wins over the placeholder default
 * below, so this only matters if that env var is somehow unset.
 */

const {
    BedrockRuntimeClient,
    ConverseCommand
} = require('@aws-sdk/client-bedrock-runtime');

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';

// Default model mapping. Override per-environment via BEDROCK_MODEL_ID
// (applies to ALL literal Anthropic model strings used in claude-extractor.js)
// or BEDROCK_MODEL_MAP for fine-grained per-model overrides.
// NOTE on data residency: confirmed decision (not a default I chose) — this
// deployment uses the "global." cross-region inference profile, which
// routes requests to whichever AWS region has capacity worldwide, for
// maximum throughput. There is no regional guarantee at all with this
// profile (broader than the "jp." Japan-only alternative). The
// CloudFormation BedrockModelId parameter (which always overrides this
// default at runtime) is set to "global.anthropic.claude-sonnet-4-6".
const DEFAULT_MODEL_MAP = {
    'claude-sonnet-4-20250514': process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-sonnet-4-6'
};

let MODEL_MAP = DEFAULT_MODEL_MAP;
if (process.env.BEDROCK_MODEL_MAP) {
    try {
        MODEL_MAP = { ...DEFAULT_MODEL_MAP, ...JSON.parse(process.env.BEDROCK_MODEL_MAP) };
    } catch (e) {
        console.error('[BedrockClient] Failed to parse BEDROCK_MODEL_MAP, using defaults:', e.message);
    }
}

function resolveModelId(anthropicModelString) {
    // If BEDROCK_MODEL_ID is explicitly set, it wins for every call —
    // simplest path for a single-model deployment.
    if (process.env.BEDROCK_MODEL_ID) return process.env.BEDROCK_MODEL_ID;
    return MODEL_MAP[anthropicModelString] || anthropicModelString;
}

let clientInstance = null;
function getClient() {
    if (clientInstance) return clientInstance;
    clientInstance = new BedrockRuntimeClient({ region: REGION });
    return clientInstance;
}

/**
 * Convert Anthropic-style message content blocks into Bedrock Converse
 * content blocks.
 *  - {type:"text", text} -> {text}
 *  - {type:"document", source:{type:"base64", media_type:"application/pdf", data}}
 *      -> {document: {format:"pdf", name, source:{bytes: Buffer}}}
 *  - {type:"image", source:{type:"base64", media_type, data}}
 *      -> {image: {format, source:{bytes: Buffer}}}
 * String content (Anthropic also allows `content: "plain string"`) is
 * passed through as a single text block.
 */
function convertContent(content, fallbackName) {
    if (typeof content === 'string') {
        return [{ text: content }];
    }
    if (!Array.isArray(content)) return [{ text: String(content ?? '') }];

    let docCounter = 0;
    return content.map((block) => {
        if (block.type === 'text') {
            return { text: block.text };
        }
        if (block.type === 'document') {
            docCounter++;
            const mediaType = block.source?.media_type || 'application/pdf';
            const format = mediaType.includes('pdf') ? 'pdf' : 'txt';
            const data = block.source?.data;
            const bytes = typeof data === 'string' ? Buffer.from(data, 'base64') : data;
            return {
                document: {
                    format,
                    // Bedrock requires a name with no spaces/special chars
                    name: `${(fallbackName || 'document').replace(/[^a-zA-Z0-9_-]/g, '_')}_${docCounter}`,
                    source: { bytes }
                }
            };
        }
        if (block.type === 'image') {
            const mediaType = block.source?.media_type || 'image/png';
            const format = mediaType.split('/')[1] || 'png';
            const data = block.source?.data;
            const bytes = typeof data === 'string' ? Buffer.from(data, 'base64') : data;
            return { image: { format, source: { bytes } } };
        }
        // Unknown block type — best effort passthrough as text
        return { text: JSON.stringify(block) };
    });
}

function convertMessages(messages, fallbackName) {
    return (messages || []).map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: convertContent(m.content, fallbackName)
    }));
}

/**
 * Anthropic-shaped messages.create() backed by Bedrock Converse.
 * @param {Object} params - { model, max_tokens, temperature, system, messages }
 * @returns {Promise<{content: Array, usage: {input_tokens, output_tokens}, model: string, stop_reason: string}>}
 */
async function createMessage(params) {
    const {
        model,
        max_tokens = 2048,
        temperature,
        system,
        messages
    } = params;

    const modelId = resolveModelId(model);
    const client = getClient();

    const command = new ConverseCommand({
        modelId,
        messages: convertMessages(messages, model),
        system: system ? [{ text: system }] : undefined,
        inferenceConfig: {
            maxTokens: max_tokens,
            ...(temperature !== undefined ? { temperature } : {})
        }
    });

    const startTime = Date.now();
    let response;
    try {
        response = await client.send(command);
    } catch (error) {
        // Surface a clearer error for the most common Bedrock failure modes
        if (error.name === 'AccessDeniedException') {
            throw new Error(`Bedrock access denied — check the task IAM role has bedrock:InvokeModel for ${modelId}. (${error.message})`);
        }
        if (error.name === 'ValidationException' && /model identifier/i.test(error.message)) {
            throw new Error(`Bedrock model ID "${modelId}" is invalid or not enabled in ${REGION} — verify via 'aws bedrock list-inference-profiles'. (${error.message})`);
        }
        if (error.name === 'ThrottlingException') {
            throw new Error(`Bedrock throttled the request for ${modelId} — consider retry/backoff. (${error.message})`);
        }
        throw error;
    }

    const durationMs = Date.now() - startTime;
    const outputMessage = response.output?.message;
    const textBlocks = (outputMessage?.content || []).filter((b) => b.text !== undefined);
    const responseText = textBlocks.map((b) => b.text).join('\n');

    // Normalize back into the exact shape claude-extractor.js already expects
    return {
        id: response.$metadata?.requestId || null,
        model: modelId,
        content: [{ type: 'text', text: responseText }],
        stop_reason: response.stopReason || null,
        usage: {
            input_tokens: response.usage?.inputTokens || 0,
            output_tokens: response.usage?.outputTokens || 0
        },
        _bedrock: {
            durationMs,
            stopReason: response.stopReason
        }
    };
}

module.exports = {
    messages: {
        create: createMessage
    },
    resolveModelId,
    getClient
};
