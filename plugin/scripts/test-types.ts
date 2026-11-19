// Compile-only consumer checks against published .d.ts files, not declaration sources.
import { WechatRoService, REMOTE_METHOD_DESCRIPTOR } from 'dsh-wechat-ro/controller';
import type { PageResult, StatusResult, TimelineResult, ExportPayload } from 'dsh-wechat-ro/controller';
import { apply as clientApply } from 'dsh-wechat-ro/client';
import { TYPERT } from 'dsh-wechat-ro/typert';
import { TYPERT_REMOTE } from 'dsh-wechat-ro/remote';
import { inject } from 'dsh-wechat-ro';
import { descriptorFor, METHOD_SPECS, requestSchemaFor } from 'dsh-wechat-ro/wire';
import { createWechatChannelClient, WechatChannelError, WECHAT_CHANNEL_PROVIDER, WECHAT_CHANNEL_ENDPOINTS, CHANNEL_LOGIN_PHASES } from 'dsh-wechat-ro/channel';
import type { WechatChannelClient, WechatChannelFetcher, WechatChannelStatus, WechatChannelLoginResult, ChannelLoginPhase, WechatChannelErrorCode } from 'dsh-wechat-ro/channel';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type StatusIsSynchronous = Expect<Equal<ReturnType<WechatRoService['status']>, StatusResult>>;
type PageIsSynchronous = Expect<Equal<ReturnType<WechatRoService['messages']>, PageResult>>;
type TimelineIsSynchronous = Expect<Equal<ReturnType<WechatRoService['timeline']>, TimelineResult>>;
type ExportIsSynchronous = Expect<Equal<ReturnType<WechatRoService['buildExport']>, ExportPayload>>;
type ClientOwnerDisposes = Expect<Equal<Awaited<ReturnType<typeof clientApply>>, void>>;

declare const service: WechatRoService;
const status: StatusResult = service.status();
const page: PageResult = service.messages({ session: 'synthetic', offset: 50, limit: 50 });
const flags: readonly boolean[] = [page.has_more, page.scan_complete, page.total_is_exact];
const captured: string | null = status.captured_at;
const marker: '@deepseek-ai/dsh-typert-protocol/remote-methods' = REMOTE_METHOD_DESCRIPTOR;
const sessionService: 'workingDirectory' = inject[3];
const ownerResult: Promise<void> = clientApply({});
const hostCodec = TYPERT.invocations[0]!.result;
const remoteCodec = TYPERT_REMOTE.descriptors[0]!.result;
if (hostCodec.mode === 'strict') hostCodec.create();
if (remoteCodec.mode === 'strict') remoteCodec.create();
const spec = METHOD_SPECS[0]!;
descriptorFor(spec).result.create().safeParse({});
requestSchemaFor(spec).safeParse({});

// @ts-expect-error Direct Host calls are not promises.
service.status().then(() => {});
// @ts-expect-error Request field types are not unknown.
service.messages({ limit: '50' });
// @ts-expect-error Unknown request properties are rejected.
service.contacts({ offset: 50 });
// @ts-expect-error Only implemented formats are public.
service.buildExport({ format: 'xml' });
// @ts-expect-error Client lifecycle is owned by the mounted context.
const disposer: Promise<() => Promise<void>> = clientApply({});

// The optional HTTP adapter is a separate public export, not a new Remote method.
const channelFetcher: WechatChannelFetcher = (url, init) => fetch(url, init);
const channel: WechatChannelClient = createWechatChannelClient(channelFetcher);
const disabledChannel: WechatChannelClient = createWechatChannelClient();
const channelSignal = new AbortController().signal;
const channelStatus: Promise<WechatChannelStatus> = channel.getStatus(channelSignal);
const channelBegin: Promise<WechatChannelLoginResult> = channel.beginLogin(channelSignal);
const channelVerify: Promise<WechatChannelLoginResult> = channel.submitVerifyCode('synthetic-code', channelSignal);
const channelLogout: Promise<WechatChannelLoginResult> = channel.logout(channelSignal);
const channelQr: Promise<Blob | null> = channel.readQrImage(channelSignal);
const channelPhases: readonly ChannelLoginPhase[] = CHANNEL_LOGIN_PHASES;
const channelPackage: 'dsh-channel-wechat' = WECHAT_CHANNEL_PROVIDER.package;
const channelVersion: '0.2.8' = WECHAT_CHANNEL_PROVIDER.reviewedVersion;
const channelLoginPath: '/api/channel-wechat/login' = WECHAT_CHANNEL_ENDPOINTS.login;
const channelError = new WechatChannelError('unauthorized', 401);
const channelErrorCode: WechatChannelErrorCode = channelError.code;
const channelErrorStatus: number | undefined = channelError.status;
type ChannelStatusIsAsync = Expect<Equal<ReturnType<WechatChannelClient['getStatus']>, Promise<WechatChannelStatus>>>;
type ChannelQrIsNullableBlob = Expect<Equal<ReturnType<WechatChannelClient['readQrImage']>, Promise<Blob | null>>>;
type ChannelDoesNotVerifyMessaging = Expect<Equal<WechatChannelStatus['messagingVerified'], false>>;
type ChannelMethodsOnly = Expect<Equal<keyof WechatChannelClient, 'getStatus' | 'beginLogin' | 'submitVerifyCode' | 'logout' | 'readQrImage'>>;

