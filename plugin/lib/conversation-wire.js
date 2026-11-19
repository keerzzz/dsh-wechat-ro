// Authenticated native-conversation UI protocol. No method here is a model tool.
// Client carries this exact factory body; test-conversation-client.mjs checks parity.
import { z } from 'zod';

export function createConversationWire(z) {
  const CONVERSATION_NAMESPACE = 'wechatConversation';
  const CONVERSATION_ERROR_CODES = [
    'INVALID_REQUEST', 'NOT_AUTHORIZED', 'SESSION_NOT_READY', 'SNAPSHOT_REQUIRED',
    'SNAPSHOT_DENIED', 'NETWORK_DISABLED', 'QR_UNAVAILABLE', 'PAIRING_REQUIRED',
    'PAIRING_ALREADY_STORED', 'PAIRING_STORAGE_FAILED', 'PAIRING_STATE_INVALID',
    'OWNER_MISMATCH', 'SHARED_CONTEXT_DENIED', 'BUSY', 'CANCELLED', 'UNAVAILABLE', 'ACTION_FAILED',
    'LOCAL_HISTORY_CLIENT_REQUIRED', 'LOCAL_HISTORY_FAILED',
    'ARCHIVE_QUERY_LIMIT',
    'HISTORY_OPEN_FAILED', 'HISTORY_ALREADY_OPEN', 'HISTORY_INVALID', 'SESSION_CREATE_FAILED', 'SESSION_PERSIST_FAILED', 'HISTORY_WRITE_FAILED',
    'WECHAT_NETWORK_FAILED', 'WECHAT_REQUEST_TIMEOUT', 'WECHAT_HTTP_REJECTED', 'WECHAT_REQUEST_REJECTED',
    'WECHAT_RESPONSE_TYPE_INVALID', 'WECHAT_RESPONSE_JSON_INVALID', 'WECHAT_RESPONSE_TOO_LARGE', 'WECHAT_RESPONSE_INVALID',
    'WECHAT_ORIGIN_REJECTED', 'WECHAT_REDIRECT_REJECTED',
  ];
  const CONVERSATION_ACTION_NAMES = [
    'createConversation', 'resumeConversation', 'grantSnapshot', 'revokeSnapshot', 'queryArchive', 'beginLogin',
    'pollLogin', 'confirmPairing', 'startChannel', 'stopChannel', 'forgetPairing', 'discardPending',
  ];
  const CONVERSATION_METHOD_SPECS = [
    { method: 'getConversationState', description: 'Read only in-memory conversation, task and workspace state, including an owner-only transient rendered login QR matrix. Does not create or resume a Session, read a source, load credentials, or use the network.' },
    { method: 'conversationAction', description: 'Perform one explicitly confirmed, authenticated Harness UI action for an archive or controlled native task. The connectConversation action initializes the exact directory-bound task and enables owner-only automatic text replies after verified pairing. Not a model tool.' },
  ];
  const CONVERSATION_METHOD_NAMES = CONVERSATION_METHOD_SPECS.map(spec => spec.method);
  const JSON_VALUE = z.lazy(() => z.union([
    z.string(), z.number().finite(), z.boolean(), z.null(), z.array(JSON_VALUE), z.record(z.string(), JSON_VALUE),
  ]));
  const JSON_OBJECT = z.record(z.string(), JSON_VALUE);
  const printable = max => z.string().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/).refine(value => value.trim().length > 0);
  const SESSION_ID = printable(256);
  const TALKER = printable(256);
  const TIMESTAMP = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
  const ERROR_CODE = z.enum(CONVERSATION_ERROR_CODES);
  const getStateRequestSchema = z.strictObject({ sessionId: SESSION_ID.optional() });
  const archiveQuerySchema = z.strictObject({
    action: z.enum(['status', 'contacts', 'sessions', 'messages', 'search', 'stats', 'digest', 'content', 'contentStats', 'media']),
    sourceKind: z.enum(['messages', 'moments', 'favorites', 'miniprogram', 'voice', 'image', 'video']).optional(),
    talker: TALKER.optional(), query: z.string().min(1).max(1000).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    fromTs: TIMESTAMP.optional(), toTs: TIMESTAMP.optional(),
  }).refine(value => value.fromTs === undefined || value.toTs === undefined || value.fromTs <= value.toTs);
  const actionSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('createConversation'), contextSessionId: SESSION_ID, confirmation: z.literal('create-readonly-conversation') }),
    z.strictObject({ action: z.literal('resumeConversation'), sessionId: SESSION_ID, confirmation: z.literal('resume-readonly-conversation') }),
    z.strictObject({
      action: z.literal('grantSnapshot'), sessionId: SESSION_ID, root: printable(4096),
      allConversations: z.boolean(), talkers: z.array(TALKER).max(100),
      fromTs: TIMESTAMP.nullable(), toTs: TIMESTAMP.nullable(), allowWechat: z.boolean(),
      confirmation: z.literal('read-decrypted-snapshot'),
    }),
    z.strictObject({ action: z.literal('revokeSnapshot'), sessionId: SESSION_ID, confirmation: z.literal('revoke-snapshot') }),
    z.strictObject({ action: z.literal('queryArchive'), sessionId: SESSION_ID, query: archiveQuerySchema }),
    z.strictObject({ action: z.literal('beginLogin'), sessionId: SESSION_ID, confirmation: z.literal('network-login') }),
    z.strictObject({ action: z.literal('pollLogin'), sessionId: SESSION_ID, verifyCode: printable(64).optional() }),
    z.strictObject({ action: z.literal('confirmPairing'), sessionId: SESSION_ID, expectedOwnerId: printable(256), confirmation: z.literal('persist-pairing') }),
    z.strictObject({ action: z.literal('startChannel'), sessionId: SESSION_ID, allowSharedContext: z.literal(true), confirmation: z.literal('poll-and-reply') }),
    z.strictObject({ action: z.literal('stopChannel'), sessionId: SESSION_ID, confirmation: z.literal('stop-channel') }),
    z.strictObject({ action: z.literal('forgetPairing'), sessionId: SESSION_ID, confirmation: z.literal('forget-local-credentials') }),
    z.strictObject({ action: z.literal('discardPending'), sessionId: SESSION_ID, confirmation: z.literal('discard-without-retry') }),
  ]).superRefine((value, ctx) => {
    if (value.action !== 'grantSnapshot') return;
    if (value.allConversations !== (value.talkers.length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['talkers'], message: 'Choose all conversations or a non-empty talker scope, not both.' });
    }
    if (new Set(value.talkers).size !== value.talkers.length) {
      ctx.addIssue({ code: 'custom', path: ['talkers'], message: 'Talker scope must contain unique identities.' });
    }
    if (value.fromTs !== null && value.toTs !== null && value.fromTs > value.toTs) {
      ctx.addIssue({ code: 'custom', path: ['toTs'], message: 'End timestamp must not precede start timestamp.' });
    }
  });
  const stateSchema = z.strictObject({
    version: z.string().min(1).max(64), sessionId: SESSION_ID.nullable(), prepared: z.boolean(),
    archive: JSON_OBJECT, channel: JSON_OBJECT, lastError: ERROR_CODE.nullable(),
  });
  const qrSchema = z.strictObject({
    payloadKind: z.literal('ilink-login'), rows: z.array(z.string().regex(/^[01]+$/).min(21).max(177)).min(21).max(177),
  }).refine(value => (value.rows.length - 21) % 4 === 0 && value.rows.every(row => row.length === value.rows.length));
  const actionResultSchema = z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), state: stateSchema, result: JSON_OBJECT.optional(), qr: qrSchema.optional() }),
    z.strictObject({ ok: z.literal(false), error: z.strictObject({ code: ERROR_CODE }) }),
  ]);
  const TASK_ID = printable(256).regex(/^wechat-task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const SOURCE_ID = printable(80);
  const TASK_ACTION_NAMES = ['connectConversation', 'createConversation', 'resumeConversation', 'grantWorkspace', 'grantDirectory', 'grantSession', 'grantSnapshot',
    'revokeSource', 'setSharing', 'querySource', 'queryFiles', 'prepareSnapshot', 'beginLogin', 'pollLogin', 'confirmPairing', 'startChannel', 'pollTextOnce', 'resumeTextOnce', 'diagnoseUpdatesOnce', 'stopChannel', 'forgetPairing', 'discardPending',
    'reviewHistoricalContext', 'authorizeHistoricalContext', 'revokeHistoricalContext',
    'selectFirstTextModel', 'reviewFirstTextContext', 'authorizeFirstTextContext', 'revokeFirstTextContext', 'allowNewFirstText',
    'importLocalHistory', 'refreshLocalHistory', 'stopLocalHistory', 'setDailyCardTime', 'refreshDailyCards'];
  const taskGetStateRequestSchema = z.strictObject({ kind: z.literal('task'), sessionId: SESSION_ID.optional() });
  const workspaceInfo = z.strictObject({ id: printable(256), root: printable(4096), title: printable(160) });
  const sourceInfo = { sourceId: SOURCE_ID, title: printable(160), allowWechat: z.boolean() };
  const taskAccessStateSchema = z.strictObject({ version: z.literal(1), sessionId: TASK_ID, disposed: z.boolean(), prepared: z.boolean(), historyKnown: z.boolean(),
    workspace: workspaceInfo.nullable(), allowWechat: z.boolean(), shareable: z.boolean(), sessionMayContainData: z.boolean(), contextBlocked: z.boolean(),
    modelVision: z.boolean().optional(), contentProcessing: z.strictObject({ processed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }).nullable().optional(), sources: z.array(z.discriminatedUnion('kind', [z.strictObject({ ...sourceInfo, kind: z.literal('directory'), root: printable(4096), write: z.boolean() }),
      z.strictObject({ ...sourceInfo, kind: z.literal('session'), sessionId: SESSION_ID }), z.strictObject({ ...sourceInfo, kind: z.literal('archive'), archive: JSON_OBJECT })])).max(32),
    lastError: printable(80).nullable() });
  const connectionSetupSchema = z.strictObject({ root: printable(4096).nullable(), title: printable(160).nullable(), sessionId: TASK_ID.nullable(),
    phase: z.enum(['directory-required', 'ready', 'pairing', 'history-required', 'model-required', 'running', 'stopped', 'expired', 'blocked']),
    modelConfigured: z.boolean(), error: ERROR_CODE.nullable(), qr: qrSchema.nullable().optional() });
  const taskStateSchema = z.strictObject({ kind: z.literal('task'), version: z.literal('0.2.0-task-v1'), sessionId: SESSION_ID.nullable(),
    available: z.boolean(), prepared: z.boolean(), task: taskAccessStateSchema.nullable(), channel: JSON_OBJECT,
    tasks: z.array(z.strictObject({ sessionId: TASK_ID, title: printable(160), prepared: z.boolean() })).max(128),
    workspaces: z.array(workspaceInfo).max(256), lastError: ERROR_CODE.nullable() }).refine(value => (value.task === null || value.task.sessionId === value.sessionId)
      && (value.channel.setup === undefined || connectionSetupSchema.safeParse(value.channel.setup).success));
  const workspaceGrant = z.strictObject({ root: printable(4096), title: printable(160), allowWechat: z.boolean(), confirmation: z.literal('read-and-write-task-workspace') });
  const sourceQuery = z.discriminatedUnion('action', [z.strictObject({ action: z.literal('status') }),
    z.strictObject({ action: z.literal('archive'), query: archiveQuerySchema }),
    z.strictObject({ action: z.literal('analyzeVoice'), talker: TALKER, localId: z.string().regex(/^[0-9]{1,20}$/), ts: TIMESTAMP }),
    z.strictObject({ action: z.literal('analyzeMedia'), talker: TALKER, localId: z.string().regex(/^[0-9]{1,20}$/), ts: TIMESTAMP }),
    z.strictObject({ action: z.literal('session'), sourceId: SOURCE_ID, query: printable(512).optional(), limit: z.number().int().min(1).max(50).optional(), offset: z.number().int().min(0).max(10000).optional() })]);
  const fileQuery = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('list'), sourceId: SOURCE_ID.optional(), path: printable(2048).optional(), limit: z.number().int().min(1).max(100).optional() }),
    z.strictObject({ action: z.literal('read'), sourceId: SOURCE_ID.optional(), path: printable(2048) }),
    z.strictObject({ action: z.literal('analyze'), sourceId: SOURCE_ID.optional(), path: printable(2048) })]);
  const target = { kind: z.literal('task'), sessionId: TASK_ID };
  const taskAction = (name, shape) => z.strictObject({ action: z.literal(name), ...target, ...shape });
  const firstModelControls = { provider: printable(256), model: printable(256), reasoningEffort: printable(80).optional(),
    temperature: z.number().finite().min(0).optional(), maxTokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() };
  const firstTextModelRequestSchema = z.union([
    z.strictObject({ ...firstModelControls, confirmation: z.literal('select-first-task-model') }),
    z.strictObject({ ...firstModelControls, confirmation: z.literal('select-first-task-model'), selectionRevision: TIMESTAMP, preparationConfirmation: z.literal('prepare-first-task-model-metadata') }),
  ]);
  const taskBaseActionSchema = z.discriminatedUnion('action', [
    taskAction('setModelVision', { enabled: z.boolean(), confirmation: z.literal('analyze-selected-media-with-current-model') }),
    taskAction('setDailyCardTime', { time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }),
    taskAction('refreshDailyCards', {}),
    taskAction('importLocalHistory', { autoUpdate: z.boolean(), allowWechat: z.boolean(), confirmation: z.literal('import-own-wechat-history') }),
    taskAction('refreshLocalHistory', { confirmation: z.literal('refresh-own-wechat-history') }),
    taskAction('stopLocalHistory', { confirmation: z.literal('stop-local-history-updates') }),
    z.strictObject({ kind: z.literal('task'), action: z.literal('connectConversation'), contextSessionId: SESSION_ID, expectedDirectory: printable(4096), confirmation: z.literal('connect-own-wechat-auto-reply') }),
    z.strictObject({ kind: z.literal('task'), action: z.literal('createConversation'), contextSessionId: SESSION_ID, workspace: workspaceGrant }),
    taskAction('resumeConversation', { confirmation: z.literal('resume-task-conversation') }),
    taskAction('grantWorkspace', { workspace: workspaceGrant }),
    taskAction('grantDirectory', { root: printable(4096), title: printable(160), sourceId: z.string().uuid().optional(), allowWechat: z.boolean(), confirmation: z.literal('read-task-directory') }),
    taskAction('grantSession', { sourceSessionId: SESSION_ID, title: printable(160), allowWechat: z.boolean(), confirmation: z.literal('read-task-session') }),
    taskAction('grantSnapshot', { root: printable(4096), allConversations: z.boolean(), talkers: z.array(TALKER).max(100), fromTs: TIMESTAMP.nullable(), toTs: TIMESTAMP.nullable(), allowWechat: z.boolean(), confirmation: z.literal('read-decrypted-snapshot') }),
    taskAction('revokeSource', { sourceId: SOURCE_ID, confirmation: z.literal('revoke-task-source') }),
    taskAction('setSharing', { allowWechat: z.boolean(), confirmation: z.literal('share-whole-task-context') }),
    taskAction('querySource', { query: sourceQuery }), taskAction('queryFiles', { query: fileQuery }),
    z.strictObject({ kind: z.literal('task'), action: z.literal('prepareSnapshot'), contextSessionId: SESSION_ID, root: printable(4096), query: printable(512).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1000).optional(), confirmation: z.literal('browse-snapshot-roster') }),
    taskAction('beginLogin', { confirmation: z.literal('network-login') }), taskAction('pollLogin', { verifyCode: printable(64).optional() }),
    taskAction('confirmPairing', { expectedOwnerId: printable(256), confirmation: z.literal('persist-pairing') }),
    taskAction('startChannel', { allowSharedContext: z.literal(true), confirmation: z.literal('poll-and-reply') }),
    taskAction('pollTextOnce', { allowSharedContext: z.literal(true), confirmation: z.literal('poll-one-text-reply') }),
    taskAction('resumeTextOnce', { allowSharedContext: z.literal(true), confirmation: z.literal('continue-unanswered-message') }),
    taskAction('diagnoseUpdatesOnce', { confirmation: z.literal('read-one-wechat-update-diagnostic') }),
    taskAction('stopChannel', { confirmation: z.literal('stop-channel') }), taskAction('forgetPairing', { confirmation: z.literal('forget-local-credentials') }),
    taskAction('discardPending', { confirmation: z.literal('discard-without-retry') }),
    taskAction('reviewHistoricalContext', {}),
    taskAction('authorizeHistoricalContext', { reviewId: z.string().uuid(), confirmation: z.literal('authorize-reviewed-task-history-text') }),
    taskAction('revokeHistoricalContext', { revokeId: z.string().uuid(), confirmation: z.literal('revoke-task-history-context') }),
    taskAction('selectFirstTextModel', { ...firstModelControls, confirmation: z.literal('select-first-task-model') }),
    taskAction('reviewFirstTextContext', {}),
    taskAction('authorizeFirstTextContext', { reviewId: z.string().uuid(), confirmation: z.literal('authorize-reviewed-first-task-text') }),
    taskAction('revokeFirstTextContext', { revokeId: z.string().uuid(), confirmation: z.literal('revoke-first-task-text') }),
    taskAction('allowNewFirstText', { priorRunId: z.string().uuid(), priorConsentId: z.string().uuid(), confirmation: z.literal('allow-new-first-text-after-unknown') }),
  ]);
  const taskActionSchema = z.union([
    taskBaseActionSchema,
    taskAction('setSharing', { allowWechat: z.literal(true), historyConsentId: z.string().uuid(), confirmation: z.literal('share-reviewed-task-history-context') }),
    taskAction('pollTextOnce', { allowSharedContext: z.literal(true), historyConsentId: z.string().uuid(), confirmation: z.literal('poll-one-text-reply-with-reviewed-history') }),
    taskAction('setSharing', { allowWechat: z.literal(true), firstTextConsentId: z.string().uuid(), confirmation: z.literal('share-reviewed-first-task-text') }),
    taskAction('pollTextOnce', { allowSharedContext: z.literal(true), firstTextConsentId: z.string().uuid(), confirmation: z.literal('poll-one-text-reply-with-first-task-text') }),
    taskAction('selectFirstTextModel', { ...firstModelControls, confirmation: z.literal('select-first-task-model'),
      selectionRevision: TIMESTAMP, preparationConfirmation: z.literal('prepare-first-task-model-metadata') }),
  ]).superRefine((value, ctx) => {
    if (value.action !== 'grantSnapshot') return;
    if (value.allConversations !== (value.talkers.length === 0) || new Set(value.talkers).size !== value.talkers.length
      || value.fromTs !== null && value.toTs !== null && value.fromTs > value.toTs) ctx.addIssue({ code: 'custom', message: 'Choose one valid, unique conversation and time scope.' });
  });
  const updatesDiagnosticSchema = z.strictObject({
    version: z.literal(1), outcome: z.enum(['valid', 'invalid', 'failed']),
    errorCode: z.enum(['not-configured', 'invalid-options', 'invalid-input', 'unsupported-origin', 'unsupported-redirect', 'network-error',
      'timeout', 'aborted', 'http-error', 'business-error', 'invalid-mime', 'invalid-json', 'response-too-large', 'invalid-response']).nullable(),
    validationField: z.enum(['http-response', 'response-body', 'root', 'ret', 'errcode', 'msgs', 'get_updates_buf', 'message', 'message_type',
      'message_state', 'group_id', 'item_list', 'item', 'item_type', 'ref_msg', 'text_item', 'text', 'message_id', 'from_user_id', 'to_user_id', 'context_token']).nullable(),
    msgsShape: z.enum(['omitted', 'null', 'array', 'other']).nullable(), cursorShape: z.enum(['omitted', 'empty', 'string', 'other']).nullable(),
    messageCount: z.number().int().min(0).max(256).nullable(), textCount: z.number().int().min(0).max(256).nullable(),
    ignoredCount: z.number().int().min(0).max(256).nullable(), httpStatus: z.number().int().min(100).max(599).nullable(),
    businessCode: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
  }).refine(value => {
    if ((value.msgsShape === 'omitted' || value.msgsShape === 'null') && value.messageCount !== 0) return false;
    if (value.msgsShape === 'other' && value.messageCount !== null) return false;
    if (value.outcome === 'valid') return value.errorCode === null && value.validationField === null
      && value.msgsShape !== null && value.msgsShape !== 'other' && value.cursorShape !== null && value.cursorShape !== 'other'
      && value.messageCount !== null && value.textCount !== null && value.ignoredCount !== null
      && value.messageCount === value.textCount + value.ignoredCount;
    if (value.textCount !== null || value.ignoredCount !== null || value.errorCode === null) return false;
    const invalid = ['invalid-response', 'invalid-json', 'invalid-mime', 'response-too-large'].includes(value.errorCode);
    return value.outcome === 'invalid' ? invalid : !invalid && value.validationField === null;
  });
  const updatesDiagnosticResultSchema = z.strictObject({ diagnostic: updatesDiagnosticSchema });
  const taskActionResultSchema = z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), state: taskStateSchema, result: JSON_OBJECT.optional(), qr: qrSchema.optional() }),
    z.strictObject({ ok: z.literal(false), error: z.strictObject({ code: ERROR_CODE }) }),
  ]).refine(value => value.ok !== true || value.result === undefined || !Object.hasOwn(value.result, 'diagnostic')
    || updatesDiagnosticResultSchema.safeParse(value.result).success);
  const historyReceiptObjects = [
    z.strictObject({ operation: z.literal('authorize'), reviewId: z.string().uuid(), consentId: z.string().uuid(), decisionId: z.string().uuid(), permissionCommitted: z.literal(true), auditCommitted: z.literal(true) }),
    z.strictObject({ operation: z.literal('share'), consentId: z.string().uuid(), decisionId: z.string().uuid(), sharingCommitted: z.literal(true), auditCommitted: z.literal(true) }),
    z.strictObject({ operation: z.literal('terminal'), consentId: z.string().uuid(), runId: z.string().uuid(), permissionRevoked: z.literal(true), sharingClosed: z.literal(true),
      requestAccepted: z.union([z.literal(0), z.literal(1)]).optional(), modelRequestsReserved: z.union([z.literal(0), z.literal(1)]).optional(),
      runOutcome: z.enum(['replied', 'empty', 'blocked', 'unknown']), auditOutcome: z.enum(['pending', 'committed', 'unknown']), decisionId: z.string().uuid().optional() }),
    z.strictObject({ operation: z.literal('revoke'), revokeId: z.string().uuid(), consentId: z.string().uuid().nullable(), runId: z.string().uuid().nullable(), permissionRevoked: z.literal(true), sharingClosed: z.literal(true),
      runOutcome: z.enum(['pending', 'unknown', 'none']), auditOutcome: z.enum(['pending', 'committed', 'unknown']), decisionId: z.string().uuid().optional() }),
    z.strictObject({ operation: z.literal('audit'), auditedOperation: z.enum(['authorize', 'share', 'reserve', 'revoke', 'terminal', 'new-input']), decisionId: z.string().uuid(),
      reviewId: z.string().uuid().nullable(), consentId: z.string().uuid().nullable(), runId: z.string().uuid().nullable(), revokeId: z.string().uuid().nullable(),
      auditOutcome: z.literal('committed'), permissionRevoked: z.boolean(), outcome: z.enum(['accepted', 'revoked', 'replied', 'empty', 'blocked', 'unknown']) }),
  ];
  const historyReceiptSchema = z.discriminatedUnion('operation', historyReceiptObjects);
  const firstTextReceiptSchema = z.discriminatedUnion('operation', [...historyReceiptObjects.map(schema => schema.extend({ purpose: z.literal('first-text-once') })),
    z.strictObject({ purpose: z.literal('first-text-once'), operation: z.literal('new-input'), priorRunId: z.string().uuid(), priorConsentId: z.string().uuid(),
      decisionId: z.string().uuid(), newInputAllowed: z.literal(true), auditCommitted: z.literal(true) }),
  ]);
  const historicalContextSchema = z.strictObject({ version: z.literal(1), supported: z.boolean(), required: z.boolean(),
    reason: z.enum(['history-unavailable', 'sdk-not-ready', 'not-required', 'unsupported-sources', 'review-expired', 'consent-expired', 'audit-unresolved', 'run-unresolved',
      'source-changed', 'history-changed', 'sdk-changed', 'sharing-changed', 'sharing-required', 'revoked', 'disposed']).nullable(),
    phase: z.enum(['blocked', 'reviewed', 'approved', 'sharing-confirmed', 'reserved', 'running', 'spent']),
    workspace: z.strictObject({ id: printable(256), root: printable(4096) }).nullable(), consumedCount: z.number().int().min(0).max(1024),
    purpose: z.literal('history-text-once'), consentId: z.string().uuid().nullable(), sharingConfirmed: z.boolean(), executable: z.boolean(), receipts: z.array(historyReceiptSchema).max(16) });
  const historicalReviewResultSchema = z.strictObject({ historicalContext: historicalContextSchema, reviewId: z.string().uuid(), expiresAt: TIMESTAMP });
  const historicalResultSchema = z.strictObject({ historicalContext: historicalContextSchema, receipt: historyReceiptSchema });
  const firstConfigurationSchema = z.strictObject({ reasoningEffort: printable(80).optional(), temperature: z.number().finite().min(0).optional(),
    maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), stopSequenceCount: z.number().int().min(0).max(128) });
  const firstTextModelSchema = z.strictObject({ version: z.literal(1), provider: printable(256), model: printable(256), selectionRevision: TIMESTAMP,
    configurationDigest: z.string().regex(/^[a-f0-9]{64}$/), configuration: firstConfigurationSchema, defaults: firstConfigurationSchema,
    adapterDefaults: z.strictObject({ reasoningEffort: z.literal(true).optional(), maxTokens: z.literal(true).optional() }),
    versions: z.strictObject({ metadata: TIMESTAMP, configuration: TIMESTAMP, connection: TIMESTAMP, authenticationIdentity: TIMESTAMP }),
    contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() });
  const firstTextSelectionSchema = z.strictObject({ provider: printable(256), model: printable(256), selectionRevision: TIMESTAMP, configuration: firstConfigurationSchema,
    preparation: z.discriminatedUnion('supported', [
      z.strictObject({ supported: z.literal(true), preparationEffects: z.strictObject({ filesystem: z.boolean(), credentials: z.boolean(), network: z.boolean(), cache: z.boolean() }) }),
      z.strictObject({ supported: z.literal(false), reason: z.literal('adapter-unsupported') }),
    ]) });
  const firstTextNativeSchema = z.strictObject({ version: z.literal(1), purpose: z.literal('first-text-once'), agentId: TASK_ID, sessionId: TASK_ID,
    sequence: TIMESTAMP, surfaceContentGeneration: TIMESTAMP, fixedSystemVersion: z.literal(1),
    scope: z.strictObject({ fixedSystem: z.literal(true), soleHumanText: z.literal(true), priorMessages: z.literal(false), sources: z.literal(false), tools: z.literal(false) }),
    model: firstTextModelSchema }).refine(value => value.agentId === value.sessionId);
  const firstTextContextSchema = historicalContextSchema.extend({ purpose: z.literal('first-text-once'), receipts: z.array(firstTextReceiptSchema).max(16),
    newInputAllowed: z.boolean().default(false),
    model: firstTextModelSchema.nullable(), native: firstTextNativeSchema.nullable(), preparation: firstTextSelectionSchema.nullable(),
    reason: z.enum(['history-unavailable', 'sdk-not-ready', 'not-required', 'unsupported-sources', 'review-expired', 'consent-expired', 'audit-unresolved', 'run-unresolved',
      'source-changed', 'history-changed', 'sdk-changed', 'sharing-changed', 'sharing-required', 'revoked', 'disposed',
      'not-live', 'not-ready', 'busy', 'leased', 'seeded-session', 'not-empty', 'unprovable-projection', 'model-not-selected', 'adapter-unsupported',
      'model-unprepared', 'model-stale', 'observation-stale', 'preparation-cancelled', 'preparation-failed']).nullable() });
  const firstTextReviewResultSchema = z.strictObject({ firstTextContext: firstTextContextSchema, reviewId: z.string().uuid(), expiresAt: TIMESTAMP });
  const firstTextResultSchema = z.strictObject({ firstTextContext: firstTextContextSchema, receipt: firstTextReceiptSchema });
  const taskWire = { TASK_ACTION_NAMES, getStateRequestSchema: taskGetStateRequestSchema, stateSchema: taskStateSchema, actionSchema: taskActionSchema,
    actionResultSchema: taskActionResultSchema, sourceQuerySchema: sourceQuery, fileQuerySchema: fileQuery,
    historicalContextSchema, historicalReviewResultSchema, historicalResultSchema, historyReceiptSchema,
    firstTextContextSchema, firstTextReviewResultSchema, firstTextResultSchema, firstTextReceiptSchema, firstTextModelSchema, firstTextSelectionSchema, firstTextModelRequestSchema,
    updatesDiagnosticSchema, updatesDiagnosticResultSchema, connectionSetupSchema };
  const rpcGetStateRequestSchema = z.union([getStateRequestSchema, taskGetStateRequestSchema]);
  const rpcActionSchema = z.union([actionSchema, taskActionSchema]);
  const rpcStateSchema = z.union([stateSchema, taskStateSchema]);
  const rpcActionResultSchema = z.union([actionResultSchema, taskActionResultSchema]);
  const methodName = method => typeof method === 'string' ? method : method.method;
  function conversationRequestSchemaFor(method) {
    const name = methodName(method);
    if (name === 'getConversationState') return rpcGetStateRequestSchema;
    if (name === 'conversationAction') return rpcActionSchema;
    throw new TypeError('Unknown conversation method');
  }
  function conversationResultSchemaFor(method) {
    const name = methodName(method);
    if (name === 'getConversationState') return rpcStateSchema;
    if (name === 'conversationAction') return rpcActionResultSchema;
    throw new TypeError('Unknown conversation method');
  }
  function conversationDescriptorFor(method) {
    const name = methodName(method);
    const spec = CONVERSATION_METHOD_SPECS.find(value => value.method === name);
    if (!spec) throw new TypeError('Unknown conversation method');
    return {
      id: 'dsh-wechat-ro#' + CONVERSATION_NAMESPACE + '/' + name,
      service: CONVERSATION_NAMESPACE, namespace: CONVERSATION_NAMESPACE, method: name,
      description: spec.description, invocation: { kind: 'direct' },
      parameters: [{
        name: 'request', wire: 'request', source: 'json', acceptsUndefined: name === 'getConversationState',
        description: name === 'getConversationState' ? 'Optional Session identity; memory-only read.' : 'One required strict user-action request.',
        codec: { mode: 'strict', typeSymbol: 'dsh-wechat-ro#' + CONVERSATION_NAMESPACE + '/' + name + 'Request', create: () => conversationRequestSchemaFor(name) },
      }],
      cancellation: { parameter: 'signal' },
      result: { mode: 'strict', typeSymbol: 'dsh-wechat-ro#' + CONVERSATION_NAMESPACE + '/' + name + 'Result', create: () => conversationResultSchemaFor(name) },
    };
  }
  const CONVERSATION_CONTRIBUTION = { package: 'dsh-wechat-ro', descriptors: CONVERSATION_METHOD_NAMES.map(conversationDescriptorFor) };
  return {
    CONVERSATION_NAMESPACE, CONVERSATION_ERROR_CODES, CONVERSATION_ACTION_NAMES,
    CONVERSATION_METHOD_SPECS, CONVERSATION_METHOD_NAMES, CONVERSATION_CONTRIBUTION,
    conversationRequestSchemaFor, conversationResultSchemaFor, conversationDescriptorFor,
    getStateRequestSchema, archiveQuerySchema, actionSchema, stateSchema, qrSchema, actionResultSchema, taskWire,
  };
}

const wire = createConversationWire(z);
export const CONVERSATION_NAMESPACE = wire.CONVERSATION_NAMESPACE;
export const CONVERSATION_ERROR_CODES = wire.CONVERSATION_ERROR_CODES;
export const CONVERSATION_ACTION_NAMES = wire.CONVERSATION_ACTION_NAMES;
export const CONVERSATION_METHOD_SPECS = wire.CONVERSATION_METHOD_SPECS;
export const CONVERSATION_METHOD_NAMES = wire.CONVERSATION_METHOD_NAMES;
export const CONVERSATION_CONTRIBUTION = wire.CONVERSATION_CONTRIBUTION;
export const conversationRequestSchemaFor = wire.conversationRequestSchemaFor;
export const conversationResultSchemaFor = wire.conversationResultSchemaFor;
export const conversationDescriptorFor = wire.conversationDescriptorFor;
export const getStateRequestSchema = wire.getStateRequestSchema;
export const archiveQuerySchema = wire.archiveQuerySchema;
export const actionSchema = wire.actionSchema;
export const stateSchema = wire.stateSchema;
export const qrSchema = wire.qrSchema;
export const actionResultSchema = wire.actionResultSchema;
export const TASK_WIRE = wire.taskWire;
