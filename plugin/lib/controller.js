// Host half: the Typert Remote service the browser panel talks to.
//
// One service, nine read-only methods. The Gateway discovers it through
// ctx.reflect.props (Service registration) plus the typertRemote binding that
// TypertRemoteService installs, and the hand-written marker descriptor below.
// Nothing here writes, spawns a process or touches WeChat.

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import {
  METHOD_NAMES,
  NAMESPACE,
  normalizeConfig,
} from './wire.js';
import * as methods from './methods.js';
import { buildExport } from './export.js';
import { WechatConversationService } from './conversation-controller.js';

/** Prototype key the Gateway reads to find exported Remote methods (mirrors @Remote). */
export const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/**
 * Read-only snapshot service.
 *
 * Method signatures stay deliberately plain: the Gateway derives wire names from
 * the declared parameter identifiers, so no destructuring, defaults or rest.
 * `signal` is the optional cancellation parameter and must stay last.
 */
export class WechatRoService extends TypertRemoteService {
  /**
   * @param ctx - the Cordis context.
   * @param config - { snapshotDir, snapshotEnabled, sourceRoot, maxRows } from the plugin row.
   */
  constructor(ctx, config) {
    super(ctx, NAMESPACE);
    const cfg = normalizeConfig(config, process.env.WECHAT_SNAPSHOT_DIR);
    this.snapshotDir = cfg.snapshotDir;
    this.snapshotEnabled = cfg.snapshotEnabled;
    this.sourceRoot = cfg.sourceRoot;
    this.maxRows = cfg.maxRows;
    this.store = methods.createContext(cfg);
    if (typeof ctx.inject === 'function') {
      ctx.inject(['agents', 'sessions', 'tools', 'agentPresets', 'sandboxPolicy', 'storageDomain', 'credentials'], function registerWechatConversation(ctx) {
        // Separate namespace/consumer scope. Never return or await the child Fiber.
        new WechatConversationService(ctx, cfg);
      });
    }
  }

  status(request, signal) {
    signal?.throwIfAborted();
    return methods.status(this.store);
  }

  contacts(request, signal) {
    signal?.throwIfAborted();
    return methods.contacts(this.store, request || {});
  }

  sessions(request, signal) {
    signal?.throwIfAborted();
    return methods.sessions(this.store, request || {});
  }

  messages(request, signal) {
    signal?.throwIfAborted();
    return methods.messages(this.store, request || {});
  }

  searchMessages(request, signal) {
    signal?.throwIfAborted();
    return methods.searchMessages(this.store, request || {});
  }

  timeline(request, signal) {
    signal?.throwIfAborted();
    return methods.timeline(this.store, request || {});
  }

  chatroomMembers(request, signal) {
    signal?.throwIfAborted();
    return methods.chatroomMembers(this.store, request || {});
  }

  sql(request, signal) {
    signal?.throwIfAborted();
    return methods.sql(this.store, request || {});
  }

  buildExport(request, signal) {
    signal?.throwIfAborted();
    this.store.requireConfigured();
    return buildExport(this.store, request || {});
  }
}

// Equivalent of applying @Remote('...') to every method: same frozen shape the
// protocol's own decorator writes, so remoteMethods() and the Gateway both see it.
const MARKERS = METHOD_NAMES.map((method) => Object.freeze({
  method,
  invocation: Object.freeze({ kind: 'direct' }),
}));

Object.defineProperty(WechatRoService.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({ version: 1, methods: Object.freeze(MARKERS) }),
});

export default WechatRoService;