// @ts-expect-error There is no fabricated public message-sending endpoint.
channel.sendMessage('synthetic-peer', 'synthetic-text');
// @ts-expect-error An arbitrary endpoint/config object is not a transport.
createWechatChannelClient({ baseUrl: 'https://invalid.example' });
// @ts-expect-error Verification codes are strings; no coercion is promised.
channel.submitVerifyCode(123456);
// @ts-expect-error Cancellation uses AbortSignal, not a string.
channel.getStatus('abort');
declare const projectedChannelStatus: WechatChannelStatus;
// @ts-expect-error Account identifiers are intentionally not projected.
projectedChannelStatus.accountId;
// @ts-expect-error Raw upstream QR URLs are intentionally not projected.
projectedChannelStatus.qrcodeUrl;
// @ts-expect-error Login state must not be re-labelled as verified messaging.
const messagingReady: true = projectedChannelStatus.messagingVerified;
// @ts-expect-error Status projection is immutable to consumers.
projectedChannelStatus.hasStoredLogin = true;
// @ts-expect-error Only the bounded, redacted error taxonomy is public.
new WechatChannelError('raw-upstream-error');

export type { StatusIsSynchronous, PageIsSynchronous, TimelineIsSynchronous, ExportIsSynchronous, ClientOwnerDisposes,
  ChannelStatusIsAsync, ChannelQrIsNullableBlob, ChannelDoesNotVerifyMessaging, ChannelMethodsOnly };
void [flags, captured, marker, sessionService, ownerResult, disabledChannel, channelStatus, channelBegin,
  channelVerify, channelLogout, channelQr, channelPhases, channelPackage, channelVersion, channelLoginPath,
  channelErrorCode, channelErrorStatus];

