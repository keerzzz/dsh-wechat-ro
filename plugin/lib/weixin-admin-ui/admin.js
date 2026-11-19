// Manual-only owner management UI. No storage, polling loop, retry, message API,
// QR URL, raw-response rendering, or browser-configurable renderer is used here.
const PHASES = ['disabled', 'unpaired', 'qr-ready', 'awaiting-confirmation', 'paired', 'recovery-required'];
const QR_STATES = ['wait', 'scaned', 'confirmed', 'expired', 'need_verifycode', 'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect'];
const TERMINAL_QR = new Set(['verify_code_blocked', 'scaned_but_redirect', 'binded_redirect']);
const CONFIRMATIONS = Object.freeze({ beginLogin: 'request-qr', confirmPairing: 'persist-pairing', forget: 'forget-local-credentials' });
const ERROR_CODES = new Set(['invalid-options', 'invalid-request', 'invalid-json', 'invalid-input', 'unsupported-media-type',
  'body-too-large', 'not-found', 'method-not-allowed', 'disabled', 'disposed', 'aborted', 'timeout', 'busy', 'not-configured',
  'asset-unavailable', 'registration-failed', 'invalid-state', 'invalid-response', 'store-failed', 'store-outcome-unknown',
  'api-failed', 'already-paired', 'login-active', 'login-required', 'login-not-confirmed', 'not-paired', 'recovery-required',
  'revision-exhausted', 'operation-failed']);

