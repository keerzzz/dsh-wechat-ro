// Host-face typert manifest for the ./typert export.
//
// DSH's typert loader imports this module for every mounted package that
// exports "./typert", validates it with validateTypertManifest() and registers
// the invocations into ctx.typert. The invocations here mirror exactly what
// controller.js exports as Remote methods, so the Gateway has a typed
// definition for every endpoint it can reach through the SRC fallback.
//
// Generated artifacts of this shape normally come from the typert generator;
// this one is hand-written because the plugin lives outside the DSH checkout.

import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import { METHOD_SPECS, NAMESPACE, PACKAGE_NAME, REQUEST_WIRE, SIGNAL_WIRE, requestSchemaFor, resultSchemaFor } from './wire.js';
import { CONVERSATION_METHOD_SPECS, CONVERSATION_NAMESPACE, conversationDescriptorFor } from './conversation-wire.js';

/** The gateway validates the request using this method's concrete schema. */
function codec(typeSymbol, spec) {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => requestSchemaFor(spec),
    description: 'Validated method request.',
  };
}

const methods = {};
for (const spec of METHOD_SPECS) {
  methods[NAMESPACE + '/' + spec.method] = {
    service: NAMESPACE,
    description: spec.description,
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: REQUEST_WIRE,
        wire: REQUEST_WIRE,
        source: 'json',
        acceptsUndefined: true,
        description: 'Optional request object.',
        codec: codec(PACKAGE_NAME + '#' + spec.method + 'Request', spec),
        strictCodec: codec(PACKAGE_NAME + '#' + spec.method + 'Request', spec),
      },
    ],
    cancellation: { parameter: SIGNAL_WIRE },
    result: {
      mode: 'strict',
      typeSymbol: PACKAGE_NAME + '#' + spec.method + 'Result',
      create: () => resultSchemaFor(spec),
      description: 'Method result payload.',
    },
    sourceLocation: { file: 'lib/controller.js', line: 1, column: 1 },
  };
}

for (const spec of CONVERSATION_METHOD_SPECS) {
  const descriptor = conversationDescriptorFor(spec);
  methods[CONVERSATION_NAMESPACE + '/' + spec.method] = {
    service: CONVERSATION_NAMESPACE, description: spec.description, invocation: descriptor.invocation,
    parameters: descriptor.parameters, cancellation: descriptor.cancellation, result: descriptor.result,
    sourceLocation: { file: 'lib/conversation-controller.js', line: 1, column: 1 },
  };
}
const $remote = createTypertRemoteInfo({ package: PACKAGE_NAME, methods }, z);

/** Service documentation consumed by the typert loader and the generated docs. */
const serviceModel = {
  key: NAMESPACE,
  exportName: 'WechatRoService',
  description: 'Read-only access to a decrypted local WeChat 4.x snapshot.',
  summary: 'Read-only WeChat snapshot queries',
  tags: ['wechat', 'read-only', 'local'],
  jsDoc: 'Queries use SQLite readOnly/query_only; SQLite may create WAL/SHM sidecars in the snapshot. buildExport is memory-only. No method talks to WeChat.',
  members: METHOD_SPECS.map((spec) => ({
    kind: 'method',
    name: spec.method,
    signature: spec.method + '(request, signal)',
    summary: spec.summary,
    jsDoc: spec.description,
  })),
  types: METHOD_SPECS.map((spec) => ({
    name: spec.method + 'Result',
    declaration: 'type ' + spec.method + 'Result = Record<string, unknown>',
  })),
};

export const TYPERT = {
  package: PACKAGE_NAME,
  face: 'host',
  schemas: [],
  get invocations() {
    return $remote.descriptors;
  },
  model: {
    services: [serviceModel, {
      key: CONVERSATION_NAMESPACE, exportName: 'WechatConversationService',
      description: 'Owner-only native Session, explicit snapshot grants and explicitly started iLink channel.',
      summary: 'Native WeChat conversation user operations', tags: ['wechat', 'owner-only', 'native-session'],
      jsDoc: 'Not model Tools. Requires canonical owner RemoteInvocation. Constructors and memory state do not read snapshots, credentials or networks; each privileged action has its own explicit confirmation.',
      members: CONVERSATION_METHOD_SPECS.map(spec => ({ kind: 'method', name: spec.method,
        signature: spec.method + '(request, signal)', summary: spec.description, jsDoc: spec.description })),
      types: [],
    }],
    events: [],
    objects: [],
  },
};

export default TYPERT;