// Self-owned Weixin modules are server-only and opt-in, not new wechatRo methods.
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import { createWeixinApi, WeixinApiError, WEIXIN_API_INFO, WEIXIN_LIMITS } from 'dsh-wechat-ro/weixin-api';
import type { WeixinApi, WeixinApiFetcher, WeixinCredentials, WeixinUpdatesDiagnostic } from 'dsh-wechat-ro/weixin-api';
import { createWeixinChannel, validateWeixinState } from 'dsh-wechat-ro/weixin-channel';
import type { WeixinChannel, WeixinStateStore, WeixinChannelState } from 'dsh-wechat-ro/weixin-channel';
import { createDshWeixinChannel, createDshWeixinReply, createWeixinCredentialStore } from 'dsh-wechat-ro/weixin-dsh';
import type { DshWeixinRuntime, DshWeixinReply } from 'dsh-wechat-ro/weixin-dsh';
declare const context: Context;
declare const credentialProvider: CredentialProvider;
declare const pairing: WeixinCredentials;
declare const pairedState: WeixinChannelState;
const apiFetcher: WeixinApiFetcher = (url, init) => fetch(url, init);
const weixinApi: WeixinApi = createWeixinApi({ fetcher: apiFetcher });
const weixinStore: WeixinStateStore = createWeixinCredentialStore(credentialProvider);
const weixinChannel: WeixinChannel = createWeixinChannel({ onTextAccepted: () => { /* Private API fact only; no payload or permission. */ } });
// @ts-expect-error The acceptance observer is a private function, not a caller-supplied boolean grant.
createWeixinChannel({ onTextAccepted: true });
const bridge: DshWeixinReply = createDshWeixinReply(context, { workspace: '/synthetic-workspace' });
const runtime: DshWeixinRuntime = createDshWeixinChannel(context, { enabled: false });
const weixinOrigin: 'https://ilinkai.weixin.qq.com' = WEIXIN_API_INFO.origin;
const textBudget: 4000 = WEIXIN_LIMITS.maxTextBytes;
const apiCancel: Promise<{ readonly accepted: true }> = weixinApi.sendText(pairing, {
  toUserId: 'synthetic-user', contextToken: 'synthetic-context', clientId: 'synthetic-client', text: 'synthetic',
}, channelSignal);
const opaqueLogin = weixinChannel.beginLogin(channelSignal);
const projectedLogin = weixinChannel.pollLogin(undefined, channelSignal);
const grantCommit: Promise<void> = weixinStore.commit(1, { ...pairedState, revision: 2, credentials: null });
const checkedState: WeixinChannelState = validateWeixinState({});
const isolatedText: Promise<string> = bridge.reply('synthetic', { messageId: '1' }, channelSignal);
const closedRuntime: Promise<void> = runtime.dispose();
type WeixinPhaseIsNotMessagingProof = Expect<Equal<Awaited<ReturnType<WeixinChannel['getStatus']>>['messagingVerified'], false>>;
type WeixinStoredPairingIsNullable = Expect<Equal<WeixinChannelState['credentials'], Readonly<WeixinCredentials> | null>>;
type WeixinReplyCleanupIsAsync = Expect<Equal<ReturnType<DshWeixinReply['dispose']>, Promise<void>>>;
// @ts-expect-error No arbitrary API origin or hidden endpoint option.
createWeixinApi({ baseUrl: 'https://invalid.example' });
// @ts-expect-error Missing reply context must not be coerced.
weixinApi.sendText(pairing, { toUserId: 'synthetic-user', clientId: 'synthetic-client', text: 'synthetic' });
// @ts-expect-error Codes are a closed redacted taxonomy, not raw responses.
new WeixinApiError('upstream-secret');
// @ts-expect-error QR status is not itself a persisted pairing.
weixinChannel.confirmPairing('yes');
// @ts-expect-error Forget requires the literal destructive local intent.
weixinChannel.forget(true);
// @ts-expect-error Recovery never retries an uncertain send implicitly.
weixinChannel.discardPending('retry');
// @ts-expect-error Credentials cannot be deleted/reset to revision 1 through CAS.
weixinStore.commit(1, undefined);
// @ts-expect-error Text bridge cannot target an existing session.
createDshWeixinReply(context, { workspace: '/synthetic', sessionId: 'existing-session' });
// @ts-expect-error No tool/sandbox permission widening option.
createDshWeixinChannel(context, { enabled: true, sandboxMode: 'danger-full-access' });
// @ts-expect-error Caller metadata must be the bounded message ID only.
bridge.reply('synthetic', { messageId: '1', botToken: 'secret' });
export type { WeixinPhaseIsNotMessagingProof, WeixinStoredPairingIsNullable, WeixinReplyCleanupIsAsync };
void [weixinOrigin, textBudget, apiCancel, opaqueLogin, projectedLogin, grantCommit, checkedState, isolatedText, closedRuntime];

