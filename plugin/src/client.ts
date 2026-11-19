// Typed contract for the browser half (lib/client.js).
//
// The bundle is a standalone lazy-CJS artifact registered through
// window.__ModuleLoader__.load({ id, factory }). It mounts its own Remote
// contribution with ctx.remote.$mount and then contributes the sidebar entry,
// the main panel, the tool result cards and the plugin config card.

import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol';

/** A Remote contribution the browser half mounts on the Host gateway. */
export interface RemoteContribution {
  readonly package: string;
  readonly descriptors: readonly InvocationDescriptor[];
}

/** The contribution this bundle mounts. */
export declare const CONTRIBUTION: RemoteContribution;

/** Wire tool names that get a custom card. */
export declare const WIRE_TOOL_NAMES: readonly string[];

/** Remote method names. */
export declare const METHOD_NAMES: readonly string[];

/** Dictionaries shipped inside the bundle (kept in sync with locale/*.json). */
export declare const __i18n: { readonly zh: Record<string, unknown>; readonly en: Record<string, unknown> };

/** The strict authenticated UI namespace, mounted alongside legacy methods. */
export declare const CONVERSATION_NAMESPACE: 'wechatConversation';
export declare const CONVERSATION_TAB_ID: 'dsh-wechat-ro/conversation';
export declare const CONVERSATION_TAB_KIND: 'wechat-ro-conversation';
/** Non-sensitive revision for the native current-Session data sidebar. */
export declare const DATA_SIDEBAR_REVISION: 'current-sse-data-v1';
export declare const CONVERSATION_CONTRIBUTION: import('./conversation-wire.js').ConversationContribution;
export declare const CONVERSATION_METHOD_NAMES: readonly import('./conversation-wire.js').ConversationMethod[];
export declare const __conversationWire: import('./conversation-wire.js').ConversationWire;
export declare const __conversationI18n: Readonly<Record<'zh' | 'en', Readonly<Record<string, string>>>>;
export declare const __taskI18n: Readonly<Record<'zh' | 'en', Readonly<Record<string, string>>>>;

/** Cordis client plugin marker. */
export declare const isPlugin: true;

/** Client services this bundle injects. */
export declare const inject: readonly ['remote', 'slots', 'locale', 'layout'];

/**
 * Mount the Remote contribution, then register the sidebar entry, the main
 * panel, the tool result cards and the plugin config card.
 * Registration cleanup is owned by the caller Context effect scope.
 */
export declare function apply(ctx: unknown): Promise<void>;