export const UI_TEXT = Object.freeze({
  zh: Object.freeze({
    title: 'WeChat RO · 配对管理', intro: '仅管理本地配对。这里不会收发消息。', language: '语言',
    statusHeading: '当前状态', manualOnly: '打开页面时读取一次；此后只在你点击时更新。',
    phaseLabel: '配对状态', storedLabel: '本地凭据', recoveryLabel: '待恢复记录', messagingLabel: '消息收发',
    messagingOff: '未启用 · 未验证', refresh: '刷新状态', stopWaiting: '停止等待并清理本页',
    pairingHeading: '扫码与保存', pairingIntro: '扫码确认后，还需单独确认保存。已保存配对不代表消息可达。',
    rendererTitle: '二维码渲染器未启用', rendererUnavailable: '本地二维码库尚未获准使用。已禁用发起扫码，不会请求二维码。',
    qrLabel: '微信扫码二维码', qrCaption: '请用微信扫码，然后手动查询扫码状态。不会自动查询。',
    verifyLabel: '验证码', verifyHelp: '仅本次手动查询使用；最多 64 字节，不含空白或控制字符，发送后立即清空。',
    verifyInvalid: '请输入 1–64 字节的有效验证码，不含空白或控制字符。',
    begin: '发起扫码…', poll: '查询扫码状态', pollWithCode: '提交验证码并查询', pair: '保存配对…', cancelLogin: '取消本次扫码…',
    cancelNote: '取消只清理临时配对资料；停止等待或关闭页面不保证撤销服务器已执行的动作。',
    forgetHeading: '忘记本地配对', forgetIntro: '只移除本地凭据，不撤销微信端授权。此操作不能用于跳过待恢复记录。',
    forget: '忘记本地凭据…', forgetReady: '将移除本地保存的这份配对。需要单独确认。', forgetNone: '没有可忘记的本地配对。',
    footer: '仅限所有者管理 · 无自动查询、重试或消息发送', back: '返回，不执行',
    unknown: '尚未核实', present: '已保存', absent: '未保存', recoveryYes: '需要处理', recoveryNo: '无',
    noStatus: '尚未读取状态。', readAt: '状态读取于 ', actionSource: '依据本次动作返回更新；尚未重新读取服务器状态。',
    uncertainSource: '当前状态未核实。请手动刷新；不会自动重试。', loading: '正在读取状态…', working: '正在执行已确认的动作…',
    needStatus: '请先刷新状态，再决定下一步。', disabledHelp: '管理能力未启用。此页不能启用插件或发送消息。',
    unpairedHelp: '尚未配对。发起扫码前需要明确确认。',
    qrHelp: '服务端有进行中的扫码步骤。本页不持有其二维码；可手动查询或取消。',
    confirmationHelp: '微信端已确认，但尚未保存到本地。请单独确认是否保存。',
    pairedHelp: '配对已保存；消息收发仍未启用、未验证。',
    recoveryHelp: '存在待恢复记录。本页不提供丢弃或重试消息，也不能直接忘记凭据。',
    stopped: '已停止本页等待并清理临时资料。服务器动作可能已发生，并未保证回滚。请手动刷新；未自动重试。',
    disposedHelp: '页面已停用，临时资料已清理。若要继续，请重新打开管理页。',
    noRetry: '未自动重试。请手动刷新状态后再决定。', unknownOutcome: '动作结果不确定，可能已生效；不能视为已回滚。',
    saved: '本次动作返回：配对已保存。消息收发仍未启用、未验证。',
    cancelled: '本次动作返回：临时扫码资料已清理。不代表撤销微信端授权。',
    forgotten: '本次动作返回：本地凭据已移除。不代表微信端授权已撤销。',
    beginTitle: '请求本次扫码二维码？', beginDescription: '将向微信服务请求一个二维码。之后仍需手动查询，再单独确认保存；不会收发消息。', beginAccept: '确认请求二维码',
    pairTitle: '保存本次配对到本地？', pairDescription: '微信端已确认。此操作将保存本地凭据，但不会启用或验证消息收发。', pairAccept: '确认保存配对',
    cancelTitle: '取消本次扫码？', cancelDescription: '将请求清理服务端临时配对资料，并立即清理本页二维码和验证码；不撤销微信端授权，也不保证回滚已执行的动作。', cancelAccept: '确认取消扫码',
    forgetTitle: '忘记本地 WeChat RO 配对？', forgetDescription: '将移除本地凭据及关联进度。不会撤销微信端授权；只有明确成功返回才能视为完成。', forgetAccept: '确认忘记本地凭据',
    phases: Object.freeze({ disabled: '已禁用', unpaired: '未配对', 'qr-ready': '扫码进行中', 'awaiting-confirmation': '待本地保存确认', paired: '已保存配对', 'recovery-required': '需恢复' }),
    qr: Object.freeze({ wait: '二维码已准备。等待扫码；请手动查询进度。', scaned: '已扫码，尚未确认。请在微信端确认后手动查询。',
      confirmed: '微信端已确认，尚未保存到本地。请单独确认保存。', expired: '二维码已失效，临时资料已清理。不会自动重新发起。',
      need_verifycode: '需要验证码。填写后点击一次提交并查询。', verify_code_blocked: '验证码受限，未完成配对。请手动取消本次扫码。',
      scaned_but_redirect: '服务要求其他验证流程，未完成配对。本页不会跳转；请手动取消。', binded_redirect: '服务返回绑定跳转状态，不能视为已登录。本页不会跳转；请手动取消。' }),
    errors: Object.freeze({
      'invalid-options': '服务配置无效。', 'invalid-request': '请求格式不被接受。', 'invalid-json': '服务无法读取请求 JSON。',
      'invalid-input': '输入不被接受。', 'unsupported-media-type': '请求内容类型不被接受。', 'body-too-large': '请求超过大小限制。',
      'not-found': '管理接口不存在。', 'method-not-allowed': '管理接口不接受此操作。', disabled: '管理能力已禁用。',
      disposed: '管理服务已停用。', aborted: '服务端中止了等待。', timeout: '服务端等待超时。', busy: '另一个管理操作正在进行。',
      'not-configured': '管理服务尚未配置完成。', 'asset-unavailable': '管理页面资源不可用。', 'registration-failed': '管理接口注册失败。',
      'invalid-state': '本地配对状态无效。', 'invalid-response': '响应格式无效，未采用其中的数据。', 'store-failed': '无法读取本地凭据存储。',
      'store-outcome-unknown': '本地凭据写入结果不确定。', 'api-failed': '微信接口请求失败。', 'already-paired': '已有本地配对。',
      'login-active': '已有进行中的扫码步骤。', 'login-required': '没有进行中的扫码步骤。', 'login-not-confirmed': '微信端尚未确认。',
      'not-paired': '没有本地配对。', 'recovery-required': '存在待恢复记录，操作已被阻止。', 'revision-exhausted': '本地记录版本已达上限。',
      'operation-failed': '管理操作失败。', 'network-error': '网络请求失败。', unauthorized: '当前浏览器未通过认证。',
      forbidden: '当前用户无权访问此管理接口。', 'http-error': '管理接口返回了未识别的错误。',
      rendererUnavailable: '二维码请求后本地渲染失败。二维码已清理；请手动刷新后取消已有扫码步骤。' }),
  }),
  en: Object.freeze({
    title: 'WeChat RO · Pairing management', intro: 'Manage local pairing only. This page never sends or receives messages.', language: 'Language',
    statusHeading: 'Current status', manualOnly: 'Read once on opening. Every later update requires your click.',
    phaseLabel: 'Pairing state', storedLabel: 'Local credentials', recoveryLabel: 'Pending recovery', messagingLabel: 'Messaging',
    messagingOff: 'Disabled · Unverified', refresh: 'Refresh status', stopWaiting: 'Stop waiting and clear this page',
    pairingHeading: 'Scan and save', pairingIntro: 'After scan confirmation, saving requires a separate action. Saved pairing does not prove message delivery.',
    rendererTitle: 'QR renderer not enabled', rendererUnavailable: 'A local QR library has not been approved. Starting a scan is disabled; no QR request will be made.',
    qrLabel: 'WeChat pairing QR code', qrCaption: 'Scan in WeChat, then check the scan status manually. There is no automatic check.',
    verifyLabel: 'Verification code', verifyHelp: 'Used for this manual check only. Maximum 64 bytes, no whitespace or control characters. Cleared immediately on submission.',
    verifyInvalid: 'Enter a valid 1–64 byte code without whitespace or control characters.',
    begin: 'Start a scan…', poll: 'Check scan status', pollWithCode: 'Submit code and check', pair: 'Save pairing…', cancelLogin: 'Cancel this scan…',
    cancelNote: 'Cancel clears temporary pairing data only. Stopping a wait or closing the page cannot guarantee rollback of server actions.',
    forgetHeading: 'Forget local pairing', forgetIntro: 'Removes local credentials only, not authorization in WeChat. It cannot bypass pending recovery.',
    forget: 'Forget local credentials…', forgetReady: 'Remove this locally saved pairing. A separate confirmation is required.', forgetNone: 'There is no local pairing to forget.',
    footer: 'Owner management only · No automatic checks, retries, or messages', back: 'Go back, do nothing',
    unknown: 'Not verified', present: 'Saved', absent: 'Not saved', recoveryYes: 'Action required', recoveryNo: 'None',
    noStatus: 'Status has not been read.', readAt: 'Status read at ', actionSource: 'Updated from this action result; server status has not been read again.',
    uncertainSource: 'Current status is unverified. Refresh manually; there is no automatic retry.', loading: 'Reading status…', working: 'Performing the confirmed action…',
    needStatus: 'Refresh status before deciding what to do next.', disabledHelp: 'Management is disabled. This page cannot enable the plugin or send messages.',
    unpairedHelp: 'Not paired. Requesting a QR code requires explicit confirmation.',
    qrHelp: 'A scan is in progress on the server. This page does not hold its QR code; check or cancel manually.',
    confirmationHelp: 'Confirmed in WeChat, but not saved locally. Decide separately whether to save.',
    pairedHelp: 'Pairing is saved. Messaging is still disabled and unverified.',
    recoveryHelp: 'A recovery record is pending. This page cannot discard or retry messages, or directly forget credentials.',
    stopped: 'Stopped waiting and cleared temporary page data. Server actions may have occurred; rollback is not guaranteed. Refresh manually. No automatic retry.',
    disposedHelp: 'This page is inactive and temporary data is cleared. Reopen the management page to continue.',
    noRetry: 'No automatic retry. Refresh status manually before deciding.', unknownOutcome: 'The action outcome is unknown and may have taken effect. Do not assume rollback.',
    saved: 'This action returned: pairing saved. Messaging remains disabled and unverified.',
    cancelled: 'This action returned: temporary scan data cleared. This does not revoke authorization in WeChat.',
    forgotten: 'This action returned: local credentials removed. Authorization in WeChat has not been revoked by this action.',
    beginTitle: 'Request a QR code for this scan?', beginDescription: 'Request one QR code from WeChat. You must then check manually and confirm saving separately. No messages will be sent or received.', beginAccept: 'Confirm QR request',
    pairTitle: 'Save this pairing locally?', pairDescription: 'WeChat has confirmed the scan. This stores local credentials, but does not enable or verify messaging.', pairAccept: 'Confirm save pairing',
    cancelTitle: 'Cancel this scan?', cancelDescription: 'Request clearing of temporary server pairing data and immediately clear this page’s QR and code. This does not revoke WeChat authorization or guarantee rollback of issued actions.', cancelAccept: 'Confirm cancel scan',
    forgetTitle: 'Forget local WeChat RO pairing?', forgetDescription: 'Remove local credentials and associated progress. Authorization in WeChat is not revoked. Only an explicit success response establishes completion.', forgetAccept: 'Confirm forget local credentials',
    phases: Object.freeze({ disabled: 'Disabled', unpaired: 'Not paired', 'qr-ready': 'Scan in progress', 'awaiting-confirmation': 'Awaiting local save confirmation', paired: 'Pairing saved', 'recovery-required': 'Recovery required' }),
    qr: Object.freeze({ wait: 'QR ready. Waiting for a scan; check progress manually.', scaned: 'Scanned, not yet confirmed. Confirm in WeChat, then check manually.',
      confirmed: 'Confirmed in WeChat, not saved locally. Confirm saving separately.', expired: 'QR expired; temporary data is cleared. No new scan will start automatically.',
      need_verifycode: 'A verification code is required. Enter it and click once to submit and check.', verify_code_blocked: 'Verification is blocked; pairing is not complete. Cancel this scan manually.',
      scaned_but_redirect: 'The service requires another verification flow; pairing is not complete. This page will not redirect. Cancel manually.', binded_redirect: 'The service returned a binding redirect, not proof of login. This page will not redirect. Cancel manually.' }),
    errors: Object.freeze({
      'invalid-options': 'Service configuration is invalid.', 'invalid-request': 'The request format was rejected.', 'invalid-json': 'The service could not read the request JSON.',
      'invalid-input': 'The input was rejected.', 'unsupported-media-type': 'The request content type was rejected.', 'body-too-large': 'The request exceeds the size limit.',
      'not-found': 'The management endpoint was not found.', 'method-not-allowed': 'The endpoint does not accept this operation.', disabled: 'Management is disabled.',
      disposed: 'The management service is inactive.', aborted: 'The server stopped waiting.', timeout: 'The server timed out.', busy: 'Another management operation is running.',
      'not-configured': 'Management is not fully configured.', 'asset-unavailable': 'A management asset is unavailable.', 'registration-failed': 'Management route registration failed.',
      'invalid-state': 'Local pairing state is invalid.', 'invalid-response': 'The response format is invalid. Its data was not used.', 'store-failed': 'Local credential storage could not be read.',
      'store-outcome-unknown': 'The local credential write outcome is unknown.', 'api-failed': 'The WeChat API request failed.', 'already-paired': 'A local pairing already exists.',
      'login-active': 'A scan is already in progress.', 'login-required': 'No scan is in progress.', 'login-not-confirmed': 'WeChat has not confirmed the scan.',
      'not-paired': 'There is no local pairing.', 'recovery-required': 'Pending recovery blocks this operation.', 'revision-exhausted': 'The local record revision limit was reached.',
      'operation-failed': 'The management operation failed.', 'network-error': 'The network request failed.', unauthorized: 'This browser is not authenticated.',
      forbidden: 'This user is not allowed to access management.', 'http-error': 'The management endpoint returned an unrecognized error.',
      rendererUnavailable: 'Local rendering failed after the QR request. The QR is cleared. Refresh manually, then cancel the existing scan.' }),
  }),
});