// Pairing administration is a separate opt-in Cordis entry, not a message API.
import adminPlugin, { apply as adminApply, Config as AdminConfig, createWeixinAdminHandler, WEIXIN_ADMIN_ROUTES, WEIXIN_ADMIN_INFO } from 'dsh-wechat-ro/weixin-admin';
import type { WeixinAdminAction, WeixinAdminContext, WeixinAdminHandler, WeixinAdminStatus, WeixinAdminResult } from 'dsh-wechat-ro/weixin-admin';
declare const adminContext: WeixinAdminContext;
const adminHandler: WeixinAdminHandler = createWeixinAdminHandler({ enabled: false });
const adminLoad: Promise<void> = adminApply(adminContext, { enabled: false, requestTimeoutMs: 40000 });
const adminDefaults: boolean = AdminConfig.parse({}).enabled;
const adminName: 'wechat-ro-weixin-admin' = adminPlugin.name;
const adminAction: WeixinAdminAction = { action: 'beginLogin', confirmation: 'request-qr' };
const adminPoll: WeixinAdminAction = { action: 'pollLogin', verifyCode: 'synthetic-code' };
const adminResponse: Promise<Response> = adminHandler.fetch(new Request('http://synthetic.invalid/api/wechat-ro-weixin/status'));
const adminClose: Promise<void> = adminHandler.dispose();
const adminCap: 4096 = WEIXIN_ADMIN_INFO.maxRequestBytes;
const adminRoutes: readonly string[] = WEIXIN_ADMIN_ROUTES.map(route => route.path);
type AdminLoadIsOwned = Expect<Equal<ReturnType<typeof adminApply>, Promise<void>>>;
type AdminNoMessaging = Expect<Equal<WeixinAdminStatus['messagingEnabled'], false>>;
type AdminNoPolling = Expect<Equal<WeixinAdminStatus['automaticPolling'], false>>;
type AdminHasOnlyFetchAndDispose = Expect<Equal<keyof WeixinAdminHandler, 'fetch' | 'dispose'>>;
declare const adminStatus: WeixinAdminResult<WeixinAdminStatus>;
if (adminStatus.ok) { const verified: false = adminStatus.value.messagingVerified; void verified; }
// @ts-expect-error No browser/serialized injection of a transport or channel dependency.
adminApply(adminContext, { enabled: true, fetcher: apiFetcher });
// @ts-expect-error Management config cannot widen agent permissions or select a workspace.
adminApply(adminContext, { enabled: true, workspace: '/synthetic-workspace' });
// @ts-expect-error Explicit confirmations are literals, not a boolean flag.
const badAdminConfirmation: WeixinAdminAction = { action: 'confirmPairing', confirmation: true };
// @ts-expect-error No send or message polling is part of the management wire protocol.
const badAdminAction: WeixinAdminAction = { action: 'pollOnce' };
// @ts-expect-error Verification codes remain strings without coercion.
const badAdminCode: WeixinAdminAction = { action: 'pollLogin', verifyCode: 1234 };
// @ts-expect-error Untrusted config cannot override host authentication.
createWeixinAdminHandler({ authenticated: true });
// @ts-expect-error The handler exposes no message operation.
adminHandler.sendText('synthetic');
export type { AdminLoadIsOwned, AdminNoMessaging, AdminNoPolling, AdminHasOnlyFetchAndDispose };
void [adminLoad, adminDefaults, adminName, adminAction, adminPoll, adminResponse, adminClose, adminCap, adminRoutes];

import { createTaskAccess, TASK_CONTEXT_SPEC, TASK_PRESET_ID, validateTaskDirectory } from 'dsh-wechat-ro/task-access';
import type { TaskAccess, TaskAccessState, TaskFileRequest, TaskSourceQuery } from 'dsh-wechat-ro/task-access';
import { createTaskSessionBridge, TASK_SESSION_INFO } from 'dsh-wechat-ro/task-session-bridge';
import type { TaskSessionBridge } from 'dsh-wechat-ro/task-session-bridge';
import { inject as taskPolicyInject } from 'dsh-wechat-ro/task-session-agent';
const taskData: TaskAccess = createTaskAccess(context, { sourceRoot: '/synthetic-forbidden-source' });
const taskSession: TaskSessionBridge = createTaskSessionBridge(context, { data: taskData });
const taskState: TaskAccessState = taskData.getState('synthetic-task');
const taskCreate: Promise<string> = taskSession.createConversation('synthetic-context', {
  root: '/synthetic-task-workspace', title: 'Synthetic task', allowWechat: false, confirmation: 'read-and-write-task-workspace',
});
const taskFile: TaskFileRequest = { action: 'edit', reference: 'synthetic-reference', oldString: 'old', newString: 'new' };
const taskSource: TaskSourceQuery = { action: 'session', sourceId: 'synthetic-source-alias', limit: 20 };
const taskPreset: 'dsh-wechat-task-v1' = TASK_PRESET_ID;
const taskSandbox: 'workspace-write' = TASK_SESSION_INFO.sandboxMode;
const taskDomain: 'wechat_task_contexts_v1' = TASK_CONTEXT_SPEC.name;
const taskWorkingDirectory: 'workingDirectory' = taskPolicyInject[3];
const taskMetadataOnlyPath: string = validateTaskDirectory('/synthetic-workspace');
type TaskNoExecution = Expect<Equal<Extract<keyof TaskAccess, 'execute' | 'runCode' | 'sendText' | 'sendMessage'>, never>>;
type TaskCreateIsAsync = Expect<Equal<ReturnType<TaskSessionBridge['createConversation']>, Promise<string>>>;
// @ts-expect-error Task creation requires explicit directory consent.
taskSession.createConversation('context', { root: '/synthetic', title: 'Synthetic', allowWechat: true });
// @ts-expect-error Model data queries cannot add a SID or raw path.
const badTaskSource: TaskSourceQuery = { action: 'session', sourceId: 'alias', sessionId: 'other' };
// @ts-expect-error A file update requires a server-issued reference, not an arbitrary path.
const badTaskWrite: TaskFileRequest = { action: 'write', path: '/arbitrary-file', content: 'text' };
// @ts-expect-error Task construction cannot widen tools or sandbox.
createTaskSessionBridge(context, { data: taskData, sandboxMode: 'danger-full-access' });
// @ts-expect-error Runtime data capabilities are not serialized plugin configuration.
createTaskAccess(context, { fetcher: apiFetcher });
export type { TaskNoExecution, TaskCreateIsAsync };
void [taskState, taskCreate, taskFile, taskSource, taskPreset, taskSandbox, taskDomain, taskWorkingDirectory, taskMetadataOnlyPath];

import { TASK_WIRE } from 'dsh-wechat-ro/conversation-wire';
import type { ConversationState, TaskConversationState, TaskConversationAction, TaskConversationActionResult } from 'dsh-wechat-ro/conversation-wire';
import { WechatConversationService, createConversationRuntime } from 'dsh-wechat-ro/conversation-controller';
declare const ownerConversations: WechatConversationService;
const taskUiState: TaskConversationState = ownerConversations.getConversationState({ kind: 'task', sessionId: 'synthetic-context' });
const oldUiState: ConversationState = ownerConversations.getConversationState({ sessionId: 'synthetic-context' });
const taskUiCreate: TaskConversationAction = { kind: 'task', action: 'createConversation', contextSessionId: 'synthetic-context',
  workspace: { root: '/synthetic-workspace', title: 'Synthetic workspace', allowWechat: false, confirmation: 'read-and-write-task-workspace' } };
const taskUiAction: Promise<TaskConversationActionResult> = ownerConversations.conversationAction(taskUiCreate);
const autoConnectAction: TaskConversationAction = { kind: 'task', action: 'connectConversation', contextSessionId: 'synthetic-context', expectedDirectory: '/synthetic-workspace', confirmation: 'connect-own-wechat-auto-reply' };
const autoConnectResult: Promise<TaskConversationActionResult> = ownerConversations.conversationAction(autoConnectAction);
TASK_WIRE.connectionSetupSchema.safeParse({ root: '/synthetic-workspace', title: 'Synthetic', sessionId: null, phase: 'ready', modelConfigured: false, error: null });
// @ts-expect-error Login-only permission cannot enable model usage, directory access or automatic replies.
const badAutoConsent: TaskConversationAction = { ...autoConnectAction, confirmation: 'network-login' };
// @ts-expect-error The exact displayed directory is required; automatic setup must not guess a workspace.
const badAutoScope: TaskConversationAction = { kind: 'task', action: 'connectConversation', contextSessionId: 'synthetic-context', confirmation: 'connect-own-wechat-auto-reply' };
// @ts-expect-error This action cannot copy or accept pairing credentials.
const badAutoCredentials: TaskConversationAction = { ...autoConnectAction, credentials: {} };
void [autoConnectResult, badAutoConsent, badAutoScope, badAutoCredentials];
const taskRuntimeState: TaskConversationState = createConversationRuntime(context).getState({ kind: 'task' });
const rosterUiAction: TaskConversationAction = { kind: 'task', action: 'prepareSnapshot', contextSessionId: 'synthetic-context', root: '/synthetic-snapshot', confirmation: 'browse-snapshot-roster' };
const textOnceUiAction: TaskConversationAction = { kind: 'task', action: 'pollTextOnce', sessionId: 'synthetic-task', allowSharedContext: true, confirmation: 'poll-one-text-reply' };
const textOnceUiReply: Promise<TaskConversationActionResult> = ownerConversations.conversationAction(textOnceUiAction);
const diagnosticUiAction: TaskConversationAction = { kind: 'task', action: 'diagnoseUpdatesOnce', sessionId: 'synthetic-task', confirmation: 'read-one-wechat-update-diagnostic' };
const diagnosticUiReply: Promise<TaskConversationActionResult> = ownerConversations.conversationAction(diagnosticUiAction);
const diagnosticChannelReply: Promise<WeixinUpdatesDiagnostic> = weixinChannel.diagnoseUpdatesOnce(channelSignal);
const diagnosticApiReply: Promise<WeixinUpdatesDiagnostic> = weixinApi.diagnoseUpdatesOnce(pairing, '', channelSignal);
declare const diagnosticProjection: WeixinUpdatesDiagnostic;
TASK_WIRE.updatesDiagnosticSchema.parse(diagnosticProjection);
TASK_WIRE.updatesDiagnosticResultSchema.parse({ diagnostic: diagnosticProjection });
type DiagnosticResultIsClosed = Expect<Equal<keyof WeixinUpdatesDiagnostic,
  'version' | 'outcome' | 'errorCode' | 'validationField' | 'msgsShape' | 'cursorShape' | 'messageCount' | 'textCount' | 'ignoredCount' | 'httpStatus' | 'businessCode'>>;