class UiFailure extends Error {
  constructor(code, outcomeUnknown = false) {
    super('Management request failed.');
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function bounded(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.isWellFormed() && new TextEncoder().encode(value).length <= limit;
}
async function readResult(response, action) {
  if (response.status === 401) throw new UiFailure('unauthorized');
  const forbidden = response.status === 403;
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
    throw new UiFailure(forbidden ? 'forbidden' : 'invalid-response', action !== 'status');
  }
  let envelope;
  try { envelope = await response.json(); } catch { throw new UiFailure(forbidden ? 'forbidden' : 'invalid-response', action !== 'status'); }
  if (exact(envelope, ['ok', 'error']) && envelope.ok === false && exact(envelope.error, ['code', 'outcomeUnknown'])
      && ERROR_CODES.has(envelope.error.code) && typeof envelope.error.outcomeUnknown === 'boolean') {
    throw new UiFailure(envelope.error.code, envelope.error.outcomeUnknown || envelope.error.code === 'store-outcome-unknown');
  }
  if (!response.ok) throw new UiFailure(forbidden ? 'forbidden' : 'http-error', action !== 'status');
  if (!exact(envelope, ['ok', 'value']) || envelope.ok !== true) throw new UiFailure('invalid-response', action !== 'status');
  const value = envelope.value;
  let valid;
  if (action === 'status') {
    valid = exact(value, ['enabled', 'phase', 'hasStoredLogin', 'pendingRecovery', 'messagingVerified', 'messagingEnabled', 'automaticPolling'])
      && typeof value.enabled === 'boolean' && PHASES.includes(value.phase) && value.enabled === (value.phase !== 'disabled')
      && typeof value.hasStoredLogin === 'boolean' && typeof value.pendingRecovery === 'boolean'
      && value.messagingVerified === false && value.messagingEnabled === false && value.automaticPolling === false;
  } else if (action === 'beginLogin') valid = exact(value, ['qrContent']) && bounded(value.qrContent, 8192);
  else if (action === 'pollLogin') valid = exact(value, ['status']) && QR_STATES.includes(value.status);
  else if (action === 'confirmPairing') valid = exact(value, ['paired']) && value.paired === true;
  else valid = value === null;
  if (!valid) throw new UiFailure('invalid-response', action !== 'status');
  return value;
}

const mounted = new WeakMap();
/**
 * Trusted same-process composition seam, NOT browser/plugin configuration.
 * renderQr(canvas, qrContent) must synchronously draw with an approved local library
 * and return undefined. No default implementation exists or is auto-discovered.
 * The browser entry below never injects it. Test renderers are synthetic, not QR codes.
 */
export function createWeixinAdminUi(root, { fetcher = (url, init) => globalThis.fetch(url, init), renderQr = null, moduleUrl = import.meta.url } = {}) {
  mounted.get(root)?.dispose();
  const doc = root.ownerDocument, win = doc.defaultView;
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, root.querySelector('#' + id));
    return elements.get(id);
  };
  const urls = { status: new URL('./status', moduleUrl).href, action: new URL('./action', moduleUrl).href };
  let locale = 'zh', view = null, source = 'initial', lastRead = '', qrState = null;
  let active = null, generation = 0, disposed = false, pendingAction = null, trigger = null;
  let rendererReady = typeof renderQr === 'function', qrVisible = false, verifyNeeded = false, invalidVerify = false, feedback = null;
  const removeListeners = [];
  const text = key => UI_TEXT[locale][key];
  const isCurrent = op => !disposed && active === op && generation === op.generation && !op.controller.signal.aborted;
  const loginActive = () => view?.phase === 'qr-ready' || view?.phase === 'awaiting-confirmation';
  function clearTransient() {
    qrVisible = false;
    verifyNeeded = false;
    invalidVerify = false;
    el('verify-code').value = '';
    // Resetting the bitmap clears pixels and the drawing context, not merely visibility.
    el('qr-canvas').width = 256;
    el('qr-canvas').height = 256;
  }
  function allowed(action) {
    if (disposed || active || pendingAction) return false;
    if (action === 'status') return true;
    if (!view?.enabled || view.pendingRecovery) return false;
    if (action === 'beginLogin') return rendererReady && view.phase === 'unpaired';
    if (action === 'pollLogin') return view.phase === 'qr-ready' && !TERMINAL_QR.has(qrState);
    if (action === 'confirmPairing') return view.phase === 'awaiting-confirmation';
    if (action === 'cancelLogin') return loginActive();
    return action === 'forget' && view.phase === 'paired' && view.hasStoredLogin;
  }
  function renderDialog() {
    if (!pendingAction) return;
    const prefix = { beginLogin: 'begin', confirmPairing: 'pair', cancelLogin: 'cancel', forget: 'forget' }[pendingAction];
    el('confirmation-title').textContent = text(prefix + 'Title');
    el('confirmation-description').textContent = text(prefix + 'Description');
    el('confirmation-accept').textContent = text(prefix + 'Accept');
    el('confirmation-accept').className = pendingAction === 'forget' ? 'danger' : 'primary';
  }
  function render() {
    doc.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    el('language').value = locale;
    doc.title = text('title');
    for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = text(node.dataset.i18n);
    el('qr-canvas').setAttribute('aria-label', text('qrLabel'));
    el('phase').textContent = view ? text('phases')[view.phase] : text('unknown');
    el('stored').textContent = view ? text(view.hasStoredLogin ? 'present' : 'absent') : text('unknown');
    el('recovery').textContent = view ? text(view.pendingRecovery ? 'recoveryYes' : 'recoveryNo') : text('unknown');
    el('status-source').textContent = source === 'read' ? text('readAt') + lastRead : text(source === 'action' ? 'actionSource' : source === 'initial' ? 'noStatus' : 'uncertainSource');
    const help = { disabled: 'disabledHelp', unpaired: 'unpairedHelp', 'qr-ready': 'qrHelp', 'awaiting-confirmation': 'confirmationHelp', paired: 'pairedHelp', 'recovery-required': 'recoveryHelp' };
    el('pairing-help').textContent = disposed ? text('disposedHelp') : qrState ? text('qr')[qrState] : text(view ? help[view.phase] : 'needStatus');
    el('renderer-notice').hidden = rendererReady;
    el('qr-panel').hidden = !qrVisible;
    el('verify-field').hidden = !verifyNeeded;
    el('verify-error').hidden = !invalidVerify;
    el('verify-error').textContent = invalidVerify ? text('verifyInvalid') : '';
    el('verify-code').setAttribute('aria-invalid', String(invalidVerify));
    el('verify-code').disabled = disposed || !!active;
    el('poll').textContent = text(verifyNeeded ? 'pollWithCode' : 'poll');
    for (const [id, action] of Object.entries({ refresh: 'status', begin: 'beginLogin', poll: 'pollLogin', pair: 'confirmPairing', 'cancel-login': 'cancelLogin', forget: 'forget' })) {
      el(id).disabled = !allowed(action);
    }
    el('poll').hidden = view?.phase !== 'qr-ready';
    el('pair').hidden = view?.phase !== 'awaiting-confirmation';
    el('cancel-login').hidden = !loginActive();
    el('begin').hidden = loginActive() || view?.phase === 'paired' || view?.phase === 'recovery-required';
    el('stop-waiting').hidden = !active;
    el('stop-waiting').disabled = disposed;
    el('progress').textContent = active ? text(active.action === 'status' ? 'loading' : 'working') : '';
    root.setAttribute('aria-busy', String(!!active));
    el('forget-help').textContent = text(!view ? 'needStatus' : view.pendingRecovery ? 'recoveryHelp' : !view.enabled ? 'disabledHelp' : view.hasStoredLogin ? 'forgetReady' : 'forgetNone');
    el('feedback').hidden = !feedback;
    el('feedback').dataset.kind = feedback?.code ? 'error' : 'info';
    el('feedback').textContent = !feedback ? '' : feedback.code
      ? text('errors')[feedback.code] + ' ' + (feedback.outcomeUnknown ? text('unknownOutcome') + ' ' : '') + text('noRetry') : text(feedback.key);
    renderDialog();
  }
  function updateFromAction(action, value) {
    source = 'action';
    if (action === 'beginLogin') {
      try {
        // The ONLY QR rendering seam. Never put qrContent in the DOM or a URL.
        if (renderQr(el('qr-canvas'), value.qrContent) !== undefined) throw new UiFailure('rendererUnavailable', true);
      } catch { rendererReady = false; throw new UiFailure('rendererUnavailable', true); }
      finally { value.qrContent = ''; }
      qrVisible = true;
      qrState = 'wait';
      view = { ...view, phase: 'qr-ready' };
    } else if (action === 'pollLogin') {
      qrState = value.status;
      el('verify-code').value = '';
      invalidVerify = false;
      verifyNeeded = qrState === 'need_verifycode';
      if (qrState === 'confirmed' || qrState === 'expired' || TERMINAL_QR.has(qrState)) clearTransient();
      if (qrState === 'confirmed') view = { ...view, phase: 'awaiting-confirmation' };
      if (qrState === 'expired') view = { ...view, phase: 'unpaired' }; // Handler cancels expired attempts before returning.
    } else {
      clearTransient();
      qrState = null;
      if (action === 'confirmPairing') {
        view = { ...view, phase: 'paired', hasStoredLogin: true, pendingRecovery: false };
        feedback = { key: 'saved' };
      } else if (action === 'forget') {
        view = { ...view, phase: 'unpaired', hasStoredLogin: false, pendingRecovery: false };
        feedback = { key: 'forgotten' };
      } else {
        view = { ...view, phase: view.hasStoredLogin ? 'paired' : 'unpaired' };
        feedback = { key: 'cancelled' };
      }
    }
  }
  async function request(action, payload) {
    if (!allowed(action)) return;
    const op = { generation: ++generation, controller: new AbortController(), action };
    active = op;
    feedback = null;
    render();
    try {
      const init = { method: action === 'status' ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
        mode: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer', signal: op.controller.signal,
        headers: { Accept: 'application/json' } };
      if (payload) {
        init.headers['Content-Type'] = 'application/json';
        init.headers['X-Wechat-Management'] = '1';
        init.body = JSON.stringify(payload);
        if (Object.hasOwn(payload, 'verifyCode')) payload.verifyCode = '';
      }
      const response = await fetcher(action === 'status' ? urls.status : urls.action, init);
      if (!isCurrent(op)) return;
      const value = await readResult(response, action);
      if (!isCurrent(op)) return;
      if (action === 'status') {
        view = value;
        source = 'read';
        lastRead = new Date().toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false });
        // A status snapshot has no attempt identifier: do not keep an older QR/code.
        clearTransient();
        qrState = null;
      } else updateFromAction(action, value);
    } catch (error) {
      if (!isCurrent(op)) return;
      clearTransient();
      view = null;
      qrState = null;
      source = 'unknown';
      feedback = error instanceof UiFailure ? { code: error.code, outcomeUnknown: error.outcomeUnknown }
        : { code: 'network-error', outcomeUnknown: action !== 'status' };
    } finally {
      if (isCurrent(op)) {
        active = null;
        render();
        if (action !== 'status') {
          const focusId = feedback?.code ? 'refresh' : verifyNeeded ? 'verify-code'
            : view?.phase === 'awaiting-confirmation' ? 'pair' : view?.phase === 'qr-ready' ? 'poll' : 'refresh';
          el(focusId).focus();
        }
      }
    }
  }
  function closeConfirmation() {
    pendingAction = null;
    if (el('confirmation-dialog').open) el('confirmation-dialog').close();
    render();
    trigger?.focus();
    trigger = null;
  }
  function openConfirmation(action, target) {
    if (!allowed(action)) return;
    pendingAction = action;
    trigger = target;
    render();
    el('confirmation-dialog').showModal();
    el('confirmation-back').focus();
  }
  function submitConfirmed() {
    const action = pendingAction;
    closeConfirmation();
    if (!allowed(action)) return;
    clearTransient();
    const payload = { action };
    if (Object.hasOwn(CONFIRMATIONS, action)) payload.confirmation = CONFIRMATIONS[action];
    void request(action, payload);
  }
  function poll() {
    if (!allowed('pollLogin')) return;
    const payload = { action: 'pollLogin' };
    if (verifyNeeded) {
      const value = el('verify-code').value;
      if (!bounded(value, 64) || /[\u0000-\u0020\u007f]/u.test(value)) {
        invalidVerify = true;
        render();
        el('verify-code').focus();
        return;
      }
      payload.verifyCode = value;
    }
    el('verify-code').value = '';
    invalidVerify = false;
    void request('pollLogin', payload);
  }
  function stopWaiting() {
    if (!active || disposed) return;
    ++generation;
    active.controller.abort();
    active = null;
    clearTransient();
    view = null;
    qrState = null;
    source = 'unknown';
    feedback = { key: 'stopped' };
    render();
    el('refresh').focus();
  }
  function listen(target, type, handler) {
    target.addEventListener(type, handler);
    removeListeners.push(() => target.removeEventListener(type, handler));
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    ++generation;
    active?.controller.abort();
    active = null;
    pendingAction = null;
    trigger = null;
    clearTransient();
    view = null;
    qrState = null;
    source = 'unknown';
    feedback = { key: 'disposedHelp' };
    for (const remove of removeListeners) remove();
    if (el('confirmation-dialog').open) el('confirmation-dialog').close();
    render();
    if (mounted.get(root) === api) mounted.delete(root);
  }
  const api = Object.freeze({ dispose });
  mounted.set(root, api);
  listen(el('language'), 'change', () => { locale = el('language').value === 'en' ? 'en' : 'zh'; render(); });
  listen(el('refresh'), 'click', () => { void request('status'); });
  for (const [id, action] of Object.entries({ begin: 'beginLogin', pair: 'confirmPairing', 'cancel-login': 'cancelLogin', forget: 'forget' })) {
    listen(el(id), 'click', () => openConfirmation(action, el(id)));
  }
  listen(el('poll'), 'click', poll);
  listen(el('stop-waiting'), 'click', stopWaiting);
  listen(el('confirmation-back'), 'click', closeConfirmation);
  listen(el('confirmation-accept'), 'click', submitConfirmed);
  listen(el('confirmation-dialog'), 'cancel', event => { event.preventDefault(); closeConfirmation(); });
  listen(el('confirmation-dialog'), 'keydown', event => {
    if (event.key !== 'Tab') return;
    const back = el('confirmation-back'), accept = el('confirmation-accept');
    if (event.shiftKey && doc.activeElement === back) { event.preventDefault(); accept.focus(); }
    else if (!event.shiftKey && doc.activeElement === accept) { event.preventDefault(); back.focus(); }
  });
  listen(win, 'pagehide', dispose);
  render();
  void request('status'); // The only automatic request. No action or retry follows it.
  return api;
}

if (typeof document !== 'undefined') {
  const root = document.getElementById('weixin-admin');
  if (root) createWeixinAdminUi(root); // Always rendererUnavailable in the browser default.
}