// @ts-expect-error Diagnostic confirmation cannot request a reply.
const badDiagnosticConfirmation: TaskConversationAction = { ...diagnosticUiAction, confirmation: 'poll-one-text-reply' };
// @ts-expect-error Diagnostic cannot accept message or pairing contents.
const badDiagnosticContent: TaskConversationAction = { ...diagnosticUiAction, body: 'synthetic-private-content' };
// @ts-expect-error Diagnostic does not expose raw message content.
diagnosticProjection.text;
// @ts-expect-error Diagnostic field categories are closed.
const badDiagnosticField: WeixinUpdatesDiagnostic['validationField'] = 'arbitrary-private-field';
import type { WeixinChannel as OneTextChannel } from 'dsh-wechat-ro/weixin-channel';
declare const oneTextChannel: OneTextChannel;
const textOnceCounts = oneTextChannel.pollTextOnce(new AbortController().signal);
type OneTextReplyLimit = Expect<Equal<Awaited<typeof textOnceCounts>['replied'], 0 | 1>>;
type OneTextRemainingCount = Expect<Equal<Awaited<typeof textOnceCounts>['remaining'], number>>;
// @ts-expect-error A bounded call does not accept a configurable limit or media flag.
oneTextChannel.pollTextOnce({ maxMessages: 2, attachments: true });
// @ts-expect-error One-text Owner permission cannot use continuous polling consent.
const badTextOnceConsent: TaskConversationAction = { kind: 'task', action: 'pollTextOnce', sessionId: 'synthetic-task', allowSharedContext: true, confirmation: 'poll-and-reply' };
// @ts-expect-error A text-once action cannot widen its message count.
const badTextOnceLimit: TaskConversationAction = { kind: 'task', action: 'pollTextOnce', sessionId: 'synthetic-task', allowSharedContext: true, confirmation: 'poll-one-text-reply', maxMessages: 2 };
// @ts-expect-error The ordinary data/sidebar branch has no single-text action.
ownerConversations.conversationAction({ action: 'pollTextOnce', sessionId: 'synthetic-context', allowSharedContext: true, confirmation: 'poll-one-text-reply' });
export type { OneTextReplyLimit, OneTextRemainingCount };
void [textOnceUiReply, textOnceCounts, badTextOnceConsent, badTextOnceLimit];
TASK_WIRE.actionSchema.safeParse(taskUiCreate);
TASK_WIRE.stateSchema.safeParse(taskUiState);
const uiSources: readonly string[] = taskUiState.task?.sources.map(source => source.sourceId) ?? [];
// @ts-expect-error Task creation requires explicit write/read consent, not the old readonly literal.
ownerConversations.conversationAction({ kind: 'task', action: 'createConversation', contextSessionId: 'synthetic-context', confirmation: 'create-readonly-conversation' });
// @ts-expect-error Owner file browsing cannot create or modify a file.
const badUiTaskFile: TaskConversationAction = { kind: 'task', action: 'queryFiles', sessionId: 'synthetic-task', query: { action: 'create', path: 'file.md', content: 'No UI write' } };
// @ts-expect-error Actor strings do not authorize a Task RPC.
ownerConversations.conversationAction({ kind: 'task', action: 'resumeConversation', sessionId: 'synthetic-task', confirmation: 'resume-task-conversation', actor: 'owner' });
// @ts-expect-error Roster permission cannot stand in for model source permission.
const badUiRoster: TaskConversationAction = { kind: 'task', action: 'grantSnapshot', sessionId: 'synthetic-task', root: '/synthetic-snapshot', allConversations: false, talkers: ['synthetic-person'], fromTs: null, toTs: null, allowWechat: false, confirmation: 'browse-snapshot-roster' };
// @ts-expect-error Source queries accept no arbitrary SQL.
const badUiTaskQuery: TaskConversationAction = { kind: 'task', action: 'querySource', sessionId: 'synthetic-task', query: { action: 'sql', query: 'SELECT 1' } };
void [taskUiState, oldUiState, taskUiCreate, taskUiAction, taskRuntimeState, rosterUiAction, uiSources];

import type { TaskHistoricalState, TaskHistoricalTextPermit, TaskHistoricalResult } from 'dsh-wechat-ro/task-access';
const historyState: TaskHistoricalState = taskData.getHistoricalState('synthetic-task');
const historyReview = taskData.reviewHistoricalContext('synthetic-task');
const historyGrant: Promise<TaskHistoricalResult> = taskData.authorizeHistoricalContext('synthetic-task', { reviewId: 'synthetic-review-id', confirmation: 'authorize-reviewed-task-history-text' });
const historyShare: Promise<TaskHistoricalResult> = taskData.shareHistoricalContext('synthetic-task', { historyConsentId: 'synthetic-consent-id', confirmation: 'share-reviewed-task-history-context' });
declare const privateHistoryPermit: TaskHistoricalTextPermit;
const historyReply = taskSession.replyHistorical('synthetic-task', 'Synthetic text', { messageId: 'synthetic-message' }, undefined, privateHistoryPermit);
const historyUiReview: TaskConversationAction = { kind: 'task', action: 'reviewHistoricalContext', sessionId: 'synthetic-task' };
const historyUiRun: TaskConversationAction = { kind: 'task', action: 'pollTextOnce', sessionId: 'synthetic-task', historyConsentId: 'synthetic-consent-id', allowSharedContext: true, confirmation: 'poll-one-text-reply-with-reviewed-history' };
const historyUiRevoke: TaskConversationAction = { kind: 'task', action: 'revokeHistoricalContext', sessionId: 'synthetic-task', revokeId: 'synthetic-revoke-id', confirmation: 'revoke-task-history-context' };
// @ts-expect-error JSON fields cannot create the private capability brand.
const forgedHistoryPermit: TaskHistoricalTextPermit = { sessionId: 'synthetic-task', consentId: 'synthetic-consent-id', runId: 'synthetic-run-id', signal: new AbortController().signal };
// @ts-expect-error Historical sharing cannot borrow a legacy confirmation.
const badHistoryShare: TaskConversationAction = { kind: 'task', action: 'setSharing', sessionId: 'synthetic-task', historyConsentId: 'synthetic-consent-id', allowWechat: true, confirmation: 'share-whole-task-context' };
// @ts-expect-error Historical polling requires its Consent id.
const badHistoryRun: TaskConversationAction = { kind: 'task', action: 'pollTextOnce', sessionId: 'synthetic-task', allowSharedContext: true, confirmation: 'poll-one-text-reply-with-reviewed-history' };
// @ts-expect-error The existing continuous path never accepts a historical capability.
const badHistoricalLoop: TaskConversationAction = { kind: 'task', action: 'startChannel', sessionId: 'synthetic-task', historyConsentId: 'synthetic-consent-id', allowSharedContext: true, confirmation: 'poll-and-reply' };
TASK_WIRE.historicalContextSchema.safeParse(historyState);
void [historyReview, historyGrant, historyShare, historyReply, historyUiReview, historyUiRun, historyUiRevoke, forgedHistoryPermit, badHistoryShare, badHistoryRun, badHistoricalLoop];

import type { TaskFirstTextState, TaskFirstTextPermit, TaskFirstTextResult, TaskFirstTextModelRequest, TaskFirstTextReceipt } from 'dsh-wechat-ro/task-access';
import type { SealedFirstTextModelObservation, SealedFirstTextObservation } from '@deepseek-ai/dsh-agent';
const firstState: TaskFirstTextState = taskData.getFirstTextState('synthetic-task');
const firstModelChoice: TaskFirstTextModelRequest = { provider: 'synthetic', model: 'synthetic-model', confirmation: 'select-first-task-model' };
const firstModelPreparation: TaskFirstTextModelRequest = { ...firstModelChoice, selectionRevision: 1, preparationConfirmation: 'prepare-first-task-model-metadata' };
const firstModelResult: Promise<{ readonly firstTextContext: TaskFirstTextState }> = taskSession.selectFirstTextModel('synthetic-task', firstModelPreparation);
const firstApproval: Promise<TaskFirstTextResult> = taskData.authorizeFirstTextContext('synthetic-task', { reviewId: 'synthetic-review', confirmation: 'authorize-reviewed-first-task-text' });
const firstShare: Promise<TaskFirstTextResult> = taskData.shareFirstTextContext('synthetic-task', { firstTextConsentId: 'synthetic-consent', confirmation: 'share-reviewed-first-task-text' });
const newFirstText: Promise<TaskFirstTextResult> = taskData.allowNewFirstText('synthetic-task', {
  priorRunId: 'synthetic-prior-run', priorConsentId: 'synthetic-prior-consent', confirmation: 'allow-new-first-text-after-unknown',
});
const newFirstUiAction: TaskConversationAction = { kind: 'task', action: 'allowNewFirstText', sessionId: 'synthetic-task',
  priorRunId: 'synthetic-prior-run', priorConsentId: 'synthetic-prior-consent', confirmation: 'allow-new-first-text-after-unknown' };
const newFirstAllowed: boolean = firstState.newInputAllowed;
// @ts-expect-error A new-input decision requires the exact old run and consent IDs.
const missingPriorFirstUiAction: TaskConversationAction = { kind: 'task', action: 'allowNewFirstText', sessionId: 'synthetic-task', confirmation: 'allow-new-first-text-after-unknown' };
// @ts-expect-error The new-input decision does not accept the one-text execution confirmation.
const wrongPriorFirstUiAction: TaskConversationAction = { ...newFirstUiAction, confirmation: 'poll-one-text-reply-with-first-task-text' };
declare const privateFirstPermit: TaskFirstTextPermit;
const firstReply = taskSession.replyFirstText('synthetic-task', 'Synthetic text', { messageId: 'synthetic-message' }, undefined, privateFirstPermit);
const firstUiRun: TaskConversationAction = { kind: 'task', action: 'pollTextOnce', sessionId: 'synthetic-task', firstTextConsentId: 'synthetic-consent', allowSharedContext: true, confirmation: 'poll-one-text-reply-with-first-task-text' };
const firstUiPreparation: TaskConversationAction = { kind: 'task', action: 'selectFirstTextModel', sessionId: 'synthetic-task', ...firstModelPreparation };
declare const firstReceipt: TaskFirstTextReceipt;
const firstReceiptPurpose: 'first-text-once' = firstReceipt.purpose;
type FirstPermitPurpose = Expect<Equal<TaskFirstTextPermit['purpose'], 'first-text-once'>>;
type FirstModelPreparationIsAsync = Expect<Equal<ReturnType<TaskSessionBridge['selectFirstTextModel']>, Promise<{ readonly firstTextContext: TaskFirstTextState }>>>;
// @ts-expect-error Preparing metadata requires the selected Task-model revision.
const badFirstPreparation: TaskFirstTextModelRequest = { ...firstModelChoice, preparationConfirmation: 'prepare-first-task-model-metadata' };
// @ts-expect-error Model selection alone cannot claim a preparation revision.
const badFirstSelection: TaskFirstTextModelRequest = { ...firstModelChoice, selectionRevision: 1 };
// @ts-expect-error A historical private permit cannot authorize the first-text executor.
taskSession.replyFirstText('synthetic-task', 'Synthetic text', { messageId: 'synthetic-message' }, undefined, privateHistoryPermit);
// @ts-expect-error A first-text private permit cannot authorize the historical executor.
taskSession.replyHistorical('synthetic-task', 'Synthetic text', { messageId: 'synthetic-message' }, undefined, privateFirstPermit);
// @ts-expect-error First-text runtime authority cannot be reconstructed from JSON.
const forgedFirstPermit: TaskFirstTextPermit = { purpose: 'first-text-once', sessionId: 'synthetic-task', consentId: 'synthetic-consent', runId: 'synthetic-run', signal: new AbortController().signal };
// @ts-expect-error SDK observations are instance-owned capabilities, not empty JSON objects.
const forgedFirstObservation: SealedFirstTextObservation = {};
// @ts-expect-error SDK model observations cannot be reconstructed from public summaries.
const forgedFirstModelObservation: SealedFirstTextModelObservation = {};
// @ts-expect-error First-text polling cannot borrow historical authorization.
const badFirstUiRun: TaskConversationAction = { kind: 'task', action: 'pollTextOnce', sessionId: 'synthetic-task', historyConsentId: 'synthetic-consent', allowSharedContext: true, confirmation: 'poll-one-text-reply-with-first-task-text' };
// @ts-expect-error First-text authority never enables continuous polling.
const badFirstLoop: TaskConversationAction = { kind: 'task', action: 'startChannel', sessionId: 'synthetic-task', firstTextConsentId: 'synthetic-consent', allowSharedContext: true, confirmation: 'poll-and-reply' };
TASK_WIRE.firstTextContextSchema.safeParse(firstState);
TASK_WIRE.firstTextReceiptSchema.safeParse(firstReceipt);
export type { FirstPermitPurpose, FirstModelPreparationIsAsync };
void [firstState, firstModelChoice, firstModelPreparation, firstModelResult, firstApproval, firstShare, newFirstText, newFirstUiAction, newFirstAllowed, missingPriorFirstUiAction, wrongPriorFirstUiAction, firstReply, firstUiRun, firstUiPreparation, firstReceiptPurpose,
  badFirstPreparation, badFirstSelection, forgedFirstPermit, forgedFirstObservation, forgedFirstModelObservation, badFirstUiRun, badFirstLoop];
